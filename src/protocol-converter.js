'use strict';

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const MESSAGES_MODELS = new Set([
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'claude-haiku-5-5',
]);

const DEFAULT_MAX_TOKENS = 8192;
const MAX_SAFE_OUTPUT_TOKENS = 16384;

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedNumber(value, minimum, maximum) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(maximum, Math.max(minimum, number));
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(scalar(model).toLowerCase());
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return scalar(part.text || part.input_text || part.content);
    })
    .filter(Boolean)
    .join('\n');
}

function imageBlock(urlValue) {
  const url = scalar(
    typeof urlValue === 'object' && urlValue !== null ? urlValue.url : urlValue,
  );
  if (!url) return null;

  const dataMatch = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }

  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

function contentBlocks(content) {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text' || part.type === 'input_text') {
      const text = scalar(part.text || part.input_text);
      if (text) blocks.push({ type: 'text', text });
      continue;
    }

    if (part.type === 'image_url' || part.image_url) {
      const image = imageBlock(part.image_url);
      if (image) blocks.push(image);
      continue;
    }

    if (part.type === 'image' && part.source) {
      blocks.push({ type: 'image', source: part.source });
    }
  }
  return blocks;
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function pushMessage(messages, role, blocks) {
  const cleanBlocks = blocks.filter(Boolean);
  if (!cleanBlocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.content.push(...cleanBlocks);
  } else {
    messages.push({ role, content: cleanBlocks });
  }
}

function convertMessages(openAIMessages) {
  const systemParts = [];
  const messages = [];

  for (const message of Array.isArray(openAIMessages) ? openAIMessages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = scalar(message.role).toLowerCase();

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'user') {
      pushMessage(messages, 'user', contentBlocks(message.content));
      continue;
    }

    if (role === 'assistant') {
      const blocks = contentBlocks(message.content);
      for (const toolCall of Array.isArray(message.tool_calls)
        ? message.tool_calls
        : []) {
        const name = scalar(toolCall?.function?.name || toolCall?.name);
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: scalar(toolCall.id) || `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
          name,
          input: parseArguments(toolCall?.function?.arguments || toolCall?.arguments),
        });
      }
      pushMessage(messages, 'assistant', blocks);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const toolUseId = scalar(message.tool_call_id || message.id);
      if (!toolUseId) continue;
      const resultBlocks = contentBlocks(message.content);
      const resultContent = resultBlocks.length
        ? resultBlocks
        : [{ type: 'text', text: textFromContent(message.content) || ' ' }];
      pushMessage(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: resultContent,
          ...(message.is_error === true ? { is_error: true } : {}),
        },
      ]);
    }
  }

  return { systemParts, messages };
}

function convertTools(tools) {
  const converted = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    const definition = tool.type === 'function' ? tool.function : tool;
    const name = scalar(definition?.name);
    if (!name) continue;
    converted.push({
      name,
      description: scalar(definition.description),
      input_schema:
        definition.parameters && typeof definition.parameters === 'object'
          ? definition.parameters
          : definition.input_schema && typeof definition.input_schema === 'object'
            ? definition.input_schema
            : { type: 'object', properties: {} },
    });
  }
  return converted;
}

function convertToolChoice(toolChoice, parallelToolCalls) {
  let converted = null;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'required') converted = { type: 'any' };
    else if (['auto', 'none'].includes(toolChoice)) converted = { type: toolChoice };
  } else if (toolChoice && typeof toolChoice === 'object') {
    const name = scalar(toolChoice?.function?.name || toolChoice.name);
    if (name) converted = { type: 'tool', name };
    else if (['auto', 'any', 'none'].includes(toolChoice.type)) {
      converted = { type: toolChoice.type };
    }
  }

  if (converted && parallelToolCalls === false) {
    converted.disable_parallel_tool_use = true;
  }
  return converted;
}

function convertOpenAIChatToAnthropic(body) {
  const source = body && typeof body === 'object' ? body : {};
  const { systemParts, messages } = convertMessages(source.messages);
  const existingSystem = textFromContent(source.system);
  if (existingSystem) systemParts.unshift(existingSystem);

  if (!messages.length) {
    messages.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  }

  const requestedMaxTokens = finiteNumber(
    source.max_completion_tokens ?? source.max_tokens,
  );
  const maxTokens = Math.trunc(
    Math.min(
      MAX_SAFE_OUTPUT_TOKENS,
      Math.max(1, requestedMaxTokens || DEFAULT_MAX_TOKENS),
    ),
  );

  const result = {
    model: scalar(source.model),
    max_tokens: maxTokens,
    messages,
    stream: source.stream === true,
  };

  if (systemParts.length) result.system = systemParts.join('\n\n');

  const tools = convertTools(source.tools);
  if (tools.length) {
    result.tools = tools;
    const toolChoice = convertToolChoice(source.tool_choice, source.parallel_tool_calls);
    if (toolChoice) result.tool_choice = toolChoice;
  }

  const temperature = boundedNumber(source.temperature, 0, 1);
  if (temperature !== null) result.temperature = temperature;
  const topP = boundedNumber(source.top_p, 0, 1);
  if (topP !== null) result.top_p = topP;
  const topK = boundedNumber(source.top_k, 1, 1000);
  if (topK !== null) result.top_k = Math.trunc(topK);

  const stopSequences = (Array.isArray(source.stop) ? source.stop : [source.stop])
    .map(scalar)
    .filter(Boolean)
    .slice(0, 4);
  if (stopSequences.length) result.stop_sequences = stopSequences;

  // WorkBuddy sends the selected thinking level as `reasoning_effort`; the
  // Messages API expresses the same thing as an explicit token budget.
  const THINKING_BUDGETS = {
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 12288,
    max: 15360,
  };
  const effort = scalar(source.reasoning_effort).toLowerCase();
  if (effort === 'none' || effort === 'off' || effort === 'disabled') {
    result.thinking = { type: 'disabled' };
  } else if (THINKING_BUDGETS[effort]) {
    const budget = THINKING_BUDGETS[effort];
    result.thinking = { type: 'enabled', budget_tokens: budget };
    result.max_tokens = Math.max(result.max_tokens, budget + 512);
    // Anthropic rejects custom sampling values while thinking is enabled.
    delete result.temperature;
    delete result.top_p;
    delete result.top_k;
  }

  return result;
}

function finishReason(stopReason, hasTools = false) {
  if (hasTools || stopReason === 'tool_use' || stopReason === 'pause_turn') {
    return 'tool_calls';
  }
  if (
    stopReason === 'max_tokens' ||
    stopReason === 'model_context_window_exceeded'
  ) {
    return 'length';
  }
  if (stopReason === 'refusal') return 'content_filter';
  return 'stop';
}

function openAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const uncached = finiteNumber(usage.input_tokens) || 0;
  const cacheCreation = finiteNumber(usage.cache_creation_input_tokens) || 0;
  const cacheRead = finiteNumber(usage.cache_read_input_tokens) || 0;
  const output = finiteNumber(usage.output_tokens) || 0;
  const prompt = uncached + cacheCreation + cacheRead;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

function messageFromAnthropic(content) {
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: scalar(block.id) || `call_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: {
          name: scalar(block.name),
          arguments: JSON.stringify(
            block.input && typeof block.input === 'object' ? block.input : {},
          ),
        },
      });
    }
  }

  const message = {
    role: 'assistant',
    content: textParts.length ? textParts.join('') : null,
  };
  if (thinkingParts.length) message.reasoning_content = thinkingParts.join('');
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, hasTools: toolCalls.length > 0 };
}

function convertAnthropicResponseToOpenAI(payload, fallbackModel) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const { message, hasTools } = messageFromAnthropic(source.content);
  const result = {
    id: scalar(source.id) || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: scalar(source.model || fallbackModel),
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason(source.stop_reason, hasTools),
      },
    ],
  };
  const usage = openAIUsage(source.usage);
  if (usage) result.usage = usage;
  return result;
}

function convertAnthropicErrorToOpenAI(payload, fallbackStatus = 502) {
  const error = payload?.error && typeof payload.error === 'object'
    ? payload.error
    : {};
  return {
    error: {
      message: scalar(error.message) || 'OpenCode Go Messages request failed.',
      type: scalar(error.type) || 'upstream_error',
      param: null,
      code: scalar(error.code) || String(fallbackStatus),
    },
  };
}

function dataFrame(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

class AnthropicSseToOpenAI {
  constructor(fallbackModel) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.id = `chatcmpl-${crypto.randomUUID()}`;
    this.model = scalar(fallbackModel);
    this.created = Math.floor(Date.now() / 1000);
    this.roleSent = false;
    this.done = false;
    this.stopReason = null;
    this.usage = {};
    this.toolIndexes = new Map();
    this.nextToolIndex = 0;
  }

  chunk(delta, finish = null, usage = undefined) {
    const result = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finish,
        },
      ],
    };
    if (usage) result.usage = usage;
    return result;
  }

  ensureRole(frames) {
    if (this.roleSent) return;
    frames.push(dataFrame(this.chunk({ role: 'assistant' })));
    this.roleSent = true;
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

    const type = payload.type || eventName;
    const frames = [];

    if (type === 'message_start') {
      if (payload.message?.id) this.id = payload.message.id;
      if (payload.message?.model) this.model = payload.message.model;
      if (payload.message?.usage) Object.assign(this.usage, payload.message.usage);
      this.ensureRole(frames);
    } else if (type === 'content_block_start') {
      this.ensureRole(frames);
      const block = payload.content_block || {};
      if (block.type === 'text' && block.text) {
        frames.push(dataFrame(this.chunk({ content: block.text })));
      } else if (block.type === 'thinking' && block.thinking) {
        frames.push(dataFrame(this.chunk({ reasoning_content: block.thinking })));
      } else if (block.type === 'tool_use') {
        const toolIndex = this.nextToolIndex++;
        this.toolIndexes.set(payload.index, toolIndex);
        frames.push(
          dataFrame(
            this.chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: scalar(block.id) || `call_${crypto.randomUUID().replaceAll('-', '')}`,
                  type: 'function',
                  function: {
                    name: scalar(block.name),
                    arguments:
                      block.input && Object.keys(block.input).length
                        ? JSON.stringify(block.input)
                        : '',
                  },
                },
              ],
            }),
          ),
        );
      }
    } else if (type === 'content_block_delta') {
      this.ensureRole(frames);
      const delta = payload.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        frames.push(dataFrame(this.chunk({ content: delta.text })));
      } else if (
        delta.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        frames.push(dataFrame(this.chunk({ reasoning_content: delta.thinking })));
      } else if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        let toolIndex = this.toolIndexes.get(payload.index);
        if (!Number.isInteger(toolIndex)) {
          toolIndex = this.nextToolIndex++;
          this.toolIndexes.set(payload.index, toolIndex);
        }
        frames.push(
          dataFrame(
            this.chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  function: { arguments: delta.partial_json },
                },
              ],
            }),
          ),
        );
      }
    } else if (type === 'message_delta') {
      if (payload.delta?.stop_reason) this.stopReason = payload.delta.stop_reason;
      if (payload.usage) Object.assign(this.usage, payload.usage);
    } else if (type === 'message_stop') {
      frames.push(this.finish());
    } else if (type === 'error') {
      frames.push(dataFrame(convertAnthropicErrorToOpenAI(payload)));
      frames.push(dataFrame('[DONE]'));
      this.done = true;
    }

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

  finish() {
    if (this.done) return '';
    const frames = [];
    this.ensureRole(frames);
    frames.push(
      dataFrame(
        this.chunk(
          {},
          finishReason(this.stopReason, this.toolIndexes.size > 0),
          openAIUsage(this.usage),
        ),
      ),
    );
    frames.push(dataFrame('[DONE]'));
    this.done = true;
    return frames.join('');
  }

  end() {
    if (this.done) return '';
    this.buffer += this.decoder.end();
    let output = this.drainFrames();
    if (this.buffer.trim()) output += this.handleFrame(this.buffer);
    this.buffer = '';
    if (!this.done) output += this.finish();
    return output;
  }
}

module.exports = {
  AnthropicSseToOpenAI,
  MESSAGES_MODELS,
  convertAnthropicErrorToOpenAI,
  convertAnthropicResponseToOpenAI,
  convertOpenAIChatToAnthropic,
  isMessagesModel,
};
