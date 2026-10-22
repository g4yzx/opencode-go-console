#!/usr/bin/env node
/**
 * opencode Go 本地控制台
 *
 *   GET  /                 单页 UI
 *   GET  /api/status       桥接 / 密钥 / 目录状态
 *   GET  /api/catalog      模型目录（?refresh=1 强制重拉）
 *   GET  /api/usage        订阅用量
 *   GET  /api/official/usage  官网控制台的官方用量（?range=24h|7d|30d|all&refresh=1）
 *   POST /api/test-model   经桥接发一个 16 token 的探针，返回状态/延迟/错误原文
 *   POST /api/key          保存密钥到 go_key.txt
 *   POST /api/install      写入 ~/.workbuddy/models.json
 *   POST /api/config       修改桥接端口（写 bridge-config.json）
 *   POST /api/bridge       启动 / 停止桥接进程
 *   POST /api/shutdown     停止桥接并退出控制台（托盘启动器用）
 *
 * 只监听 127.0.0.1，零 npm 依赖。
 */
'use strict'

const http = require('node:http')
const net = require('node:net')
const tls = require('node:tls')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const accounts = require('./accounts')
const officialUsage = require('./src/official-usage')
const { writeFileAtomic, readTailText } = require('./src/file-util')

const PACKAGE_ROOT = __dirname
const UI_FILE = path.join(__dirname, 'ui', 'index.html')
const CATALOG_PATH = path.join(PACKAGE_ROOT, 'models-catalog.json')
// Local edits: `overrides` patches catalog rows, `custom` holds hand-added
// models that the gateway catalogue does not list at all.
const CUSTOM_PATH = path.join(PACKAGE_ROOT, 'custom-models.json')
const PROXY_PATH = path.join(PACKAGE_ROOT, 'proxy-config.json')
const LEGACY_PROXY_TXT = path.join(PACKAGE_ROOT, 'proxy.txt')
const KEY_FILE = path.join(PACKAGE_ROOT, 'go_key.txt')
const MODELS_JSON = process.env.WORKBUDDY_MODELS_JSON || path.join(os.homedir(), '.workbuddy', 'models.json')
const STATE_DIR = path.join(PACKAGE_ROOT, '.state')
const UI_PID = path.join(STATE_DIR, 'ui-bridge.pid')

const UI_PORT = Number(process.env.OPENCODE_GO_UI_PORT || 8790)
const DEFAULT_BRIDGE_PORT = (() => {
  const n = Number(process.env.OPENCODE_GO_BRIDGE_PORT || 8788)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 8788
})()
const CONFIG_PATH = path.join(PACKAGE_ROOT, 'bridge-config.json')
const GATEWAY = (process.env.OPENCODE_GO_GATEWAY || 'https://opencode.ai/inference/go').replace(/\/+$/, '')
const MODELS_URL = GATEWAY + '/v1/models'
const USAGE_URL = GATEWAY + '/v1/usage'
const METADATA_URL = 'https://models.dev/api.json'
const CATALOG_TTL_MS = 6 * 3600 * 1000
const MAX_OUTPUT_CAP = 65536
const NAME_SUFFIX = ' (opencode Go)'
const NPM_TO_PROTOCOL = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/openai-compatible': 'chat',
  '@ai-sdk/google': 'google',
}
const USABLE = new Set(['chat', 'anthropic', 'responses', 'google'])

// ---------------------------------------------------------------- helpers

function readKey () {
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim() } catch { return '' }
}

/** Saved bridge port; falls back to the env var or 8788. */
function bridgePort () {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const port = Number(raw && raw.bridgePort)
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port
  } catch {}
  return DEFAULT_BRIDGE_PORT
}

function writeBridgePort (port) {
  writeFileAtomic(CONFIG_PATH, JSON.stringify({ bridgePort: port }, null, 2) + '\n', 'utf8')
}

/**
 * Proxy settings. `models` is the per-model allow list: only those ids are
 * forced through the proxy, everything else stays direct.
 */
function readProxyConfig () {
  let file = {}
  try { file = JSON.parse(fs.readFileSync(PROXY_PATH, 'utf8')) } catch {}
  let legacy = ''
  try {
    legacy = fs.readFileSync(LEGACY_PROXY_TXT, 'utf8')
      .split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#')) || ''
  } catch {}
  const url = typeof file.url === 'string' ? file.url.trim() : legacy
  const models = Array.isArray(file.models)
    ? [...new Set(file.models.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))]
    : []
  return {
    enabled: typeof file.enabled === 'boolean' ? file.enabled : Boolean(url),
    url,
    fallback: typeof file.fallback === 'boolean' ? file.fallback : true,
    models,
  }
}

function writeProxyConfig (state) {
  writeFileAtomic(PROXY_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/** Normalize `host:port`, `http://host:port`, `user:pass@host:port`. */
function normalizeProxyUrl (raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let parsed
  try { parsed = new URL(withScheme) } catch { throw new Error('代理地址格式不对，示例 http://127.0.0.1:7897') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http:// 或 https:// 代理')
  }
  if (!parsed.hostname) throw new Error('代理地址缺少主机名')
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口不合法')
  return parsed.toString().replace(/\/$/, '')
}

function testProxyPort (url) {
  return new Promise((resolve) => {
    let target
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`)
      target = {
        host: parsed.hostname,
        port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      }
    } catch {
      resolve({ ok: false, message: '地址解析失败' })
      return
    }
    const started = Date.now()
    let settled = false
    const socket = net.connect({ host: target.host, port: target.port })
    const finish = (ok, message) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, message, ms: Date.now() - started })
    }
    socket.setTimeout(3000, () => finish(false, `连接 ${target.host}:${target.port} 超时`))
    socket.once('connect', () => finish(true, `代理 ${target.host}:${target.port} 可连接`))
    socket.once('error', (e) => finish(false, `连接 ${target.host}:${target.port} 失败：${e.message}`))
  })
}

/**
 * Plain-HTTP tunnelling agent: CONNECT through the local proxy, then speak
 * cleartext HTTP to the target. Used to ask an IP echo service what country the
 * proxy actually exits from — "proxy enabled" and "proxy is in the US" are two
 * different things.
 */
class ProxyTunnel extends http.Agent {
  constructor (proxy) {
    super({ keepAlive: false, maxSockets: 1 })
    this.proxy = proxy
  }

  createConnection (options, cb) {
    const p = this.proxy
    const headers = {}
    if (p.username) {
      const user = decodeURIComponent(p.username)
      const pass = decodeURIComponent(p.password || '')
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 8080,
      method: 'CONNECT',
      path: `${options.host}:${options.port || 80}`,
      headers,
      timeout: 8000,
    })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        cb(new Error(`代理 CONNECT ${res.statusCode}`))
        return
      }
      socket.setTimeout(0)
      cb(null, socket)
    })
    req.once('timeout', () => { req.destroy(); cb(new Error('连接代理超时')) })
    req.once('error', cb)
    req.end()
  }
}

/** Exit IP + country as seen through the proxy (ip-api.com, cleartext on purpose). */
function proxyExitInfo (url) {
  return new Promise((resolve) => {
    let proxy
    try {
      proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`)
    } catch {
      resolve({ ok: false, error: '代理地址解析失败' })
      return
    }
    const started = Date.now()
    const agent = new ProxyTunnel(proxy)
    const req = http.get({
      host: 'ip-api.com',
      port: 80,
      path: '/json/?fields=status,message,country,countryCode,query',
      agent,
      headers: { accept: 'application/json' },
    }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          if (j.status === 'success') {
            resolve({ ok: true, ip: j.query, country: j.country, code: j.countryCode, ms: Date.now() - started })
          } else {
            resolve({ ok: false, error: j.message || '出口查询失败', ms: Date.now() - started })
          }
        } catch {
          resolve({ ok: false, error: '出口查询返回异常', ms: Date.now() - started })
        }
      })
    })
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: '出口查询超时' }) })
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }))
  })
}

async function apiProxy (body) {
  const action = String((body && body.action) || 'read')
  const current = readProxyConfig()

  if (action === 'read') {
    return { ok: true, ...current, reachable: current.url ? await testProxyPort(current.url) : null }
  }
  if (action === 'test') {
    const url = normalizeProxyUrl(body.url || current.url)
    if (!url) return { ok: false, message: '还没填代理地址' }
    const result = await testProxyPort(url)
    // The port being open says nothing about where the traffic exits.
    const exit = result.ok ? await proxyExitInfo(url) : null
    return { ok: true, result: { ...result, exit, url } }
  }
  if (action === 'save') {
    const url = normalizeProxyUrl(body.url)
    const enabled = body.enabled !== false
    if (enabled && !url) throw new Error('启用代理前先填地址')
    const state = {
      enabled,
      url,
      fallback: body.fallback !== false,
      models: current.models,
    }
    writeProxyConfig(state)
    return { ok: true, ...state }
  }
  if (action === 'toggleModel') {
    const id = String(body.id || '').trim()
    if (!id) throw new Error('缺少模型 id')
    const models = new Set(current.models)
    if (body.on === true) models.add(id)
    else models.delete(id)
    const state = { ...current, models: [...models].sort() }
    writeProxyConfig(state)
    return { ok: true, ...state }
  }
  if (action === 'clearModels') {
    const state = { ...current, models: [] }
    writeProxyConfig(state)
    return { ok: true, ...state }
  }
  throw new Error('未知代理操作: ' + action)
}

function writeKey (key) {
  writeFileAtomic(KEY_FILE, key.trim() + '\n', { encoding: 'utf8', mode: 0o600 })
}

function readCatalog () {
  try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) } catch { return null }
}

const PROTOCOLS = new Set(['chat', 'anthropic', 'responses', 'google'])

function readCustom () {
  try {
    const raw = JSON.parse(fs.readFileSync(CUSTOM_PATH, 'utf8'))
    const overrides = raw && typeof raw.overrides === 'object' && raw.overrides ? raw.overrides : {}
    const custom = raw && Array.isArray(raw.custom)
      ? raw.custom.filter(m => m && typeof m.id === 'string' && m.id.trim())
      : []
    return { version: 1, overrides, custom }
  } catch {
    return { version: 1, overrides: {}, custom: [] }
  }
}

function writeCustom (state) {
  writeFileAtomic(CUSTOM_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/** Sanitize the editable surface shared by overrides and hand-added models. */
function normalizeModelFields (input, base) {
  const src = input && typeof input === 'object' ? input : {}
  const positive = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
  }
  const efforts = Array.isArray(src.reasoningEfforts)
    ? EFFORT_ORDER.filter(e => src.reasoningEfforts.includes(e))
    : (base && Array.isArray(base.reasoningEfforts) ? base.reasoningEfforts : [])
  const defaultEffort = efforts.includes(String(src.defaultEffort || ''))
    ? String(src.defaultEffort)
    : efforts.includes('medium') ? 'medium' : efforts.includes('high') ? 'high' : (efforts[0] || null)
  return {
    name: typeof src.name === 'string' && src.name.trim()
      ? src.name.trim().slice(0, 80)
      : (base && base.name) || '',
    protocol: PROTOCOLS.has(String(src.protocol))
      ? String(src.protocol)
      : (base && base.protocol) || 'chat',
    context: positive(src.context) ?? (base ? base.context : null),
    output: positive(src.output) ?? (base ? base.output : null),
    images: typeof src.images === 'boolean' ? src.images : Boolean(base && base.images),
    reasoning: typeof src.reasoning === 'boolean'
      ? src.reasoning
      : Boolean((base && base.reasoning) || efforts.length),
    reasoningEfforts: efforts,
    defaultEffort,
    canDisableThinking: typeof src.canDisableThinking === 'boolean'
      ? src.canDisableThinking
      : Boolean(base && base.canDisableThinking),
  }
}

/** Apply local overrides + hand-added models on top of a catalog snapshot. */
function mergeCustom (catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return catalog
  const state = readCustom()
  const models = catalog.models.map(m => {
    const patch = state.overrides[m.id]
    if (!patch || typeof patch !== 'object') return m
    return { ...m, ...normalizeModelFields(patch, m), overridden: true }
  })
  const known = new Set(models.map(m => m.id))
  for (const entry of state.custom) {
    if (known.has(entry.id)) continue
    const base = {
      id: entry.id, name: entry.id, protocol: 'chat', context: null, output: null,
      images: false, reasoning: false, reasoningEfforts: [], canDisableThinking: false,
      costIn: null, costOut: null, status: 'custom',
    }
    models.push({ ...base, ...normalizeModelFields(entry, base), id: entry.id, custom: true })
    known.add(entry.id)
  }
  models.sort((a, b) => (a.protocol === b.protocol ? a.id.localeCompare(b.id) : a.protocol.localeCompare(b.protocol)))
  return {
    ...catalog,
    models,
    counts: {
      gateway: catalog.models.length,
      usable: models.filter(m => USABLE.has(m.protocol)).length,
    },
  }
}

async function fetchJson (url, timeoutMs) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'workbuddy-opencode-go-ui/1.0' },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
    return await res.json()
  } finally { clearTimeout(timer) }
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** models.dev `reasoning_options` -> WorkBuddy reasoning capabilities. */
function parseReasoningOptions (options) {
  const efforts = new Set()
  let canDisable = false
  let budgetMax = null
  for (const option of Array.isArray(options) ? options : []) {
    if (!option || typeof option !== 'object') continue
    if (option.type === 'effort') {
      for (const raw of Array.isArray(option.values) ? option.values : []) {
        if (typeof raw !== 'string') continue
        const value = raw.trim().toLowerCase()
        if (['none', 'off', 'disabled'].includes(value)) canDisable = true
        else if (EFFORT_ORDER.includes(value)) efforts.add(value)
      }
    } else if (option.type === 'toggle') {
      canDisable = true
    } else if (option.type === 'budget_tokens' && Number.isFinite(Number(option.max))) {
      budgetMax = Number(option.max)
    }
  }
  const ordered = EFFORT_ORDER.filter(e => efforts.has(e))
  const defaultEffort = ordered.includes('medium')
    ? 'medium'
    : ordered.includes('high')
      ? 'high'
      : ordered[0] || null
  return { reasoningEfforts: ordered, defaultEffort, canDisableThinking: canDisable, thinkingBudgetMax: budgetMax }
}

async function collectCatalog () {
  const [listing, meta] = await Promise.all([
    fetchJson(MODELS_URL, 30000),
    fetchJson(METADATA_URL, 120000),
  ])
  const ids = [...new Set((listing.data || []).map(r => r && r.id).filter(id => typeof id === 'string' && id.trim()))]
  const provider = (meta && meta['opencode-go']) || {}
  const defaultNpm = provider.npm || '@ai-sdk/openai-compatible'
  const entries = provider.models || {}

  const models = []
  const missingMetadata = []
  for (const id of ids) {
    const m = entries[id]
    if (!m || typeof m !== 'object') {
      missingMetadata.push(id)
      models.push({ id, name: id, protocol: 'unknown', context: null, output: null,
        reasoning: null, reasoningEfforts: [], defaultEffort: null, canDisableThinking: false,
        thinkingBudgetMax: null, images: null, costIn: null, costOut: null, status: '' })
      continue
    }
    const npm = (m.provider && m.provider.npm) || defaultNpm
    const limit = m.limit || {}
    const cost = m.cost || {}
    const input = (m.modalities && m.modalities.input) || []
    const thinking = parseReasoningOptions(m.reasoning_options)
    models.push({
      id,
      name: m.name || id,
      protocol: NPM_TO_PROTOCOL[npm] || 'unknown',
      context: limit.context ?? null,
      output: limit.output ?? null,
      reasoning: Boolean(m.reasoning),
      reasoningEfforts: thinking.reasoningEfforts,
      defaultEffort: thinking.defaultEffort,
      canDisableThinking: thinking.canDisableThinking,
      thinkingBudgetMax: thinking.thinkingBudgetMax,
      images: Array.isArray(input) && input.includes('image'),
      costIn: cost.input ?? null,
      costOut: cost.output ?? null,
      costCacheRead: cost.cache_read ?? null,
      costCacheWrite: cost.cache_write ?? null,
      status: m.status || '',
      releaseDate: m.release_date || '',
    })
  }
  models.sort((a, b) => (a.protocol === b.protocol ? a.id.localeCompare(b.id) : a.protocol.localeCompare(b.protocol)))

  const catalog = {
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    sources: { gateway: MODELS_URL, metadata: METADATA_URL },
    counts: {
      gateway: ids.length,
      usable: models.filter(m => USABLE.has(m.protocol)).length,
    },
    models,
    missingMetadata,
    notInGateway: Object.keys(entries).filter(id => !ids.includes(id)).sort(),
  }
  const tmp = CATALOG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, CATALOG_PATH)
  return catalog
}

function recountCatalog (catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return catalog
  const usable = catalog.models.filter(m => USABLE.has(m.protocol)).length
  return { ...catalog, counts: { gateway: catalog.models.length, usable } }
}

/**
 * Models WorkBuddy already has in ~/.workbuddy/models.json. Only rows this
 * bridge owns (name suffix or a 127.0.0.1 URL) are considered, so unrelated
 * custom models are left alone.
 */
function readWorkbuddyModels () {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'))
    const list = Array.isArray(raw) ? raw : []
    const map = new Map()
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue
      const name = typeof m.name === 'string' ? m.name : ''
      const local = /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(String(m.url || ''))
      if (!local && !name.endsWith(NAME_SUFFIX)) continue
      map.set(m.id, m)
    }
    return { path: MODELS_JSON, map, mtime: fs.statSync(MODELS_JSON).mtimeMs }
  } catch {
    return { path: MODELS_JSON, map: new Map(), mtime: null }
  }
}

/** Attach `wb.installed` + parameter drift to every catalog row. */
function annotateWorkbuddy (catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return catalog
  const wb = readWorkbuddyModels()
  const expectedUrl = `http://127.0.0.1:${bridgePort()}/v1`
  const outdatedIds = []
  let installed = 0

  const models = catalog.models.map((m) => {
    const entry = wb.map.get(m.id)
    if (!entry) return m
    installed += 1
    const diffs = []
    const ctx = Number(m.context)
    const out = Number(m.output)
    const cap = (m.overridden || m.custom) ? 1000000 : MAX_OUTPUT_CAP
    const expectCtx = Number.isInteger(ctx) && ctx > 0 ? ctx : 200000
    const expectOut = Number.isInteger(out) && out > 0 ? Math.min(out, cap) : 32768
    if (String(entry.url || '') !== expectedUrl) diffs.push('端口')
    if (Number(entry.maxInputTokens) !== expectCtx) diffs.push('上下文')
    if (Number(entry.maxOutputTokens) !== expectOut) diffs.push('输出上限')
    if (Boolean(entry.supportsImages) !== Boolean(m.images)) diffs.push('图片')
    if (diffs.length) outdatedIds.push(`${m.id}（${diffs.join('/')}）`)
    return { ...m, wb: { installed: true, diffs, url: entry.url || '' } }
  })

  const known = new Set(models.map(m => m.id))
  const orphans = [...wb.map.keys()].filter(id => !known.has(id)).sort()
  return {
    ...catalog,
    models,
    workbuddy: {
      path: MODELS_JSON,
      exists: Boolean(wb.mtime),
      count: wb.map.size,
      installed,
      outdated: outdatedIds.length,
      outdatedIds,
      orphans,
      syncedAt: wb.mtime,
    },
  }
}

async function getCatalog (refresh) {
  const saved = readCatalog()
  const fresh = saved && Number.isFinite(saved.generatedAtMs) && (Date.now() - saved.generatedAtMs) < CATALOG_TTL_MS
  if (saved && fresh && !refresh) {
    return { catalog: annotateWorkbuddy(mergeCustom(recountCatalog(saved))), fetched: false }
  }
  return { catalog: annotateWorkbuddy(mergeCustom(await collectCatalog())), fetched: true }
}

async function bridgeHealth (port) {
  const target = Number(port) || bridgePort()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1200)
  try {
    const res = await fetch(`http://127.0.0.1:${target}/health`, { signal: ac.signal })
    if (!res.ok) return { running: false }
    const body = await res.json()
    return { running: true, models: body.supportedModels, catalogLoaded: body.catalogLoaded }
  } catch { return { running: false } }
  finally { clearTimeout(timer) }
}

function readPid () {
  try { return Number(fs.readFileSync(UI_PID, 'utf8').trim()) || 0 } catch { return 0 }
}

function writePid (pid) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  writeFileAtomic(UI_PID, String(pid) + '\n', 'utf8')
}

function readModelsJson () {
  const raw = fs.readFileSync(MODELS_JSON, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error('models.json 根节点不是数组')
  return data
}

function buildEntry (m, key, reasoning) {
  const out = Number(m.output)
  const ctx = Number(m.context)
  // Hand-edited rows may legitimately exceed the conservative catalog cap.
  const outputCap = (m.overridden || m.custom) ? 1000000 : MAX_OUTPUT_CAP
  const efforts = Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []
  const supportsReasoning = Boolean(m.reasoning) || efforts.length > 0
  const entry = {
    id: m.id,
    name: `${m.name || m.id}${NAME_SUFFIX}`,
    vendor: 'Custom',
    url: `http://127.0.0.1:${bridgePort()}/v1`,
    apiKey: key || 'opencode-go',
    supportsToolCall: true,
    supportsImages: Boolean(m.images),
    supportsReasoning,
    maxInputTokens: Number.isInteger(ctx) && ctx > 0 ? ctx : 200000,
    maxOutputTokens: Number.isInteger(out) && out > 0 ? Math.min(out, outputCap) : 32768,
  }
  if (supportsReasoning && (efforts.length || reasoning)) {
    const supportedEfforts = efforts.length ? efforts : ['low', 'medium', 'high']
    entry.reasoning = {
      defaultEffort: m.defaultEffort && supportedEfforts.includes(m.defaultEffort)
        ? m.defaultEffort
        : supportedEfforts.includes('medium')
          ? 'medium'
          : supportedEfforts.includes('high')
            ? 'high'
            : supportedEfforts[0],
      supportedEfforts,
      canDisableThinking: Boolean(m.canDisableThinking),
    }
  }
  return entry
}

function stamp () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------------------------------------------------------------- actions

/** Which bridge ports the rows already written into models.json point at. */
function modelsPortUsage () {
  try {
    const ports = new Set()
    for (const m of readModelsJson()) {
      if (!m || typeof m.name !== 'string' || !m.name.endsWith(NAME_SUFFIX)) continue
      const match = /^http:\/\/127\.0\.0\.1:(\d+)\/v1$/.exec(String(m.url || ''))
      if (match) ports.add(Number(match[1]))
    }
    return [...ports].sort((a, b) => a - b)
  } catch { return [] }
}

async function apiStatus () {
  const key = readKey()
  const cat = readCatalog()
  const port = bridgePort()
  const bridge = await bridgeHealth(port)
  return {
    bridge: { port, ...bridge },
    ports: { ui: UI_PORT, bridge: port },
    modelsPorts: modelsPortUsage(),
    proxy: (() => {
      const cfg = readProxyConfig()
      return { enabled: cfg.enabled, url: cfg.url, forced: cfg.models.length, fallback: cfg.fallback }
    })(),
    key: { present: Boolean(key), length: key.length },
    accounts: (() => {
      const s = accounts.read()
      const a = s.accounts.find(x => x.ref === s.activeRef)
      return { total: s.accounts.length, active: a ? a.name : null, autoSwitch: s.autoSwitch }
    })(),
    catalog: cat ? {
      exists: true,
      count: Array.isArray(cat.models) ? cat.models.length : 0,
      usable: cat.counts ? cat.counts.usable : null,
      generatedAt: cat.generatedAt,
      stale: !(Number.isFinite(cat.generatedAtMs) && (Date.now() - cat.generatedAtMs) < CATALOG_TTL_MS),
    } : { exists: false, stale: true },
    paths: { key: KEY_FILE, modelsJson: MODELS_JSON, catalog: CATALOG_PATH },
  }
}

async function apiUsage (ref) {
  const store = accounts.read()
  const active = store.accounts.find(a => a.ref === store.activeRef)
  const key = ref ? accounts.keyOf(ref) : (active && active.key ? active.key : readKey())
  if (!key) return { error: '还没有配置密钥' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ac.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const brief = text ? '：' + text.replace(/\s+/g, ' ').slice(0, 120) : ''
      if (res.status === 401) return { error: '密钥被拒绝（401）' + brief }
      if (res.status === 403) return { error: '密钥无 Go 订阅权限（403）' + brief }
      return { error: `用量接口 HTTP ${res.status}${brief}` }
    }
    const payload = JSON.parse(text)
    if (ref && payload && payload.usage) accounts.setUsage(ref, payload.usage)
    return payload
  } catch (e) {
    return { error: e.name === 'AbortError' ? '用量接口超时' : `无法连接 ${USAGE_URL}: ${e.message}` }
  } finally { clearTimeout(timer) }
}

/**
 * Official usage from https://opencode.ai/console — the same numbers the
 * subscription page shows, including requests the bridge never saw.
 */
async function apiOfficialUsage (days, force) {
  const store = accounts.read()
  const active = store.accounts.find(a => a.ref === store.activeRef)
  const key = (active && active.key) || readKey()
  const span = officialUsage.clampDays(days)
  if (!key) return { ok: false, days: span, error: '还没有配置密钥' }
  try {
    return await officialUsage.fetchOfficial({ key, days: span, force: force === true })
  } catch (e) {
    return { ok: false, days: span, error: e.message, last: officialUsage.lastSnapshot() }
  }
}

/**
 * Fire one tiny streaming request through the local bridge and report exactly
 * what came back. This is the "why can't it connect" button: status, latency
 * and the upstream error body, measured on the same path WorkBuddy uses.
 */
async function apiTestModel (id) {
  const model = String(id || '').trim()
  if (!model) throw new Error('缺少模型 id')
  const port = bridgePort()
  const health = await bridgeHealth(port)
  if (!health.running) return { ok: false, model, error: `桥接没在运行（端口 ${port}）` }

  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 45000)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: ac.signal,
    })
    const text = await res.text()
    const ms = Date.now() - started
    if (!res.ok) {
      let msg = text.replace(/\s+/g, ' ').slice(0, 400)
      try {
        const j = JSON.parse(text)
        if (j && j.error) msg = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error))
      } catch {}
      return { ok: false, model, status: res.status, ms, error: msg }
    }
    return {
      ok: true,
      model,
      status: 200,
      ms,
      chunks: (text.match(/^data: /gm) || []).length,
      bytes: text.length,
    }
  } catch (e) {
    return {
      ok: false,
      model,
      ms: Date.now() - started,
      error: e && e.name === 'AbortError' ? '超时（45 秒）' : (e && e.message) || String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}

function apiAccounts () {
  return accounts.publicView(accounts.read())
}

async function apiAccountAction (body) {
  const action = body.action
  if (action === 'add') {
    const ref = accounts.add(body.name, body.key)
    return { ok: true, ref, ...apiAccounts() }
  }
  if (action === 'rename') { accounts.update(body.ref, { name: body.name }); return { ok: true, ...apiAccounts() } }
  if (action === 'replaceKey') { accounts.update(body.ref, { key: body.key }); return { ok: true, ...apiAccounts() } }
  if (action === 'delete') { accounts.remove(body.ref); return { ok: true, ...apiAccounts() } }
  if (action === 'activate') { accounts.activate(body.ref); return { ok: true, ...apiAccounts() } }
  if (action === 'reorder') { accounts.reorder(body.ref, body.direction); return { ok: true, ...apiAccounts() } }
  if (action === 'autoSwitch') { accounts.setAutoSwitch(body.on !== false); return { ok: true, ...apiAccounts() } }
  throw new Error('未知账号操作: ' + action)
}

function apiAnalytics (days) {
  const span = Math.max(1, Math.min(90, Number(days) || 7))
  const since = Date.now() - span * 86400000
  const cat = readCatalog()
  const price = new Map()
  if (cat && Array.isArray(cat.models)) {
    for (const m of cat.models) {
      price.set(m.id, {
        in: m.costIn, out: m.costOut,
        cacheRead: m.costCacheRead, cacheWrite: m.costCacheWrite,
      })
    }
  }
  let lines = []
  try {
    // The bridge rotates the log at 8 MB, but a long-running panel may meet a
    // file that grew past that before rotating; never slurp a huge file.
    lines = readTailText(path.join(PACKAGE_ROOT, 'usage-history.jsonl'), 16 * 1024 * 1024).split('\n')
  } catch { lines = [] }

  const byModel = new Map()
  let requests = 0
  let withUsage = 0
  let prompt = 0
  let completion = 0
  let cached = 0
  let oldest = null

  for (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row.at !== 'number' || row.at < since) continue
    requests++
    if (oldest === null || row.at < oldest) oldest = row.at
    const key = row.model || '(unknown)'
    let slot = byModel.get(key)
    if (!slot) {
      slot = { id: key, requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0 }
      byModel.set(key, slot)
    }
    slot.requests++
    if (row.usage && (row.usage.prompt || row.usage.completion)) {
      withUsage++
      const rowPrompt = row.usage.prompt || 0
      const rowCompletion = row.usage.completion || 0
      const rowCached = row.usage.cached || 0
      const rowCacheWrite = row.usage.cacheWrite || 0
      slot.prompt += rowPrompt
      slot.completion += rowCompletion
      slot.cached += rowCached
      prompt += rowPrompt
      completion += rowCompletion
      cached += rowCached
      const p = price.get(key)
      if (p && typeof p.in === 'number' && typeof p.out === 'number') {
        // Cached prompt tokens are billed at the cache_read rate, cache writes at
        // cache_write; everything else at the normal input rate.
        const cacheReadPrice = typeof p.cacheRead === 'number' ? p.cacheRead : p.in
        const cacheWritePrice = typeof p.cacheWrite === 'number' ? p.cacheWrite : p.in
        const uncached = Math.max(0, rowPrompt - rowCached - rowCacheWrite)
        slot.cost += (
          uncached * p.in +
          rowCached * cacheReadPrice +
          rowCacheWrite * cacheWritePrice +
          rowCompletion * p.out
        ) / 1e6
      }
    }
  }

  const models = [...byModel.values()]
    .map(m => ({ ...m, cost: Number(m.cost.toFixed(6)) }))
    .sort((a, b) => b.requests - a.requests)
  const cost = Number(models.reduce((s, m) => s + m.cost, 0).toFixed(6))
  return {
    days: span,
    requests,
    withUsage,
    coverage: requests ? Number((withUsage / requests).toFixed(2)) : 0,
    prompt,
    completion,
    cached,
    cost,
    models,
    oldest: oldest ? new Date(oldest).toISOString() : null,
    note: 'token 以各协议上游返回的 usage 为准（流式会在末尾补 usage 块）；金额按 models.dev 单价估算，不是账单',
  }
}

async function apiInstall (body) {
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : []
  if (!ids.length) throw new Error('没有选中模型')
  const cat = mergeCustom(readCatalog())
  if (!cat) throw new Error('还没有模型目录，先刷新目录')
  const byId = new Map(cat.models.map(m => [m.id, m]))
  const chosen = ids.map(id => byId.get(id)).filter(m => m && USABLE.has(m.protocol))
  if (!chosen.length) throw new Error('选中的模型都不可桥接')

  const data = readModelsJson()
  const key = readKey()
  const entries = chosen.map(m => buildEntry(m, key, body.reasoning === true))

  const added = []
  const updated = []
  for (const e of entries) {
    const idx = data.findIndex(m => m && m.id === e.id)
    if (idx === -1) { data.push(e); added.push(e.id) } else { data[idx] = e; updated.push(e.id) }
  }

  let pruned = 0
  if (body.prune === true) {
    const keep = new Set(entries.map(e => e.id))
    const before = data.length
    for (let i = data.length - 1; i >= 0; i--) {
      const m = data[i]
      if (m && typeof m.name === 'string' && m.name.endsWith(NAME_SUFFIX) && !keep.has(m.id)) {
        data.splice(i, 1)
        pruned++
      }
    }
    if (before - data.length !== pruned) pruned = before - data.length
  }

  const backup = `${MODELS_JSON}.bak-${stamp()}`
  fs.copyFileSync(MODELS_JSON, backup)
  writeFileAtomic(MODELS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return { added, updated, pruned, total: data.length, backup }
}

async function apiModelEdit (body) {
  const action = String(body.action || '')
  const id = String(body.id || '').trim()
  const state = readCustom()

  if (action === 'save') {
    const cat = readCatalog()
    const inCatalog = Boolean(cat && cat.models.some(m => m.id === id))
    const existingCustom = state.custom.find(m => m.id === id)

    if (!inCatalog && !existingCustom) {
      // New hand-added model.
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(id)) {
        throw new Error('模型 id 只能用字母数字和 . _ : -，2-80 字符')
      }
      const fields = normalizeModelFields({ ...body, id }, null)
      state.custom.push({ id, ...fields })
    } else if (existingCustom) {
      const fields = normalizeModelFields(body, existingCustom)
      Object.assign(existingCustom, fields, { id })
    } else {
      // Override a catalog row: store only the editable surface.
      const base = cat.models.find(m => m.id === id)
      state.overrides[id] = normalizeModelFields(body, base)
    }
  } else if (action === 'reset') {
    delete state.overrides[id]
  } else if (action === 'delete') {
    state.custom = state.custom.filter(m => m.id !== id)
    delete state.overrides[id]
  } else {
    throw new Error('未知操作: ' + action)
  }

  writeCustom(state)
  const { catalog } = await getCatalog(false)
  return { ok: true, catalog, custom: state }
}

/** Graceful shutdown via the bridge's own token, then a hard kill fallback. */
async function stopBridgeProcess (port) {
  const target = Number(port) || bridgePort()
  const health = await bridgeHealth(target)
  if (!health.running) {
    try { fs.unlinkSync(UI_PID) } catch {}
    return { ok: true, stopped: false, message: '端口 ' + target + ' 上没有运行中的桥接' }
  }
  try {
    const token = fs.readFileSync(path.join(STATE_DIR, 'shutdown.token'), 'utf8').trim()
    if (token) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2500)
      try {
        const res = await fetch(`http://127.0.0.1:${target}/shutdown`, {
          method: 'POST',
          headers: { 'x-bridge-shutdown-token': token },
          signal: ac.signal,
        })
        if (res.ok) {
          try { fs.unlinkSync(UI_PID) } catch {}
          return { ok: true, stopped: true, message: '桥接已停止' }
        }
      } finally { clearTimeout(timer) }
    }
  } catch {}

  const pid = readPid()
  if (!pid) {
    return { ok: false, stopped: false, message: '端口 ' + target + ' 上的桥接不是面板启动的，请先手动关闭它' }
  }
  try {
    process.kill(pid)
    try { fs.unlinkSync(UI_PID) } catch {}
    return { ok: true, stopped: true, message: '桥接已停止 (pid ' + pid + ')' }
  } catch (e) {
    if (e.code === 'ESRCH') {
      try { fs.unlinkSync(UI_PID) } catch {}
      return { ok: true, stopped: true, message: '桥接进程已经退出' }
    }
    return { ok: false, stopped: false, message: '停止失败: ' + e.message }
  }
}

async function apiBridge (action) {
  if (action === 'stop') return stopBridgeProcess(bridgePort())
  if (action !== 'start') throw new Error('未知操作')

  const port = bridgePort()
  const running = await bridgeHealth(port)
  if (running.running) {
    return { ok: true, message: '桥接已经在端口 ' + port + ' 运行（' + (running.models || '?') + ' 个模型）' }
  }
  const nodeBin = process.execPath
  const child = spawn(nodeBin, [path.join(PACKAGE_ROOT, 'src', 'bridge.js')], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_GO_BRIDGE_PORT: String(port),
      OPENCODE_GO_BRIDGE_STATE_DIR: STATE_DIR,
      ...(readKey() ? { GO_KEY: readKey() } : {}),
    },
  })
  child.unref()
  writePid(child.pid)
  return { ok: true, message: '桥接已启动 (pid ' + child.pid + '，端口 ' + port + ')' }
}

/** Rewrite our own models.json rows when the port changes. */
function retargetModelsPort (oldPort, newPort) {
  if (oldPort === newPort) return { rewritten: 0, backup: null }
  let data
  try { data = readModelsJson() } catch { return { rewritten: 0, backup: null } }
  let rewritten = 0
  for (const m of data) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.name !== 'string' || !m.name.endsWith(NAME_SUFFIX)) continue
    if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(String(m.url || ''))) continue
    const next = `http://127.0.0.1:${newPort}/v1`
    if (m.url !== next) { m.url = next; rewritten++ }
  }
  if (!rewritten) return { rewritten: 0, backup: null }
  const backup = `${MODELS_JSON}.bak-${stamp()}`
  fs.copyFileSync(MODELS_JSON, backup)
  writeFileAtomic(MODELS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return { rewritten, backup }
}

async function apiConfigSave (body) {
  const port = Number(body && body.bridgePort)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须是 1024–65535 的整数')
  }
  if (port === UI_PORT) throw new Error('桥接端口不能和控制台端口相同（' + UI_PORT + '）')

  const oldPort = bridgePort()
  let stopped = null
  if (port !== oldPort) {
    const result = await stopBridgeProcess(oldPort)
    if (!result.ok) throw new Error(result.message)
    if (result.stopped) stopped = result.message
  }

  writeBridgePort(port)
  const retarget = retargetModelsPort(oldPort, port)
  return {
    ok: true,
    port,
    previous: oldPort,
    stopped,
    rewritten: retarget.rewritten,
    backup: retarget.backup,
  }
}

// ---------------------------------------------------------------- server

function sendJson (res, code, obj) {
  if (res.writableEnded || res.destroyed) return
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(buf)
}

/**
 * A page on the open internet can still POST to 127.0.0.1 (a "simple" request
 * skips preflight). Two cheap checks close that hole without hurting curl or
 * the panel itself: a foreign Origin is refused, and every state-changing call
 * must be JSON — which a cross-site form or `text/plain` fetch cannot send
 * without triggering a preflight this server never approves.
 */
function isLocalOrigin (req) {
  const origin = req.headers.origin
  if (!origin) return true
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  const host = parsed.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return false
  return Number(parsed.port) === UI_PORT
}

function isJsonRequest (req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''))
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${UI_PORT}`)
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!isLocalOrigin(req)) {
        return sendJson(res, 403, { error: '拒绝跨站请求' })
      }
      if (!isJsonRequest(req)) {
        return sendJson(res, 415, { error: '请求体必须使用 application/json' })
      }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(UI_FILE)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': html.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
      return
    }
    if (url.pathname === '/api/status') return sendJson(res, 200, await apiStatus())
    if (url.pathname === '/api/catalog') {
      const { catalog, fetched } = await getCatalog(url.searchParams.get('refresh') === '1')
      return sendJson(res, 200, { ...catalog, fetched })
    }
    if (url.pathname === '/api/usage') {
      return sendJson(res, 200, await apiUsage(url.searchParams.get('ref') || undefined))
    }
    if (url.pathname === '/api/official/usage') {
      return sendJson(res, 200, await apiOfficialUsage(
        url.searchParams.get('days') || 1,
        url.searchParams.get('refresh') === '1',
      ))
    }
    if (url.pathname === '/api/accounts') {
      if (req.method === 'GET') return sendJson(res, 200, apiAccounts())
      return sendJson(res, 200, await apiAccountAction(await readBody(req)))
    }
    if (url.pathname === '/api/analytics') {
      return sendJson(res, 200, apiAnalytics(url.searchParams.get('days')))
    }
    if (url.pathname === '/api/key' && req.method === 'POST') {
      const body = await readBody(req)
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      if (!key) return sendJson(res, 400, { error: '密钥为空' })
      writeKey(key)
      const store = accounts.read()
      if (!store.accounts.length) accounts.add('默认账号', key)
      else if (store.activeRef) accounts.update(store.activeRef, { key })
      else accounts.add('默认账号', key)
      return sendJson(res, 200, { ok: true, length: key.length })
    }
    if (url.pathname === '/api/install' && req.method === 'POST') {
      return sendJson(res, 200, await apiInstall(await readBody(req)))
    }
    if (url.pathname === '/api/models' && req.method === 'POST') {
      return sendJson(res, 200, await apiModelEdit(await readBody(req)))
    }
    if (url.pathname === '/api/test-model' && req.method === 'POST') {
      const body = await readBody(req)
      return sendJson(res, 200, await apiTestModel(body.id))
    }
    if (url.pathname === '/api/proxy') {
      const body = req.method === 'POST' ? await readBody(req) : { action: 'read' }
      return sendJson(res, 200, await apiProxy(body))
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      return sendJson(res, 200, await apiConfigSave(await readBody(req)))
    }
    if (url.pathname === '/api/bridge' && req.method === 'POST') {
      const body = await readBody(req)
      return sendJson(res, 200, await apiBridge(body.action))
    }
    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      // The tray launcher calls this instead of killing the process, so the
      // bridge gets its token-authorised shutdown first.
      sendJson(res, 200, { ok: true, stopping: true })
      shutdown('api').catch(() => process.exit(0))
      return
    }
    sendJson(res, 404, { error: '找不到 ' + url.pathname })
  } catch (e) {
    sendJson(res, 500, { error: e && e.message ? e.message : String(e) })
  }
})

// ---------------------------------------------------------------- lifecycle

function panelUrl () {
  return `http://127.0.0.1:${UI_PORT}`
}

/** rundll32 hands the URL to the default browser without spawning a console. */
function openBrowser () {
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', panelUrl()], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()
    return true
  } catch {
    console.log(`请手动在浏览器打开 ${panelUrl()}`)
    return false
  }
}

let shuttingDown = false

/**
 * Stop the bridge, close the listener, exit. The tray launcher waits for the
 * port to close, so this has to be bounded: a wedged upstream must never keep
 * the user's "退出" hanging.
 */
async function shutdown (reason) {
  if (shuttingDown) return
  shuttingDown = true
  const hardExit = setTimeout(() => process.exit(0), 8000)
  hardExit.unref()
  try {
    const result = await stopBridgeProcess(bridgePort())
    console.log(`桥接：${result.message}`)
  } catch (e) {
    console.log(`桥接停止失败：${e && e.message}`)
  }
  try { server.close() } catch {}
  console.log(`控制台已退出（${reason}）`)
  setTimeout(() => process.exit(0), 100)
}

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    // Double click while the panel is already up: show it instead of crashing.
    console.log(`端口 ${UI_PORT} 已在监听，控制台应该已经在运行`)
    if (!process.argv.includes('--no-open')) openBrowser()
    process.exit(0)
  }
  console.error('控制台启动失败：' + (error && error.message))
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { shutdown(signal).catch(() => process.exit(0)) })
}
process.on('unhandledRejection', (e) => {
  console.error('未处理的 Promise 拒绝：' + (e && e.message ? e.message : String(e)))
})

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`opencode Go 控制台  ${panelUrl()}`)
  console.log(`桥接端口 ${bridgePort()} | 密钥 ${readKey() ? '已配置' : '未配置'} | 目录 ${readCatalog() ? '已缓存' : '待生成'}`)
  if (process.argv.includes('--no-open')) return
  openBrowser()
})
