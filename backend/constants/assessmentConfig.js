const GRADING_PERIODS = Object.freeze(['1st', '2nd', '3rd']);
const ASSESSMENT_MODES = ['activity', 'quiz', 'grading_assessment'];
const ASSIGNMENT_SCOPES = ['handled_class', 'advisory_class'];

function normalizeGradingPeriod(value) {
  const normalized = String(value || '').trim();
  return GRADING_PERIODS.includes(normalized) ? normalized : '';
}

function normalizeAssessmentMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ASSESSMENT_MODES.includes(normalized) ? normalized : 'activity';
}

function normalizeAssignmentScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ASSIGNMENT_SCOPES.includes(normalized) ? normalized : 'handled_class';
}

function gradingPeriodOrder(period) {
  return GRADING_PERIODS.indexOf(normalizeGradingPeriod(period));
}

module.exports = {
  GRADING_PERIODS,
  ASSESSMENT_MODES,
  ASSIGNMENT_SCOPES,
  normalizeGradingPeriod,
  normalizeAssessmentMode,
  normalizeAssignmentScope,
  gradingPeriodOrder,
};
