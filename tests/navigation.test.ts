import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRole, FEATURES } from '../src/auth/roles';
import { notificationRoute } from '../src/notifications/routes';
import { availableFeatures } from '../src/screens/roleConfig';
import { isGradeTenStudent } from '../src/auth/studentAccess';
import type { User } from '../src/api/types';

test('Principal uses the existing admin role and unknown roles cannot open role areas', () => {
  assert.equal(normalizeRole('Principal'), 'admin');
  assert.equal(normalizeRole('Head Teacher'), 'headteacher');
  assert.throws(() => normalizeRole('superuser'));
  assert.throws(() => normalizeRole(null));
});
test('notification taps resolve the generic inbox into the authenticated role', () => {
  for (const role of ['admin', 'secretary', 'headteacher', 'teacher', 'student'] as const) {
    assert.equal(notificationRoute({ route: '/notifications' }, role), `/${role}/notifications`);
  }
});
test('notification data cannot navigate outside the current authorized role', () => {
  assert.equal(notificationRoute({ route: '/admin/approvals' }, 'student'), null);
  assert.equal(notificationRoute({ route: 'https://example.com' }, 'teacher'), null);
  assert.equal(notificationRoute({ route: '/teacher/grades?token=secret' }, 'teacher'), null);
  assert.equal(notificationRoute({ route: '/student/grades' }, 'student'), '/student/grades');
  assert.equal(notificationRoute(null, 'admin'), null);
  assert.equal(FEATURES.teacher.includes('approvals'), true);
});

test('all student grades can join a subject while academic tools recognize the server grade format', () => {
  const account: User = { id: 'student', name: 'Student', email: 'student@example.test', role: 'student' };
  for (const gradeLevel of ['Grade 7', '7', 'Grade 8', 'Grade 9', 'Grade 11', 'Grade 12', undefined]) {
    const user = { ...account, gradeLevel };
    assert.equal(isGradeTenStudent(user), false);
    assert.deepEqual(availableFeatures(user).map(item => item.feature), ['attendance', 'subjects', 'announcements']);
  }
  for (const gradeLevel of ['Grade 10', '10']) {
    const user = { ...account, gradeLevel };
    assert.equal(isGradeTenStudent(user), true);
    assert.ok(availableFeatures(user).some(item => item.feature === 'lessons'));
    assert.ok(availableFeatures(user).some(item => item.feature === 'grades'));
  }
  assert.equal(isGradeTenStudent({ role: 'teacher', gradeLevel: 'Grade 10' }), false);
  assert.ok(availableFeatures({ ...account, role: 'teacher' }).some(item => item.feature === 'approvals'));
});
