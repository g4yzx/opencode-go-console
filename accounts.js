'use strict'
/**
 * Multi-account store for the opencode Go bridge.
 *
 * Shared by bridge.js (key resolution + fallback) and ui.js (management).
 * Plain JSON on disk, mode 0600, never sent back to the browser in clear.
 *
 * Shape:
 * {
 *   version: 1,
 *   activeRef: 'acc_a1b2c3',
 *   autoSwitch: true,
 *   accounts: [{
 *     ref, name, key, createdAt,
 *     lastError: 'quota' | 'credential' | null, lastErrorAt,
 *     usage: { rolling, weekly, monthly } | null, usageAt
 *   }]
 * }
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_PATH = path.join(__dirname, 'accounts.json')

function storePath () {
  return process.env.OPENCODE_GO_ACCOUNTS || DEFAULT_PATH
}

function emptyStore () {
  return { version: 1, activeRef: '', autoSwitch: true, accounts: [] }
}

function read () {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    if (!raw || !Array.isArray(raw.accounts)) return emptyStore()
    raw.version = 1
    raw.autoSwitch = raw.autoSwitch !== false
    return raw
  } catch {
    return emptyStore()
  }
}

function write (store) {
  const p = storePath()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, p)
  try { fs.chmodSync(p, 0o600) } catch {}
  return store
}

function newRef (store) {
  for (let i = 0; i < 50; i++) {
    const ref = 'acc_' + crypto.randomBytes(3).toString('hex')
    if (!store.accounts.some(a => a.ref === ref)) return ref
  }
  return 'acc_' + Date.now().toString(36)
}

/** Public view: never expose the key. */
function publicView (store) {
  return {
    activeRef: store.activeRef,
    autoSwitch: store.autoSwitch,
    accounts: store.accounts.map(a => ({
      ref: a.ref,
      name: a.name,
      keyTail: typeof a.key === 'string' && a.key.length >= 4 ? a.key.slice(-4) : '',
      keyLength: typeof a.key === 'string' ? a.key.length : 0,
      createdAt: a.createdAt || null,
      lastError: a.lastError || null,
      lastErrorAt: a.lastErrorAt || null,
      usage: a.usage || null,
      usageAt: a.usageAt || null,
    })),
  }
}

/** Keys to try, current account first, then the rest in stored order. */
function candidateKeys (clientKey) {
  const store = read()
  const usable = store.accounts.filter(a => typeof a.key === 'string' && a.key.trim())
  const byRef = new Map(usable.map(a => [a.ref, a]))

  // A real key typed into WorkBuddy wins; placeholder keys fall through to accounts.
  const isPlaceholder = !clientKey || /^(opencode-go|wb-.*|placeholder|x)$/i.test(clientKey.trim())
  if (!isPlaceholder) {
    const known = usable.find(a => a.key === clientKey)
    return [{ ref: known ? known.ref : null, name: known ? known.name : '客户端密钥', key: clientKey, fromClient: true }]
  }
  if (!usable.length) return []

  const ordered = []
  const active = byRef.get(store.activeRef) || usable[0]
  ordered.push(active)
  for (const a of usable) if (a.ref !== active.ref) ordered.push(a)

  if (!store.autoSwitch) return ordered.slice(0, 1)
  return ordered.map(a => ({ ref: a.ref, name: a.name, key: a.key, fromClient: false }))
}

function markResult (ref, outcome) {
  if (!ref) return
  const store = read()
  const acc = store.accounts.find(a => a.ref === ref)
  if (!acc) return
  if (outcome === 'ok') {
    acc.lastError = null
    acc.lastErrorAt = null
    if (store.activeRef !== ref) store.activeRef = ref
  } else {
    acc.lastError = outcome
    acc.lastErrorAt = Date.now()
  }
  write(store)
}

function setUsage (ref, usage) {
  const store = read()
  const acc = store.accounts.find(a => a.ref === ref)
  if (!acc) return
  acc.usage = usage
  acc.usageAt = Date.now()
  write(store)
}

function add (name, key) {
  const store = read()
  if (store.accounts.length >= 20) throw new Error('最多 20 个账号')
  if (!key || !key.trim()) throw new Error('密钥为空')
  const ref = newRef(store)
  store.accounts.push({
    ref,
    name: (name || '').trim() || `账号 ${store.accounts.length + 1}`,
    key: key.trim(),
    createdAt: Date.now(),
    lastError: null,
    lastErrorAt: null,
    usage: null,
    usageAt: null,
  })
  if (!store.activeRef) store.activeRef = ref
  write(store)
  return ref
}

function update (ref, patch) {
  const store = read()
  const acc = store.accounts.find(a => a.ref === ref)
  if (!acc) throw new Error('账号不存在')
  if (typeof patch.name === 'string' && patch.name.trim()) acc.name = patch.name.trim()
  if (typeof patch.key === 'string' && patch.key.trim()) {
    acc.key = patch.key.trim()
    acc.lastError = null
    acc.lastErrorAt = null
    acc.usage = null
    acc.usageAt = null
  }
  write(store)
  return acc
}

function remove (ref) {
  const store = read()
  const idx = store.accounts.findIndex(a => a.ref === ref)
  if (idx === -1) throw new Error('账号不存在')
  store.accounts.splice(idx, 1)
  if (store.activeRef === ref) store.activeRef = store.accounts[0] ? store.accounts[0].ref : ''
  write(store)
}

function activate (ref) {
  const store = read()
  if (!store.accounts.some(a => a.ref === ref)) throw new Error('账号不存在')
  store.activeRef = ref
  write(store)
}

function reorder (ref, direction) {
  const store = read()
  const idx = store.accounts.findIndex(a => a.ref === ref)
  if (idx === -1) throw new Error('账号不存在')
  const target = direction === 'up' ? idx - 1 : idx + 1
  if (target < 0 || target >= store.accounts.length) return
  const [item] = store.accounts.splice(idx, 1)
  store.accounts.splice(target, 0, item)
  write(store)
}

function setAutoSwitch (on) {
  const store = read()
  store.autoSwitch = on !== false
  write(store)
}

function keyOf (ref) {
  const store = read()
  const acc = store.accounts.find(a => a.ref === ref)
  return acc ? acc.key : ''
}

module.exports = {
  storePath, read, write, publicView, candidateKeys, markResult, setUsage,
  add, update, remove, activate, reorder, setAutoSwitch, keyOf,
}
