'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const {
  AnthropicSseToOpenAI,
  MESSAGES_MODELS,
  convertAnthropicErrorToOpenAI,
  convertAnthropicResponseToOpenAI,
  convertOpenAIChatToAnthropic,
  isMessagesModel,
} = require('./protocol-converter');
const {
  ResponsesSseToOpenAI,
  convertOpenAIChatToResponses,
  convertResponsesErrorToOpenAI,
  convertResponsesResponseToOpenAI,
} = require('./responses-converter');
const {
  GoogleSseToOpenAI,
  convertGoogleErrorToOpenAI,
  convertGoogleResponseToOpenAI,
  convertOpenAIChatToGoogle,
} = require('./google-converter');
const {
  usageFromJson,
  usageFromPayload,
  tailCollector,
} = require('./usage');

const accounts = require('../accounts');
const { rotateIfBigger } = require('./file-util');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);
const APP_VERSION = PACKAGE.version;
const LISTEN_HOST = '127.0.0.1';
/** Port saved by the control panel; the env var still wins when set. */
function configuredPort() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'bridge-config.json'), 'utf8'),
    );
    const port = Number(raw && raw.bridgePort);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch {
    // No saved config yet — fall through to the default.
  }
  return 8788;
}
const requestedPort = Number.parseInt(
  process.env.OPENCODE_GO_BRIDGE_PORT || String(configuredPort()),
  10,
);
const LISTEN_PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
    ? requestedPort
    : 8788;
const TEST_UPSTREAM_ORIGIN =
  process.env.NODE_ENV === 'test'
    ? process.env.OPENCODE_GO_UPSTREAM_ORIGIN
    : '';
const UPSTREAM_ORIGIN = new URL(
  TEST_UPSTREAM_ORIGIN || 'https://opencode.ai',
);
// Current documented gateway layout. The legacy /zen/go/v1 prefixes still answer,
// but /inference/go is what the official clients now use.
const GATEWAY_PREFIX = '/inference/go';
const OPENAI_UPSTREAM_PATH = `${GATEWAY_PREFIX}/openai/v1/chat/completions`;
const ANTHROPIC_UPSTREAM_PATH = `${GATEWAY_PREFIX}/anthropic/v1/messages`;
const RESPONSES_UPSTREAM_PATH = `${GATEWAY_PREFIX}/openai/v1/responses`;
const GOOGLE_UPSTREAM_BASE = `${GATEWAY_PREFIX}/google/v1beta/models`;
const UPSTREAM_CLIENT = UPSTREAM_ORIGIN.protocol === 'http:' ? http : https;
const USER_AGENT = `workbuddy-opencode-go-bridge/${APP_VERSION}`;

// Some Go models (the GPT family) are refused when the request reaches the
// upstream from a country OpenAI does not serve: 403
// `unsupported_country_region_territory`. Retrying the same request through a
// local HTTP proxy fixes it, so the proxy is used as an automatic fallback and
// only for that specific rejection.
// Proxy is per-model now: `proxy-config.json` decides whether the proxy is
// enabled at all, and which model ids are forced through it. Requests for other
// models still go direct, unless the upstream proves to be geo-restricted for
// that model (then the model is remembered, not the whole process).
const PROXY_CONFIG_PATH = path.join(PACKAGE_ROOT, 'proxy-config.json');

function parseProxyEndpoint(raw) {
  const text = scalar(raw).trim();
  if (!text) return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`,
    );
    if (!url.hostname) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      auth: url.username
        ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}`
        : '',
    };
  } catch {
    return null;
  }
}

/** Legacy sources: OPENCODE_GO_PROXY env, then proxy.txt. */
function legacyProxyUrl() {
  const env = String(process.env.OPENCODE_GO_PROXY || '').trim();
  if (env) return env;
  try {
    return (
      fs
        .readFileSync(path.join(PACKAGE_ROOT, 'proxy.txt'), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#')) || ''
    );
  } catch {
    return '';
  }
}

function loadProxyConfig() {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf8'));
  } catch {
    // No panel config yet — fall back to the legacy single-URL setup.
  }
  const url = scalar(
    process.env.OPENCODE_GO_PROXY || (file && file.url) || legacyProxyUrl(),
  ).trim();
  const endpoint = parseProxyEndpoint(url);
  const models = new Set(
    (Array.isArray(file && file.models) ? file.models : [])
      .map((id) => normalizeModel(id))
      .filter(Boolean),
  );
  const enabled =
    file && typeof file.enabled === 'boolean' ? file.enabled : Boolean(endpoint);
  return {
    enabled: Boolean(enabled) && Boolean(endpoint),
    url,
    endpoint,
    models,
    fallback: file && typeof file.fallback === 'boolean' ? file.fallback : true,
  };
}

let proxyCache = { at: 0, value: null };

/** Cached so edits in the panel apply within a few seconds without a restart. */
function proxyConfig() {
  const now = Date.now();
  if (proxyCache.value && now - proxyCache.at < 3000) return proxyCache.value;
  const value = loadProxyConfig();
  proxyCache = { at: now, value };
  return value;
}
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const STATE_DIR =
  process.env.OPENCODE_GO_BRIDGE_STATE_DIR ||
  path.join(process.env.LOCALAPPDATA || PACKAGE_ROOT, 'OpenCodeGoBridge');
const PID_PATH = path.join(STATE_DIR, 'bridge.pid');
const SHUTDOWN_TOKEN_PATH = path.join(STATE_DIR, 'shutdown.token');
const DIAGNOSTIC_PATH = path.join(STATE_DIR, 'diagnostic.log');
let shutdownToken = '';

// Built-in fallback only. models-catalog.json (written by catalog.py) is the
// authority; these lists keep the bridge usable when that file is absent.
const CHAT_MODELS = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'minimax-m3.1-flash-free',
  'longcat-2.0',
  'longcat-2.5-preview-free',
  'step-5-preview',
  'hy3',
  'hy4-preview',
  'beam-free',
  'omen-alpha',
]);
// Models served by the OpenAI /responses or Google protocol. WorkBuddy speaks
// OpenAI chat only, so these are rejected with a clear message.
const RESPONSES_ONLY_MODELS = new Set([
  'gpt-5.6-luna',
  'gpt-6-luna',
  'grok-4.6',
  'grok-4.7',
  'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor',
]);
const GOOGLE_ONLY_MODELS = new Set(['gemini-4-argon-contributor']);
const SUPPORTED_MODELS = Object.freeze([
  ...Array.from(CHAT_MODELS),
  ...Array.from(MESSAGES_MODELS),
]);

// ---------------------------------------------------------------------------
// Dynamic catalog. catalog.py writes models-catalog.json (gateway listing +
// models.dev metadata). When present it decides the protocol per model, so new
// upstream models work without touching this file.
// ---------------------------------------------------------------------------
const CATALOG_PATH = path.join(PACKAGE_ROOT, 'models-catalog.json');
const CATALOG_TTL_MS = 5000;
let catalogState = { mtimeMs: -1, at: 0, protocols: new Map() };

function catalogProtocols() {
  const now = Date.now();
  if (now - catalogState.at < CATALOG_TTL_MS) return catalogState.protocols;
  catalogState.at = now;
  try {
    const stat = fs.statSync(CATALOG_PATH);
    if (stat.mtimeMs === catalogState.mtimeMs) return catalogState.protocols;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const protocols = new Map();
    for (const row of Array.isArray(parsed?.models) ? parsed.models : []) {
      if (row && typeof row.id === 'string' && typeof row.protocol === 'string') {
        protocols.set(row.id.toLowerCase(), row.protocol);
      }
    }
    if (protocols.size) {
      catalogState = { mtimeMs: stat.mtimeMs, at: now, protocols };
    }
  } catch {
    // No catalog file: the built-in allowlists below remain the fallback.
  }
  return catalogState.protocols;
}

/** Wire protocol for a model: catalog first, built-in allowlists as fallback. */
function protocolFor(model) {
  const fromCatalog = catalogProtocols().get(model);
  if (fromCatalog === 'chat' || fromCatalog === 'anthropic') return fromCatalog;
  if (fromCatalog === 'responses' || fromCatalog === 'google') return fromCatalog;
  if (MESSAGES_MODELS.has(model)) return 'anthropic';
  if (RESPONSES_ONLY_MODELS.has(model)) return 'responses';
  if (GOOGLE_ONLY_MODELS.has(model)) return 'google';
  if (CHAT_MODELS.has(model)) return 'chat';
  return undefined;
}

/** Advertised list: catalog entries WorkBuddy can actually drive, else built-ins. */
function advertisedModels() {
  const usable = [...catalogProtocols()]
    .filter(([, protocol]) => protocol === 'chat' || protocol === 'anthropic' || protocol === 'responses')
    .map(([id]) => id);
  return usable.length ? [...new Set([...SUPPORTED_MODELS, ...usable])] : SUPPORTED_MODELS;
}


const ROUTES = new Map([
  ['/v1/chat/completions', OPENAI_UPSTREAM_PATH],
  ['/chat/completions', OPENAI_UPSTREAM_PATH],
  ['/v1/messages', ANTHROPIC_UPSTREAM_PATH],
  ['/messages', ANTHROPIC_UPSTREAM_PATH],
  ['/v1/responses', RESPONSES_UPSTREAM_PATH],
  ['/responses', RESPONSES_UPSTREAM_PATH],
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const stats = {
  proxiedRequests: 0,
  convertedMessagesRequests: 0,
  convertedResponsesRequests: 0,
  convertedGoogleRequests: 0,
  upstreamFailures: 0,
  accountSwitches: 0,
};

// Models that already proved geo-restricted go through the proxy from then on,
// so we stop paying for a doomed direct attempt — per model, not per process.
const geoProxyModels = new Set();
// Sampling parameters a model has already rejected, keyed by model id.
const blockedSamplingParams = new Map();

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function normalizeModel(value) {
  return scalar(value).trim().toLowerCase();
}

function diagnostic(event, code = '') {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const safeEvent = scalar(event).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
    const safeCode = scalar(code).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
    // A long-lived bridge would otherwise grow this file forever.
    rotateIfBigger(DIAGNOSTIC_PATH, 1024 * 1024, `${DIAGNOSTIC_PATH}.1`);
    fs.appendFileSync(
      DIAGNOSTIC_PATH,
      `${new Date().toISOString()} ${safeEvent}${safeCode ? ` ${safeCode}` : ''}\n`,
      'utf8',
    );
  } catch {
    // Diagnostics must never prevent startup or disclose request contents.
  }
}

function writePid() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, `${process.pid}\n`, 'utf8');
}

function removePid() {
  try {
    if (fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch {
    // A stale or already removed PID file is harmless.
  }
}

function writeShutdownToken() {
  shutdownToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SHUTDOWN_TOKEN_PATH, shutdownToken + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function removeRuntimeState() {
  let ownsState = false;
  try {
    ownsState =
      fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid);
  } catch {
    // Missing state is harmless during shutdown.
  }
  removePid();
  if (ownsState) {
    try {
      fs.unlinkSync(SHUTDOWN_TOKEN_PATH);
    } catch {
      // A stale or already removed control token is harmless.
    }
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return scalar(part.text || part.content || part.input_text);
    })
    .filter(Boolean)
    .join('\n');
}

function explicitSessionFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const containers = [body, body.metadata, body.meta, body.context].filter(
    (item) => item && typeof item === 'object',
  );
  const keys = [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'chat_session_id',
    'chatSessionId',
    'thread_id',
    'threadId',
  ];
  for (const container of containers) {
    for (const key of keys) {
      const value = scalar(container[key]);
      if (value) return value;
    }
  }
  return '';
}

function conversationSeed(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.messages)) {
    const system = body.messages.find(
      (message) =>
        message && (message.role === 'system' || message.role === 'developer'),
    );
    const firstUser = body.messages.find(
      (message) => message && message.role === 'user',
    );
    return [contentText(system?.content), contentText(firstUser?.content)]
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(body.input)) {
    const firstInput = body.input.find(
      (item) => item && typeof item === 'object',
    );
    return contentText(firstInput?.content || firstInput?.input);
  }
  return contentText(body.input || body.prompt);
}

function deriveSessionId(req, body) {
  const headerNames = [
    'x-opencode-session',
    'x-session-id',
    'session-id',
    'x-conversation-id',
    'conversation-id',
    'x-chat-session-id',
    'x-thread-id',
  ];
  for (const name of headerNames) {
    const value = scalar(req.headers[name]);
    if (value) return `client-${sha256(value).slice(0, 32)}`;
  }
  const bodySession = explicitSessionFromBody(body);
  if (bodySession) return `body-${sha256(bodySession).slice(0, 32)}`;
  const credential =
    req.headers.authorization || req.headers['x-api-key'] || 'anonymous';
  const authFingerprint = sha256(credential).slice(0, 16);
  const model = normalizeModel(body?.model) || 'unknown-model';
  const seed = conversationSeed(body) || 'no-conversation-seed';
  return `derived-${sha256(`${authFingerprint}|${model}|${seed}`).slice(0, 32)}`;
}

function localHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  };
}

function jsonResponse(res, statusCode, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(
    statusCode,
    localHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': data.length,
    }),
  );
  res.end(data);
}

function bearerToken(value) {
  const match = scalar(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function filteredRequestHeaders(
  req,
  bodyLength,
  sessionId,
  mode,
  apiKey,
) {
  // `mode` is one of 'chat' (verbatim), 'anthropic' (Messages) or
  // 'responses'. The two converted modes need an unencoded body so the SSE
  // translator can parse it incrementally.
  const convertToMessages = mode === 'anthropic';
  const converted = mode === 'anthropic' || mode === 'responses' || mode === 'google';
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'user-agent' ||
      lower === 'x-opencode-session' ||
      lower === 'origin' ||
      lower === 'referer' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower.startsWith('sec-fetch-') ||
      (converted && lower === 'accept-encoding')
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers.host = UPSTREAM_ORIGIN.host;
  headers['content-length'] = String(bodyLength);
  headers['user-agent'] = USER_AGENT;
  headers['x-opencode-session'] = sessionId;
  const key = scalar(apiKey).trim() || scalar(process.env.GO_KEY).trim();
  if (convertToMessages) {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  if (converted) headers['accept-encoding'] = 'identity';
  return headers;
}

/** Does this upstream rejection mean "try another account"? */
function classifyRejection(status, text) {
  if (status === 401 || status === 403) return 'credential';
  if (status === 402 || status === 429) return 'quota';
  if (status === 400 || status === 404) {
    const lower = String(text || '').toLowerCase();
    if (/(quota|usage limit|credit|rate.?limit|insufficient)/.test(lower)) return 'quota';
    if (/(invalid credential|unauthorized|invalid api key)/.test(lower)) return 'credential';
  }
  return 'other';
}

function readRejection(upstreamRes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    upstreamRes.on('data', (c) => {
      size += c.length;
      if (size <= 64 * 1024) chunks.push(c);
    });
    upstreamRes.on('end', () => resolve(Buffer.concat(chunks)));
    upstreamRes.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/** Open an HTTP CONNECT tunnel and wrap it in TLS. */
function openTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15000, () => fail(new Error('proxy_timeout')));
    socket.once('error', fail);
    socket.once('connect', () => {
      const auth = proxy.auth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`,
      );
    });
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16384) fail(new Error('proxy_bad_response'));
        return;
      }
      socket.removeListener('data', onData);
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const status = Number((statusLine.match(/\s(\d{3})\b/) || [])[1]);
      if (status !== 200) {
        fail(new Error(`proxy_connect_${status || 'failed'}`));
        return;
      }
      settled = true;
      socket.setTimeout(0);
      const secure = tls.connect({ socket, servername: host });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', (error) => {
        if (!secure.destroyed) secure.destroy();
        reject(error);
      });
    };
    socket.on('data', onData);
  });
}

async function attemptUpstream(headers, forwardedPath, search, body, useProxy) {
  let tunnel = null;
  const proxy = useProxy ? proxyConfig().endpoint : null;
  if (proxy && UPSTREAM_ORIGIN.protocol === 'https:') {
    try {
      tunnel = await openTunnel(
        proxy,
        UPSTREAM_ORIGIN.hostname,
        Number(UPSTREAM_ORIGIN.port) || 443,
      );
    } catch (error) {
      return { kind: 'error', error };
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const options = {
      protocol: UPSTREAM_ORIGIN.protocol,
      hostname: UPSTREAM_ORIGIN.hostname,
      port: UPSTREAM_ORIGIN.port || (UPSTREAM_ORIGIN.protocol === 'https:' ? 443 : 80),
      method: 'POST',
      path: `${forwardedPath}${search}`,
      headers,
    };
    if (tunnel) {
      // `agent: false` ignores `createConnection`; only an explicit Agent that
      // overrides createConnection actually reuses the tunnel socket.
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tunnel;
      options.agent = agent;
    }
    const upstreamReq = UPSTREAM_CLIENT.request(options, (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        if (status >= 200 && status < 300) {
          finish({ kind: 'ok', upstreamRes, req: upstreamReq });
          return;
        }
        readRejection(upstreamRes).then((buf) => finish({
          kind: 'reject',
          status,
          statusMessage: upstreamRes.statusMessage,
          headers: upstreamRes.headers,
          body: buf,
        }));
    });
    upstreamReq.setTimeout(10 * 60 * 1000, () => {
      upstreamReq.destroy(new Error('upstream_timeout'));
    });
    upstreamReq.on('error', (error) => {
      if (tunnel && !tunnel.destroyed) tunnel.destroy();
      finish({ kind: 'error', error, req: upstreamReq });
    });
    upstreamReq.on('close', () => {
      if (tunnel && !tunnel.destroyed && upstreamReq.destroyed) tunnel.destroy();
    });
    upstreamReq.end(body);
  });
}

function recordUsage(entry) {
  try {
    const history = path.join(PACKAGE_ROOT, 'usage-history.jsonl');
    // Cap the live file at 8 MB; the dashboard reads 16 MB of tail, so one
    // rotation never hides anything it would have shown.
    rotateIfBigger(history, 8 * 1024 * 1024, `${history}.1`);
    fs.appendFileSync(
      history,
      JSON.stringify(entry) + '\n',
      'utf8',
    );
  } catch {
    // Usage accounting must never break a request.
  }
}

/**
 * Normalize any provider's usage block to
 * `{ prompt, completion, cached, cacheWrite }`.
 *
 * - OpenAI chat:      prompt_tokens / completion_tokens (+ prompt_tokens_details.cached_tokens)
 * - OpenAI responses: input_tokens / output_tokens  (+ input_tokens_details.cached_tokens, input includes cache)
 * - Anthropic:        input_tokens / output_tokens  (+ cache_read_input_tokens / cache_creation_input_tokens,
 *                      where input_tokens EXCLUDES the cached parts)
 * - Google:           promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount, cachedContentTokenCount)
 */
function filteredResponseHeaders(upstreamHeaders) {
  const headers = localHeaders();
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lower) &&
      lower !== 'access-control-allow-origin'
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

function readUpstreamJson(upstreamRes, callback) {
  const chunks = [];
  let size = 0;
  let ended = false;
  upstreamRes.on('data', (chunk) => {
    if (ended) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      ended = true;
      callback(new Error('response_too_large'));
      upstreamRes.destroy();
      return;
    }
    chunks.push(chunk);
  });
  upstreamRes.on('end', () => {
    if (ended) return;
    ended = true;
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      callback(new Error('invalid_json'));
    }
  });
  upstreamRes.on('error', (error) => {
    if (ended) return;
    ended = true;
    callback(error);
  });
}

function handleConvertedMessagesResponse(upstreamRes, res, model, streamRequested, onUsage) {
  const statusCode = upstreamRes.statusCode || 502;
  if (statusCode < 200 || statusCode >= 300) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (res.writableEnded) return;
      jsonResponse(
        res,
        statusCode,
        convertAnthropicErrorToOpenAI(error ? null : payload, statusCode),
      );
    });
    return;
  }
  if (!streamRequested) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (error) {
        if (res.writableEnded) return;
        jsonResponse(res, 502, {
          error: {
            message: 'OpenCode Go returned an invalid Messages response.',
            type: 'upstream_protocol_error',
            param: null,
            code: '502',
          },
        });
        return;
      }
      if (onUsage) onUsage(usageFromPayload(payload));
      if (res.writableEnded) return;
      jsonResponse(res, statusCode, convertAnthropicResponseToOpenAI(payload, model));
    });
    return;
  }
  res.writeHead(
    statusCode,
    localHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }),
  );
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const translator = new AnthropicSseToOpenAI(model);
  const tail = tailCollector();
  upstreamRes.on('data', (chunk) => {
    tail.push(chunk);
    if (res.writableEnded) return;
    const output = translator.push(chunk);
    if (output) res.write(output);
  });
  upstreamRes.on('end', () => {
    if (onUsage) onUsage(tail.usage());
    if (res.writableEnded) return;
    const output = translator.end();
    if (output) res.write(output);
    res.end();
  });
  upstreamRes.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
}

function handleConvertedResponsesResponse(upstreamRes, res, model, streamRequested, onUsage) {
  const statusCode = upstreamRes.statusCode || 502;
  if (statusCode < 200 || statusCode >= 300) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (res.writableEnded) return;
      jsonResponse(
        res,
        statusCode,
        convertResponsesErrorToOpenAI(error ? null : payload, statusCode),
      );
    });
    return;
  }
  if (!streamRequested) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (error) {
        if (res.writableEnded) return;
        jsonResponse(res, 502, {
          error: {
            message: 'OpenCode Go returned an invalid Responses payload.',
            type: 'upstream_protocol_error',
            param: null,
            code: '502',
          },
        });
        return;
      }
      if (onUsage) onUsage(usageFromPayload(payload));
      if (res.writableEnded) return;
      jsonResponse(res, statusCode, convertResponsesResponseToOpenAI(payload, model));
    });
    return;
  }
  res.writeHead(
    statusCode,
    localHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }),
  );
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const translator = new ResponsesSseToOpenAI(model);
  const tail = tailCollector();
  upstreamRes.on('data', (chunk) => {
    tail.push(chunk);
    if (res.writableEnded) return;
    const output = translator.push(chunk);
    if (output) res.write(output);
  });
  upstreamRes.on('end', () => {
    if (onUsage) onUsage(tail.usage());
    if (res.writableEnded) return;
    const output = translator.end();
    if (output) res.write(output);
    res.end();
  });
  upstreamRes.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
}

function handleConvertedGoogleResponse(upstreamRes, res, model, streamRequested, onUsage) {
  const statusCode = upstreamRes.statusCode || 502;
  if (statusCode < 200 || statusCode >= 300) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (res.writableEnded) return;
      jsonResponse(
        res,
        statusCode,
        convertGoogleErrorToOpenAI(error ? null : payload, statusCode),
      );
    });
    return;
  }
  if (!streamRequested) {
    readUpstreamJson(upstreamRes, (error, payload) => {
      if (error) {
        if (res.writableEnded) return;
        jsonResponse(res, 502, {
          error: {
            message: 'OpenCode Go returned an invalid Google response.',
            type: 'upstream_protocol_error',
            param: null,
            code: '502',
          },
        });
        return;
      }
      if (onUsage) onUsage(usageFromPayload(payload));
      if (res.writableEnded) return;
      jsonResponse(res, statusCode, convertGoogleResponseToOpenAI(payload, model));
    });
    return;
  }
  res.writeHead(
    statusCode,
    localHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }),
  );
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const translator = new GoogleSseToOpenAI(model);
  const tail = tailCollector();
  upstreamRes.on('data', (chunk) => {
    tail.push(chunk);
    if (res.writableEnded) return;
    const output = translator.push(chunk);
    if (output) res.write(output);
  });
  upstreamRes.on('end', () => {
    if (onUsage) onUsage(tail.usage());
    if (res.writableEnded) return;
    const output = translator.end();
    if (output) res.write(output);
    res.end();
  });
  upstreamRes.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
}

/** Should this rejection be retried through the local proxy? */
function needsProxyRetry(outcome) {
  const cfg = proxyConfig();
  if (!cfg.enabled || !cfg.fallback) return false;
  if (!outcome || outcome.kind !== 'reject') return false;
  if (outcome.status !== 403 && outcome.status !== 400) return false;
  return /unsupported_country_region_territory|unsupported_country/i.test(
    outcome.body.toString('utf8'),
  );
}

// Sampling knobs that reasoning-only models reject outright. WorkBuddy sends
// `temperature` by default, so the bridge retries once without the offending
// field instead of failing the whole turn.
const STRIPPABLE_PARAMETERS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'seed',
  // Injected by the bridge to get a usage block on streams; drop it if an
  // upstream does not accept it instead of failing the request.
  'stream_options',
]);

function stripParamsFromBody(bodyBuffer, names) {
  if (!names || !names.size) return bodyBuffer;
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    const targets = [parsed];
    if (parsed.generationConfig && typeof parsed.generationConfig === 'object') {
      targets.push(parsed.generationConfig);
    }
    let changed = false;
    for (const target of targets) {
      for (const name of names) {
        for (const alias of name === 'top_p' ? ['top_p', 'topP'] : [name]) {
          if (Object.prototype.hasOwnProperty.call(target, alias)) {
            delete target[alias];
            changed = true;
          }
        }
      }
    }
    return changed ? Buffer.from(JSON.stringify(parsed)) : bodyBuffer;
  } catch {
    return bodyBuffer;
  }
}

function stripUnsupportedParameter(outcome, bodyBuffer) {
  if (!outcome || outcome.kind !== 'reject' || outcome.status !== 400) return null;
  const match = outcome.body
    .toString('utf8')
    .match(/unsupported parameter:\s*['"]([a-z_]+)['"]/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!STRIPPABLE_PARAMETERS.has(name)) return null;
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    const candidates = [parsed];
    if (parsed.generationConfig && typeof parsed.generationConfig === 'object') {
      candidates.push(parsed.generationConfig);
    }
    const aliases = name === 'top_p' ? ['top_p', 'topP'] : [name];
    for (const target of candidates) {
      for (const alias of aliases) {
        if (Object.prototype.hasOwnProperty.call(target, alias)) {
          delete target[alias];
          return { name, body: Buffer.from(JSON.stringify(parsed)) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function supportedModelResponse() {
  return {
    object: 'list',
    data: advertisedModels().map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'opencode-go',
    })),
  };
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url || '/',
    `http://${LISTEN_HOST}:${LISTEN_PORT}`,
  );

  if (requestUrl.pathname === '/shutdown') {
    if (req.method !== 'POST') {
      jsonResponse(res, 405, {
        error: {
          message: 'This endpoint requires POST.',
          type: 'invalid_request_error',
          param: null,
          code: 'method_not_allowed',
        },
      });
      return;
    }
    const providedToken = scalar(req.headers['x-bridge-shutdown-token']);
    const expected = Buffer.from(shutdownToken);
    const provided = Buffer.from(providedToken);
    const authorized =
      expected.length > 0 &&
      expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided);
    if (!authorized) {
      jsonResponse(res, 403, {
        error: {
          message: 'Local shutdown authorization failed.',
          type: 'authentication_error',
          param: null,
          code: 'shutdown_not_authorized',
        },
      });
      return;
    }
    jsonResponse(res, 202, { ok: true, stopping: true });
    setImmediate(() => stop(0));
    return;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/health') {
    jsonResponse(res, 200, {
      ok: true,
      service: 'opencode-go-bridge',
      version: APP_VERSION,
      listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
      uptimeSeconds: Math.floor(process.uptime()),
      supportedModels: advertisedModels().length,
      catalogLoaded: catalogProtocols().size > 0,
      geoProxy: proxyConfig().endpoint
        ? `${proxyConfig().endpoint.host}:${proxyConfig().endpoint.port}`
        : null,
      proxy: (() => {
        const cfg = proxyConfig();
        return {
          enabled: cfg.enabled,
          url: cfg.url || null,
          fallback: cfg.fallback,
          forced: [...cfg.models],
          autoPromoted: [...geoProxyModels],
        };
      })(),
      accounts: (() => {
        const store = accounts.read();
        const active = store.accounts.find((a) => a.ref === store.activeRef);
        return {
          total: store.accounts.length,
          active: active ? active.name : null,
          autoSwitch: store.autoSwitch,
        };
      })(),
      stats,
    });
    return;
  }

  if (
    req.method === 'GET' &&
    ['/v1/models', '/models'].includes(requestUrl.pathname)
  ) {
    jsonResponse(res, 200, supportedModelResponse());
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(
      204,
      localHeaders({
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers':
          'authorization,content-type,x-api-key,anthropic-version',
        'access-control-max-age': '600',
      }),
    );
    res.end();
    return;
  }

  const upstreamPath = ROUTES.get(requestUrl.pathname);
  if (!upstreamPath) {
    jsonResponse(res, 404, {
      error: {
        message: 'Unsupported local path.',
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported_path',
      },
    });
    return;
  }
  if (req.method !== 'POST') {
    jsonResponse(res, 405, {
      error: {
        message: 'This endpoint requires POST.',
        type: 'invalid_request_error',
        param: null,
        code: 'method_not_allowed',
      },
    });
    return;
  }

  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on('data', (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      rejected = true;
      jsonResponse(res, 413, {
        error: {
          message: 'Request body is too large.',
          type: 'invalid_request_error',
          param: null,
          code: 'request_too_large',
        },
      });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected) return;
    const bodyBuffer = Buffer.concat(chunks);
    let parsedBody;
    try {
      parsedBody = bodyBuffer.length
        ? JSON.parse(bodyBuffer.toString('utf8'))
        : {};
    } catch {
      jsonResponse(res, 400, {
        error: {
          message: 'Request body must be valid JSON.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_json',
        },
      });
      return;
    }

    const isChatRoute = ['/v1/chat/completions', '/chat/completions'].includes(
      requestUrl.pathname,
    );
    const model = normalizeModel(parsedBody?.model);
    const protocol = model ? protocolFor(model) : undefined;
    if (isChatRoute && model && protocol === undefined) {
      jsonResponse(res, 400, {
        error: {
          message: `Model '${model}' is not in the OpenCode Go catalog. Run catalog.py --refresh, or check the id.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'unsupported_model',
        },
        supported_models: advertisedModels(),
      });
      return;
    }

    const streamRequested = parsedBody?.stream === true;
    const convertToMessages = isChatRoute && protocol === 'anthropic';
    const convertToResponses = isChatRoute && protocol === 'responses';
    const convertToGoogle = isChatRoute && protocol === 'google';
    const headerMode = convertToMessages
      ? 'anthropic'
      : convertToResponses
        ? 'responses'
        : convertToGoogle
          ? 'google'
          : 'chat';
    let forwardedBody = bodyBuffer;
    let forwardedPath = upstreamPath;
    let forwardedSearch = requestUrl.search;
    if (convertToMessages) {
      forwardedBody = Buffer.from(
        JSON.stringify(convertOpenAIChatToAnthropic(parsedBody)),
      );
      forwardedPath = ANTHROPIC_UPSTREAM_PATH;
      stats.convertedMessagesRequests += 1;
    } else if (convertToResponses) {
      forwardedBody = Buffer.from(
        JSON.stringify(convertOpenAIChatToResponses(parsedBody)),
      );
      forwardedPath = RESPONSES_UPSTREAM_PATH;
      stats.convertedResponsesRequests += 1;
    } else if (convertToGoogle) {
      forwardedBody = Buffer.from(
        JSON.stringify(convertOpenAIChatToGoogle(parsedBody)),
      );
      const verb = streamRequested ? 'streamGenerateContent' : 'generateContent';
      forwardedPath = `${GOOGLE_UPSTREAM_BASE}/${encodeURIComponent(model)}:${verb}`;
      forwardedSearch = streamRequested ? '?alt=sse' : '';
      stats.convertedGoogleRequests += 1;
    } else if (isChatRoute && streamRequested && parsedBody && typeof parsedBody === 'object') {
      // Ask the upstream to append a usage chunk at the end of the stream;
      // without it a streaming request has no token counts to report.
      forwardedBody = Buffer.from(
        JSON.stringify({
          ...parsedBody,
          stream_options: {
            ...(parsedBody.stream_options && typeof parsedBody.stream_options === 'object'
              ? parsedBody.stream_options
              : {}),
            include_usage: true,
          },
        }),
      );
    }
    const sessionId = deriveSessionId(req, parsedBody);
    const clientKey =
      bearerToken(req.headers.authorization) || scalar(req.headers['x-api-key']);
    const candidates = accounts.candidateKeys(clientKey);
    const attempts = candidates.length ? candidates : [{ ref: null, key: '' }];
    stats.proxiedRequests += 1;

    const finishSuccess = (upstreamRes, cand, switched) => {
      if (cand.ref) accounts.markResult(cand.ref, 'ok');
      if (switched) stats.accountSwitches += 1;
      const record = (stream, usage) => recordUsage({
        at: Date.now(), model, protocol, account: cand.ref, switched, stream,
        ...(usage ? { usage } : {}),
      });
      if (convertToMessages) {
        handleConvertedMessagesResponse(upstreamRes, res, model, streamRequested, (usage) =>
          record(streamRequested, usage));
        return;
      }
      if (convertToResponses) {
        handleConvertedResponsesResponse(upstreamRes, res, model, streamRequested, (usage) =>
          record(streamRequested, usage));
        return;
      }
      if (convertToGoogle) {
        handleConvertedGoogleResponse(upstreamRes, res, model, streamRequested, (usage) =>
          record(streamRequested, usage));
        return;
      }
      if (streamRequested) {
        res.writeHead(
          upstreamRes.statusCode || 502,
          upstreamRes.statusMessage,
          filteredResponseHeaders(upstreamRes.headers),
        );
        // Tee the SSE so the trailing usage chunk can be read without buffering
        // the whole response or delaying the client.
        const tail = tailCollector();
        upstreamRes.on('data', (chunk) => {
          tail.push(chunk);
          if (!res.writableEnded) res.write(chunk);
        });
        upstreamRes.on('end', () => {
          record(true, tail.usage());
          if (!res.writableEnded) res.end();
        });
        upstreamRes.on('error', () => { if (!res.writableEnded) res.destroy(); });
        return;
      }
      const chunks = [];
      let bytes = 0;
      upstreamRes.on('data', (c) => {
        bytes += c.length;
        if (bytes <= 8 * 1024 * 1024) chunks.push(c);
      });
      upstreamRes.on('end', () => {
        const buf = Buffer.concat(chunks);
        recordUsage({
          at: Date.now(), model, protocol, account: cand.ref, switched, stream: false,
          usage: usageFromJson(buf.toString('utf8')),
        });
        if (res.writableEnded) return;
        res.writeHead(
          upstreamRes.statusCode || 502,
          upstreamRes.statusMessage,
          filteredResponseHeaders(upstreamRes.headers),
        );
        res.end(buf);
      });
      upstreamRes.on('error', () => { if (!res.writableEnded) res.destroy(); });
    };

    (async () => {
      const cfg = proxyConfig();
      const proxyKey = normalizeModel(model || '');
      // Models the user pinned to the proxy always take it; models that already
      // hit a geo wall are remembered individually.
      const proxyFirst =
        cfg.enabled && (cfg.models.has(proxyKey) || geoProxyModels.has(proxyKey));
      let last = null;
      let switched = false;
      for (const cand of attempts) {
        if (res.writableEnded || res.destroyed) return;
        const knownBlocked = model ? blockedSamplingParams.get(model) : null;
        let attemptBody = knownBlocked
          ? stripParamsFromBody(forwardedBody, knownBlocked)
          : forwardedBody;
        let outcome = null;
        for (let round = 0; round < 3; round += 1) {
          const headers = filteredRequestHeaders(
            req, attemptBody.length, sessionId, headerMode, cand.key,
          );
          outcome = await attemptUpstream(
            headers, forwardedPath, forwardedSearch, attemptBody, proxyFirst,
          );
          if (!proxyFirst && needsProxyRetry(outcome)) {
            diagnostic('geo_retry_via_proxy', cand.ref || 'client-key');
            const retried = await attemptUpstream(
              headers, forwardedPath, forwardedSearch, attemptBody, true,
            );
            // A dead proxy must not hide the real upstream answer.
            if (retried.kind !== 'error') {
              outcome = retried;
              geoProxyModels.add(proxyKey);
            } else {
              diagnostic('proxy_retry_failed', retried.error?.message);
            }
          }
          const stripped = stripUnsupportedParameter(outcome, attemptBody);
          if (!stripped) break;
          if (model) {
            if (!blockedSamplingParams.has(model)) blockedSamplingParams.set(model, new Set());
            blockedSamplingParams.get(model).add(stripped.name);
          }
          attemptBody = stripped.body;
          diagnostic('retry_without_parameter', stripped.name);
        }
        if (!outcome) continue;

        if (outcome.kind === 'ok') {
          finishSuccess(outcome.upstreamRes, cand, switched);
          return;
        }
        if (outcome.kind === 'error') {
          stats.upstreamFailures += 1;
          const reason = outcome.error?.code || outcome.error?.message || 'unknown';
          diagnostic('upstream_failure', reason);
          if (!res.headersSent) {
            // A model pinned to the proxy must not silently fall back to a
            // direct request — surface the proxy failure instead.
            const pinned = proxyFirst && cfg.endpoint;
            jsonResponse(res, 502, {
              error: {
                message: pinned
                  ? `Model '${model}' is pinned to the proxy ${cfg.endpoint.host}:${cfg.endpoint.port}, but the proxy connection failed (${reason}).`
                  : 'OpenCode Go upstream request failed.',
                type: 'upstream_error',
                param: null,
                code: pinned ? 'proxy_unavailable' : 'upstream_unavailable',
              },
            });
          } else {
            res.destroy();
          }
          return;
        }

        const text = outcome.body.toString('utf8');
        const reason = classifyRejection(outcome.status, text);
        if (cand.ref) accounts.markResult(cand.ref, reason);
        diagnostic('upstream_reject', `${outcome.status}/${reason}/${cand.ref || 'client-key'}`);
        last = { outcome, cand };
        if (reason === 'other') break;
        switched = true;
      }

      if (res.writableEnded) return;
      if (!last) {
        jsonResponse(res, 502, {
          error: { message: 'No usable OpenCode Go credential.', type: 'upstream_error', code: 'no_credential' },
        });
        return;
      }
      const responseHeaders = filteredResponseHeaders(last.outcome.headers);
      let errorBody = last.outcome.body;
      if (convertToGoogle || convertToResponses || convertToMessages) {
        try {
          const payload = JSON.parse(errorBody.toString('utf8'));
          const wrapped = convertToGoogle
            ? convertGoogleErrorToOpenAI(payload, last.outcome.status)
            : convertToResponses
              ? convertResponsesErrorToOpenAI(payload, last.outcome.status)
              : convertAnthropicErrorToOpenAI(payload, last.outcome.status);
          errorBody = Buffer.from(JSON.stringify(wrapped));
          delete responseHeaders['content-length'];
          responseHeaders['content-type'] = 'application/json; charset=utf-8';
        } catch {
          // Not JSON: forward the upstream body untouched.
        }
      }
      res.writeHead(
        last.outcome.status,
        last.outcome.statusMessage,
        responseHeaders,
      );
      res.end(errorBody);
    })().catch((error) => {
      stats.upstreamFailures += 1;
      diagnostic('dispatch_failure', error?.code || error?.message);
      if (!res.headersSent) {
        jsonResponse(res, 502, {
          error: { message: 'Bridge dispatch failed.', type: 'upstream_error', code: 'dispatch_failed' },
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });

  req.on('error', () => {
    if (!res.headersSent) {
      jsonResponse(res, 400, {
        error: {
          message: 'Invalid local request.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request',
        },
      });
    }
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    removeRuntimeState();
    process.exit(exitCode);
  });
  setTimeout(() => {
    removeRuntimeState();
    process.exit(exitCode);
  }, 3000).unref();
}

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    diagnostic('port_in_use', String(LISTEN_PORT));
    removeRuntimeState();
    process.exit(73);
  }
  diagnostic('startup_failure', error?.code || error?.name);
  removeRuntimeState();
  process.exit(1);
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('uncaughtException', (error) => {
  diagnostic('uncaught_exception', error?.code || error?.name);
  stop(1);
});
process.on('unhandledRejection', (error) => {
  diagnostic('unhandled_rejection', error?.code || error?.name);
  stop(1);
});
process.on('exit', removeRuntimeState);

writePid();
writeShutdownToken();
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  diagnostic('started', APP_VERSION);
  if (process.stdout.isTTY) {
    process.stdout.write(
      `OpenCode Go Bridge for WorkBuddy ${APP_VERSION} listening on ${LISTEN_HOST}:${LISTEN_PORT}\n`,
    );
  }
});
