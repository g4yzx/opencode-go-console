'use strict';

/**
 * Usage normalization shared by every protocol the bridge speaks.
 *
 * The gateways disagree on field names and on whether the cached prompt tokens
 * are part of the input count, so everything is normalized to:
 *
 *   { prompt, completion, cached, cacheWrite }
 *
 * `prompt` is the TOTAL input (cached + cache-write + fresh), which is what the
 * provider dashboards show as input tokens.
 */

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // Google generateContent
  if ('promptTokenCount' in u) {
    const prompt = n(u.promptTokenCount);
    const completion = n(u.candidatesTokenCount) + n(u.thoughtsTokenCount);
    const cached = n(u.cachedContentTokenCount);
    if (!prompt && !completion) return null;
    return { prompt, completion, cached, cacheWrite: 0 };
  }

  const details =
    (u.input_tokens_details && typeof u.input_tokens_details === 'object' && u.input_tokens_details) ||
    (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' && u.prompt_tokens_details) ||
    {};
  // Anthropic reports the uncached remainder in input_tokens; OpenAI-style APIs
  // report the total in prompt_tokens / input_tokens.
  const anthropicStyle =
    u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
  const cached = n(
    u.cache_read_input_tokens !== undefined ? u.cache_read_input_tokens : details.cached_tokens,
  );
  const cacheWrite = n(u.cache_creation_input_tokens);
  const rawPrompt = n(u.prompt_tokens ?? u.input_tokens);
  const prompt = anthropicStyle ? rawPrompt + cached + cacheWrite : rawPrompt;
  const completion = n(u.completion_tokens ?? u.output_tokens);
  if (!prompt && !completion) return null;
  return { prompt, completion, cached, cacheWrite };
}

function usageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeUsage(payload.usage) || normalizeUsage(payload.usageMetadata);
}

function usageFromJson(text) {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    return normalizeUsage(j.usage) || normalizeUsage(j.usageMetadata);
  } catch {
    return null;
  }
}

/** Extract one balanced `{...}` starting at `start`, ignoring braces in strings. */
function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull usage out of an SSE tail.
 *
 * A stream can carry several usage blocks (Anthropic sends input tokens in
 * `message_start` and the final output count in `message_delta`), so all
 * occurrences in the tail are merged: the maximum of each field wins, which is
 * the cumulative/final value for every provider we speak.
 */
function usageFromSseTail(tail) {
  if (!tail) return null;
  let merged = null;
  const take = (u) => {
    if (!u) return;
    merged = {
      prompt: Math.max(merged ? merged.prompt : 0, u.prompt),
      completion: Math.max(merged ? merged.completion : 0, u.completion),
      cached: Math.max(merged ? merged.cached : 0, u.cached),
      cacheWrite: Math.max(merged ? merged.cacheWrite : 0, u.cacheWrite),
    };
  };

  for (const key of ['"usage"', '"usageMetadata"']) {
    let idx = tail.lastIndexOf(key);
    let guard = 0;
    while (idx !== -1 && guard < 200) {
      guard += 1;
      const start = tail.indexOf('{', idx + key.length);
      if (start !== -1) {
        const raw = balancedObjectAt(tail, start);
        if (raw) {
          try {
            take(normalizeUsage(JSON.parse(raw)));
          } catch {
            // Truncated by the tail cap — skip this occurrence.
          }
        }
      }
      idx = tail.lastIndexOf(key, idx - 1);
    }
  }
  return merged;
}

/** Keep the last 64 KiB of an SSE stream so the trailing usage can be parsed. */
function tailCollector() {
  let tail = '';
  return {
    push(chunk) {
      tail = (tail + chunk.toString('latin1')).slice(-65536);
    },
    usage() {
      return usageFromSseTail(tail);
    },
  };
}

module.exports = {
  normalizeUsage,
  usageFromPayload,
  usageFromJson,
  usageFromSseTail,
  tailCollector,
};
