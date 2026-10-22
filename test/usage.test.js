'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeUsage,
  usageFromPayload,
  usageFromSseTail,
  tailCollector,
} = require('../src/usage');

test('openai chat usage keeps prompt_tokens as the total input', () => {
  const u = normalizeUsage({
    prompt_tokens: 14,
    completion_tokens: 16,
    total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 4 },
  });
  assert.deepEqual(u, { prompt: 14, completion: 16, cached: 4, cacheWrite: 0 });
});

test('openai responses usage does not double count cached input', () => {
  const u = normalizeUsage({
    input_tokens: 9,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 2 },
  });
  assert.deepEqual(u, { prompt: 9, completion: 5, cached: 2, cacheWrite: 0 });
});

test('anthropic usage adds cache read/write back into the input total', () => {
  const u = normalizeUsage({
    input_tokens: 8,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
  });
  assert.deepEqual(u, { prompt: 128, completion: 5, cached: 100, cacheWrite: 20 });
});

test('google usage counts thinking tokens as output', () => {
  const u = normalizeUsage({
    promptTokenCount: 10,
    candidatesTokenCount: 6,
    thoughtsTokenCount: 40,
    cachedContentTokenCount: 3,
  });
  assert.deepEqual(u, { prompt: 10, completion: 46, cached: 3, cacheWrite: 0 });
});

test('usageFromPayload handles uppercase UsageMetadata key', () => {
  const u = usageFromPayload({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
  assert.equal(u.prompt, 3);
  assert.equal(u.completion, 2);
});

test('sse tail: openai final usage chunk', () => {
  const tail = [
    'data: {"id":"x","choices":[{"delta":{"content":"ok"}}]}',
    'data: {"id":"x","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":7}}',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepEqual(usageFromSseTail(tail), {
    prompt: 21, completion: 7, cached: 0, cacheWrite: 0,
  });
});

test('sse tail: anthropic message_delta wins over message_start', () => {
  const tail = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":50}}}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    '',
  ].join('\n');
  const u = usageFromSseTail(tail);
  assert.equal(u.prompt, 62);
  assert.equal(u.completion, 9);
  assert.equal(u.cached, 50);
});

test('sse tail: responses completed event', () => {
  const tail = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":11,"input_tokens_details":{"cached_tokens":8}}}}',
    '',
  ].join('\n');
  const u = usageFromSseTail(tail);
  assert.equal(u.prompt, 30);
  assert.equal(u.completion, 11);
  assert.equal(u.cached, 8);
});

test('sse tail: google usageMetadata', () => {
  const tail = [
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"thoughtsTokenCount":3}}',
  ].join('\n');
  const u = usageFromSseTail(tail);
  assert.equal(u.prompt, 5);
  assert.equal(u.completion, 5);
});

test('tailCollector survives chunk boundaries and keeps the last usage', () => {
  const collector = tailCollector();
  const payload = 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n';
  const cut = 18;
  collector.push(Buffer.from('garbage '.repeat(20)));
  collector.push(Buffer.from(payload.slice(0, cut)));
  assert.equal(collector.usage(), null);
  collector.push(Buffer.from(payload.slice(cut)));
  assert.deepEqual(collector.usage(), {
    prompt: 7, completion: 3, cached: 0, cacheWrite: 0,
  });
});

test('tailCollector ignores empty usage objects', () => {
  const collector = tailCollector();
  collector.push(Buffer.from('data: {"usage":{}}\n'));
  assert.equal(collector.usage(), null);
});
