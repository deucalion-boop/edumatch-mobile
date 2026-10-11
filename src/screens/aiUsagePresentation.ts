import type { AiUsageTrend } from '../api/types';

export interface AiUsageChartBucket {
  start: string;
  end: string;
  requests: number;
  successfulDrafts: number;
  failedRequests: number;
}

/** Keep all days in the totals while fitting the chart on small phone screens. */
export function buildAiUsageChart(trend: readonly AiUsageTrend[]): AiUsageChartBucket[] {
  const bucketSize = Math.max(1, Math.ceil(trend.length / 7));
  const buckets: AiUsageChartBucket[] = [];
  for (let offset = 0; offset < trend.length; offset += bucketSize) {
    const days = trend.slice(offset, offset + bucketSize);
    buckets.push({
      start: days[0]!.date,
      end: days[days.length - 1]!.date,
      requests: days.reduce((total, day) => total + day.requests, 0),
      successfulDrafts: days.reduce((total, day) => total + day.successfulDrafts, 0),
      failedRequests: days.reduce((total, day) => total + day.failedRequests, 0),
    });
  }
  return buckets;
}

export function aiUsageDate(value: string) {
  const isDateKey = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isDateKey ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: isDateKey ? 'UTC' : 'Asia/Manila' });
}

export function aiUsageTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila',
  });
}
