'use strict';

// OpenAI Chat Completions <-> Google Generative AI (generateContent) translation.
//
// The OpenCode Go gateway exposes Gemini under
// `{gateway}/google/v1beta/models/{model}:generateContent`
// and `:streamGenerateContent?alt=sse` for streaming. Google's request shape
// (`contents` / `parts` / `functionCall`) and response shape
// (`candidates[].content.parts`) are different enough from OpenAI chat that a
// translation layer is required for WorkBuddy to drive those models.

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_SAFE_OUTPUT_TOKENS = 65536;

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

function parseDataUrl(url) {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/** Chat content -> Google `parts`. */
function contentParts(content) {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text) parts.push({ text: part.text });
    } else if (part.type === 'image_url') {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : scalar(part.image_url?.url);
      if (!url) continue;
      const inline = parseDataUrl(url);
      if (inline) parts.push({ inlineData: inline });
      else parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

// Google accepts a narrower JSON-schema dialect than OpenAI. Unknown keywords
// cause a 400, so rebuild each schema from the supported subset.
const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'propertyOrdering',
  'title',
  'default',
  'example',
]);

function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {};
      for (const [name, child] of Object.entries(value)) {
        const cleaned = sanitizeSchema(child, depth + 1);
        if (cleaned) properties[name] = cleaned;
      }
      result.properties = properties;
    } else if (key === 'items') {
      const cleaned = sanitizeSchema(value, depth + 1);
      if (cleaned) result.items = cleaned;
    } else if (key === 'required') {
      if (Array.isArray(value)) result.required = value.filter((v) => typeof v === 'string');
    } else if (key === 'enum') {
      if (Array.isArray(value)) result.enum = value;
    } else if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  if (!result.type && result.properties) result.type = 'object';
  return Object.keys(result).length ? result : undefined;
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const declarations = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function) continue;
    const name = scalar(tool.function.name);
    if (!name) continue;
    const declaration = { name };
    if (typeof tool.function.description === 'string') {
      declaration.description = tool.function.description;
    }
    const parameters = sanitizeSchema(tool.function.parameters);
    if (parameters) declaration.parameters = parameters;
    declarations.push(declaration);
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function convertToolConfig(toolChoice) {
  const config = {};
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') config.mode = 'NONE';
    else if (toolChoice === 'required') config.mode = 'ANY';
    else if (toolChoice === 'auto') config.mode = 'AUTO';
  } else if (toolChoice && typeof toolChoice === 'object') {
    const name = scalar(toolChoice.function?.name) || scalar(toolChoice.name);
    if (name) {
      config.mode = 'ANY';
      config.allowedFunctionNames = [name];
    }
  }
  return Object.keys(config).length
    ? { functionCallingConfig: config }
    : undefined;
}

/** Chat Completions body -> Google generateContent body. */
function convertOpenAIChatToGoogle(body) {
  const source = body && typeof body === 'object' ? body : {};
  const contents = [];
  const systemTexts = [];
  const toolNamesByCallId = new Map();

  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = scalar(message.role);

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(message.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const callId = scalar(message.tool_call_id) || scalar(message.name);
      const name = toolNamesByCallId.get(callId) || scalar(message.name) || 'tool';
      const raw = textFromContent(message.content);
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = { result: raw };
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        payload = { result: payload };
      }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: payload } }],
      });
      continue;
    }

    if (role === 'assistant') {
      const parts = contentParts(message.content);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function || {};
        const name = scalar(fn.name);
        const callId = scalar(call?.id);
        if (callId && name) toolNamesByCallId.set(callId, name);
        let args = {};
        try {
          args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {};
        } catch {
          args = { _raw: fn.arguments };
        }
        parts.push({ functionCall: { name, args } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    const parts = contentParts(message.content);
    if (parts.length) contents.push({ role: 'user', parts });
  }

  const result = { contents };
  if (systemTexts.length) {
    result.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
  }

  const generationConfig = {};
  const maxTokens =
    boundedNumber(source.max_completion_tokens, 1, MAX_SAFE_OUTPUT_TOKENS) ??
    boundedNumber(source.max_tokens, 1, MAX_SAFE_OUTPUT_TOKENS);
  generationConfig.maxOutputTokens = maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const temperature = finiteNumber(source.temperature);
  if (temperature !== undefined) generationConfig.temperature = temperature;
  const topP = finiteNumber(source.top_p);
  if (topP !== undefined) generationConfig.topP = topP;
  if (Array.isArray(source.stop) && source.stop.length) {
    generationConfig.stopSequences = source.stop.filter((s) => typeof s === 'string').slice(0, 4);
  } else if (typeof source.stop === 'string' && source.stop) {
    generationConfig.stopSequences = [source.stop];
  }

  // Thinking budget / level. Gemini models expose either a level enum or a
  // token budget; `none` maps to budget 0 (thinking disabled).
  const effort = scalar(source.reasoning_effort).toLowerCase();
  if (effort === 'none' || effort === 'off' || effort === 'disabled') {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  } else if (effort === 'minimal' || effort === 'low') {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  } else if (effort === 'medium') {
    generationConfig.thinkingConfig = { thinkingLevel: 'medium' };
  } else if (effort === 'high' || effort === 'xhigh' || effort === 'max') {
    generationConfig.thinkingConfig = { thinkingLevel: 'high' };
  }

  result.generationConfig = generationConfig;

  const tools = convertTools(source.tools);
  if (tools) result.tools = tools;
  const toolConfig = convertToolConfig(source.tool_choice);
  if (toolConfig) result.toolConfig = toolConfig;

  return result;
}

function googleUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.promptTokenCount) || 0;
  const candidates = Number(usage.candidatesTokenCount) || 0;
  const thoughts = Number(usage.thoughtsTokenCount) || 0;
  const total = Number(usage.totalTokenCount) || prompt + candidates + thoughts;
  if (!prompt && !candidates && !thoughts) return undefined;
  const completion = Math.max(candidates + thoughts, total - prompt);
  const cached = Number(usage.cachedContentTokenCount) || 0;
  const result = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
  };
  if (cached) result.prompt_tokens_details = { cached_tokens: cached };
  if (thoughts) result.completion_tokens_details = { reasoning_tokens: thoughts };
  return result;
}

function finishReasonFromGoogle(candidate, hasTools) {
  if (hasTools) return 'tool_calls';
  switch (scalar(candidate?.finishReason)) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return 'stop';
    default:
      return 'stop';
  }
}

/** Google generateContent response -> Chat Completions response. */
function convertGoogleResponseToOpenAI(payload, fallbackModel) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const candidate = Array.isArray(source.candidates) ? source.candidates[0] : null;
  let text = '';
  const toolCalls = [];

  for (const part of candidate?.content?.parts || []) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: {
          name: scalar(part.functionCall.name),
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const message = { role: 'assistant', content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;

  let finish = finishReasonFromGoogle(candidate, toolCalls.length > 0);
  if (!candidate && source.promptFeedback?.blockReason) finish = 'content_filter';

  const result = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: scalar(source.modelVersion) || scalar(fallbackModel),
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finish,
      },
    ],
  };
  const usage = googleUsage(source.usageMetadata);
  if (usage) result.usage = usage;
  return result;
}

function convertGoogleErrorToOpenAI(payload, fallbackStatus = 502) {
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : {};
  return {
    error: {
      message: scalar(error.message) || 'OpenCode Go Google request failed.',
      type: scalar(error.status) || 'upstream_error',
      param: null,
      code: String(error.code || fallbackStatus),
    },
  };
}

function dataFrame(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** Google `alt=sse` chunks -> Chat Completions chunks. */
class GoogleSseToOpenAI {
  constructor(fallbackModel) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.id = `chatcmpl-${crypto.randomUUID()}`;
    this.model = scalar(fallbackModel);
    this.created = Math.floor(Date.now() / 1000);
    this.roleSent = false;
    this.done = false;
    this.finish = null;
    this.usage = null;
    this.toolCount = 0;
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

  handlePayload(payload) {
    const frames = [];
    if (payload?.error) {
      this.ensureRole(frames);
      frames.push(dataFrame(convertGoogleErrorToOpenAI(payload)));
      frames.push(dataFrame('[DONE]'));
      this.done = true;
      return frames.join('');
    }

    if (payload?.modelVersion) this.model = payload.modelVersion;
    if (payload?.usageMetadata) {
      this.usage = googleUsage(payload.usageMetadata) || this.usage;
    }
    const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
    if (!candidate) return '';

    for (const part of candidate.content?.parts || []) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text) {
        this.ensureRole(frames);
        frames.push(dataFrame(this.chunk({ content: part.text })));
      }
      if (part.functionCall) {
        this.ensureRole(frames);
        const index = this.toolCount++;
        frames.push(
          dataFrame(
            this.chunk({
              tool_calls: [
                {
                  index,
                  id: `call_${crypto.randomUUID().replaceAll('-', '')}`,
                  type: 'function',
                  function: {
                    name: scalar(part.functionCall.name),
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                  },
                },
              ],
            }),
          ),
        );
      }
    }

    if (candidate.finishReason) {
      this.finish = finishReasonFromGoogle(candidate, this.toolCount > 0);
    }
    return frames.join('');
  }

  handleFrame(frame) {
    if (!frame.trim() || this.done) return '';
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') return '';
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return '';
    }
    return this.handlePayload(payload);
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

  finishChunk() {
    if (this.done) return '';
    const frames = [];
    this.ensureRole(frames);
    frames.push(
      dataFrame(
        this.chunk(
          {},
          this.finish || (this.toolCount ? 'tool_calls' : 'stop'),
          this.usage || undefined,
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
    if (!this.done) output += this.finishChunk();
    return output;
  }
}

module.exports = {
  GoogleSseToOpenAI,
  convertGoogleErrorToOpenAI,
  convertGoogleResponseToOpenAI,
  convertOpenAIChatToGoogle,
  googleUsage,
  sanitizeSchema,
};
