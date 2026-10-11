'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const assessmentConfig = require('../../backend/constants/assessmentConfig');
const strandSubjects = require('../../backend/constants/strandSubjects');

const backendRoot = join(__dirname, '../../backend');
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule(path, dependencies, globals = {}) {
  const module = { exports: {} };
  runInNewContext(readFileSync(join(backendRoot, path), 'utf8'), {
    module,
    exports: module.exports,
    console,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ...globals,
  });
  return module.exports;
}

const gradeService = loadModule('services/supabaseGradeRecordService.js', {
  './supabaseStorageService': {},
  './supabaseEnrollmentService': {},
  './supabaseContentService': {},
  './supabaseActivityService': {},
  '../constants/assessmentConfig': assessmentConfig,
});
const recommendationService = loadModule('services/recommendationService.js', {
  openai: function OpenAI() { assert.fail('No AI provider should be called by grade-based recommendations'); },
  '../models/Settings': {},
  '../models/Submission': {},
  '../models/Recommendation': {},
  '../constants/strandSubjects': strandSubjects,
  '../constants/assessmentConfig': assessmentConfig,
  '../utils/aiRuntimeConfig': {},
  './assessmentPolicyService': {},
});

function fixture(subjectId = 'science') {
  return {
    subject: { _id: subjectId, name: 'Science', code: 'SCI', subjectCategory: 'Science' },
    lessons: [{ _id: `${subjectId}-lesson`, subjectId, title: 'Science lesson' }],
    assessments: assessmentConfig.GRADING_PERIODS.map((period, index) => ({
      _id: `${subjectId}-p${index + 1}`, subjectId, title: `Science P${index + 1}`,
      assessmentMode: 'grading_assessment', gradingPeriod: period,
    })),
    submissions: assessmentConfig.GRADING_PERIODS.map((period, index) => ({
      _id: `${subjectId}-submission-${index + 1}`, assessmentId: `${subjectId}-p${index + 1}`,
      studentId: 'student-1', status: 'completed', score: 80, totalPoints: 100,
      scoringStatus: 'final', submittedAt: `2026-10-0${index + 1}T01:00:00.000Z`,
    })),
  };
}

function createHarness(options = {}) {
  const science = fixture();
  const subjects = options.subjects || [science.subject];
  const lessons = options.lessons || science.lessons;
  const assessments = options.assessments || science.assessments;
  const submissions = options.submissions || science.submissions;
  const student = options.student === undefined
    ? { _id: 'student-1', name: 'Grade Ten Student', role: 'student', gradeLevel: 'Grade 10', status: 'active' }
    : options.student;
  const events = [];
  const alerts = [];
  const savedRecommendations = [];
  const errors = [];
  let failuresRemaining = options.notifyFailures || 0;
  const client = { from(table) {
    if (table === 'assessment_weights') return {
      select() { return { async in() { return { data: [], error: null }; } }; },
    };
    assert.equal(table, 'recommendations');
    return { async upsert(payload, conflict) {
      assert.equal(conflict.onConflict, 'student_id');
      events.push('save recommendation');
      savedRecommendations.push(plain(payload));
      return { error: options.recommendationError || null };
    } };
  } };
  const service = loadModule('services/supabaseAcademicProgressService.js', {
    './supabaseStorageService': { getSupabaseStorageClient: () => client },
    './supabaseContentService': {
      listSupabaseLessons: async () => lessons,
      listSupabaseAssessments: async () => assessments,
    },
    './supabaseEnrollmentService': {
      listHydratedStudentEnrollments: async (studentId, status) => {
        assert.equal(studentId, 'student-1');
        assert.equal(status, 'approved');
        return subjects.map(subjectId => ({ subjectId }));
      },
    },
    './supabaseProgressionService': {
      listLessonProgress: async () => lessons.map(lesson => ({ lessonId: lesson._id, status: 'completed' })),
    },
    './supabaseActivityService': { listStudentActivitySubmissions: async () => submissions },
    '../constants/assessmentConfig': assessmentConfig,
    './supabaseGradeRecordService': {
      buildSubjectGradeRecords: gradeService.buildSubjectGradeRecords,
      latestGradeResults: gradeService.latestGradeResults,
      saveSubjectGradeRecords: async records => { events.push('save subject grades'); return records; },
    },
    './recommendationService': { buildRecommendationFromGradeRecords: recommendationService.buildRecommendationFromGradeRecords },
    './supabaseAccountService': { async findSupabaseAccount(field, studentId) {
      events.push('read student');
      assert.equal(field, 'id');
      assert.equal(studentId, 'student-1');
      if (options.lookupError) throw new Error(options.lookupError);
      return student;
    } },
    './adminNotificationService': { async notifyRecommendationReady(payload) {
      events.push('notify admin');
      alerts.push(plain(payload));
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('Temporary notification failure');
      }
      return 1;
    } },
  }, { console: { error: (...args) => errors.push(args) } });
  return {
    compute: () => service.computeAcademicProgress('student-1'),
    events, alerts, savedRecommendations, errors,
  };
}

test('a saved complete recommendation triggers admin notification with the student and strand', async () => {
  const harness = createHarness();
  const progress = plain(await harness.compute());
  assert.deepEqual(harness.events, ['save subject grades', 'save recommendation', 'read student', 'notify admin']);
  const alert = harness.alerts[0];
  assert.equal(alert.student.gradeLevel, 'Grade 10');
  assert.equal(alert.student._id, 'student-1');
  assert.equal(alert.academicProgress.isRecommendationReady, true);
  assert.equal(alert.academicProgress.recommendationStatus, 'ready');
  assert.equal(alert.academicProgress.recommendationProgressPercent, 100);
  assert.equal(alert.academicProgress.recommendedStrand.name, 'STEM');
  assert.equal(harness.savedRecommendations[0].recommended_strand.name, 'STEM');
  assert.deepEqual(alert.academicProgress.gradeRecords, progress.gradeRecords);
  assert.equal(progress.overallLearningProgress.completionPercentage, 100);
});

test('completing currently posted work does not alert before all three grading periods exist', async () => {
  const science = fixture();
  const harness = createHarness({ assessments: science.assessments.slice(0, 2), submissions: science.submissions.slice(0, 2) });
  const progress = await harness.compute();
  assert.equal(progress.overallLearningProgress.completionPercentage, 100);
  assert.equal(harness.savedRecommendations[0].recommended_strand.name, '');
  assert.deepEqual(harness.events, ['save subject grades', 'save recommendation']);
});

test('a missing grading period in any enrolled subject prevents a ready alert', async () => {
  const science = fixture();
  const math = fixture('math');
  const harness = createHarness({
    subjects: [science.subject, { ...math.subject, name: 'Mathematics', subjectCategory: 'Math' }],
    lessons: [...science.lessons, ...math.lessons],
    assessments: [...science.assessments, ...math.assessments],
    submissions: [...science.submissions, ...math.submissions.slice(0, 2)],
  });
  await harness.compute();
  assert.equal(harness.savedRecommendations[0].recommended_strand.name, '');
  assert.equal(harness.alerts.length, 0);
});

test('unreviewed AI essay scores cannot complete a grading record or trigger the ready alert', async () => {
  for (const scoringStatus of ['pending_teacher_review', 'final', '', undefined]) {
    const science = fixture();
    const last = science.submissions.at(-1);
    last.aiEvaluations = [{ questionId: 'essay-1', score: 80 }];
    last.scoringStatus = scoringStatus;
    const harness = createHarness({ submissions: science.submissions });
    const progress = await harness.compute();
    assert.equal(progress.gradeRecords[0].p3, null);
    assert.equal(progress.gradeRecords[0].finalGrade, null);
    assert.equal(harness.savedRecommendations[0].recommended_strand.name, '');
    assert.equal(harness.alerts.length, 0);
  }
});

test('teacher approval or override of the final essay score makes the recommendation ready', async () => {
  for (const scoringStatus of ['teacher_approved', 'teacher_overridden']) {
    const science = fixture();
    const last = science.submissions.at(-1);
    last.aiEvaluations = [{ questionId: 'essay-1', score: 80 }];
    last.scoringStatus = scoringStatus;
    last.teacherAdjustedScore = 95;
    const harness = createHarness({ submissions: science.submissions });
    const progress = await harness.compute();
    assert.equal(progress.gradeRecords[0].p3, 95);
    assert.equal(progress.gradeRecords[0].finalGrade, 85);
    assert.equal(harness.alerts[0].academicProgress.recommendationProgressPercent, 100);
  }
});

test('recomputing a ready recommendation retries notification safely and leaves persistence deduplication to the service', async () => {
  const harness = createHarness({ notifyFailures: 1 });
  const first = plain(await harness.compute());
  const second = plain(await harness.compute());
  assert.equal(first.gradeRecords[0].finalGrade, 80);
  assert.equal(second.gradeRecords[0].finalGrade, 80);
  assert.equal(harness.savedRecommendations.length, 2);
  assert.equal(harness.alerts.length, 2);
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.alerts[0].student._id, harness.alerts[1].student._id);
});

test('student lookup failure leaves saved academic progress usable', async () => {
  const harness = createHarness({ lookupError: 'Temporary account lookup failure' });
  const progress = await harness.compute();
  assert.equal(progress.gradeRecords[0].finalGrade, 80);
  assert.equal(harness.savedRecommendations[0].recommended_strand.name, 'STEM');
  assert.equal(harness.alerts.length, 0);
  assert.equal(harness.errors.length, 1);
});

test('a recommendation save failure prevents an admin-ready event', async () => {
  const harness = createHarness({ recommendationError: { message: 'Recommendation save failed' } });
  await assert.rejects(harness.compute(), { message: 'Recommendation save failed', statusCode: 500 });
  assert.deepEqual(harness.events, ['save subject grades', 'save recommendation']);
});

test('student account details remain available to the notification service for eligibility checks', async () => {
  const student = { _id: 'student-1', role: 'student', gradeLevel: 'Grade 9', status: 'inactive', archive: { isArchived: true } };
  const harness = createHarness({ student });
  await harness.compute();
  assert.deepEqual(harness.alerts[0].student, student);
});
