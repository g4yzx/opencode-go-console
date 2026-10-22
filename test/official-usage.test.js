'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  clampDays,
  windowFor,
  normalizeSummary,
  normalizeModels,
  normalizeDaily,
} = require('../src/official-usage');

const NOW = Date.parse('2026-10-22T08:00:00.000Z');

test('console summary strings become numbers and micro-cents become dollars', () => {
  const s = normalizeSummary({
    totalRequests: '157',
    totalInputTokens: '1008921',
    totalOutputTokens: '120965',
    totalCacheReadTokens: '37932444',
    totalCacheWrite5mTokens: '40056',
    totalCacheWrite1hTokens: '1000',
    totalCostMicroCents: '46807031',
  });
  assert.equal(s.requests, 157);
  assert.equal(s.input, 1008921);
  assert.equal(s.output, 120965);
  assert.equal(s.cacheRead, 37932444);
  assert.equal(s.cacheWrite, 41056);
  assert.equal(s.cost, 0.46807);
});

test('missing summary fields degrade to zero instead of NaN', () => {
  assert.deepEqual(normalizeSummary({}), {
    requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    costMicroCents: 0, cost: 0,
  });
  assert.equal(normalizeSummary(null).requests, 0);
});

test('models are normalized and sorted by official cost', () => {
  const list = normalizeModels({
    items: [
      { model: 'cheap', provider: 'opencode-go', totalRequests: '9', totalInputTokens: '10', totalOutputTokens: '2', totalCostMicroCents: '1500' },
      { model: 'pricey', provider: 'opencode-go', totalRequests: '1', totalInputTokens: '2000', totalOutputTokens: '20', totalCostMicroCents: '900000' },
    ],
  });
  assert.deepEqual(list.map(m => m.id), ['pricey', 'cheap']);
  assert.equal(list[0].cost, 0.009);
  assert.equal(list[1].requests, 9);
  assert.equal(list[0].cacheRead, 0);
});

test('cost-by-day rows keep their date and money', () => {
  const daily = normalizeDaily([
    { date: '2026-10-21', totalTokens: '38969893', totalRequests: '151', totalCostMicroCents: '40636060' },
  ]);
  assert.deepEqual(daily, [{ date: '2026-10-21', tokens: 38969893, requests: 151, cost: 0.406361 }]);
  assert.deepEqual(normalizeDaily(null), []);
});

test('the dashboard window becomes an explicit ISO lower bound', () => {
  const day = windowFor(1, NOW);
  assert.equal(day.range, '24h');
  assert.equal(day.since, '2026-10-21T08:00:00.000Z');
  assert.equal(windowFor(7, NOW).since, '2026-10-15T08:00:00.000Z');
  assert.equal(windowFor(30, NOW).range, '30d');
});

test('90 days means everything, so no lower bound is sent', () => {
  const all = windowFor(90, NOW);
  assert.equal(all.days, 90);
  assert.equal(all.range, 'all');
  assert.equal(all.since, null);
});

test('day buckets are clamped to the ranges the console accepts', () => {
  assert.equal(clampDays(0), 1);
  assert.equal(clampDays(-4), 1);
  assert.equal(clampDays(999), 90);
  assert.equal(clampDays('7'), 7);
});
