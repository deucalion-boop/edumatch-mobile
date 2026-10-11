const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { upsertNotifications } = require('./supabaseNotificationService');

const ADMIN_ROLE = 'admin';
const RECIPIENT_PAGE_SIZE = 500;

function clean(value, fallback = '') {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || fallback : fallback;
}

function referenceId(value) {
  return clean(value && typeof value === 'object' ? value._id || value.id : value);
}

async function activeAdminIds() {
  const recipients = new Set();
  const client = getSupabaseStorageClient();
  for (let offset = 0; ; offset += RECIPIENT_PAGE_SIZE) {
    const { data, error } = await client.from('users').select('id,role,status')
      .eq('role', ADMIN_ROLE).eq('status', 'active')
      .order('id', { ascending: true }).range(offset, offset + RECIPIENT_PAGE_SIZE - 1);
    if (error) throw Object.assign(new Error(error.message || 'Failed to find admin notification recipients'), { statusCode: 500 });
    const rows = data || [];
    for (const row of rows) {
      const id = referenceId(row);
      if (id && row.role === ADMIN_ROLE && row.status === 'active') recipients.add(id);
    }
    if (rows.length < RECIPIENT_PAGE_SIZE) break;
  }
  return [...recipients];
}

async function createAdminNotifications({ sender, type, title, message, eventKey, meta }) {
  const recipientIds = await activeAdminIds();
  if (!recipientIds.length) return 0;
  return upsertNotifications(recipientIds.map(recipientId => ({
    recipientId,
    recipientRole: ADMIN_ROLE,
    senderId: referenceId(sender) || null,
    senderRole: clean(sender?.role, 'system'),
    senderName: clean(sender?.name || sender?.username, 'EduMatch'),
    type,
    title,
    subject: title,
    message,
    preview: message,
    eventKey,
    meta,
  })));
}

async function notifyLessonCreated({ lesson, publisher }) {
  const lessonId = referenceId(lesson);
  if (!lessonId) return 0;
  const name = clean(publisher?.name || publisher?.username, 'A teacher');
  const title = clean(lesson.title, 'Untitled lesson');
  const subject = clean(lesson.subject);
  return createAdminNotifications({
    sender: publisher,
    type: 'lesson_created',
    title: 'New lesson created',
    message: `${name} created the lesson "${title}"${subject ? ` in ${subject}` : ''}.`,
    eventKey: `admin:lesson-created:${lessonId}`,
    meta: {
      route: '/admin/notifications', entityType: 'lesson', entityId: lessonId,
      lessonId, lessonTitle: title, subject, subjectId: referenceId(lesson.subjectId),
      teacherId: referenceId(lesson.createdBy), publisherId: referenceId(publisher),
    },
  });
}

async function notifyAssessmentCreated({ assessment, publisher }) {
  const assessmentId = referenceId(assessment);
  if (!assessmentId) return 0;
  const name = clean(publisher?.name || publisher?.username, 'A teacher');
  const title = clean(assessment.title, 'Untitled assessment');
  const subject = clean(assessment.subject);
  return createAdminNotifications({
    sender: publisher,
    type: 'assessment_created',
    title: 'New assessment created',
    message: `${name} created the assessment "${title}"${subject ? ` in ${subject}` : ''}.`,
    eventKey: `admin:assessment-created:${assessmentId}`,
    meta: {
      route: '/admin/notifications', entityType: 'assessment', entityId: assessmentId,
      assessmentId, assessmentTitle: title, subject, subjectId: referenceId(assessment.subjectId),
      teacherId: referenceId(assessment.createdBy), publisherId: referenceId(publisher),
      assessmentMode: clean(assessment.assessmentMode),
    },
  });
}

async function notifyRecommendationReady({ student, academicProgress }) {
  const studentId = referenceId(student);
  const gradeLevel = clean(student?.gradeLevel).toLowerCase().replace(/^grade\s*/, '');
  const strand = clean(academicProgress?.recommendedStrand?.name);
  if (!studentId || student?.role !== 'student' || student?.status !== 'active'
    || student?.archive?.isArchived === true || gradeLevel !== '10'
    || academicProgress?.isRecommendationReady !== true
    || academicProgress?.recommendationProgressPercent !== 100 || !strand) return 0;
  const studentName = clean(student.name || student.username, 'A student');
  return createAdminNotifications({
    sender: student,
    type: 'student_recommendation_ready',
    title: 'Student recommendation ready',
    message: `${studentName} completed the required grading progress and received a ${strand} strand recommendation.`,
    // A refresh or recomputation must not reset a read/cleared alert or send another push.
    eventKey: `admin:recommendation-ready:${studentId}`,
    meta: {
      route: '/admin/academic', entityType: 'student', entityId: studentId,
      studentId, studentName, recommendedStrand: strand, recommendationProgressPercent: 100,
      sectionName: clean(student.sectionName), gradeLevel: clean(student.gradeLevel),
    },
  });
}

module.exports = { notifyLessonCreated, notifyAssessmentCreated, notifyRecommendationReady };
