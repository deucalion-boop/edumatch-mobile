'use strict';
// Exercises only the deterministic fixture on an isolated port; never production.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const port = 5100;
const base = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, [path.join(__dirname, 'mock-api.cjs')], {
  env: { ...process.env, VERIFICATION_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const tokens = {};
const deadline = setTimeout(() => { server.kill(); process.exitCode = 1; }, 30000);
async function request(route, role, body, expected = 200) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`); return data;
}
async function run() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.stdout.once('data', resolve);
    server.once('exit', code => { if (code) reject(new Error(`Fixture server exited with ${code}`)); });
  });
  for (const role of ['admin', 'secretary', 'headteacher', 'teacher', 'student']) {
    const challenge = await request('/auth/login', role, { username: role, password: 'VerifyEduMatch1!', captchaToken: 'verification-captcha-token' }, 202);
    assert.equal(challenge.requiresOtp, true);
    const auth = await request('/auth/login/verify-otp', role, { challengeToken: challenge.challengeToken, otpCode: '123456', captchaToken: 'verification-captcha-token' });
    tokens[role] = auth.token;
    assert.equal((await request('/mobile/me', role)).user.role, role);
  }
  assert.equal((await request('/admin/analytics', 'admin')).analytics.totalStudents, 2);
  assert.equal((await request('/secretary/students', 'secretary')).students.length, 2);
  assert.equal((await request('/headteacher/teachers', 'headteacher')).summary.totalTeachers, 1);
  assert.equal((await request('/teacher/subjects', 'teacher')).subjects[0].code, 'MATH10');
  assert.equal((await request('/student/subjects', 'student')).insights.subjectPerformance[0].finalPercentage, 84);
  for (const [role, routes] of [
    ['admin', ['/admin/users', '/admin/attendance/report', '/admin/student-account-requests']],
    ['secretary', ['/secretary/directory', '/secretary/students/archived', '/secretary/attendance']],
    ['headteacher', ['/headteacher/teachers/teacher-1/students', '/headteacher/lessons', '/headteacher/assessments', '/headteacher/attendance']],
    ['teacher', ['/teacher/students', '/teacher/enrollment-requests', '/teacher/lessons', '/teacher/assessments', '/teacher/attendance']],
    ['student', ['/student/lessons', '/student/assessments', '/student/submissions/me', '/student/activity-submissions', '/student/attendance']],
  ]) {
    for (const route of routes) assert.equal((await request(route, role)).success, true);
    assert.equal((await request('/notifications', role)).notifications.length, 1);
  }
  await request('/admin/analytics', 'student', undefined, 403);
  const grading = await fetch(`${base}/teacher/assessments/assessment-1/submissions/submission-1/review`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.teacher}` },
    body: JSON.stringify({ action: 'grade', gradeValue: 22, teacherFeedback: 'Fixture-reviewed answer.' }),
  });
  assert.equal(grading.status, 200);
  assert.equal((await grading.json()).submission.gradeValue, 22);
  assert.equal((await request('/student/submissions/me', 'student')).submissions[0].teacherFeedback, 'Fixture-reviewed answer.');
  const session = await request('/mobile/attendance/sessions', 'teacher', { subjectId: 'subject-1', dateKey: '2026-10-09', durationMinutes: 15, lateAfterMinutes: 5 }, 201);
  const scan = await request('/mobile/attendance/scan', 'student', { qrPayload: session.qrPayload });
  assert.equal(scan.duplicate, false); assert.equal(scan.attendance.status, 'Present');
  assert.equal((await request('/mobile/attendance/scan', 'student', { qrPayload: session.qrPayload })).duplicate, true);
  const roster = await request(`/mobile/attendance/sessions/${session.session.id}`, 'teacher');
  assert.equal(roster.roster[0].status, 'Present'); assert.equal(roster.session.scanCount, 1);
  const rotated = await request(`/mobile/attendance/sessions/${session.session.id}/rotate`, 'teacher', {});
  assert.notEqual(rotated.qrPayload, session.qrPayload);
  await request('/mobile/attendance/scan', 'student', { qrPayload: session.qrPayload }, 400);
  const finalized = await request(`/mobile/attendance/sessions/${session.session.id}/finalize`, 'teacher', { overrides: [{ studentId: 'student-2', status: 'Excused' }] });
  assert.equal(finalized.record.isLocked, true); assert.equal(finalized.record.summary.excusedCount, 1);
  await request('/mobile/attendance/scan', 'student', { qrPayload: rotated.qrPayload }, 409);
  await request('/teacher/subjects/subject-1/announcements', 'teacher', { title: 'Fixture announcement', content: 'Class begins at 8 AM.', requestId: 'fixture-announcement-request' }, 201);
  const announcements = await request('/notifications/announcements', 'student');
  assert.equal(announcements.announcements[0].title, 'Fixture announcement');
  const approvals = await request('/admin/export-requests/archived-pdf', 'admin');
  assert.equal(approvals.requests[0].status, 'pending');
  const response = await fetch(`${base}/admin/export-requests/${approvals.requests[0].id}/review`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.admin}` },
    body: JSON.stringify({ decision: 'approved', note: 'Fixture smoke test.' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await request('/secretary/students/archived/export-requests/current', 'secretary')).request.status, 'approved');
  process.stdout.write('Fixture smoke: five-role profiles/dashboards/records/academic/attendance/notifications, role denial, teacher grading/student results, QR scan/duplicate/rotation/finalization, announcement delivery, export approval passed.\n');
}
run().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }).finally(() => {
  clearTimeout(deadline); server.kill();
});
