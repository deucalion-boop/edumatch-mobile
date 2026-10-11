'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { sanitizeAiGenerationMetadata } = require('../../backend/utils/aiGenerationMetadata');

const backendRoot = join(__dirname, '../../backend');
const NOW = '2026-10-11T06:00:00.000Z';
const TEACHER_ENDPOINT = '/api/teacher/assessments/ai-generate';
const HEADTEACHER_ENDPOINT = '/api/headteacher/assessments/ai-generate';
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule(path, requireMock, globals = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(join(backendRoot, path), 'utf8'), {
    module, exports: module.exports, require: requireMock, console, ...globals,
  });
  return module.exports;
}

const usageService = loadModule('services/supabaseAiUsageService.js', name => {
  if (name === '../utils/aiGenerationMetadata') return { sanitizeAiGenerationMetadata };
  if (name === './supabaseStorageService') return {
    getSupabaseStorageClient() { assert.fail('Tests must inject a client; no live database is used.'); },
  };
  throw new Error(`Unexpected dependency: ${name}`);
});

function log(overrides = {}) {
  return {
    id: 'row-001', actor_user_id: 'teacher-1', actor_name: 'Science Teacher', actor_role: 'teacher',
    endpoint: TEACHER_ENDPOINT, method: 'POST', succeeded: true, status_code: 200,
    duration_ms: 1200, created_at: '2026-10-11T04:00:00.000Z', metadata: {}, ...overrides,
  };
}

function database(rows, { ignoreFilters = false, error = null } = {}) {
  const queries = [];
  const client = { from(table) {
    assert.equal(table, 'audit_logs');
    const calls = [];
    const filters = [];
    const orders = [];
    queries.push(calls);
    const query = {
      select(fields) { calls.push(['select', fields]); return query; },
      eq(field, value) { calls.push(['eq', field, value]); filters.push(row => row[field] === value); return query; },
      in(field, values) { calls.push(['in', field, plain(values)]); filters.push(row => values.includes(row[field])); return query; },
      not(field, operator, value) { calls.push(['not', field, operator, value]); filters.push(row => row[field] !== value); return query; },
      gte(field, value) { calls.push(['gte', field, value]); filters.push(row => new Date(row[field]) >= new Date(value)); return query; },
      lte(field, value) { calls.push(['lte', field, value]); filters.push(row => new Date(row[field]) <= new Date(value)); return query; },
      order(field, options) { calls.push(['order', field, plain(options)]); orders.push([field, options]); return query; },
      async range(start, end) {
        calls.push(['range', start, end]);
        let selected = rows.filter(row => ignoreFilters || filters.every(filter => filter(row)));
        selected.sort((left, right) => {
          for (const [field, { ascending }] of orders) {
            const difference = String(left[field]).localeCompare(String(right[field]));
            if (difference) return ascending ? difference : -difference;
          }
          return 0;
        });
        return { data: selected.slice(start, end + 1), error };
      },
    };
    return query;
  } };
  return { client, queries };
}

async function usage(rows, params = {}, options = {}) {
  const db = database(rows, options);
  const result = plain(await usageService.getSupabaseAiUsage(params, { client: db.client, now: NOW }));
  return { ...result, queries: db.queries };
}

test('AI usage counts exact authenticated generation routes, outcomes and fallback drafts', async () => {
  const rows = [
    log({ metadata: { aiGeneration: { provider: 'openrouter', model: 'model-one', subject: 'Science', department: 'Science', requestedQuestions: 10, generatedQuestions: 8, providerRequests: 2, generationMode: 'openrouter-api' } } }),
    log({ id: 'row-002', succeeded: false, status_code: 502, created_at: '2026-10-11T03:00:00.000Z' }),
    log({ id: 'row-003', actor_user_id: 'headteacher-1', actor_name: 'Department Head', actor_role: 'headteacher', endpoint: HEADTEACHER_ENDPOINT, created_at: '2026-10-10T15:00:00.000Z', metadata: { aiGeneration: { generationMode: 'provider-local-fallback' } } }),
    log({ id: 'row-004', actor_user_id: 'teacher-2', created_at: '2026-10-05T01:00:00.000Z' }),
    log({ id: 'manual', endpoint: '/api/teacher/assessments' }),
    log({ id: 'evaluation', endpoint: '/api/teacher/assessments/essay-evaluate' }),
    log({ id: 'recommendation', endpoint: '/api/recommendation/recompute/:studentId' }),
    log({ id: 'wrong-method', method: 'GET' }),
    log({ id: 'suffix', endpoint: `${TEACHER_ENDPOINT}/other` }),
    log({ id: 'student', actor_role: 'student' }),
    log({ id: 'admin', actor_role: 'admin' }),
    log({ id: 'unauthenticated', actor_user_id: null, actor_role: '', succeeded: false, status_code: 401 }),
    log({ id: 'denied-other-role', endpoint: HEADTEACHER_ENDPOINT, succeeded: false, status_code: 403 }),
    log({ id: 'invalid-date', created_at: 'invalid' }),
    log({ id: 'future', created_at: '2026-10-11T06:00:00.001Z' }),
    log({ id: 'too-old', created_at: '2026-10-04T15:59:59.999Z' }),
  ];
  // Also verify application scope even if an adapter unexpectedly returns unrelated rows.
  const { aiUsage, queries } = await usage(rows, { days: 7 }, { ignoreFilters: true });
  assert.deepEqual(aiUsage.summary, { requests: 4, successfulDrafts: 3, failedRequests: 1, activeCreators: 3, localFallbacks: 1 });
  assert.deepEqual(aiUsage.period, { days: 7, start: '2026-10-04T16:00:00.000Z', end: NOW });
  assert.equal(aiUsage.trend.length, 7);
  assert.deepEqual(aiUsage.trend.at(-1), { date: '2026-10-11', requests: 2, successfulDrafts: 1, failedRequests: 1 });
  assert.deepEqual(aiUsage.creators[0], { id: 'teacher-1', name: 'Science Teacher', role: 'teacher', requests: 2, successfulDrafts: 1, failedRequests: 1, department: 'Science' });
  assert.equal(aiUsage.recent[0].providerRequests, 2);
  assert.equal(aiUsage.recent[0].generatedQuestions, 8);
  assert.equal(aiUsage.recent[0].model, 'model-one');
  assert.equal('model' in aiUsage.recent.find(row => row.id === 'row-004'), false);
  assert(queries[0].some(call => call[0] === 'eq' && call[1] === 'method' && call[2] === 'POST'));
  assert.deepEqual(queries[0].find(call => call[0] === 'in' && call[1] === 'endpoint')[2], [TEACHER_ENDPOINT, HEADTEACHER_ENDPOINT]);
  assert.deepEqual(queries[0].find(call => call[0] === 'in' && call[1] === 'actor_role')[2], ['teacher', 'headteacher']);
});

test('AI usage reads beyond 1000 rows and paginates the full filtered history', async () => {
  const rows = Array.from({ length: 1023 }, (_, index) => log({ id: `row-${String(index).padStart(4, '0')}`, succeeded: index % 2 === 0 }));
  rows.push(log({ id: 'wrong-role', endpoint: HEADTEACHER_ENDPOINT, succeeded: false }));
  const { aiUsage, queries } = await usage(rows, { days: 30, page: 205, pageSize: 5 });
  assert.deepEqual(queries.map(query => query.find(call => call[0] === 'range')), [['range', 0, 499], ['range', 500, 999], ['range', 1000, 1499]]);
  assert.equal(aiUsage.summary.requests, 1023);
  assert.equal(aiUsage.summary.successfulDrafts, 512);
  assert.equal(aiUsage.summary.failedRequests, 511);
  assert.deepEqual(aiUsage.pagination, { page: 205, pageSize: 5, totalPages: 205, totalRecords: 1023 });
  assert.deepEqual(aiUsage.recent.map(row => row.id), ['row-0002', 'row-0001', 'row-0000']);
  assert.equal(aiUsage.trend.reduce((total, day) => total + day.requests, 0), 1023);
});

test('Manila calendar boundaries include the first day and clamp pagination and supported periods', async () => {
  const rows = [log({ id: 'at-start', created_at: '2026-10-04T16:00:00.000Z' }), log({ id: 'before-start', created_at: '2026-10-04T15:59:59.999Z' })];
  const { aiUsage } = await usage(rows, { days: '7', page: 999, pageSize: 1 });
  assert.equal(aiUsage.summary.requests, 1);
  assert.deepEqual(aiUsage.trend[0], { date: '2026-10-05', requests: 1, successfulDrafts: 1, failedRequests: 0 });
  assert.equal(aiUsage.pagination.page, 1);
  const { aiUsage: empty } = await usage([], { days: 'invalid', page: '-2', pageSize: 900 });
  assert.equal(empty.period.days, 30);
  assert.deepEqual(empty.pagination, { page: 1, pageSize: 50, totalPages: 1, totalRecords: 0 });
  assert.equal(empty.trend.length, 30);
  const { aiUsage: longest } = await usage([], { days: 90, page: Infinity, pageSize: 0 });
  assert.equal(longest.trend.length, 90);
  assert.equal(longest.pagination.pageSize, 5);
});

test('AI usage propagates storage failures instead of displaying empty successful analytics', async () => {
  const db = database([], { error: { message: 'Audit storage unavailable', code: 'AUDIT_FAILURE' } });
  await assert.rejects(usageService.getSupabaseAiUsage({}, { client: db.client, now: NOW }), error => {
    assert.equal(error.message, 'Audit storage unavailable');
    assert.equal(error.name, 'SupabaseAiUsageError');
    assert.equal(error.statusCode, 500);
    assert.equal(error.code, 'AUDIT_FAILURE');
    return true;
  });
});

test('AI audit metadata whitelists operational fields and rejects secrets, content and invalid counts', () => {
  const safe = sanitizeAiGenerationMetadata({
    provider: ' openrouter ', model: 'm'.repeat(300), subject: ' Science ', requestedQuestions: 10.9,
    generatedQuestions: -1, providerRequests: Infinity, apiKey: 'secret', baseUrl: 'secret-host',
    prompt: 'student content', questions: [{ questionText: 'private question' }], output: 'private output',
  });
  assert.deepEqual(safe, { provider: 'openrouter', model: 'm'.repeat(160), subject: 'Science', requestedQuestions: 10 });
  assert.deepEqual(sanitizeAiGenerationMetadata({ generatedQuestions: 0, providerRequests: 2 }), { generatedQuestions: 0, providerRequests: 2 });
  assert.deepEqual(sanitizeAiGenerationMetadata({ subject: { private: true }, requestedQuestions: '10' }), {});
});

test('audit middleware persists safe server context without trusting body AI metadata', async () => {
  const saved = [];
  const middleware = loadModule('middlewares/auditLogMiddleware.js', name => {
    if (name === '../services/supabaseAuditLogService') return { async createAuditLog(payload) { saved.push(plain(payload)); } };
    if (name === '../utils/aiGenerationMetadata') return { sanitizeAiGenerationMetadata };
    throw new Error(`Unexpected dependency: ${name}`);
  }, { setImmediate });
  const req = {
    method: 'POST', originalUrl: TEACHER_ENDPOINT, baseUrl: '/api/teacher', route: { path: '/assessments/ai-generate' },
    headers: {}, user: { _id: 'teacher-1', name: 'Teacher', role: 'teacher' },
    body: { password: 'secret', aiGeneration: { provider: 'body-spoof', apiKey: 'secret' }, topic: 'private lesson content' },
    auditLogContext: { aiGeneration: { provider: 'openrouter', providerRequests: 1, apiKey: 'secret', prompt: 'private prompt' } },
  };
  let finished;
  middleware(req, { statusCode: 200, on(event, callback) { assert.equal(event, 'finish'); finished = callback; } }, () => {});
  finished();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved[0].metadata.aiGeneration, { provider: 'openrouter', providerRequests: 1 });
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  assert.equal(JSON.stringify(saved).includes('private lesson content'), false);
  assert.equal(saved[0].succeeded, true);
});

function generationHarness(outputs, { isEnabled = true } = {}) {
  const calls = [];
  const controller = loadModule('controllers/aiController.js', name => {
    if (name === 'path') return require('node:path');
    if (name === 'openai') return class { constructor() { assert.fail('Unexpected OpenAI SDK request'); } };
    if (name === '../utils/aiRuntimeConfig') return { getAiRuntimeConfigFromEnv: () => ({ provider: 'openrouter', model: 'model-one', apiKey: 'secret-provider-key', maxTokens: 1024, temperature: 0.3, isEnabled }) };
    if (name === '../utils/responseHelper') return { sendSuccess(res, statusCode, message, body) { Object.assign(res, { statusCode, message, body: plain(body) }); } };
    if (name === '../constants/userRoles') return { ROLE_HEADTEACHER: 'headteacher', ROLE_TEACHER: 'teacher' };
    if (name === '../constants/strandSubjects') return { normalizeStrand: () => '', getSubjectCategory: () => 'Science' };
    if (name === '../services/recommendationService') return { normalizeSubjectCategory: () => 'Science' };
    if (name === '../services/assessmentPolicyService') return {
      parseExamDurationMinutes: value => Number(value), parseSubmissionDeadline: () => null,
      buildAssessmentPolicy: () => ({ assessmentMode: 'activity', gradingPeriod: '', countsTowardRecommendation: false, assignmentScope: 'handled_class' }),
    };
    return {};
  }, { async fetch(url, options) {
    calls.push({ url, options });
    const output = outputs[calls.length - 1];
    assert.notEqual(output, undefined, 'Unexpected extra provider call');
    if (output instanceof Error) throw output;
    return { ok: true, async json() { return { choices: [{ message: { content: output } }] }; } };
  } });
  return { calls, async generate() {
    const req = { user: { _id: 'teacher-1', role: 'teacher', subject: 'Science', department: 'Science' }, body: {
      subjectId: 'subject-1', subject: 'Science', topic: 'Private lesson content', examType: 'multiple-choice',
      difficulty: 'medium', numberOfItems: 2, examDurationMinutes: 30,
    } };
    const res = {};
    let error;
    await controller.generateAssessmentWithAi(req, res, value => { error = value; });
    return { metadata: plain(req.auditLogContext?.aiGeneration), res, error };
  } };
}

const validOutput = JSON.stringify({ title: 'Generated draft', questions: [
  { questionText: 'Private generated question', options: ['A', 'B'], correctAnswer: 'A' },
  { questionText: 'Another private question', options: ['A', 'B'], correctAnswer: 'B' },
] });

test('AI generation captures provider, model and returned question counts without content or API keys', async () => {
  const harness = generationHarness([validOutput]);
  const { metadata, res, error } = await harness.generate();
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(metadata, { provider: 'openrouter', model: 'model-one', subject: 'Science', department: 'Science', difficulty: 'medium', examType: 'multiple-choice', requestedQuestions: 2, providerRequests: 1, generationMode: 'openrouter-api', generatedQuestions: 2 });
  assert.equal(JSON.stringify(metadata).includes('Private'), false);
  assert.equal(JSON.stringify(metadata).includes('secret-provider-key'), false);
});

test('AI generation counts repair calls and distinguishes deterministic fallback drafts', async () => {
  const repaired = generationHarness(['invalid provider output', validOutput]);
  const repairedResult = await repaired.generate();
  assert.equal(repairedResult.error, undefined);
  assert.equal(repairedResult.metadata.providerRequests, 2);
  assert.equal(repairedResult.metadata.generationMode, 'openrouter-api');
  const fallback = generationHarness(['invalid provider output', 'still invalid']);
  const fallbackResult = await fallback.generate();
  assert.equal(fallbackResult.error, undefined);
  assert.equal(fallbackResult.metadata.providerRequests, 2);
  assert.equal(fallbackResult.metadata.generationMode, 'provider-local-fallback');
  assert.equal(fallbackResult.metadata.generatedQuestions, 2);
});

test('failed provider calls and disabled generation retain accurate operational counts', async () => {
  const failing = generationHarness([new Error('Provider unavailable')]);
  const result = await failing.generate();
  assert.equal(result.error.statusCode, 502);
  assert.equal(result.metadata.providerRequests, 1);
  assert.equal('generatedQuestions' in result.metadata, false);
  const disabled = generationHarness([], { isEnabled: false });
  const disabledResult = await disabled.generate();
  assert.equal(disabledResult.error.statusCode, 403);
  assert.equal(disabledResult.metadata.providerRequests, 0);
  assert.equal(disabled.calls.length, 0);
});

test('manual assessments no longer become fabricated AI totals in legacy analytics', async () => {
  const rows = { users: [], lessons: [], assessments: [
    { id: 'manual-1', title: 'Manual activity', exam_type: 'practical', difficulty: 'easy', created_at: NOW },
    { id: 'manual-2', title: 'Manual exam', exam_type: 'written', difficulty: 'hard', created_at: NOW },
  ] };
  const service = loadModule('services/supabaseAnalyticsService.js', name => {
    assert.equal(name, './supabaseStorageService');
    return { getSupabaseStorageClient: () => ({ from(table) { return { async select() { return { data: rows[table], error: null }; } }; } }) };
  });
  const result = plain(await service.getSupabaseAnalytics());
  assert.equal(result.analytics.totalAssessments, 2);
  assert.equal(result.aiAnalytics.trackingAvailable, false);
  assert.equal(result.aiAnalytics.totalGeneratedExams, null);
  assert.equal(result.aiAnalytics.unattemptedExams, null);
  assert.deepEqual(result.aiAnalytics.examTypes, []);
});

test('AI usage route requires administrator authentication and forwards query options', async () => {
  const calls = [];
  const admin = loadModule('controllers/adminController.js', name => {
    if (name === '../services/supabaseAiUsageService') return { async getSupabaseAiUsage(options) { calls.push(plain(options)); return { aiUsage: { summary: { requests: 4 } } }; } };
    if (name === '../utils/responseHelper') return { sendSuccess(res, status, message, body) { Object.assign(res, { status, message, body }); } };
    return {};
  });
  const res = {};
  await admin.getAiUsage({ query: { days: '7', page: '2', pageSize: '5' } }, res, error => { throw error; });
  assert.deepEqual(calls, [{ days: '7', page: '2', pageSize: '5' }]);
  assert.equal(res.status, 200);
  assert.equal(res.body.aiUsage.summary.requests, 4);

  const routes = [];
  const auth = () => {};
  const adminOnly = () => {};
  const router = {
    use(...middleware) { routes.push(['use', ...middleware]); },
    route() { return { post() { return this; }, get() { return this; }, put() { return this; }, delete() { return this; } }; },
    get(path, ...handler) { routes.push(['get', path, ...handler]); }, post() {}, put() {}, patch() {},
  };
  loadModule('routes/adminRoutes.js', name => {
    if (name === 'express') return { Router: () => router };
    if (name === '../middlewares/authMiddleware') return auth;
    if (name === '../middlewares/roleMiddleware') return role => { assert.equal(role, 'admin'); return adminOnly; };
    if (name === '../controllers/adminController') return admin;
    if (name === '../utils/uploadMiddleware') return { uploadProfileImage: { single: () => () => {} } };
    return {};
  });
  assert.deepEqual(routes[0], ['use', auth, adminOnly]);
  assert.deepEqual(routes.find(route => route[1] === '/ai-usage'), ['get', '/ai-usage', admin.getAiUsage]);
});
