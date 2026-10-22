'use strict';

/**
 * Official usage numbers, straight from the OpenCode console.
 *
 * The page at https://opencode.ai/console/org_... is a SPA, but everything it
 * renders comes from a plain JSON API that a personal / service account key can
 * call as well (the key just needs the `Usage` resource readable):
 *
 *   GET /console/api/usage/summary?since=<ISO>&range=24h|7d|30d|all
 *   GET /console/api/usage/models?since=<ISO>
 *   GET /console/api/usage/cost-by-day?since=<ISO>&bucket=day
 *   GET /console/api/usage/users?since=<ISO>
 *
 * `range=24h` means "today in UTC", which is not what the dashboard's 今天 tab
 * shows, so every request carries an explicit `since` instead — that makes the
 * official window line up with the local `days` window byte for byte.
 *
 * Shapes come back stringly typed and money is integer micro-cents (1e-8 USD).
 */

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = (process.env.OPENCODE_CONSOLE_API || 'https://opencode.ai/console/api')
  .replace(/\/+$/, '');
const STATE_DIR = path.join(__dirname, '..', '.state');
const SNAPSHOT = path.join(STATE_DIR, 'official-usage.json');
const TTL_MS = 5 * 60 * 1000;
const DAY_MS = 86400000;

function clampDays (v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 90);
}

/**
 * Window for a `days` bucket. 90 days means "everything" so the console can
 * use its own `all` range instead of an arbitrary lower bound.
 */
function windowFor (days, now = Date.now()) {
  const d = clampDays(days);
  if (d >= 90) return { days: d, since: null, range: 'all' };
  return {
    days: d,
    since: new Date(now - d * DAY_MS).toISOString(),
    range: d === 1 ? '24h' : d === 7 ? '7d' : '30d',
  };
}

function num (v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** micro-cents (1e-8 USD) → dollars */
function usd (microCents) {
  return Number((num(microCents) / 1e8).toFixed(6));
}

function normalizeSummary (raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    requests: num(r.totalRequests),
    input: num(r.totalInputTokens),
    output: num(r.totalOutputTokens),
    cacheRead: num(r.totalCacheReadTokens),
    cacheWrite: num(r.totalCacheWrite5mTokens) + num(r.totalCacheWrite1hTokens),
    costMicroCents: num(r.totalCostMicroCents),
    cost: usd(r.totalCostMicroCents),
  };
}

function normalizeModels (raw) {
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  return items.map((m) => ({
    id: String(m.model || m.id || '(unknown)'),
    provider: String(m.provider || ''),
    requests: num(m.totalRequests),
    input: num(m.totalInputTokens),
    output: num(m.totalOutputTokens),
    cacheRead: num(m.totalCacheReadTokens),
    cacheWrite: num(m.totalCacheWrite5mTokens) + num(m.totalCacheWrite1hTokens),
    costMicroCents: num(m.totalCostMicroCents),
    cost: usd(m.totalCostMicroCents),
  })).sort((a, b) => b.costMicroCents - a.costMicroCents || b.requests - a.requests);
}

function normalizeDaily (raw) {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((d) => ({
    date: String(d.date || ''),
    tokens: num(d.totalTokens),
    requests: num(d.totalRequests),
    cost: usd(d.totalCostMicroCents),
  }));
}

async function call (endpoint, key, query, timeoutMs) {
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'user-agent': 'opencode-go-bridge/1.0',
      },
      signal: ac.signal,
    });
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? '超时' : (e && e.message) || String(e);
    throw new Error(`无法连接 opencode.ai 控制台：${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    const brief = text ? '：' + text.replace(/\s+/g, ' ').slice(0, 120) : '';
    if (res.status === 401) throw new Error('密钥被控制台拒绝（401），可能已撤销或过期');
    if (res.status === 403) throw new Error('密钥没有读取用量的权限（403），到控制台给这把密钥加 Usage: Read');
    if (res.status === 404) throw new Error(`控制台接口不存在（404）${brief}`);
    throw new Error(`控制台接口 HTTP ${res.status}${brief}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('控制台返回的不是 JSON：' + text.slice(0, 120));
  }
}

const cache = new Map();

function readSnapshot () {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (!raw || !raw.summary) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeSnapshot (snap) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = SNAPSHOT + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SNAPSHOT);
  } catch {
    // A read-only checkout still works — the snapshot is only a convenience.
  }
}

/**
 * Pull summary + per-model + per-day for one `days` bucket.
 *
 * Cached for five minutes per bucket so an auto-refreshing dashboard does not
 * hammer the API; `force` bypasses the cache (the 同步 button).
 */
async function fetchOfficial ({ key, days, force, timeoutMs } = {}) {
  const win = windowFor(days);
  if (!key) return { ok: false, days: win.days, error: '还没有配置密钥' };

  const hit = cache.get(win.days);
  if (!force && hit && Date.now() - hit.at < TTL_MS) {
    return { ...hit.data, cached: true };
  }

  const query = { range: win.range, since: win.since };
  const [summaryRaw, modelsRaw, dailyRaw] = await Promise.all([
    call('/usage/summary', key, query, timeoutMs),
    call('/usage/models', key, query, timeoutMs).catch(() => ({ items: [] })),
    call('/usage/cost-by-day', key, { ...query, bucket: 'day' }, timeoutMs).catch(() => []),
  ]);

  const data = {
    ok: true,
    days: win.days,
    since: win.since,
    at: Date.now(),
    summary: normalizeSummary(summaryRaw),
    models: normalizeModels(modelsRaw),
    daily: normalizeDaily(dailyRaw),
  };
  cache.set(win.days, { at: data.at, data });
  writeSnapshot(data);
  return { ...data, cached: false };
}

/** Last successful snapshot written to disk (survives a panel restart). */
function lastSnapshot () {
  const snap = readSnapshot();
  if (!snap) return null;
  return { ...snap, cached: true, stale: Date.now() - num(snap.at) > TTL_MS };
}

module.exports = {
  API_BASE,
  TTL_MS,
  DAY_MS,
  clampDays,
  windowFor,
  normalizeSummary,
  normalizeModels,
  normalizeDaily,
  fetchOfficial,
  lastSnapshot,
};
