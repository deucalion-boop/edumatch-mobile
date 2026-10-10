const { readProfileRows } = require('./supabaseUserProfileService');
const { availableAssessments, studentSubmissions } = require('./supabaseStudentDashboardService');
const crypto = require('crypto');
const { upsertNotifications } = require('./supabaseNotificationService');
const { GRADING_PERIODS, normalizeGradingPeriod } = require('../constants/assessmentConfig');
const { getStudentSettings } = require('./studentSettingsService');

const STUDENT_ROLE = 'student';
const UPCOMING_DEADLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

function clean(value, fallback = '') {
  return String(value || '').trim() || fallback;
}

function truncate(value, maxLength) {
  const normalized = clean(value).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function senderDetails(sender, fallbackName = 'EduMatch') {
  return {
    senderId: sender?._id || null,
    senderRole: clean(sender?.role, 'system').toLowerCase(),
    senderName: truncate(sender?.name || sender?.username || fallbackName, 120),
  };
}

function hashValue(value) {
  return crypto.createHash('sha256').update(clean(value)).digest('hex').slice(0, 16);
}

async function createStudentNotifications({
  recipientIds,
  sender = null,
  type,
  title,
  subject,
  preview,
  message = '',
  urgent = false,
  eventKey,
  meta = {},
}) {
  const uniqueRecipientIds = [...new Set((recipientIds || []).map((id) => clean(id)).filter(Boolean))];
  if (uniqueRecipientIds.length === 0) return 0;

  const senderPayload = senderDetails(sender);
  const normalizedEventKey = clean(eventKey);
  return upsertNotifications(uniqueRecipientIds.map((recipientId) => ({
    recipientId,
    recipientRole: STUDENT_ROLE,
    ...senderPayload,
    type: clean(type, 'student_update').toLowerCase(),
    title: truncate(title, 220),
    message: truncate(message || subject || title, 400),
    subject: truncate(subject || title, 200),
    preview: truncate(preview || message || subject || title, 220),
    urgent: urgent === true,
    eventKey: normalizedEventKey,
    meta,
  })));
}

async function approvedStudentsForSubject(subjectId, teacherId) {
  const id = clean(subjectId?._id || subjectId?.id || subjectId);
  if (!id) return [];
  const subject = (await readProfileRows('subjects', 'id', id))[0];
  if (!subject || String(subject.teacherId) !== String(teacherId)) return [];
  const rows = await readProfileRows('subject_enrollments', 'subject_id', id);
  const ids = rows.filter(row => row.status === 'approved' && String(row.teacherId) === String(teacherId)).map(row => row.studentId);
  if (!ids.length) return [];
  return (await readProfileRows('users', 'id', ids)).filter(row => row.role === 'student' && row.status === 'active' && row.archive?.isArchived !== true).map(row => row.id);
}
async function resolveAssessmentRecipients(assessment, publisher) {
  const teacherId = publisher?._id || publisher?.id || assessment.createdBy;
  let eligible;
  if (assessment.assignmentScope === 'advisory_class') {
    const teacher = (await readProfileRows('users', 'id', teacherId))[0];
    eligible = teacher?.advisorySectionId ? (await readProfileRows('users', 'section_id', teacher.advisorySectionId))
      .filter(row => row.role === 'student' && row.status === 'active' && row.archive?.isArchived !== true).map(row => row.id) : [];
  } else {
    eligible = await approvedStudentsForSubject(assessment.subjectId || assessment.lessonId?.subjectId, teacherId);
  }
  const assigned = Array.isArray(assessment.assignedStudentIds) ? assessment.assignedStudentIds.map(String) : [];
  return assigned.length ? eligible.filter(id => assigned.includes(String(id))) : eligible;
}

async function notifyLessonPublished({ lesson, publisher }) {
  const recipientIds = await approvedStudentsForSubject(lesson?.subjectId, lesson?.createdBy?._id || lesson?.createdBy || publisher?._id);
  return createStudentNotifications({
    recipientIds,
    sender: publisher,
    type: 'lesson_published',
    title: clean(lesson?.title, 'New Lesson'),
    subject: clean(lesson?.subject, 'your class'),
    preview: `${clean(publisher?.name, 'Your teacher')} published a new ${clean(lesson?.subject, 'class')} lesson.`,
    eventKey: `lesson:${clean(lesson?._id)}`,
    meta: { route: '/student/lessons?lessonId=' + encodeURIComponent(clean(lesson?._id)), contentType: 'Lesson', entityType: 'lesson', entityId: clean(lesson?._id) },
  });
}

async function notifyAssessmentAssigned({ assessment, publisher }) {
  const recipientIds = await resolveAssessmentRecipients(assessment, publisher);
  const isActivity = clean(assessment?.assessmentMode).toLowerCase() === 'activity';
  const contentType = isActivity ? 'Activity' : clean(assessment?.assessmentMode).toLowerCase() === 'quiz' ? 'Quiz' : 'Exam';
  const deadline = assessment?.submissionDeadline ? new Date(assessment.submissionDeadline) : null;
  const deadlineText = deadline && !Number.isNaN(deadline.getTime())
    ? ` Due ${deadline.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}.`
    : '';
  return createStudentNotifications({
    recipientIds,
    sender: publisher,
    type: isActivity ? 'activity_assigned' : 'assessment_assigned',
    title: clean(assessment?.title, 'New ' + contentType),
    subject: clean(assessment?.subject, 'your class'),
    preview: `A new ${contentType} has been posted in ${clean(assessment?.subject, 'your class')}.${deadlineText}`,
    eventKey: `assessment:${clean(assessment?._id)}`,
    meta: { route: '/student/activities?assessmentId=' + encodeURIComponent(clean(assessment?._id)), contentType, entityType: 'assessment', entityId: clean(assessment?._id) },
  });
}

async function notifySubmissionCompleted({ submission, assessment }) {
  const isActivity = clean(assessment?.assessmentMode).toLowerCase() === 'activity';
  return createStudentNotifications({
    recipientIds: [submission?.studentId],
    type: isActivity ? 'activity_submitted' : 'assessment_submitted',
    title: isActivity ? 'Activity submitted successfully' : 'Assessment submitted successfully',
    subject: clean(assessment?.title, isActivity ? 'Activity' : 'Assessment'),
    preview: isActivity
      ? 'Your work was received. You will be notified when your teacher posts a grade or feedback.'
      : 'Your answers were received and your result is now available.',
    eventKey: `submission:${clean(submission?._id)}:${clean(submission?.submittedAt)}`,
    meta: { route: '/student/activities', entityType: 'submission', entityId: clean(submission?._id) },
  });
}

async function notifyAutomatedGrade({ submission, assessment }) {
  const total = Number(submission?.totalPoints || 0);
  if (total <= 0) return 0;
  const score = Number(submission?.score || 0);
  return createStudentNotifications({
    recipientIds: [submission?.studentId],
    type: 'grade_released',
    title: 'Grade released',
    subject: clean(assessment?.title, 'Assessment result'),
    preview: `Your score is ${score} out of ${total}.`,
    eventKey: `auto-grade:${clean(submission?._id)}:${score}:${total}`,
    meta: { route: '/student/dashboard?section=grades', entityType: 'submission', entityId: clean(submission?._id) },
  });
}

async function syncUpcomingDeadlines(studentId) {
  const settings = await getStudentSettings(studentId);
  if (settings.notifications.deadlines === false || settings.notifications.inApp === false) return;
  const reminder = settings.learning.deadlineReminder;
  if (reminder === 'none') return;
  const now = new Date();
  const windowMultiplier = reminder === 'three-days' ? 3 : 1;
  const deadlineLimit = new Date(now.getTime() + (UPCOMING_DEADLINE_WINDOW_MS * windowMultiplier));
  const manilaDate = (value) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const approvedSubjectIds = (await readProfileRows('subject_enrollments', 'student_id', studentId)).filter(row => row.status === 'approved').map(row => row.subjectId);
  const assessments = (await availableAssessments(studentId, approvedSubjectIds)).filter(row => {
    const deadline = new Date(row.submissionDeadline);
    if (!(deadline > now) || deadline > deadlineLimit) return false;
    return reminder !== 'same-day' || manilaDate(deadline) === manilaDate(now);
  });
  const submittedIds = new Set((await studentSubmissions(studentId, true)).map(row => clean(row.assessmentId?._id)));
  await Promise.all(assessments
    .filter((assessment) => !submittedIds.has(clean(assessment._id)))
    .map((assessment) => createStudentNotifications({
      recipientIds: [studentId],
      type: 'deadline_upcoming',
      title: 'Upcoming submission deadline',
      subject: clean(assessment.title, 'Assigned work'),
      preview: `Due ${new Date(assessment.submissionDeadline).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}.`,
      urgent: true,
      eventKey: `deadline:${clean(assessment._id)}:${new Date(assessment.submissionDeadline).toISOString()}`,
      meta: { route: '/student/activities', entityType: 'assessment', entityId: clean(assessment._id) },
    })));
}

async function syncGradesAndFeedback(studentId) {
  const submissions = (await studentSubmissions(studentId)).filter(row => row.gradeValue != null || clean(row.teacherFeedback) || row.gradedAt).slice(0, 60);
  const tasks = [];
  submissions.forEach((submission) => {
    const assessmentTitle = clean(submission?.assessmentId?.title, 'Activity');
    if (submission.gradeValue !== null && submission.gradeValue !== undefined) {
      tasks.push(createStudentNotifications({
        recipientIds: [studentId],
        type: 'grade_updated',
        title: 'Grade released or updated',
        subject: assessmentTitle,
        preview: `Your teacher posted a grade of ${submission.gradeValue}.`,
        eventKey: `teacher-grade:${clean(submission._id)}:${submission.gradeValue}:${clean(submission.gradedAt)}`,
        meta: { route: '/student/dashboard?section=grades', entityType: 'submission', entityId: clean(submission._id) },
      }));
    }
    const feedback = clean(submission.teacherFeedback);
    if (feedback) {
      tasks.push(createStudentNotifications({
        recipientIds: [studentId],
        type: 'teacher_feedback',
        title: 'Teacher feedback received',
        subject: assessmentTitle,
        preview: truncate(feedback, 220),
        eventKey: `feedback:${clean(submission._id)}:${hashValue(feedback)}`,
        meta: { route: '/student/activities', entityType: 'submission', entityId: clean(submission._id) },
      }));
    }
  });
  await Promise.all(tasks);
}

async function syncRecommendation(studentId) {
  const recommendation = (await readProfileRows('recommendations', 'student_id', studentId))[0];
  const attempts = (Array.isArray(recommendation?.assessmentAttempts) ? recommendation.assessmentAttempts : [])
    .filter((attempt) => Boolean(normalizeGradingPeriod(attempt?.gradingPeriod)));
  if (attempts.length === 0) return;
  const strand = clean(recommendation?.recommendedStrand?.name);
  const isReady = Boolean(strand);
  const completedPeriods = new Set(attempts.map((attempt) => normalizeGradingPeriod(attempt?.gradingPeriod)));
  const completedCount = GRADING_PERIODS.filter((period) => completedPeriods.has(period)).length;
  const progress = Math.min(100, Math.round((completedCount / GRADING_PERIODS.length) * 100));
  await createStudentNotifications({
    recipientIds: [studentId],
    type: isReady ? 'recommendation_ready' : 'recommendation_progress',
    title: isReady ? 'New strand recommendation' : 'Recommendation progress updated',
    subject: isReady ? `${strand} is your recommended strand` : `${progress}% complete`,
    preview: isReady
      ? 'Your strand recommendation is ready. Open your dashboard to review the result.'
      : `You have completed ${completedCount} of ${GRADING_PERIODS.length} grading assessments.`,
    eventKey: `recommendation:${isReady ? strand : 'progress'}:${completedCount}`,
    meta: { route: '/student/dashboard?section=recommendations', entityType: 'recommendation', entityId: clean(recommendation?._id) },
  });
}

async function syncStudentNotifications(studentId) {
  await Promise.all([
    syncUpcomingDeadlines(studentId),
    syncGradesAndFeedback(studentId),
    syncRecommendation(studentId),
  ]);
}

async function safelyRunNotificationTask(label, task) {
  try {
    return await task();
  } catch (error) {
    console.error(`[NOTIFICATIONS] ${label} failed:`, error?.message || error);
    return null;
  }
}

module.exports = {
  approvedStudentsForSubject,
  createStudentNotifications,
  notifyAssessmentAssigned,
  notifyAutomatedGrade,
  notifyLessonPublished,
  notifySubmissionCompleted,
  safelyRunNotificationTask,
  syncStudentNotifications,
};
