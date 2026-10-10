const Assessment = require('../models/Assessment');
const SubjectEnrollment = require('../models/SubjectEnrollment');
const User = require('../models/User');
const { ROLE_STUDENT } = require('../constants/userRoles');
const {
  GRADING_PERIODS,
  normalizeGradingPeriod,
  normalizeAssessmentMode,
  normalizeAssignmentScope,
} = require('../constants/assessmentConfig');

function parseSubmissionDeadline(rawValue) {
  const hasValue = rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
  if (!hasValue) return null;
  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error('submissionDeadline must be a valid ISO date-time value');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseExamDurationMinutes(rawValue, options = {}) {
  const { required = false } = options;
  const hasValue = rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '';
  if (!hasValue) {
    if (!required) return null;
    const error = new Error('examDurationMinutes is required');
    error.statusCode = 400;
    throw error;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
    const error = new Error('examDurationMinutes must be an integer between 1 and 300');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function isPastDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() <= Date.now();
}

function buildAssessmentPolicy(input = {}) {
  const assessmentMode = normalizeAssessmentMode(input.assessmentMode || input.mode);
  const isPracticalExam = String(input.examType || '').trim().toLowerCase() === 'practical_exam';
  const gradingPeriod = assessmentMode === 'grading_assessment'
    ? normalizeGradingPeriod(input.gradingPeriod)
    : '';
  const assignmentScope = normalizeAssignmentScope(input.assignmentScope);
  const countsTowardRecommendation = assessmentMode === 'grading_assessment' && Boolean(gradingPeriod);

  if (assessmentMode === 'grading_assessment' && !gradingPeriod) {
    const error = new Error(`gradingPeriod is required for grading assessments. Allowed values: ${GRADING_PERIODS.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  if (isPracticalExam && assessmentMode !== 'grading_assessment') {
    const error = new Error('Practical Exam must be published as an exam with a 1st, 2nd, or 3rd grading period');
    error.statusCode = 400;
    throw error;
  }

  return {
    assessmentMode,
    gradingPeriod,
    countsTowardRecommendation,
    assignmentScope,
  };
}

async function resolveAssignedStudentIds({
  assignmentScope,
  teacherId,
  subjectId,
  fallbackToAllHandledStudents = false,
}) {
  const normalizedTeacherId = String(teacherId || '').trim();
  if (!normalizedTeacherId) return [];

  if (assignmentScope === 'advisory_class') {
    const teacher = await User.findById(normalizedTeacherId)
      .select('advisorySectionId')
      .lean();

    const advisorySectionId = String(teacher?.advisorySectionId || '').trim();
    const studentQuery = {
      role: ROLE_STUDENT,
      ...(advisorySectionId
        ? { sectionId: advisorySectionId }
        : { managedBy: normalizedTeacherId }),
    };

    const students = await User.find(studentQuery)
      .select('_id')
      .lean();
    return [...new Set(students.map((student) => String(student?._id || '')).filter(Boolean))];
  }

  const normalizedSubjectId = String(subjectId || '').trim();
  if (!normalizedSubjectId) {
    if (fallbackToAllHandledStudents) {
      const rows = await SubjectEnrollment.find({
        teacherId: normalizedTeacherId,
        status: 'approved',
      })
        .select('studentId')
        .lean();

      return [...new Set(rows.map((row) => String(row?.studentId || '')).filter(Boolean))];
    }

    const error = new Error('A subject-linked lesson is required when assigning an assessment to a handled class');
    error.statusCode = 400;
    throw error;
  }

  const rows = await SubjectEnrollment.find({
    teacherId: normalizedTeacherId,
    subjectId: normalizedSubjectId,
    status: 'approved',
  })
    .select('studentId')
    .lean();

  return [...new Set(rows.map((row) => String(row?.studentId || '')).filter(Boolean))];
}

async function assertUniqueGradingAssessment({ teacherId, subjectId, gradingPeriod, excludeAssessmentId = null }) {
  const normalizedTeacherId = String(teacherId || '').trim();
  const normalizedSubjectId = String(subjectId || '').trim();
  const normalizedGradingPeriod = normalizeGradingPeriod(gradingPeriod);
  if (!normalizedTeacherId || !normalizedSubjectId || !normalizedGradingPeriod) return;

  const query = {
    createdBy: normalizedTeacherId,
    subjectId: normalizedSubjectId,
    countsTowardRecommendation: true,
    gradingPeriod: normalizedGradingPeriod,
  };
  if (excludeAssessmentId) {
    query._id = { $ne: excludeAssessmentId };
  }

  const existing = await Assessment.findOne(query)
    .select('_id title')
    .lean();

  if (existing) {
    const error = new Error(`A grading assessment for the ${normalizedGradingPeriod} grading period already exists for this class.`);
    error.statusCode = 409;
    throw error;
  }
}

function isRecommendationAssessment(assessment) {
  return Boolean(assessment?.countsTowardRecommendation)
    && normalizeAssessmentMode(assessment?.assessmentMode) === 'grading_assessment'
    && Boolean(normalizeGradingPeriod(assessment?.gradingPeriod));
}

module.exports = {
  GRADING_PERIODS,
  parseSubmissionDeadline,
  parseExamDurationMinutes,
  isPastDate,
  buildAssessmentPolicy,
  resolveAssignedStudentIds,
  assertUniqueGradingAssessment,
  isRecommendationAssessment,
};
