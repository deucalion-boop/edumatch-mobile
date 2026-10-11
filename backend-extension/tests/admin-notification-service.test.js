'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const root = join(__dirname, '../../backend/services');
const plain = value => JSON.parse(JSON.stringify(value));

function load(file, dependencies) {
  const module = { exports: {} };
  runInNewContext(readFileSync(join(root, file), 'utf8'), {
    module, exports: module.exports, console,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return module.exports;
}

function harness(accounts = [
  { id: 'admin-one', role: 'admin', status: 'active' },
  { id: 'admin-two', role: 'admin', status: 'active' },
  { id: 'inactive-admin', role: 'admin', status: 'inactive' },
  { id: 'teacher-one', role: 'teacher', status: 'active' },
  { id: 'student-one', role: 'student', status: 'active' },
], { readError = null, writeError = null } = {}) {
  const saved = new Map();
  const reads = [];
  const writes = [];
  const client = { from(table) {
    if (table === 'users') {
      const calls = [];
      const filters = [];
      reads.push(calls);
      const query = {
        select(fields) { calls.push(['select', fields]); return query; },
        eq(field, value) { calls.push(['eq', field, value]); filters.push(row => row[field] === value); return query; },
        order(field, value) { calls.push(['order', field, plain(value)]); return query; },
        async range(start, end) {
          calls.push(['range', start, end]);
          return { data: accounts.filter(row => filters.every(filter => filter(row))).slice(start, end + 1), error: readError };
        },
      };
      return query;
    }
    assert.equal(table, 'notifications');
    return { upsert(rows, options) {
      writes.push({ rows: plain(rows), options: plain(options) });
      return { async select(fields) {
        assert.equal(fields, 'id');
        if (writeError) return { data: null, error: writeError };
        const inserted = [];
        for (const row of rows) {
          const key = [row.recipient_id, row.recipient_role, row.type, row.event_key].join('|');
          if (saved.has(key)) continue;
          const record = { id: `notification-${saved.size + 1}`, ...plain(row) };
          saved.set(key, record);
          inserted.push({ id: record.id });
        }
        return { data: inserted, error: null };
      } };
    } };
  } };
  const storage = { getSupabaseStorageClient: () => client };
  const persistence = load('supabaseNotificationService.js', { './supabaseStorageService': storage });
  const service = load('adminNotificationService.js', {
    './supabaseStorageService': storage,
    './supabaseNotificationService': persistence,
  });
  return { service, saved, reads, writes };
}

const publisher = { _id: 'teacher-one', role: 'teacher', name: 'Science Teacher' };
const lesson = { _id: 'lesson-one', title: 'Electric circuits', subject: 'Science', subjectId: 'science', createdBy: 'teacher-one' };
const assessment = { id: 'assessment-one', title: 'Circuit quiz', subject: 'Science', subjectId: 'science', createdBy: 'teacher-one', assessmentMode: 'quiz' };
const student = { _id: 'student-one', role: 'student', status: 'active', gradeLevel: 'Grade 10', name: 'Student One', sectionName: 'Section A' };
const readyProgress = { isRecommendationReady: true, recommendationProgressPercent: 100, recommendedStrand: { name: 'STEM' } };

test('new lessons and assessments notify every active admin with content and publisher details', async () => {
  const { service, saved, reads } = harness();
  assert.equal(await service.notifyLessonCreated({ lesson, publisher }), 2);
  assert.equal(await service.notifyAssessmentCreated({ assessment, publisher: { ...publisher, role: 'headteacher', name: 'Science Head' } }), 2);
  const rows = [...saved.values()];
  assert.deepEqual([...new Set(rows.map(row => row.recipient_id))], ['admin-one', 'admin-two']);
  assert.ok(rows.every(row => row.recipient_role === 'admin' && !row.is_viewed));
  assert.equal(rows[0].type, 'lesson_created');
  assert.match(rows[0].message, /Science Teacher.*Electric circuits.*Science/);
  assert.equal(rows[0].meta.entityId, 'lesson-one');
  assert.equal(rows[0].meta.route, '/admin/notifications');
  assert.equal(rows[2].sender_role, 'headteacher');
  assert.equal(rows[2].meta.assessmentId, 'assessment-one');
  assert.equal(rows[2].meta.assessmentMode, 'quiz');
  for (const calls of reads) {
    assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'role' && call[2] === 'admin'));
    assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'status' && call[2] === 'active'));
  }
});

test('a ready Grade 10 recommendation sends one alert per admin and repeated recomputations preserve read and cleared alerts', async () => {
  const { service, saved, writes } = harness();
  assert.equal(await service.notifyRecommendationReady({ student, academicProgress: readyProgress }), 2);
  const first = [...saved.values()][0];
  first.is_viewed = true;
  first.is_cleared = true;
  first.viewed_at = '2026-10-11T01:00:00Z';
  assert.match(first.message, /Student One.*completed.*STEM/);
  assert.equal(first.meta.route, '/admin/academic');
  assert.equal(first.meta.studentId, student._id);
  assert.equal(first.meta.recommendationProgressPercent, 100);
  assert.equal(await service.notifyRecommendationReady({ student, academicProgress: { ...readyProgress, recommendedStrand: { name: 'HUMSS' } } }), 0);
  assert.equal(saved.size, 2);
  assert.equal(first.is_viewed, true);
  assert.equal(first.is_cleared, true);
  assert.equal(first.viewed_at, '2026-10-11T01:00:00Z');
  assert.ok(writes.every(write => write.options.ignoreDuplicates === true && write.options.onConflict === 'recipient_id,recipient_role,type,event_key'));
});

test('content event keys are stable and different saved content sends separate alerts', async () => {
  const { service, saved } = harness();
  assert.equal(await service.notifyLessonCreated({ lesson, publisher }), 2);
  assert.equal(await service.notifyLessonCreated({ lesson, publisher }), 0);
  assert.equal(await service.notifyLessonCreated({ lesson: { ...lesson, _id: 'lesson-copy' }, publisher }), 2);
  assert.equal(await service.notifyAssessmentCreated({ assessment, publisher }), 2);
  assert.equal(await service.notifyAssessmentCreated({ assessment, publisher }), 0);
  assert.equal(saved.size, 6);
});

test('incomplete recommendations, missing strands, other grades and ineligible students create no admin notifications', async () => {
  const { service, reads, writes } = harness();
  const cases = [
    { student, academicProgress: { ...readyProgress, isRecommendationReady: false } },
    { student, academicProgress: { ...readyProgress, recommendationProgressPercent: 99 } },
    { student, academicProgress: { ...readyProgress, recommendedStrand: { name: '' } } },
    { student: { ...student, gradeLevel: 'Grade 9' }, academicProgress: readyProgress },
    { student: { ...student, status: 'inactive' }, academicProgress: readyProgress },
    { student: { ...student, role: 'teacher' }, academicProgress: readyProgress },
    { student: { ...student, archive: { isArchived: true } }, academicProgress: readyProgress },
    { student: { ...student, _id: '' }, academicProgress: readyProgress },
  ];
  for (const input of cases) assert.equal(await service.notifyRecommendationReady(input), 0);
  assert.equal(reads.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(await service.notifyLessonCreated({ lesson: { title: 'Unsaved draft' }, publisher }), 0);
  assert.equal(await service.notifyAssessmentCreated({ assessment: { title: 'AI draft' }, publisher }), 0);
  assert.equal(reads.length, 0);
});

test('Grade 10 short labels are accepted and no admin recipients requires no notification write', async () => {
  const populated = harness();
  assert.equal(await populated.service.notifyRecommendationReady({ student: { ...student, gradeLevel: '10' }, academicProgress: readyProgress }), 2);
  const empty = harness([]);
  assert.equal(await empty.service.notifyLessonCreated({ lesson, publisher }), 0);
  assert.equal(empty.writes.length, 0);
});

test('active admin recipient lookup reads every database page', async () => {
  const accounts = Array.from({ length: 501 }, (_, index) => ({ id: `admin-${index}`, role: 'admin', status: 'active' }));
  const { service, reads, saved } = harness(accounts);
  assert.equal(await service.notifyLessonCreated({ lesson, publisher }), 501);
  assert.equal(saved.size, 501);
  assert.deepEqual(reads.map(calls => calls.find(call => call[0] === 'range')), [['range', 0, 499], ['range', 500, 999]]);
});

test('recipient and notification persistence failures remain visible to the safe caller for retry', async () => {
  const failingRead = harness(undefined, { readError: { message: 'Recipient database unavailable' } });
  await assert.rejects(() => failingRead.service.notifyLessonCreated({ lesson, publisher }), /Recipient database unavailable/);
  assert.equal(failingRead.writes.length, 0);
  const failingWrite = harness(undefined, { writeError: { message: 'Notification database unavailable' } });
  await assert.rejects(() => failingWrite.service.notifyRecommendationReady({ student, academicProgress: readyProgress }), /Notification database unavailable/);
  assert.equal(failingWrite.saved.size, 0);
});
