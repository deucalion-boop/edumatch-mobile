/* Verification fixture only. Never deploy this server or import it into the app. */
'use strict';
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const port = Number(process.env.VERIFICATION_API_PORT || 5099);
const hostname = '127.0.0.1';
const origin = `http://${hostname}:${port}`;
const fixed = '2026-10-09T01:00:00.000Z';
const roleNames = { admin: 'Dr. Elena Reyes', secretary: 'Julia Flores', headteacher: 'Alicia Cruz', teacher: 'Mateo Rivera', student: 'Maya Santos' };
const roles = Object.keys(roleNames);
const users = roles.map(role => ({ id: `${role}-1`, name: roleNames[role], email: `${role}@gmail.com`, username: role,
  role, status: 'active', department: ['teacher', 'headteacher'].includes(role) ? 'Mathematics' : '', subject: role === 'teacher' ? 'Mathematics' : '',
  strand: 'STEM', gradeLevel: role === 'student' ? '10' : '', sectionId: role === 'student' ? 'section-1' : '',
  section: role === 'student' ? { id: 'section-1', name: '10 – Newton' } : null,
  advisorySectionId: role === 'teacher' ? 'section-1' : '', forcePasswordChange: false,
  contactNumber: '09123456789', createdAt: fixed }));
const pendingStudent = { id: 'student-2', name: 'Paulo Dela Cruz', email: 'paulo@gmail.com', role: 'student', status: 'active', gradeLevel: '10', strand: 'STEM', sectionId: 'section-1' };
users.push(pendingStudent);
const studentRecords = users.filter(user => user.role === 'student').map(user => ({ ...user,
  section: { id: 'section-1', name: '10 – Newton' }, adviser: { id: 'teacher-1', name: roleNames.teacher },
  progress: { masteryProgress: 84, averageScore: 84, completedAssessments: 3 },
  recommendation: { recommendationExplanation: 'Recent Mathematics evidence indicates consistent progress.', recommendationStatus: 'in_progress' } }));
const sections = [{ id: 'section-1', name: '10 – Newton', gradeLevel: '10', department: 'Mathematics', adviser: { id: 'teacher-1', name: roleNames.teacher } }];
const subjects = [{ id: 'subject-1', name: 'Mathematics', subject: 'Mathematics', className: '10 – Newton', code: 'MATH10',
  track: 'STEM', description: 'Mathematics for Grade 10.', teacherId: 'teacher-1', enrollmentStatus: 'approved',
  approvedStudentsCount: 2, pendingRequestsCount: 1, lessonCount: 1, assessmentCount: 2, createdAt: fixed }];
const joinableSubject = { id: 'subject-join7', name: 'Mathematics 7', subject: 'Mathematics', className: 'Grade 7 – Sampaguita', code: 'JOIN7',
  track: 'GENERAL', description: 'A class used only for enrollment verification.', teacherId: 'teacher-1',
  teacher: { id: 'teacher-1', name: roleNames.teacher, email: 'teacher@gmail.com', profileImage: null }, createdAt: fixed };
const subjectEnrollmentRequests = new Map();
const lessons = [{ id: 'lesson-1', title: 'Quadratic equations', description: 'Recognize and solve quadratic equations using appropriate methods.',
  subject: 'Mathematics', subjectId: 'subject-1', className: '10 – Newton', track: 'STEM', createdAt: fixed,
  attachments: [{ id: 'attachment-1', fileName: 'quadratic-equations.pdf', fileType: 'application/pdf', size: 64,
    url: `${origin}/api/verification/material.pdf`, downloadUrl: `${origin}/api/verification/material.pdf` }],
  progress: { status: 'in_progress', progressPercent: 30, engagementSeconds: 120, reachedEnd: false } }];
const assessments = [{ id: 'assessment-1', title: 'Model a real-world equation', subject: 'Mathematics', subjectId: 'subject-1',
  assessmentMode: 'activity', activityPoints: 25, challengeDescription: 'Describe a situation that can be represented by a quadratic equation and explain your solution.',
  allowedSubmissionTypes: ['written', 'link', 'file'], allowResubmission: true, allowLateSubmissions: false,
  attachments: [], isLocked: false, isDeadlinePassed: false, submissionDeadline: '2026-12-30T10:00:00.000Z', createdAt: fixed },
{ id: 'assessment-2', title: 'Quadratic equations quiz', subject: 'Mathematics', subjectId: 'subject-1', assessmentMode: 'quiz',
  examType: 'multiple_choice', examDurationMinutes: 30, numberOfItems: 2, activityPoints: null, attachments: [], isLocked: false,
  questions: [{ questionText: 'Which equation is quadratic?', type: 'multiple_choice', options: ['x² + 2x + 1 = 0', '2x + 1 = 0'], points: 1 },
    { questionText: 'Solve x² = 4.', type: 'short_answer', options: [], points: 1 }], createdAt: fixed }];
if (process.env.VERIFICATION_LEARNING_PAGINATION === 'true') {
  const lessonTemplate = structuredClone(lessons[0]);
  const lessonTitles = ['Quadratic equations', 'Factoring polynomials', 'Functions and graphs', 'Linear inequalities', 'Geometry foundations',
    'Ratios and proportions', 'Data and probability', 'Coordinate geometry', 'Sequences and patterns', 'Measurement and area', 'Review and reflection'];
  lessons.splice(0, lessons.length, ...lessonTitles.map((title, index) => ({ ...structuredClone(lessonTemplate), id: `lesson-pagination-${index + 1}`, title,
    description: `${title}: read the class notes, consider the worked examples, and practice explaining each step. Bring your questions to the next class discussion.`,
    attachments: lessonTemplate.attachments.map(file => ({ ...file, id: `attachment-pagination-${index + 1}`, fileName: `lesson-${index + 1}-notes.pdf` })) })));
  const activityTemplate = structuredClone(assessments[0]);
  const quizTemplate = structuredClone(assessments[1]);
  const assessmentTitles = ['Model a real-world equation', 'Quadratic equations quiz', 'Interpret a graph', 'Compare geometric figures', 'Apply ratios',
    'Describe a data set', 'Explain a pattern'];
  assessments.splice(0, assessments.length, ...assessmentTitles.map((title, index) => ({ ...structuredClone(index === 1 ? quizTemplate : activityTemplate),
    id: `assessment-pagination-${index + 1}`, title, challengeDescription: index === 1 ? undefined : `${title}. Explain your reasoning using a clear example from your class notes.` })));
}
const grades = [{ id: 'submission-1', studentId: 'student-1', studentName: roleNames.student, studentEmail: 'student@gmail.com',
  assessmentId: 'assessment-1', assessmentTitle: assessments[0].title, subjectId: 'subject-1', subjectName: 'Mathematics',
  assessmentMode: 'activity', activityPoints: 25, score: 21, totalPoints: 25, percentage: 84, gradeValue: 21,
  status: 'completed', scoringStatus: 'final', teacherFeedback: 'A clear explanation. Include units in the model.',
  responseText: 'A ball thrown upward follows a quadratic path.', links: [], attachments: [], submittedAt: fixed }];
const requests = [{ id: 'enrollment-1', studentId: 'student-2', name: pendingStudent.name, email: pendingStudent.email,
  status: 'active', enrollmentStatus: 'pending', subjectId: 'subject-1', subjectName: 'Mathematics', className: '10 – Newton', requestedAt: fixed }];
const exportRequests = [{ id: 'export-request-1', requestType: 'archived_student_records_pdf', status: 'pending', format: 'pdf', studentCount: 2,
  requester: { id: 'secretary-1', role: 'secretary', name: roleNames.secretary }, filters: { schoolYear: '2025-2026', department: 'all', gradeLevel: 'all', searchTerm: '' }, createdAt: fixed }];
const accounts = [{ id: 'account-request-1', studentId: 'student-2', studentName: pendingStudent.name,
  studentEmail: pendingStudent.email, action: 'deactivate', reason: 'The learner transferred to another school.', status: 'pending', createdAt: fixed }];
const notifications = roles.map(role => ({ id: `notification-${role}`, recipientRole: role, type: role === 'student' ? 'announcement_published' : 'admin_message',
  title: 'Welcome to the school year', subject: 'School updates', message: 'Review your class schedules and attendance records.', content: 'Review your class schedules and attendance records.',
  eventKey: `announcement:${createHash('sha256').update(role).digest('hex')}`, senderName: roleNames.admin, teacher: roleNames.admin, isViewed: false, createdAt: fixed,
  meta: { route: role === 'student' ? '/student/announcements' : '/notifications' } }));
const attendanceRecords = [{ id: 'attendance-1', title: '10 – Newton', dateKey: '2026-10-08', attendanceScope: 'handled_class', isLocked: true,
  subject: { id: 'subject-1', name: 'Mathematics', className: '10 – Newton', code: 'MATH10' }, section: sections[0], teacher: { id: 'teacher-1', name: roleNames.teacher },
  entries: [{ studentId: 'student-1', studentName: roleNames.student, status: 'Present' }, { studentId: 'student-2', studentName: pendingStudent.name, status: 'Late' }],
  summary: { totalStudents: 2, presentCount: 1, lateCount: 1, absentCount: 0, excusedCount: 0 } }];
const sessionMap = new Map();
const challenges = new Map();
const activeTokens = new Set();
const drafts = new Map();
const examSessions = new Map();
const announcementsSent = new Set();
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ success: status < 400, message: status < 400 ? 'Verification fixture response' : value.message, ...value }));
}
function requireRole(user, ...allowed) {
  if (!allowed.includes(user.role)) throw Object.assign(new Error('Forbidden: insufficient permissions'), { status: 403 });
}
function sessionPublic(value) {
  const { qrPayload, roster, ...session } = value;
  return { ...session, scanCount: roster.filter(row => row.scannedAt).length };
}
function attendanceSummary(records) {
  return records.reduce((total, record) => {
    for (const status of ['presentCount', 'lateCount', 'absentCount', 'excusedCount']) total[status] += record.summary[status] || 0;
    return total;
  }, { totalRecords: records.length, totalStudents: 2, presentCount: 0, lateCount: 0, absentCount: 0, excusedCount: 0, totalTeachers: 1 });
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
    const output = {};
    for (const match of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type:[^\r]*\r\n)?\r\n([\s\S]*?)(?=\r\n--)/g)) {
      output[match[1]] = match[2] ? { fileName: match[2] } : match[3];
    }
    return output;
  }
  return JSON.parse(body);
}
const captchaHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verification CAPTCHA fixture</title></head><body style="font:16px system-ui;padding:24px;background:#f4f8f7"><h2>Verification fixture</h2><p>This local test check substitutes only the external CAPTCHA service for browser verification.</p><button id="verify" style="padding:16px;border-radius:10px;border:0;background:#087f6d;color:white;font-size:16px">Complete verification check</button><script>document.getElementById('verify').onclick=function(){var value=JSON.stringify({type:'captcha',token:'verification-captcha-token'});if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(value);else window.parent.postMessage(value,'*');};</script></body></html>`;

async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, origin);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const method = req.method;
  if (path === '/health') return send(res, 200, { fixture: true });
  if (path === '/mobile/captcha') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(captchaHtml);
  }
  if (path === '/verification/material.pdf') {
    const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="quadratic-equations.pdf"' }); return res.end(pdf);
  }
  const body = await readBody(req);
  if (path === '/auth/login' && method === 'POST') {
    const role = body.username === 'principal' ? 'admin' : body.username;
    if (!roles.includes(role) || body.password !== 'VerifyEduMatch1!') return send(res, 401, { message: 'Invalid fixture credentials' });
    if (body.captchaToken !== 'verification-captcha-token') return send(res, 400, { message: 'Complete the verification check.' });
    const challengeToken = createHash('sha256').update(`${role}-${Date.now()}`).digest('hex');
    challenges.set(challengeToken, role);
    return send(res, 202, { requiresOtp: true, challengeToken, deliveryHint: `${role[0]}***@gmail.com`,
      expiresAt: new Date(Date.now() + 120000).toISOString(), resendAvailableAt: new Date(Date.now() + 30000).toISOString() });
  }
  if (path === '/auth/login/resend-otp' && method === 'POST') {
    if (!challenges.has(body.challengeToken)) return send(res, 400, { message: 'Invalid challenge' });
    return send(res, 202, { requiresOtp: true, challengeToken: body.challengeToken, deliveryHint: 'f***@gmail.com',
      expiresAt: new Date(Date.now() + 120000).toISOString(), resendAvailableAt: new Date(Date.now() + 30000).toISOString() });
  }
  if (path === '/auth/login/verify-otp' && method === 'POST') {
    const role = challenges.get(body.challengeToken);
    if (!role || body.otpCode !== '123456' || body.captchaToken !== 'verification-captcha-token') return send(res, 400, { message: 'Invalid fixture verification code or CAPTCHA.' });
    challenges.delete(body.challengeToken);
    const token = `fixture-token-${role}`; activeTokens.add(token);
    return send(res, 200, { token, user: users.find(user => user.role === role) });
  }
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const role = token.replace('fixture-token-', '');
  const user = users.find(item => item.id === `${role}-1`);
  if (!user || !activeTokens.has(token)) return send(res, 401, { message: 'Invalid or expired token' });
  if (path === '/auth/logout') { activeTokens.delete(token); return send(res, 200, {}); }
  if (path === '/mobile/me') return send(res, 200, { user });
  if (path === '/auth/presence') return send(res, 200, { lastActivityAt: new Date().toISOString() });
  if (path === '/auth/sessions') return send(res, 200, { sessions: [{ id: 'fixture-session', current: true, createdAt: fixed, expiresAt: '2026-12-30T00:00:00.000Z' }] });
  if (/^\/auth\/sessions\//.test(path) && method === 'DELETE') return send(res, 200, {});
  if (/^\/mobile\/devices/.test(path)) return send(res, 200, { registered: method !== 'DELETE' });
  if (path === '/notifications' && method === 'GET') return send(res, 200, { notifications: notifications.filter(row => row.recipientRole === role), unreadCount: notifications.filter(row => row.recipientRole === role && !row.isViewed).length });
  if (path === '/notifications/announcements') { requireRole(user, 'student'); return send(res, 200, { announcements: notifications.filter(row => row.recipientRole === 'student' && row.type === 'announcement_published') }); }
  if (/^\/notifications\/[^/]+\/view$/.test(path) || path === '/notifications/view-all') {
    notifications.filter(row => row.recipientRole === role && (path.endsWith('view-all') || row.id === path.split('/')[2])).forEach(row => { row.isViewed = true; });
    return send(res, 200, { unreadCount: 0 });
  }
  const namespace = path.split('/')[1];
  if (roles.includes(namespace)) requireRole(user, namespace);
  if (path === '/admin/analytics') return send(res, 200, { analytics: { totalUsers: users.length, totalStudents: 2, totalTeachers: 1, totalSubjects: subjects.length, totalAssessments: assessments.length }, recentActivities: [{ id: 'activity-1', title: 'Lesson published', description: lessons[0].title, type: 'lesson', occurredAt: fixed }] });
  if (/^\/(admin|secretary)\/users$/.test(path)) {
    if (method === 'GET') return send(res, 200, { users });
    const created = { ...body, id: randomUUID(), role: body.role || 'student', status: 'pending' }; users.push(created); return send(res, 201, { user: created });
  }
  if (/^\/(admin|secretary)\/users\/[^/]+$/.test(path)) {
    const account = users.find(row => row.id === path.split('/')[3]);
    if (!account) return send(res, 404, { message: 'User not found' });
    if (method === 'PUT') Object.assign(account, body);
    return send(res, 200, { user: account });
  }
  if (/^\/(admin|secretary|headteacher|teacher)\/sections$/.test(path)) return send(res, 200, { sections, advisorySection: sections[0] });
  if (path === '/secretary/directory') return send(res, 200, { users: users.filter(row => ['teacher', 'headteacher'].includes(row.role)) });
  if (path === '/secretary/students' || path === '/secretary/students/archived') return send(res, 200, { students: studentRecords, summary: { totalStudents: 2, totalArchived: 2, currentSchoolYear: '2026-2027', schoolYears: ['2025-2026'] } });
  if (path === '/secretary/students/archived/export-requests/current') return send(res, 200, { request: exportRequests[0] || null });
  if (path === '/admin/export-requests/archived-pdf') return send(res, 200, { requests: exportRequests, summary: { pendingCount: exportRequests.filter(row => row.status === 'pending').length } });
  if (path === '/admin/student-account-requests') return send(res, 200, { requests: accounts });
  if (path === '/student/account-requests/current') return send(res, 200, { request: accounts.find(row => row.studentId === user.id) || null });
  if (/^\/admin\/(export-requests|student-account-requests)\/[^/]+\/review$/.test(path)) {
    const list = path.includes('student-account') ? accounts : exportRequests;
    const item = list.find(row => row.id === path.split('/')[3]);
    if (!item || item.status !== 'pending') return send(res, 404, { message: 'Pending request not found' });
    if (!['approved', 'rejected'].includes(body.decision)) return send(res, 400, { message: 'Invalid decision' });
    Object.assign(item, { status: body.decision, reviewerNote: body.note || '', reviewedAt: new Date().toISOString() });
    return send(res, 200, { request: item });
  }
  if (path === '/headteacher/teachers') {
    if (method === 'GET') return send(res, 200, { department: 'Mathematics', teachers: users.filter(row => row.role === 'teacher'),
      summary: { totalTeachers: 1, totalStudents: 2, totalLessons: lessons.length, totalAssessments: assessments.length } });
    const teacher = { ...body, id: randomUUID(), role: 'teacher', status: 'pending' }; users.push(teacher); return send(res, 201, { user: teacher });
  }
  if (/^\/headteacher\/teachers\/[^/]+\/students$/.test(path)) return send(res, 200, { students: studentRecords, teacher: users.find(row => row.role === 'teacher'), summary: { totalStudents: 2 } });
  if (path === '/teacher/students') return send(res, 200, { students: studentRecords });
  if (path === '/student/teachers') return send(res, 200, { teachers: users.filter(row => row.role === 'teacher') });
  if (path === '/teacher/enrollment-requests') return send(res, 200, { requests: requests.filter(row => row.enrollmentStatus === 'pending') });
  if (/^\/teacher\/enrollment-requests\/[^/]+\/(accept|reject)$/.test(path)) {
    const item = requests.find(row => row.id === path.split('/')[3]);
    if (!item || item.enrollmentStatus !== 'pending') return send(res, 404, { message: 'Pending enrollment request not found' });
    item.enrollmentStatus = path.endsWith('accept') ? 'approved' : 'rejected';
    return send(res, 200, { student: { id: item.studentId, enrollmentStatus: item.enrollmentStatus } });
  }
  if (path === '/teacher/subjects' || path === '/student/subjects') {
    if (method === 'POST') { const created = { ...body, id: randomUUID(), name: body.subject, code: 'NEW101', track: 'STEM' }; subjects.push(created); return send(res, 201, { subject: created }); }
    const pendingSubjects = path === '/student/subjects' ? [...subjectEnrollmentRequests.values()].filter(request => request.studentId === user.id && request.subject.enrollmentStatus === 'pending').map(request => request.subject) : [];
    return send(res, 200, { subjects, pendingSubjects, studentContext: { section: sections[0] },
      insights: { subjectPerformance: [{ subjectId: 'subject-1', subjectName: 'Mathematics', finalPercentage: 84, performanceLevel: 'proficient', hasSufficientData: true }] } });
  }
  if (path === '/student/subjects/join') {
    requireRole(user, 'student');
    if (String(body.code || '').toUpperCase() !== joinableSubject.code) return send(res, 201, { subject: subjects[0], enrollmentStatus: 'pending' });
    const key = `${user.id}:${joinableSubject.id}`;
    let request = subjectEnrollmentRequests.get(key);
    if (!request) {
      request = { id: randomUUID(), studentId: user.id, requestedAt: new Date().toISOString(),
        subject: { ...joinableSubject, enrollmentStatus: 'pending', requestedAt: new Date().toISOString(), decidedAt: null } };
      subjectEnrollmentRequests.set(key, request);
    }
    return send(res, 201, { message: 'Enrollment request sent successfully', request });
  }
  if (/^\/(teacher|student|headteacher)\/lessons$/.test(path)) {
    if (method === 'POST') { const created = { ...body, id: randomUUID(), subject: body.subject || 'Mathematics', subjectId: body.subjectId || 'subject-1', attachments: [] }; lessons.push(created); return send(res, 201, { lesson: created }); }
    return send(res, 200, { lessons });
  }
  if (/^\/student\/lessons\/[^/]+\/progress$/.test(path)) {
    const lesson = lessons.find(row => row.id === path.split('/')[3]); if (!lesson) return send(res, 404, { message: 'Lesson not found' });
    lesson.progress = { ...body, status: body.reachedEnd && body.progressPercent >= 100 ? 'completed' : 'in_progress' }; return send(res, 200, { progress: lesson.progress });
  }
  if (/^\/(teacher|student|headteacher)\/assessments$/.test(path)) {
    if (method === 'POST') { const created = { ...body, id: randomUUID(), attachments: [], isLocked: false }; assessments.push(created); return send(res, 201, { assessment: created }); }
    return send(res, 200, { assessments });
  }
  if (path === '/teacher/students/assessment-results') return send(res, 200, { results: grades });
  if (path === '/student/submissions/me' || path === '/student/activity-submissions') return send(res, 200, { submissions: [...grades, ...drafts.values()] });
  if (/^\/teacher\/assessments\/[^/]+\/submissions\/[^/]+\/review$/.test(path)) {
    const item = grades.find(row => row.id === path.split('/')[5]); if (!item) return send(res, 404, { message: 'Submission not found' });
    if (body.action === 'grade' && (!Number.isFinite(body.gradeValue) || body.gradeValue < 0 || body.gradeValue > item.totalPoints)) return send(res, 400, { message: `Grade must be from 0 to ${item.totalPoints}` });
    Object.assign(item, body, { score: body.action === 'grade' ? body.gradeValue : 0, status: body.action === 'grade' ? 'completed' : 'returned_for_revision' });
    return send(res, 200, { submission: item });
  }
  if (/^\/student\/assessments\/[^/]+\/activity-response\/(draft|submit|unsubmit)$/.test(path)) {
    const assessmentId = path.split('/')[3]; const existing = drafts.get(assessmentId) || {};
    const assessment = assessments.find(row => row.id === assessmentId);
    const submission = { ...existing, ...body, id: existing.id || randomUUID(), assessmentId, assessmentTitle: assessment?.title || 'Activity',
      status: path.endsWith('submit') && !path.endsWith('unsubmit') ? 'completed' : 'in_progress', links: body.links || [], attachments: [], totalPoints: 0, score: 0 };
    drafts.set(assessmentId, submission); return send(res, 200, { submission });
  }
  if (/^\/student\/assessments\/[^/]+(?:\/(start|progress|submissions))?$/.test(path)) {
    const assessmentId = path.split('/')[3]; const assessment = assessments.find(row => row.id === assessmentId);
    if (!assessment) return send(res, 404, { message: 'Assessment not found' });
    let session = examSessions.get(assessmentId);
    if (path.endsWith('start') && !session) { session = { id: randomUUID(), status: 'in_progress', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), remainingSeconds: 1800, answers: [] }; examSessions.set(assessmentId, session); }
    if (path.endsWith('progress') && session) session.answers = body.answers;
    if (path.endsWith('submissions')) return send(res, 201, { submission: { id: session?.id, assessmentId, score: 2, totalPoints: 2, percentage: 100, status: 'completed' } });
    return send(res, 200, { assessment, session: session || null, serverTime: new Date().toISOString() });
  }
  if (/^\/(teacher\/subjects\/[^/]+\/announcements|headteacher\/teachers\/[^/]+\/announcements|(admin|secretary)\/users\/[^/]+\/messages)$/.test(path)) {
    const recipientRole = role === 'teacher' ? 'student' : role === 'headteacher' ? 'teacher' : users.find(row => row.id === path.split('/')[3])?.role || 'student';
    const key = body.requestId || randomUUID();
    if (!announcementsSent.has(key)) {
      announcementsSent.add(key);
      notifications.unshift({ id: randomUUID(), recipientRole, type: role === 'teacher' ? 'announcement_published' : 'admin_message',
        title: body.title || body.subject, subject: 'Mathematics', message: body.content, content: body.content, teacher: user.name,
        senderName: user.name, eventKey: `announcement:${createHash('sha256').update(key).digest('hex')}`, isViewed: false, createdAt: new Date().toISOString() });
    }
    return send(res, 201, { recipientCount: 2 });
  }
  if (path === '/mobile/attendance/sessions') {
    requireRole(user, 'teacher');
    if (method === 'GET') return send(res, 200, { sessions: [...sessionMap.values()].filter(value => !url.searchParams.get('subjectId') || value.subjectId === url.searchParams.get('subjectId')).map(sessionPublic) });
    const session = { id: randomUUID(), subjectId: body.subjectId, dateKey: body.dateKey, status: 'open',
      expiresAt: new Date(Date.now() + Number(body.durationMinutes || 15) * 60000).toISOString(), lateAfter: new Date(Date.now() + Number(body.lateAfterMinutes || 5) * 60000).toISOString(),
      attendanceRecordId: null, scanCount: 0, qrPayload: `fixture-qr-${randomUUID()}`,
      roster: studentRecords.map(student => ({ studentId: student.id, studentName: student.name, status: null, scannedAt: null })) };
    sessionMap.set(session.id, session); return send(res, 201, { session: sessionPublic(session), qrPayload: session.qrPayload });
  }
  if (/^\/mobile\/attendance\/sessions\/[^/]+(?:\/(rotate|finalize))?$/.test(path)) {
    requireRole(user, 'teacher');
    const session = sessionMap.get(path.split('/')[4]); if (!session) return send(res, 404, { message: 'Attendance session not found' });
    if (path.endsWith('rotate')) { session.qrPayload = `fixture-qr-${randomUUID()}`; return send(res, 200, { session: sessionPublic(session), qrPayload: session.qrPayload }); }
    if (path.endsWith('finalize')) {
      if (session.status !== 'open') return send(res, 409, { message: 'Attendance is already finalized' });
      for (const row of session.roster) row.status = body.overrides?.find(override => override.studentId === row.studentId)?.status || row.status || 'Absent';
      const entries = session.roster.map(row => ({ studentId: row.studentId, studentName: row.studentName, status: row.status }));
      const summary = { totalStudents: entries.length, presentCount: 0, lateCount: 0, absentCount: 0, excusedCount: 0 };
      entries.forEach(row => { summary[`${row.status.toLowerCase()}Count`]++; });
      const record = { ...attendanceRecords[0], id: randomUUID(), dateKey: session.dateKey, entries, summary, isLocked: true };
      attendanceRecords.unshift(record); session.status = 'finalized'; session.attendanceRecordId = record.id;
      return send(res, 200, { session: sessionPublic(session), record });
    }
    return send(res, 200, { session: sessionPublic(session), roster: session.roster });
  }
  if (path === '/mobile/attendance/scan') {
    requireRole(user, 'student');
    const session = [...sessionMap.values()].find(value => value.qrPayload === body.qrPayload);
    if (!session) return send(res, 400, { message: 'Invalid attendance QR code' });
    if (session.status !== 'open') return send(res, 409, { message: 'Attendance session is finalized' });
    if (Date.now() > Date.parse(session.expiresAt)) return send(res, 410, { message: 'Attendance QR code has expired' });
    const row = session.roster.find(value => value.studentId === user.id); const duplicate = !!row.scannedAt;
    if (!duplicate) { row.status = Date.now() > Date.parse(session.lateAfter) ? 'Late' : 'Present'; row.scannedAt = new Date().toISOString(); }
    return send(res, 200, { attendance: { sessionId: session.id, subjectId: session.subjectId, dateKey: session.dateKey, status: row.status, scannedAt: row.scannedAt }, duplicate });
  }
  if (path === '/teacher/attendance/roster') {
    const record = attendanceRecords.find(row => row.dateKey === url.searchParams.get('date'));
    return send(res, 200, { attendanceScope: url.searchParams.get('scope') || 'handled_class', subject: subjects[0], section: sections[0], dateKey: url.searchParams.get('date'), attendance: record || null,
      students: studentRecords.map(student => ({ ...student, attendanceStatus: record?.entries.find(row => row.studentId === student.id)?.status || '' })) });
  }
  if (path === '/teacher/attendance' && method === 'POST') {
    const record = { ...attendanceRecords[0], id: randomUUID(), dateKey: body.date, entries: body.entries, isLocked: false }; attendanceRecords.unshift(record); return send(res, 201, { record });
  }
  if (/^\/teacher\/attendance\/[^/]+\/lock$/.test(path)) {
    const record = attendanceRecords.find(row => row.id === path.split('/')[3]); if (!record) return send(res, 404, { message: 'Attendance not found' }); record.isLocked = true; return send(res, 200, { record });
  }
  if (/^\/(admin\/attendance\/report|secretary\/attendance|headteacher\/attendance|teacher\/attendance|student\/attendance)$/.test(path)) {
    const summary = attendanceSummary(attendanceRecords);
    const records = role === 'student' ? attendanceRecords.map(row => ({ ...row, entries: undefined, status: row.entries.find(entry => entry.studentId === user.id)?.status || '' })) : attendanceRecords;
    return send(res, 200, { summary, ...(role === 'teacher' || role === 'student' ? { records } : { recentRecords: records }), studentSummaries: studentRecords, teacherSummaries: users.filter(row => row.role === 'teacher') });
  }
  return send(res, 404, { message: `Verification fixture does not implement ${method} ${path}` });
}

const server = http.createServer((req, res) => handle(req, res).catch(error => send(res, error.status || 500, { message: error.message })));
server.listen(port, hostname, () => process.stdout.write(`EduMatch verification fixture: ${origin}/api\nFixture usernames: ${roles.join(', ')} (principal aliases admin)\nPassword: VerifyEduMatch1! | OTP: 123456\n`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
