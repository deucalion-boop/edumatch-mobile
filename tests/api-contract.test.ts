import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { Approval, CreateUserInput, Role } from '../src/api/types';

// Keep test transport isolated; the shipped client always calls the configured API.
process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:5099/api';
Object.defineProperty(globalThis, '__DEV__', { value: true, configurable: true });
const modules = Promise.all([import('../src/api/client'), import('../src/api/edumatch')]);
type CapturedRequest = { method: string; url: string; body: unknown; authorization: unknown };
async function transport(handler: (request: CapturedRequest) => unknown) {
  const [{ api, setAccessToken }, endpoints] = await modules;
  const captured: CapturedRequest[] = [];
  api.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const request = { method: config.method || 'get', url: config.url || '',
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
      authorization: config.headers.Authorization };
    captured.push(request);
    return { data: handler(request), status: 200, statusText: 'OK', headers: {}, config };
  };
  setAccessToken(null);
  return { captured, setAccessToken, ...endpoints };
}

test('login preserves OTP timing and verifies a fresh CAPTCHA before accepting the server role', async () => {
  const { authApi, captured } = await transport(request => request.url === '/auth/login'
    ? { success: true, requiresOtp: true, challengeToken: 'challenge', deliveryHint: 'm***@gmail.com',
      expiresAt: '2026-10-09T03:00:00Z', resendAvailableAt: '2026-10-09T02:58:30Z' }
    : { success: true, token: 'verified-jwt', user: { _id: 'principal-1', name: 'Principal', email: 'p@gmail.com',
      role: 'principal', forcePasswordChange: true } });
  const challenge = await authApi.login({ username: 'principal', password: 'secret', captchaToken: 'captcha-one', remember: true });
  assert.equal('challengeToken' in challenge && challenge.challengeToken, 'challenge');
  assert.equal('expiresAt' in challenge && challenge.expiresAt, '2026-10-09T03:00:00Z');
  const session = await authApi.verifyOtp({ challengeToken: 'challenge', otpCode: '123456', captchaToken: 'captcha-two' });
  assert.equal(session.user.id, 'principal-1');
  assert.equal(session.user.role, 'admin');
  assert.equal(session.user.forcePasswordChange, true);
  assert.equal(session.token, 'verified-jwt');
  assert.deepEqual(captured.map(item => [item.url, item.body]), [
    ['/auth/login', { username: 'principal', password: 'secret', captchaToken: 'captcha-one', remember: true }],
    ['/auth/login/verify-otp', { challengeToken: 'challenge', otpCode: '123456', captchaToken: 'captcha-two' }],
  ]);
});

test('rehydration uses authenticated mobile profile and never defaults an unknown role to admin', async () => {
  const { authApi, normalizeRole, captured, setAccessToken } = await transport(() => ({ success: true,
    user: { id: 'student-1', name: 'Student', email: 's@gmail.com', role: 'student' } }));
  setAccessToken('stored-jwt');
  assert.equal((await authApi.me()).role, 'student');
  assert.equal(captured[0]?.url, '/mobile/me');
  assert.equal(captured[0]?.authorization, 'Bearer stored-jwt');
  assert.throws(() => normalizeRole('superuser'), /unsupported account role/);
});

test('legacy account authentication fields are removed before they enter mobile caches', async () => {
  const { edumatchApi } = await transport(() => ({ success: true, users: [{ id: 'student-1', role: 'student', name: 'Learner', email: 's@gmail.com',
    password: 'server-password-hash', tokenVersion: 3, invite: { tokenHash: 'invite-hash' }, resetPassword: { tokenHash: 'reset-hash' },
    progress: { averageScore: 85 } }] }));
  const account = (await edumatchApi.users('admin'))[0]!;
  assert.equal(account.password, undefined); assert.equal(account.invite, undefined); assert.equal(account.resetPassword, undefined);
  assert.equal(account.tokenVersion, undefined); assert.deepEqual(account.progress, { averageScore: 85 });
  const record = (await edumatchApi.records('admin'))[0]!;
  assert.equal(record.raw.password, undefined);
});

test('unsupported role operations fail before making a request', async () => {
  const { edumatchApi, captured } = await transport(() => ({ success: true }));
  await assert.rejects(() => edumatchApi.subjects('admin'), /unavailable for your role/);
  const approval: Approval = { id: 'request-1', title: 'Export', subtitle: '', kind: 'export', raw: {} };
  await assert.rejects(() => edumatchApi.reviewApproval('secretary', approval, 'approved'), /unavailable for your role/);
  assert.equal(captured.length, 0);
});

test('account creation requires username before sending requests for every creator role', async () => {
  const { edumatchApi, captured } = await transport(() => ({ success: true }));
  for (const role of ['admin', 'secretary', 'headteacher', 'teacher'] as const) {
    for (const username of [undefined, '', ' \t\n ']) {
      const input = { name: 'School User', email: 'user@gmail.com', role: 'student', username } as CreateUserInput;
      await assert.rejects(() => edumatchApi.createUser(role, input), /Username is required/);
    }
  }
  assert.equal(captured.length, 0);
});

test('every account creation route submits and returns the chosen username', async () => {
  const { edumatchApi, captured } = await transport(request => ({ success: true,
    user: { id: 'new-user', ...(request.body as CreateUserInput) } }));
  const cases: [Role, Role, string][] = [
    ['admin', 'student', '/admin/users'],
    ['admin', 'teacher', '/admin/users'],
    ['admin', 'headteacher', '/admin/users'],
    ['admin', 'secretary', '/admin/users'],
    ['secretary', 'student', '/secretary/users'],
    ['secretary', 'teacher', '/secretary/users'],
    ['headteacher', 'teacher', '/headteacher/teachers'],
    ['headteacher', 'student', '/headteacher/students'],
    ['teacher', 'student', '/teacher/students'],
  ];
  for (const [creatorRole, accountRole, path] of cases) {
    const account = await edumatchApi.createUser(creatorRole, {
      name: 'School User', email: 'user@gmail.com', username: '  school.user  ', role: accountRole,
    });
    assert.equal(captured.at(-1)?.url, path);
    assert.equal((captured.at(-1)?.body as CreateUserInput).username, 'school.user');
    assert.equal(account.username, 'school.user');
  }
});

test('student subjects show pending enrollment and submit the teacher code through the existing endpoint', async () => {
  const { edumatchApi, captured } = await transport(request => request.method === 'get'
    ? { success: true, subjects: [{ id: 'approved', name: 'Math', className: 'A', enrollmentStatus: 'approved' }],
      pendingSubjects: [{ id: 'pending', name: 'Science', className: 'B', enrollmentStatus: 'pending' }] }
    : { success: true, request: { id: 'request', subject: { id: 'pending', enrollmentStatus: 'pending' } } });
  await edumatchApi.joinSubject('SCI7-01');
  assert.deepEqual(captured[0]?.body, { code: 'SCI7-01' });
  assert.equal(captured[0]?.url, '/student/subjects/join');
  const subjects = await edumatchApi.subjects('student');
  assert.deepEqual(subjects.map(item => [item.id, item.enrollmentStatus]), [['approved', 'approved'], ['pending', 'pending']]);
});

test('Grade 10 dashboard recognizes the backend format and counts approved classes only', async () => {
  const { edumatchApi, normalizeUser, captured } = await transport(request => request.url === '/student/attendance'
    ? { success: true, records: [], summary: { totalRecords: 0 } }
    : { success: true, subjects: [{ id: 'approved', enrollmentStatus: 'approved' }], pendingSubjects: [{ id: 'pending', enrollmentStatus: 'pending' }] });
  const user = normalizeUser({ id: 'student', name: 'Student', email: 'student@example.test', role: 'student', gradeLevel: 'Grade 10' });
  const dashboard = await edumatchApi.dashboard('student', user);
  assert.equal(dashboard.metrics.find(item => item.label === 'Classes')?.value, 1);
  assert.ok(captured.some(item => item.url === '/student/subjects'));
});

test('enrollment approval passes the enrollment request ID rather than the student ID', async () => {
  const { edumatchApi, captured } = await transport(request => request.method === 'get'
    ? { success: true, requests: [{ id: 'request-99', studentId: 'student-1', name: 'Learner', status: 'active', enrollmentStatus: 'pending' }] }
    : { success: true, student: { id: 'student-1' } });
  const requests = await edumatchApi.approvals('teacher');
  assert.equal(requests[0]?.status, 'pending');
  await edumatchApi.reviewApproval('teacher', requests[0]!, 'approved');
  assert.equal(captured[1]?.url, '/teacher/enrollment-requests/request-99/accept');
});

test('student legacy grades normalize hydrated assessment IDs and deduplicate activity records', async () => {
  const { edumatchApi } = await transport(request => request.url === '/student/submissions/me'
    ? { success: true, submissions: [{ _id: 'submission-1', assessmentId: { _id: 'assessment-1', title: 'Quiz', subject: 'Math' }, score: 7, totalPoints: 10 }] }
    : { success: true, submissions: [{ id: 'submission-1', assessmentId: 'assessment-1', assessmentTitle: 'Quiz', subject: 'Math', score: 7, totalPoints: 10 },
      { id: 'submission-2', assessmentId: 'assessment-2', assessmentTitle: 'Activity', score: 15, totalPoints: 20 }] });
  const grades = await edumatchApi.grades('student');
  assert.equal(grades.length, 2);
  assert.equal(grades[0]?.raw.assessmentId, 'assessment-1');
  assert.equal(grades[0]?.title, 'Quiz');
  assert.match(grades[1]?.subtitle || '', /15 \/ 20/);
});

test('grade reviews submit points and feedback without calculating client-side final grades', async () => {
  const { edumatchApi, captured } = await transport(() => ({ success: true, submission: { id: 'submission-1', gradeValue: 17, totalPoints: 25 } }));
  const result = await edumatchApi.reviewGrade({ assessmentId: 'assessment /1', submissionId: 'submission-1',
    action: 'grade', gradeValue: 17, teacherFeedback: 'Good work.' });
  assert.equal(captured[0]?.url, '/teacher/assessments/assessment%20%2F1/submissions/submission-1/review');
  assert.deepEqual(captured[0]?.body, { action: 'grade', gradeValue: 17, teacherFeedback: 'Good work.' });
  assert.equal(result.totalPoints, 25);
});

test('server grade validation errors propagate unchanged', async () => {
  const [{ api }, { edumatchApi }] = await modules;
  api.defaults.adapter = async config => {
    const response = { data: { success: false, message: 'Grade must be from 0 to 25' }, status: 400, statusText: 'Bad Request', headers: {}, config };
    throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, undefined, response);
  };
  await assert.rejects(() => edumatchApi.reviewGrade({ assessmentId: 'assessment-1', submissionId: 'submission-1', action: 'grade', gradeValue: 90 }),
    error => error instanceof AxiosError && error.response?.status === 400 && error.response.data.message === 'Grade must be from 0 to 25');
});

test('QR scan posts the opaque payload and accepts the authenticated server duplicate result', async () => {
  const { attendanceSessions, captured, setAccessToken } = await transport(() => ({ success: true, duplicate: true,
    attendance: { sessionId: 'session-1', subjectId: 'subject-1', dateKey: '2026-10-09', status: 'Late', scannedAt: '2026-10-09T03:00:00Z' } }));
  setAccessToken('student-jwt');
  const result = await attendanceSessions.scan('opaque.signed.qr');
  assert.equal(result.duplicate, true);
  assert.equal(result.attendance.status, 'Late');
  assert.deepEqual(captured[0]?.body, { qrPayload: 'opaque.signed.qr' });
  assert.equal(captured[0]?.authorization, 'Bearer student-jwt');
});

test('QR finalization submits overrides and uses the server locked record', async () => {
  const { attendanceSessions, captured } = await transport(() => ({ success: true,
    session: { id: 'session-1', status: 'finalized' }, record: { id: 'record-1', isLocked: true, dateKey: '2026-10-09', entries: [] } }));
  const result = await attendanceSessions.finalize('session-1', [{ studentId: 'student-2', status: 'Excused' }]);
  assert.equal(result.record.isLocked, true);
  assert.deepEqual(captured[0]?.body, { overrides: [{ studentId: 'student-2', status: 'Excused' }] });
  assert.equal(captured[0]?.url, '/mobile/attendance/sessions/session-1/finalize');
});

test('malformed list responses are visible errors rather than fabricated empty results', async () => {
  const { edumatchApi } = await transport(() => ({ success: true, users: null }));
  await assert.rejects(() => edumatchApi.users('admin'), /invalid users response/);
});
