'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const userRoles = require('../../backend/constants/userRoles');
const strands = require('../../backend/constants/strandSubjects');
const assessmentConfig = require('../../backend/constants/assessmentConfig');

const backendRoot = join(__dirname, '../../backend');
const sources = Object.fromEntries([
  ['teacher', 'controllers/teacherController.js'],
  ['headteacher', 'controllers/headteacherController.js'],
  ['policy', 'services/assessmentPolicyService.js'],
  ['notifications', 'services/studentNotificationService.js'],
].map(([key, path]) => [key, readFileSync(join(backendRoot, path), 'utf8')]));
const quietConsole = { log() {}, warn() {}, error() {} };

function loadModule(source, requireMock) {
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, require: requireMock, console: quietConsole });
  return module.exports;
}

function createHarness(options = {}) {
  const writes = [];
  const studentAlerts = [];
  const adminAlerts = [];
  const progressCalls = [];
  const events = [];
  const teacher = { _id: 'teacher-id', role: 'teacher', name: 'Sample Teacher', department: 'Science', subject: 'Science', managedBy: 'headteacher-id' };
  const headteacher = { _id: 'headteacher-id', role: 'headteacher', name: 'Sample Head Teacher', department: 'Science' };
  const sourceLesson = { _id: 'source-lesson', title: 'Source lesson', subject: 'Science', track: 'GENERAL', subjectId: 'source-class', createdBy: teacher._id, attachments: [] };
  const sourceAssessment = { _id: 'source-assessment', title: 'Source assessment', lessonId: sourceLesson._id, subjectId: 'source-class', subject: 'Science', assessmentMode: options.assessmentMode || 'quiz', totalPoints: 10, activityPoints: 10, createdBy: teacher._id, attachments: [], questions: [], assignmentScope: 'handled_class' };
  const subjects = ['source-class', 'existing-class', 'new-class'].map(_id => ({ _id, name: 'Science', track: 'GENERAL', className: _id }));
  async function save(kind, payload) {
    if (options.saveError) throw options.saveError;
    const entity = { ...payload, _id: `saved-${kind}-${writes.length + 1}` };
    writes.push({ kind, entity });
    events.push(`save:${kind}`);
    return entity;
  }
  const content = {
    async createSupabaseLesson(payload) { return save('lesson', payload); },
    async createSupabaseAssessment(payload) { return save('assessment', payload); },
    async findSupabaseLesson() { return sourceLesson; },
    async findSupabaseAssessment() { return sourceAssessment; },
    async listSupabaseLessons() { return [sourceLesson, { ...sourceLesson, _id: 'existing-lesson', subjectId: 'existing-class' }]; },
    async listSupabaseAssessments() { return [sourceAssessment, { ...sourceAssessment, _id: 'existing-assessment', subjectId: 'existing-class' }]; },
    async updateSupabaseAssessment(id, teacherId, payload) { events.push('update:assessment'); return payload; },
  };
  const policy = loadModule(sources.policy, name => name === '../constants/assessmentConfig' ? assessmentConfig : {});
  const { safelyRunNotificationTask } = loadModule(sources.notifications, () => ({}));
  async function studentAlert(kind, payload) {
    studentAlerts.push({ kind, payload });
    events.push(`student:${kind}`);
    if (options.studentAlertError) throw options.studentAlertError;
  }
  async function adminAlert(kind, payload) {
    adminAlerts.push({ kind, payload });
    events.push(`admin:${kind}`);
    if (options.adminAlertError) throw options.adminAlertError;
  }
  const requireMock = name => {
    if (name === 'path' || name === 'crypto') return require(name);
    if (name === '../constants/userRoles') return userRoles;
    if (name === '../constants/strandSubjects') return strands;
    if (name === '../constants/assessmentConfig') return assessmentConfig;
    if (name === '../services/assessmentPolicyService') return policy;
    if (name === '../services/supabaseContentService') return content;
    if (name === '../services/supabaseAccountService') return { async findSupabaseAccount() { return teacher; } };
    if (name === '../services/subjectService') return {
      async listTeacherSubjects() { return subjects; },
      async findTeacherSubject(teacherId, subjectId) { return subjects.find(item => item._id === subjectId); },
    };
    if (name === '../services/storageService') return {
      async uploadFiles() { return [{ originalName: 'lesson.pdf', storedPath: 'lesson.pdf', mimeType: 'application/pdf', extension: 'pdf', size: 50 }]; },
    };
    if (name === '../services/studentNotificationService') return {
      safelyRunNotificationTask,
      async notifyLessonPublished(payload) { return studentAlert('lesson', payload); },
      async notifyAssessmentAssigned(payload) { return studentAlert('assessment', payload); },
      async approvedStudentsForSubject() { return []; },
      async createStudentNotifications(payload) { return studentAlert('grade', payload); },
    };
    if (name === '../services/adminNotificationService') return {
      async notifyLessonCreated(payload) { return adminAlert('lesson', payload); },
      async notifyAssessmentCreated(payload) { return adminAlert('assessment', payload); },
    };
    if (name === '../services/recommendationService') return { normalizeSubjectCategory(value) { return value || 'Science'; } };
    if (name === '../utils/fileStorage') return { resolveStoredFileUrl() { return 'https://example.test/lesson.pdf'; } };
    if (name === '../utils/responseHelper') return {
      sendSuccess(res, statusCode, message, body) { Object.assign(res, { statusCode, message, body }); },
    };
    if (name === '../services/supabaseAcademicProgressService') return {
      async computeAcademicProgress(studentId) {
        progressCalls.push(studentId);
        events.push('progress');
        if (options.progressError) throw options.progressError;
        return {};
      },
    };
    if (name === '../services/supabaseActivityService') return {
      async findActivitySubmissionById() { return { id: 'submission-id', studentId: 'student-id', status: 'completed', totalPoints: 10 }; },
      async updateActivityReview({ values }) {
        events.push('save:grade');
        if (options.saveError) throw options.saveError;
        return { id: 'submission-id', studentId: 'student-id', ...values };
      },
    };
    // Inert imports prevent this controller test from opening database, email,
    // storage clients or credentials for unrelated handlers.
    return {};
  };
  const controllers = { teacher: loadModule(sources.teacher, requireMock), headteacher: loadModule(sources.headteacher, requireMock) };
  async function invoke(role, handler, overrides = {}) {
    const res = {};
    let error;
    await controllers[role][handler]({
      user: role === 'teacher' ? teacher : headteacher,
      protocol: 'https', get() { return 'example.test'; },
      body: {}, params: {}, files: {}, ...overrides,
    }, res, value => { error = value; });
    return { res, error };
  }
  return { invoke, writes, adminAlerts, studentAlerts, progressCalls, events, teacher, headteacher };
}

const lessonRequest = { body: { title: 'New lesson', description: 'A new lesson', subject: 'Science', subjectId: 'new-class', teacherId: 'teacher-id' }, files: { lessonPlanFile: [{ originalname: 'lesson.pdf', mimetype: 'application/pdf', size: 50 }] } };
const assessmentRequest = { body: { teacherId: 'teacher-id', lessonId: 'source-lesson', title: 'New assessment', subject: 'Science', examType: 'multiple-choice', difficulty: 'medium', numberOfItems: 1, examDurationMinutes: 30, assessmentMode: 'quiz', questions: [] } };
const copyRequest = { body: { subjectIds: ['source-class', 'existing-class', 'new-class', 'new-class'] }, params: { id: 'source' } };
const creationPaths = [
  { role: 'teacher', handler: 'createLesson', kind: 'lesson', request: lessonRequest },
  { role: 'teacher', handler: 'createAssessment', kind: 'assessment', request: assessmentRequest },
  { role: 'teacher', handler: 'copyTeacherLessonToClasses', kind: 'lesson', request: copyRequest },
  { role: 'teacher', handler: 'copyTeacherAssessmentToClasses', kind: 'assessment', request: copyRequest },
  { role: 'headteacher', handler: 'createManagedTeacherLesson', kind: 'lesson', request: lessonRequest },
  { role: 'headteacher', handler: 'createManagedTeacherAssessment', kind: 'assessment', request: assessmentRequest },
];

for (const path of creationPaths) {
  test(`${path.handler} alerts admins once for newly persisted content with the actual publisher`, async () => {
    const harness = createHarness();
    const { res, error } = await harness.invoke(path.role, path.handler, path.request);
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.adminAlerts.length, 1);
    const alert = harness.adminAlerts[0];
    assert.equal(alert.kind, path.kind);
    assert.equal(alert.payload[path.kind], harness.writes[0].entity);
    assert.equal(alert.payload.publisher, harness[path.role]);
    assert.equal(harness.events[0], `save:${path.kind}`);
    if (path.role === 'teacher') assert.equal(harness.studentAlerts.length, 1);
  });

  test(`${path.handler} does not alert admins when persistence fails`, async () => {
    const saveError = new Error('Unable to persist content');
    const harness = createHarness({ saveError });
    const { res, error } = await harness.invoke(path.role, path.handler, path.request);
    assert.equal(error, saveError);
    assert.equal(res.statusCode, undefined);
    assert.equal(harness.adminAlerts.length, 0);
    assert.equal(harness.studentAlerts.length, 0);
  });
}

test('student alert failure still delivers an independent admin alert for every teacher creation path', async () => {
  for (const path of creationPaths.filter(item => item.role === 'teacher')) {
    const harness = createHarness({ studentAlertError: new Error('Student notifications unavailable') });
    const { res, error } = await harness.invoke(path.role, path.handler, path.request);
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(harness.adminAlerts.length, 1);
  }
});

test('admin notification failure leaves each successfully created lesson or assessment saved', async () => {
  for (const path of creationPaths) {
    const harness = createHarness({ adminAlertError: new Error('Admin notifications unavailable') });
    const { res, error } = await harness.invoke(path.role, path.handler, path.request);
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(harness.writes.length, 1);
  }
});

test('copying only current or existing classes does not create content alerts', async () => {
  for (const handler of ['copyTeacherLessonToClasses', 'copyTeacherAssessmentToClasses']) {
    const harness = createHarness();
    const { res, error } = await harness.invoke('teacher', handler, { ...copyRequest, body: { subjectIds: ['source-class', 'existing-class'] } });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.adminAlerts.length, 0);
    assert.equal(harness.studentAlerts.length, 0);
  }
});

test('assessment deadline edits do not emit creation alerts', async () => {
  const harness = createHarness();
  const { res, error } = await harness.invoke('teacher', 'updateAssessmentQuestions', { params: { id: 'source-assessment' }, body: { submissionDeadline: null } });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(harness.adminAlerts.length, 0);
  assert.equal(harness.writes.length, 0);
});

test('teacher final grading refreshes recommendation progress after saving the grade', async () => {
  const harness = createHarness({ assessmentMode: 'grading_assessment' });
  const { res, error } = await harness.invoke('teacher', 'reviewActivitySubmission', { params: { assessmentId: 'source-assessment', submissionId: 'submission-id' }, body: { gradeValue: 8 } });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.progressCalls, ['student-id']);
  assert.deepEqual(harness.events, ['save:grade', 'progress', 'student:grade']);
});

test('recommendation refresh failure does not fail the persisted grade or student grade alert', async () => {
  const harness = createHarness({ assessmentMode: 'grading_assessment', progressError: new Error('Academic progress unavailable') });
  const { res, error } = await harness.invoke('teacher', 'reviewActivitySubmission', { params: { assessmentId: 'source-assessment', submissionId: 'submission-id' }, body: { gradeValue: 8 } });
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.submission.gradeValue, 8);
  assert.equal(harness.studentAlerts.length, 1);
});

test('ordinary activity grades and failed final-grade writes do not trigger recommendation refresh', async () => {
  const request = { params: { assessmentId: 'source-assessment', submissionId: 'submission-id' }, body: { gradeValue: 8 } };
  const activity = createHarness({ assessmentMode: 'activity' });
  const activityResult = await activity.invoke('teacher', 'reviewActivitySubmission', request);
  assert.equal(activityResult.error, undefined);
  assert.equal(activityResult.res.statusCode, 200);
  assert.equal(activity.progressCalls.length, 0);
  const saveError = new Error('Grade persistence failed');
  const failure = createHarness({ assessmentMode: 'grading_assessment', saveError });
  const failedResult = await failure.invoke('teacher', 'reviewActivitySubmission', request);
  assert.equal(failedResult.error, saveError);
  assert.equal(failure.progressCalls.length, 0);
  assert.equal(failure.studentAlerts.length, 0);
});
