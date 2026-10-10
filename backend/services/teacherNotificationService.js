const crypto = require('crypto');
const Assessment = require('../models/Assessment');
const { upsertNotification } = require('./supabaseNotificationService');
const Submission = require('../models/Submission');
const SubjectEnrollment = require('../models/SubjectEnrollment');
const { findSupabaseAccount } = require('./supabaseAccountService');

const TEACHER_ROLE = 'teacher';
const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value, fallback = '') {
  return String(value || '').trim() || fallback;
}

function truncate(value, maxLength) {
  const normalized = clean(value).replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function hashIds(values) {
  return crypto.createHash('sha256')
    .update((values || []).map((value) => clean(value)).sort().join(':'))
    .digest('hex')
    .slice(0, 16);
}

async function createTeacherNotification({
  recipientId,
  sender = null,
  type,
  title,
  subject,
  preview,
  urgent = false,
  eventKey,
  meta = {},
}) {
  const normalizedRecipientId = clean(recipientId);
  const normalizedEventKey = clean(eventKey);
  if (!normalizedRecipientId || !normalizedEventKey) return null;

  const senderName = truncate(sender?.name || sender?.username || 'EduMatch', 120);
  return upsertNotification({
    recipientId: normalizedRecipientId,
    recipientRole: TEACHER_ROLE,
    senderId: sender?._id || null,
    senderRole: clean(sender?.role, 'system').toLowerCase(),
    senderName,
    type: clean(type, 'teacher_update').toLowerCase(),
    title: truncate(title, 220),
    message: truncate(subject || title, 400),
    subject: truncate(subject || title, 200),
    preview: truncate(preview || subject || title, 220),
    urgent: urgent === true,
    eventKey: normalizedEventKey,
    meta,
  });
}

async function getStudent(studentOrId) {
  if (studentOrId && typeof studentOrId === 'object' && studentOrId.name) return studentOrId;
  const studentId = clean(studentOrId?._id || studentOrId);
  if (!studentId) return null;
  return findSupabaseAccount('id', studentId);
}

async function notifyEnrollmentRequest({ enrollment, student, subject }) {
  const sender = await getStudent(student || enrollment?.studentId);
  return createTeacherNotification({
    recipientId: enrollment?.teacherId || subject?.teacherId,
    sender,
    type: 'enrollment_request',
    title: 'New enrollment request',
    subject: clean(subject?.className || subject?.name, 'Class enrollment'),
    preview: `${clean(sender?.name, 'A student')} requested to join your class.`,
    eventKey: `enrollment:${clean(enrollment?._id)}`,
    meta: {
      route: '/teacher/students?request=' + encodeURIComponent(clean(enrollment?._id)),
      entityType: 'enrollment',
      entityId: clean(enrollment?._id),
    },
  });
}

async function notifyTeacherSubmission({ submission, assessment, student }) {
  const sender = await getStudent(student || submission?.studentId);
  const isActivity = clean(assessment?.assessmentMode).toLowerCase() === 'activity';
  return createTeacherNotification({
    recipientId: assessment?.createdBy,
    sender,
    type: 'student_submission',
    title: 'New student submission',
    subject: clean(assessment?.title, isActivity ? 'Activity submission' : 'Assessment submission'),
    preview: `${clean(sender?.name, 'A student')} submitted ${isActivity ? 'an activity' : 'an assessment'}${isActivity ? ' and it is ready for review.' : '.'}`,
    eventKey: `teacher-submission:${clean(submission?._id)}:${clean(submission?.submittedAt)}`,
    meta: { route: '/teacher/records?tab=assessments', entityType: 'submission', entityId: clean(submission?._id) },
  });
}

async function notifyExamIncident({ submission, assessment, student, action }) {
  const sender = await getStudent(student || submission?.studentId);
  const normalizedAction = clean(action || submission?.status, 'flagged').toLowerCase();
  const isTerminated = normalizedAction.includes('terminat');
  const isPaused = normalizedAction.includes('pause');
  const title = isTerminated
    ? 'Assessment terminated'
    : (isPaused ? 'Assessment paused after violations' : 'Assessment automatically submitted');
  return createTeacherNotification({
    recipientId: assessment?.createdBy,
    sender,
    type: 'exam_incident',
    title,
    subject: clean(assessment?.title, 'Assessment incident'),
    preview: `${clean(sender?.name, 'A student')} reached ${Number(submission?.violationCount || 0)} recorded violation(s).`,
    urgent: true,
    eventKey: `exam-incident:${clean(submission?._id)}:${normalizedAction}:${Number(submission?.violationCount || 0)}`,
    meta: { route: '/teacher/records?tab=assessments', entityType: 'submission', entityId: clean(submission?._id) },
  });
}

async function syncPendingEnrollments(teacherId) {
  const enrollments = await SubjectEnrollment.find({ teacherId, status: 'pending' })
    .populate('studentId', '_id name username role')
    .populate('subjectId', 'name className teacherId')
    .sort({ requestedAt: -1 })
    .limit(50)
    .lean();
  await Promise.all(enrollments.map((enrollment) => notifyEnrollmentRequest({
    enrollment,
    student: enrollment.studentId,
    subject: enrollment.subjectId,
  })));
}

async function syncGradingQueue(teacherId) {
  const activityIds = (await Assessment.find({ createdBy: teacherId, assessmentMode: 'activity' })
    .select('_id')
    .lean()).map((assessment) => assessment._id);
  if (activityIds.length === 0) return;

  const cutoff = new Date(Date.now() - DAY_MS);
  const pending = await Submission.find({
    assessmentId: { $in: activityIds },
    status: 'completed',
    submittedAt: { $lte: cutoff },
    gradedAt: null,
    gradeValue: null,
  }).select('_id').sort({ submittedAt: 1 }).limit(100).lean();
  if (pending.length === 0) return;

  await createTeacherNotification({
    recipientId: teacherId,
    type: 'grading_queue',
    title: 'Work awaiting grading',
    subject: `${pending.length} submission${pending.length === 1 ? '' : 's'} need review`,
    preview: 'One or more activity submissions have been waiting for feedback for over 24 hours.',
    eventKey: `grading-queue:${hashIds(pending.map((row) => row._id))}`,
    meta: { route: '/teacher/records?tab=assessments', entityType: 'grading_queue' },
  });
}

async function expectedStudentIds(assessment) {
  const assigned = Array.isArray(assessment?.assignedStudentIds)
    ? assessment.assignedStudentIds.map((id) => clean(id)).filter(Boolean)
    : [];
  if (assigned.length > 0) return [...new Set(assigned)];
  const enrollments = await SubjectEnrollment.find({
    teacherId: assessment?.createdBy,
    subjectId: assessment?.subjectId,
    status: 'approved',
  }).select('studentId').lean();
  return [...new Set(enrollments.map((row) => clean(row.studentId)).filter(Boolean))];
}

async function syncDeadlineAlerts(teacherId) {
  const now = new Date();
  const assessments = await Assessment.find({
    createdBy: teacherId,
    submissionDeadline: { $gte: new Date(now.getTime() - (7 * DAY_MS)), $lte: new Date(now.getTime() + DAY_MS) },
  }).select('_id title subjectId createdBy assignedStudentIds submissionDeadline').lean();

  await Promise.all(assessments.map(async (assessment) => {
    const studentIds = await expectedStudentIds(assessment);
    if (studentIds.length === 0) return;
    const submittedIds = new Set((await Submission.find({
      assessmentId: assessment._id,
      studentId: { $in: studentIds },
      status: { $in: ['completed', 'auto_submitted', 'terminated'] },
    }).select('studentId').lean()).map((row) => clean(row.studentId)));
    const missingCount = studentIds.filter((studentId) => !submittedIds.has(studentId)).length;
    if (missingCount === 0) return;

    const deadline = new Date(assessment.submissionDeadline);
    const isMissed = deadline <= now;
    await createTeacherNotification({
      recipientId: teacherId,
      type: isMissed ? 'deadline_missed' : 'deadline_upcoming_teacher',
      title: isMissed ? 'Students missed a deadline' : 'Upcoming class deadline',
      subject: clean(assessment.title, 'Assigned work'),
      preview: `${missingCount} student${missingCount === 1 ? ' has' : 's have'} not submitted. ${isMissed ? 'The deadline has passed.' : `Due ${deadline.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}.`}`,
      urgent: isMissed,
      eventKey: `teacher-deadline:${clean(assessment._id)}:${isMissed ? 'missed' : 'upcoming'}:${deadline.toISOString()}`,
      meta: { route: '/teacher/records?tab=assessments', entityType: 'assessment', entityId: clean(assessment._id) },
    });
  }));
}

async function syncTeacherNotifications(teacherId) {
  await Promise.all([
    syncPendingEnrollments(teacherId),
    syncGradingQueue(teacherId),
    syncDeadlineAlerts(teacherId),
  ]);
}

module.exports = {
  notifyEnrollmentRequest,
  notifyExamIncident,
  notifyTeacherSubmission,
  syncTeacherNotifications,
};
