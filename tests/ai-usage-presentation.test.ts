import assert from 'node:assert/strict';
import test from 'node:test';
import { aiUsageDate, aiUsageTimestamp, buildAiUsageChart } from '../src/screens/aiUsagePresentation';

test('AI chart keeps every request and outcome when grouping phone-sized ranges', () => {
  for (const days of [7, 30, 90]) {
    const trend = Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10),
      requests: index + 1,
      successfulDrafts: index,
      failedRequests: 1,
    }));
    const chart = buildAiUsageChart(trend);
    assert.ok(chart.length <= 7);
    assert.equal(chart[0]?.start, trend[0]?.date);
    assert.equal(chart.at(-1)?.end, trend.at(-1)?.date);
    for (const metric of ['requests', 'successfulDrafts', 'failedRequests'] as const) {
      assert.equal(chart.reduce((total, bucket) => total + bucket[metric], 0), trend.reduce((total, day) => total + day[metric], 0));
    }
    for (let index = 1; index < chart.length; index++) {
      assert.ok(chart[index]!.start > chart[index - 1]!.end);
    }
  }
  assert.deepEqual(buildAiUsageChart([]), []);
});

test('AI usage dates display Manila calendar boundaries consistently with daily buckets', () => {
  assert.equal(aiUsageDate('2026-10-10T16:00:00.000Z'), aiUsageDate('2026-10-11'));
  assert.equal(aiUsageDate('2026-10-11T15:59:59.000Z'), aiUsageDate('2026-10-11'));
  assert.equal(aiUsageDate('2026-10-11T16:00:00.000Z'), aiUsageDate('2026-10-12'));
  assert.equal(aiUsageDate('invalid'), 'invalid');
  assert.equal(aiUsageTimestamp('2026-10-10T16:00:00.000Z'), aiUsageTimestamp('2026-10-11T00:00:00+08:00'));
  const expectedTimestamp = new Date('2026-10-10T16:00:00Z').toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila',
  });
  assert.equal(aiUsageTimestamp('2026-10-10T16:00:00Z'), expectedTimestamp);
});
