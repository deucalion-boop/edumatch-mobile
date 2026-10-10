const { readProfileRows } = require('./supabaseUserProfileService');
const { getSupabaseStorageClient } = require('./supabaseStorageService');

async function hydrateRequests(rows) {
  if (!rows.length) return [];
  const [students, subjects, sections] = await Promise.all([
    readProfileRows('users', 'id', [...new Set(rows.map(row => row.studentId))]),
    readProfileRows('subjects', 'id', [...new Set(rows.map(row => row.subjectId))]),
    readProfileRows('sections', 'id', [...new Set(rows.map(row => row.sectionId).filter(Boolean))]),
  ]);
  return rows.map(row => ({ ...row,
    studentId: students.find(student => student.id === row.studentId) || { _id: row.studentId },
    subjectId: subjects.find(subject => subject.id === row.subjectId) || { _id: row.subjectId },
    sectionId: sections.find(section => section.id === row.sectionId) || row.sectionId,
  }));
}
async function teacherRequests(teacherId, subjectFilter = '', status = 'pending') {
  const [rows, subjects] = await Promise.all([
    readProfileRows('subject_enrollments', 'teacher_id', teacherId),
    readProfileRows('subjects', 'teacher_id', teacherId),
  ]);
  const allowed = new Set(subjects.filter(s => !subjectFilter || s.id === subjectFilter).map(s => s.id));
  return hydrateRequests(rows.filter(row => row.status === status && allowed.has(row.subjectId))
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)));
}
async function decideTeacherRequest(teacherId, requestId, status) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid enrollment decision');
  const client = getSupabaseStorageClient();
  const { data: existing, error: readError } = await client.from('subject_enrollments').select('*')
    .eq('id', String(requestId)).eq('teacher_id', String(teacherId)).maybeSingle();
  if (readError) throw Object.assign(new Error(readError.message), { statusCode: 500 });
  if (!existing) throw Object.assign(new Error('Enrollment request not found'), { statusCode: 404 });
  const now = new Date().toISOString();
  const { data, error } = await client.from('subject_enrollments').update({ status, decided_at: now, updated_at: now })
    .eq('id', String(requestId)).eq('teacher_id', String(teacherId)).eq('status', 'pending').select('*').maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  if (!data) throw Object.assign(new Error('Enrollment request is not pending'), { statusCode: 409 });
  const row = { _id: data.id, studentId: data.student_id, subjectId: data.subject_id, sectionId: data.section_id,
    sectionName: data.section_name, status: data.status, decidedAt: data.decided_at };
  return (await hydrateRequests([row]))[0];
}
async function teacherResultData(teacherId, subjectFilter = '', studentFilter = '') {
  const [subjects, enrollments, assessments, lessons] = await Promise.all([
    readProfileRows('subjects', 'teacher_id', teacherId),
    readProfileRows('subject_enrollments', 'teacher_id', teacherId),
    readProfileRows('assessments', 'created_by', teacherId),
    readProfileRows('lessons', 'created_by', teacherId),
  ]);
  const subjectIds = new Set(subjects.filter(row => !subjectFilter || row.id === subjectFilter).map(row => row.id));
  const studentIds = [...new Set(enrollments.filter(row => row.status === 'approved' && subjectIds.has(row.subjectId)
    && (!studentFilter || row.studentId === studentFilter)).map(row => row.studentId))];
  if (!studentIds.length) return { assessmentsById: new Map(), submissions: [] };
  const students = (await readProfileRows('users', 'id', studentIds)).filter(row => row.archive?.isArchived !== true);
  const assessmentsById = new Map(assessments.filter(row => subjectIds.has(row.subjectId)
    || (!subjectFilter && row.assessmentMode === 'activity' && !row.lessonId))
    .map(row => [row.id, { ...row, lessonId: lessons.find(lesson => lesson.id === row.lessonId) || null }]));
  if (!assessmentsById.size) return { assessmentsById, submissions: [] };
  const submissions = (await readProfileRows('submissions', 'assessment_id', [...assessmentsById.keys()]))
    .filter(row => ['completed', 'auto_submitted', 'terminated', 'returned_for_revision'].includes(row.status) && students.some(student => student.id === row.studentId))
    .map(row => ({ ...row, studentId: students.find(student => student.id === row.studentId) }));
  return { assessmentsById, submissions };
}
module.exports = { teacherRequests, decideTeacherRequest, teacherResultData };
