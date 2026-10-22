'use strict';

// OpenAI Chat Completions <-> OpenAI Responses protocol translation.
//
// WorkBuddy only speaks `POST /v1/chat/completions`. Some OpenCode Go models
// (the GPT family, Grok 4.7, Muse Spark) are served through the newer
// `/openai/v1/responses` protocol, which has a different request shape
// (`input` items instead of `messages`) and a different response shape
// (`output` items + typed SSE events). This module bridges the two so those
// models behave like ordinary chat models from WorkBuddy's point of view.

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
// Models.dev reports a 1M context window for the Luna entries with no output
// limit; a runaway max_output_tokens would be rejected upstream, so clamp.
const MAX_SAFE_OUTPUT_TOKENS = 65536;
// The Responses route rejects max_output_tokens below 16 outright:
// "Invalid 'max_output_tokens': integer below minimum value. Expected >= 16".
// WorkBuddy's model test asks for 1 token, which is why GPT failed while
// Gemini (no such floor) passed — so lift the floor instead of forwarding 1.
const MIN_OUTPUT_TOKENS = 16;

function scalar(value) {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedNumber(value, minimum, maximum) {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  return Math.min(Math.max(number, minimum), maximum);
}

/** Flatten a chat `content` value (string or part array) into plain text. */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

/** Convert chat message content parts into Responses input content parts. */
function inputContent(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image_url') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : scalar(part.image_url?.url);
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (part.type === 'input_text' && typeof part.text === 'string') {
      parts.push(part);
    } else if (part.type === 'input_image' && part.image_url) {
      parts.push(part);
    }
  }
  return parts;
}

/** Chat messages -> Responses `instructions` + `input` items. */
function convertMessages(messages) {
  const instructions = [];
  const input = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = scalar(message.role);

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(message.content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: scalar(message.tool_call_id) || scalar(message.name),
        output: textFromContent(message.content),
      });
      continue;
    }

    if (role === 'assistant') {
      const text = textFromContent(message.content);
      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      for (const call of toolCalls) {
        const fn = call?.function || {};
        input.push({
          type: 'function_call',
          call_id: scalar(call?.id) || `call_${crypto.randomUUID().replaceAll('-', '')}`,
          name: scalar(fn.name),
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }

    // user (and anything unexpected, treated as user input)
    const parts = inputContent(message.content);
    if (parts.length) input.push({ role: 'user', content: parts });
  }

  return { instructions: instructions.join('\n\n'), input };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function) continue;
    const entry = {
      type: 'function',
      name: scalar(tool.function.name),
      parameters:
        tool.function.parameters && typeof tool.function.parameters === 'object'
          ? tool.function.parameters
          : { type: 'object', properties: {} },
    };
    if (typeof tool.function.description === 'string') {
      entry.description = tool.function.description;
    }
    if (typeof tool.function.strict === 'boolean') entry.strict = tool.function.strict;
    if (entry.name) converted.push(entry);
  }
  return converted.length ? converted : undefined;
}

function convertToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return toolChoice;
    }
    return undefined;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const name = scalar(toolChoice.function?.name) || scalar(toolChoice.name);
    if (name) return { type: 'function', name };
  }
  return undefined;
}

/**
 * Convert a Chat Completions request body into a Responses request body.
 * Unsupported chat-only fields (`stream_options`, `n`, `logprobs`, ...) are
 * dropped rather than forwarded, because the Responses API rejects unknowns.
 */
function convertOpenAIChatToResponses(body) {
  const source = body && typeof body === 'object' ? body : {};
  const { instructions, input } = convertMessages(source.messages);
  const result = {
    model: scalar(source.model),
    input,
    store: false,
  };

  if (instructions) result.instructions = instructions;

  const maxTokens =
    boundedNumber(source.max_completion_tokens, 1, MAX_SAFE_OUTPUT_TOKENS) ??
    boundedNumber(source.max_tokens, 1, MAX_SAFE_OUTPUT_TOKENS);
  result.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);

  if (source.stream === true) result.stream = true;

  const temperature = finiteNumber(source.temperature);
  if (temperature !== undefined) result.temperature = temperature;
  const topP = finiteNumber(source.top_p);
  if (topP !== undefined) result.top_p = topP;

  if (typeof source.parallel_tool_calls === 'boolean') {
    result.parallel_tool_calls = source.parallel_tool_calls;
  }
  if (typeof source.user === 'string' && source.user) result.user = source.user;

  const tools = convertTools(source.tools);
  if (tools) result.tools = tools;
  const toolChoice = convertToolChoice(source.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;

  if (typeof source.reasoning_effort === 'string') {
    // The Responses models accept none/low/medium/high/xhigh/max — "minimal"
    // (WorkBuddy's 微) is rejected with a 400, so fold it onto low.
    const effort = source.reasoning_effort === 'minimal' ? 'low' : source.reasoning_effort;
    result.reasoning = { effort };
  }

  return result;
}

function openAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  if (!prompt && !completion) return undefined;
  const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens) || 0;
  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
  };
  if (cached) result.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning) result.completion_tokens_details = { reasoning_tokens: reasoning };
  return result;
}

function finishReasonFromResponse(payload, hasTools) {
  if (hasTools) return 'tool_calls';
  if (payload?.status === 'incomplete') {
    return payload?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  }
  return 'stop';
}

/** Responses non-stream payload -> Chat Completions payload. */
function convertResponsesResponseToOpenAI(payload, fallbackModel) {
  const source = payload && typeof payload === 'object' ? payload : {};
  let text = '';
  let reasoningText = '';
  const toolCalls = [];

  for (const item of Array.isArray(source.output) ? source.output : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!part) continue;
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        else if (part.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id:
          scalar(item.call_id) ||
          scalar(item.id) ||
          `call_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: {
          name: scalar(item.name),
          arguments:
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === 'reasoning') {
      for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (part && typeof part.text === 'string') reasoningText += part.text;
      }
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && typeof part.text === 'string') reasoningText += part.text;
      }
    }
  }

  if (!text && typeof source.output_text === 'string') text = source.output_text;

  const message = { role: 'assistant', content: text };
  if (reasoningText) message.reasoning_content = reasoningText;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const result = {
    id: scalar(source.id) || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created:
      Number(source.created_at) ||
      Math.floor(Date.now() / 1000),
    model: scalar(source.model) || scalar(fallbackModel),
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReasonFromResponse(source, toolCalls.length > 0),
      },
    ],
  };
  const usage = openAIUsage(source.usage);
  if (usage) result.usage = usage;
  return result;
}

function convertResponsesErrorToOpenAI(payload, fallbackStatus = 502) {
  const error =
    payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  return {
    error: {
      message:
        scalar(error?.message) ||
        scalar(payload?.message) ||
        'OpenCode Go Responses request failed.',
      type: scalar(error?.type) || 'upstream_error',
      param: null,
      code: scalar(error?.code) || String(fallbackStatus),
    },
  };
}

function dataFrame(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * Responses typed SSE events -> Chat Completions `delta` chunks.
 * Usage: `push(buffer)` returns a string of ready `data:` frames.
 */
class ResponsesSseToOpenAI {
  constructor(fallbackModel) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.id = `chatcmpl-${crypto.randomUUID()}`;
    this.model = scalar(fallbackModel);
    this.created = Math.floor(Date.now() / 1000);
    this.roleSent = false;
    this.done = false;
    this.toolIndexes = new Map();
    this.sawArguments = new Set();
    this.nextToolIndex = 0;
    this.finish = null;
    this.usage = null;
  }

  chunk(delta, finish = null, usage = undefined) {
    const result = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    };
    if (usage) result.usage = usage;
    return result;
  }

  ensureRole(frames) {
    if (this.roleSent) return;
    frames.push(dataFrame(this.chunk({ role: 'assistant' })));
    this.roleSent = true;
  }

  toolIndexFor(itemId, outputIndex) {
    const key = scalar(itemId) || `output-${outputIndex}`;
    let index = this.toolIndexes.get(key);
    if (Number.isInteger(index)) return index;
    index = this.nextToolIndex++;
    this.toolIndexes.set(key, index);
    this.toolIndexes.set(key.toLowerCase(), index);
    return index;
  }

  handleFrame(frame) {
    if (!frame.trim() || this.done) return '';
    let eventName = '';
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const rawData = dataLines.join('\n');
    if (!rawData || rawData === '[DONE]') return '';

    let payload;
    try {
      payload = JSON.parse(rawData);
    } catch {
      return '';
    }

    const type = scalar(payload.type) || eventName;
    const frames = [];

    if (type === 'response.created' || type === 'response.in_progress') {
      const response = payload.response || {};
      if (response.id) this.id = response.id;
      if (response.model) this.model = response.model;
      this.ensureRole(frames);
    } else if (type === 'response.output_item.added') {
      const item = payload.item || {};
      if (item.type === 'message' || item.type === 'reasoning') {
        this.ensureRole(frames);
      } else if (item.type === 'function_call') {
        this.ensureRole(frames);
        const index = this.toolIndexFor(item.id, payload.output_index);
        frames.push(
          dataFrame(
            this.chunk({
              tool_calls: [
                {
                  index,
                  id:
                    scalar(item.call_id) ||
                    scalar(item.id) ||
                    `call_${crypto.randomUUID().replaceAll('-', '')}`,
                  type: 'function',
                  function: {
                    name: scalar(item.name),
                    arguments: '',
                  },
                },
              ],
            }),
          ),
        );
      }
    } else if (type === 'response.content_part.added') {
      const part = payload.part || {};
      if (part.type === 'output_text' && typeof part.text === 'string' && part.text) {
        this.ensureRole(frames);
        frames.push(dataFrame(this.chunk({ content: part.text })));
      }
    } else if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
      const delta = payload.delta;
      if (typeof delta === 'string' && delta) {
        this.ensureRole(frames);
        frames.push(dataFrame(this.chunk({ content: delta })));
      }
    } else if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      const delta = payload.delta;
      if (typeof delta === 'string' && delta) {
        this.ensureRole(frames);
        frames.push(dataFrame(this.chunk({ reasoning_content: delta })));
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const delta = payload.delta;
      if (typeof delta === 'string' && delta) {
        this.ensureRole(frames);
        const index = this.toolIndexFor(payload.item_id, payload.output_index);
        this.sawArguments.add(index);
        frames.push(
          dataFrame(
            this.chunk({
              tool_calls: [{ index, function: { arguments: delta } }],
            }),
          ),
        );
      }
    } else if (type === 'response.output_item.done') {
      const item = payload.item || {};
      if (item.type === 'function_call') {
        const index = this.toolIndexFor(item.id, payload.output_index);
        // Upstreams that do not stream argument deltas only expose the full
        // arguments here; emit them once so the tool call stays usable.
        if (!this.sawArguments.has(index) && typeof item.arguments === 'string' && item.arguments) {
          frames.push(
            dataFrame(
              this.chunk({
                tool_calls: [{ index, function: { arguments: item.arguments } }],
              }),
            ),
          );
        }
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = payload.response || {};
      if (response.id) this.id = response.id;
      if (response.model) this.model = response.model;
      this.usage = openAIUsage(response.usage) || this.usage;
      const hasTools = this.toolIndexes.size > 0;
      this.finish = finishReasonFromResponse(
        type === 'response.incomplete' ? { status: 'incomplete', ...response } : response,
        hasTools,
      );
      frames.push(this.finishChunk());
    } else if (type === 'response.failed') {
      const response = payload.response || {};
      frames.push(
        dataFrame(
          convertResponsesErrorToOpenAI(
            { error: response.error || { message: 'OpenCode Go response failed.' } },
            502,
          ),
        ),
      );
      frames.push(dataFrame('[DONE]'));
      this.done = true;
    } else if (type === 'error') {
      frames.push(dataFrame(convertResponsesErrorToOpenAI(payload)));
      frames.push(dataFrame('[DONE]'));
      this.done = true;
    }

    return frames.join('');
  }

  finishChunk() {
    if (this.done) return '';
    const frames = [];
    this.ensureRole(frames);
    frames.push(
      dataFrame(
        this.chunk(
          {},
          this.finish || (this.toolIndexes.size ? 'tool_calls' : 'stop'),
          this.usage || undefined,
        ),
      ),
    );
    frames.push(dataFrame('[DONE]'));
    this.done = true;
    return frames.join('');
  }

  drainFrames() {
    let output = '';
    while (true) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      output += this.handleFrame(frame);
    }
    return output;
  }

  push(chunk) {
    if (this.done) return '';
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    return this.drainFrames();
  }

  end() {
    if (this.done) return '';
    this.buffer += this.decoder.end();
    let output = this.drainFrames();
    if (this.buffer.trim()) output += this.handleFrame(this.buffer);
    this.buffer = '';
    if (!this.done) output += this.finishChunk();
    return output;
  }
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_SAFE_OUTPUT_TOKENS,
  ResponsesSseToOpenAI,
  convertOpenAIChatToResponses,
  convertResponsesErrorToOpenAI,
  convertResponsesResponseToOpenAI,
  openAIUsage,
};
