const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { sanitizeAiGenerationMetadata } = require('../utils/aiGenerationMetadata');

const GENERATION_ENDPOINTS = {
  teacher: '/api/teacher/assessments/ai-generate',
  headteacher: '/api/headteacher/assessments/ai-generate',
};
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATABASE_PAGE_SIZE = 500;

function usageError(error) {
  const normalized = new Error(String(error?.message || 'Failed to read AI usage from Supabase'));
  normalized.name = 'SupabaseAiUsageError';
  normalized.code = error?.code;
  normalized.statusCode = 500;
  return normalized;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function dayKey(date) {
  return new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function usagePeriod(days, now) {
  const manilaDay = dayKey(now);
  const todayStart = new Date(`${manilaDay}T00:00:00.000Z`).getTime() - MANILA_OFFSET_MS;
  const start = new Date(todayStart - ((days - 1) * DAY_MS));
  return { start, end: now };
}

async function readGenerationLogs(client, start, end) {
  const rows = [];
  for (let offset = 0; ; offset += DATABASE_PAGE_SIZE) {
    const { data, error } = await client.from('audit_logs')
      .select('id,actor_user_id,actor_name,actor_identifier,actor_role,method,endpoint,succeeded,status_code,duration_ms,metadata,created_at')
      .eq('method', 'POST')
      .in('endpoint', Object.values(GENERATION_ENDPOINTS))
      .in('actor_role', Object.keys(GENERATION_ENDPOINTS))
      .not('actor_user_id', 'is', null)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + DATABASE_PAGE_SIZE - 1);
    if (error) throw usageError(error);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < DATABASE_PAGE_SIZE) break;
  }
  return rows;
}

async function getSupabaseAiUsage({ days = 30, page = 1, pageSize = 5 } = {}, dependencies = {}) {
  const requestedDays = Number(days);
  const periodDays = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const requestedPage = positiveInteger(page, 1);
  const resolvedPageSize = Math.min(50, positiveInteger(pageSize, 5));
  const now = dependencies.now ? new Date(dependencies.now) : new Date();
  const { start, end } = usagePeriod(periodDays, now);
  const client = dependencies.client || getSupabaseStorageClient();
  const rows = await readGenerationLogs(client, start, end);
  const summary = { requests: 0, successfulDrafts: 0, failedRequests: 0, activeCreators: 0, localFallbacks: 0 };
  const trend = Array.from({ length: periodDays }, (_, index) => ({
    date: dayKey(new Date(start.getTime() + index * DAY_MS)),
    requests: 0,
    successfulDrafts: 0,
    failedRequests: 0,
  }));
  const trendByDate = new Map(trend.map(bucket => [bucket.date, bucket]));
  const creatorsById = new Map();
  const recent = [];

  for (const row of rows) {
    const creatorId = String(row.actor_user_id || '').trim();
    const role = String(row.actor_role || '');
    const createdAt = new Date(row.created_at);
    // Recheck scope defensively and exclude denied requests to a different role's route.
    if (!creatorId || row.method !== 'POST' || GENERATION_ENDPOINTS[role] !== row.endpoint
      || !Number.isFinite(createdAt.getTime()) || createdAt < start || createdAt > end) continue;
    const metadata = sanitizeAiGenerationMetadata(row.metadata?.aiGeneration);
    const succeeded = row.succeeded === true;
    const creatorName = String(row.actor_name || row.actor_identifier || 'School staff').trim() || 'School staff';
    const creator = creatorsById.get(creatorId) || {
      id: creatorId,
      name: creatorName,
      role,
      requests: 0,
      successfulDrafts: 0,
      failedRequests: 0,
    };
    if (!creator.department && metadata.department) creator.department = metadata.department;
    creatorsById.set(creatorId, creator);
    const bucket = trendByDate.get(dayKey(createdAt));
    for (const target of [summary, creator, bucket]) {
      target.requests += 1;
      target[succeeded ? 'successfulDrafts' : 'failedRequests'] += 1;
    }
    if (succeeded && metadata.generationMode === 'provider-local-fallback') summary.localFallbacks += 1;
    const durationMs = Number(row.duration_ms);
    const entry = {
      id: String(row.id),
      creatorId,
      creatorName,
      creatorRole: role,
      createdAt: createdAt.toISOString(),
      succeeded,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    };
    for (const field of ['provider', 'model', 'subject', 'generationMode', 'requestedQuestions', 'generatedQuestions', 'providerRequests']) {
      if (metadata[field] !== undefined) entry[field] = metadata[field];
    }
    recent.push(entry);
  }

  summary.activeCreators = creatorsById.size;
  const creators = [...creatorsById.values()].sort((left, right) => right.requests - left.requests || left.name.localeCompare(right.name));
  recent.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const totalPages = Math.max(1, Math.ceil(recent.length / resolvedPageSize));
  const resolvedPage = Math.min(requestedPage, totalPages);
  const offset = (resolvedPage - 1) * resolvedPageSize;
  return {
    aiUsage: {
      period: { days: periodDays, start: start.toISOString(), end: end.toISOString() },
      summary,
      trend,
      creators,
      recent: recent.slice(offset, offset + resolvedPageSize),
      pagination: { page: resolvedPage, pageSize: resolvedPageSize, totalPages, totalRecords: recent.length },
    },
  };
}

module.exports = { getSupabaseAiUsage };
