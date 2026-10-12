'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAttendanceService, parseQr, validDate, sessionDto } = require('../lib/attendance');
const { createDeviceService } = require('../lib/devices');
const { createPushWorker, nextAttempt } = require('../lib/push-worker');
const { identityAuth, publicUser } = require('../lib/profile');
const { createDashboardService } = require('../lib/dashboard');

function fakeClient(tables = {}, rpcHandlers = {}) {
  const calls = [];
  return { calls, tables, async rpc(name, params) {
    calls.push({ name, params });
    return rpcHandlers[name] ? rpcHandlers[name](params) : { data: null, error: null };
  }, from(table) {
    let predicates = [];
    let patch;
    let single = false;
    let limit = Infinity;
    const request = {
      select() { return request; }, eq(key, value) { predicates.push((row) => row[key] === value); return request; },
      lte(key, value) { predicates.push((row) => row[key] <= value); return request; },
      order() { return request; }, limit(value) { limit = value; return request; },
      update(value) { patch = value; return request; }, maybeSingle() { single = true; return request; },
      then(resolve, reject) {
        const selected = (tables[table] || []).filter((row) => predicates.every((predicate) => predicate(row))).slice(0, limit);
        if (patch) selected.forEach((row) => Object.assign(row, patch));
        return Promise.resolve({ data: single ? selected[0] || null : selected, error: null }).then(resolve, reject);
      },
    };
    return request;
  } };
}

const teacher = { _id: 'teacher1', role: 'teacher', tokenVersion: 0 };
const student = { _id: 'student1', role: 'student' };
const token = crypto.randomBytes(32).toString('base64url');
const qrPayload = `edumatch://attendance/session1?token=${token}`;

test('QR parser rejects other URLs, malformed secrets, and forged paths', () => {
  const parsed = parseQr(qrPayload);
  assert.equal(parsed.id, 'session1');
  assert.equal(parsed.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  for (const invalid of ['https://evil.example/attendance/session1', 'edumatch://other/session1?token=' + token,
    qrPayload + '&studentId=other', qrPayload + '&token=' + token, qrPayload + '#fragment',
    'edumatch://attendance/a/b?token=' + token, 'edumatch://attendance/session1?token=x', null]) {
    assert.throws(() => parseQr(invalid), /Invalid/);
  }
});

test('impossible attendance dates are rejected', () => {
  assert.equal(validDate('2026-10-09'), '2026-10-09');
  for (const invalid of ['2026-02-30', '2026-13-01', '09-10-2026', undefined]) assert.throws(() => validDate(invalid));
});

test('teachers cannot scan and students cannot finalize or create sessions', async () => {
  const client = fakeClient();
  const attendance = createAttendanceService(client);
  await assert.rejects(attendance.scan(teacher, { qrPayload }), { statusCode: 403 });
  await assert.rejects(attendance.finalize(student, 'session1'), { statusCode: 403 });
  await assert.rejects(attendance.create(student, {}), { statusCode: 403 });
  assert.equal(client.calls.length, 0);
});

test('session creation uses current server school date and never client teacher identity', async () => {
  const client = fakeClient({}, { mobile_create_attendance_session: async (params) => ({ data: {
    id:params.p_id,subject_id:params.p_subject_id,date_key:params.p_date_key,status:'open',
  } }) });
  const attendance = createAttendanceService(client, { now: () => new Date('2026-10-08T16:30:00Z') });
  await assert.rejects(attendance.create(teacher, { subjectId:'class1',dateKey:'2026-10-08' }), { statusCode:400 });
  const result = await attendance.create(teacher, { subjectId:'class1',dateKey:'2026-10-09',teacherId:'forged' });
  assert.equal(client.calls[0].params.p_teacher_id,teacher._id);
  assert.equal(client.calls[0].params.p_token_hash,parseQr(result.qrPayload).tokenHash);
  assert.equal(result.session.dateKey,'2026-10-09');
});

test('scans use authenticated identity and token hash, ignoring client status/studentId', async () => {
  const result = { attendance: { sessionId: 'session1', status: 'Present' }, duplicate: true };
  const client = fakeClient({}, { mobile_scan_attendance: async () => ({ data: result }) });
  assert.deepEqual(await createAttendanceService(client).scan(student, { qrPayload, studentId: 'forged', status: 'Absent' }), result);
  assert.equal(client.calls[0].params.p_student_id, 'student1');
  assert.equal(client.calls[0].params.p_token_hash.length, 64);
  assert.equal(Object.keys(client.calls[0].params).length, 3);
});

test('database QR expiration, roster authorization, and finalization failures preserve HTTP semantics', async () => {
  for (const [code, statusCode] of [['55000', 409], ['42501', 403], ['P0002', 404]]) {
    const client = fakeClient({}, { mobile_scan_attendance: async () => ({ error: { code, message: 'Denied by server' } }) });
    await assert.rejects(createAttendanceService(client).scan(student, { qrPayload }), { statusCode });
  }
});

test('teacher detail does not expose another teacher session or raw QR secret', async () => {
  const client = fakeClient({ mobile_attendance_sessions: [{ id: 'session1', teacher_id: 'other', token_hash: 'secret' }] });
  await assert.rejects(createAttendanceService(client).detail(teacher, 'session1'), { statusCode: 404 });
  assert.equal('token_hash' in sessionDto({ id: 'session1', token_hash: 'secret' }), false);
});

test('duplicate/malformed finalize overrides never reach the database', async () => {
  const client = fakeClient();
  const attendance = createAttendanceService(client);
  for (const overrides of [[{ studentId: 's1', status: 'Present' }, { studentId: 's1', status: 'Late' }],
    [{ studentId: 's1', status: 'Invalid' }], null]) {
    if (overrides === null) continue;
    await assert.rejects(attendance.finalize(teacher, 'session1', { overrides }), { statusCode: 400 });
  }
  assert.equal(client.calls.length, 0);
});

test('device registration requires app project, active session, and authenticated user ownership', async () => {
  const body = { installationId: 'installation1234567', expoPushToken: 'ExpoPushToken[abcdefghijk]', platform: 'android', projectId: 'project1', userId: 'forged' };
  const client = fakeClient({}, { mobile_register_device: async () => ({ data: { installation_id: body.installationId, platform: 'android', enabled: true } }) });
  const devices = createDeviceService(client, 'project1');
  await assert.rejects(devices.register(teacher, { ...body, projectId: 'foreign' }, { _id: 'session1' }), { statusCode: 403 });
  await assert.rejects(devices.register(teacher, body), { statusCode: 401 });
  await devices.register(teacher, body, { _id: 'session1' });
  assert.equal(client.calls[0].params.p_user_id, teacher._id);
  assert.equal(client.calls[0].params.p_session_id, 'session1');
});

test('device unregister cannot disable another account installation', async () => {
  const client = fakeClient({ mobile_devices: [{ installation_id: 'installation1234567', user_id: 'other', enabled: true }] });
  await createDeviceService(client, 'project1').unregister(teacher, 'installation1234567');
  assert.equal(client.tables.mobile_devices[0].enabled, true);
});

test('old logout response cannot unregister the same account new login session', async () => {
  const client = fakeClient({ mobile_devices: [{ installation_id: 'installation1234567', user_id: teacher._id, session_id:'new', enabled: true }] });
  const devices = createDeviceService(client, 'project1');
  await devices.unregister(teacher, 'installation1234567', { _id:'old' });
  assert.equal(client.tables.mobile_devices[0].enabled, true);
  await devices.unregister(teacher, 'installation1234567', { _id:'new' });
  assert.equal(client.tables.mobile_devices[0].enabled, false);
});

test('identity request retains original route metadata and exposes only safe profile fields', async () => {
  const req = { baseUrl: '/api/mobile', path: '/me', method: 'GET' };
  let checked;
  const middleware = identityAuth((scoped, res, next) => {
    checked = { baseUrl: scoped.baseUrl, path: scoped.path };
    scoped.user = { ...teacher, password: 'secret', tokenVersion: 4, forcePasswordChange: true };
    next();
  });
  await new Promise((resolve, reject) => middleware(req, {}, (error) => error ? reject(error) : resolve()));
  assert.deepEqual(checked, { baseUrl: '/api/auth', path: '/sessions' });
  assert.equal(req.path, '/me');
  assert.equal(publicUser(req.user, req).forcePasswordChange, true);
  assert.equal('password' in publicUser(req.user, req), false);
});

test('dashboard executes controllers only for current authorized role', async () => {
  const called = [];
  const controller = (name, payload) => (req, res) => { called.push(name); res.status(200).json(payload); };
  const dashboard = createDashboardService({ teacher: {
    getTeacherSubjects: controller('subjects', { subjects: [{ approvedStudentsCount: 3 }] }),
    getEnrollmentRequests: controller('requests', { requests: [{ id: 'r1' }] }),
  } });
  const result = await dashboard({ user: teacher });
  assert.deepEqual(called.sort(), ['requests', 'subjects']);
  assert.equal(result.metrics[1].value, 3);
  await assert.rejects(dashboard({ user: { _id: 'u1', role: 'principal' } }), { statusCode: 403 });
});

test('Expo ticket success schedules receipt validation and payload excludes school records', async () => {
  const job = { id: 1, status: 'sending', attempts: 1, installation_id: 'i1', session_id: 's1',
    expoPushToken: 'ExpoPushToken[abcdefghijk]', notificationId: 'n1', notificationType: 'grade_released' };
  const client = fakeClient({ mobile_push_jobs: [job] }, { mobile_claim_push_jobs: async () => ({ data: [{ ...job }] }) });
  let sent;
  const worker = createPushWorker(client, { projectId: 'project1', now: () => 1000000,
    fetchImpl: async (url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket1' }] }) }; } });
  assert.equal(await worker.sendBatch(), 1);
  assert.equal(job.status, 'ticket');
  assert.equal(job.ticket_id, 'ticket1');
  assert.equal(Date.parse(job.available_at), 1900000);
  assert.equal(sent[0].data.route, '/notifications');
  assert.equal(sent[0].channelId, 'school-updates');
  assert.equal(sent[0].body, 'You have a new school update.');
});

test('DeviceNotRegistered receipt disables only same session and retires job', async () => {
  const job = { id: 1, status: 'ticket', attempts: 1, ticket_id: 'ticket1', installation_id: 'i1', session_id: 'old',
    available_at: new Date(0).toISOString(), ticket_at: new Date(0).toISOString() };
  const client = fakeClient({ mobile_push_jobs: [job], mobile_devices: [{ installation_id: 'i1', session_id: 'new', enabled: true }] });
  const worker = createPushWorker(client, { projectId: 'project1', now: () => 1000000,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { ticket1: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }) }) });
  await worker.checkReceipts();
  assert.equal(job.status, 'dead');
  assert.equal(client.tables.mobile_devices[0].enabled, true);
});

test('Expo transient outage applies bounded exponential retry', async () => {
  const job = { id: 1, status: 'sending', attempts: 2, expoPushToken: 'ExpoPushToken[abcdefghijk]' };
  const client = fakeClient({ mobile_push_jobs: [job] }, { mobile_claim_push_jobs: async () => ({ data: [{ ...job }] }) });
  const worker = createPushWorker(client, { projectId: 'project1', now: () => 1000000,
    fetchImpl: async () => ({ ok: false, status: 503 }) });
  await worker.sendBatch();
  assert.equal(job.status, 'pending');
  assert.equal(Date.parse(job.available_at), 1004000);
  assert.equal(Date.parse(nextAttempt(100, 1000000)), 4600000);
});

test('successful receipts are recorded without resending the message', async () => {
  const job = { id: 1, status: 'ticket', ticket_id: 'ticket1', available_at: new Date(0).toISOString() };
  const client = fakeClient({ mobile_push_jobs: [job] });
  let requests = 0;
  const worker = createPushWorker(client, { projectId: 'project1', fetchImpl: async (url) => {
    assert.match(url, /getReceipts$/); requests += 1;
    return { ok: true, json: async () => ({ data: { ticket1: { status: 'ok' } } }) };
  } });
  await worker.checkReceipts();
  assert.equal(job.status, 'delivered');
  assert.equal(requests, 1);
});
