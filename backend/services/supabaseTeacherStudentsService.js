const { findTeacherSubject } = require('./subjectService');
const { readProfileRows } = require('./supabaseUserProfileService');
const { teacherRequests } = require('./supabaseTeacherRecordsService');
const { getSupabaseStorageClient } = require('./supabaseStorageService');

function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\s\x00-\x1f]/.test(value)) {
    throw Object.assign(new Error(`${label} is invalid or missing`), { statusCode: 400 });
  }
  return value;
}
async function requireTeacherSubject(teacherId, subjectId) {
  requireId(subjectId, 'Subject ID');
  const subject = await findTeacherSubject(teacherId, subjectId, { includeInactive: true });
  if (!subject) throw Object.assign(new Error('Subject not found'), { statusCode: 404 });
  return subject;
}
async function subjectStudents(teacherId, subjectId) {
  const subject = await requireTeacherSubject(teacherId, subjectId);
  const enrollments = await teacherRequests(teacherId, subjectId, 'approved');
  return { subject, enrollments };
}
async function removeSubjectStudent(teacherId, subjectId, studentId) {
  requireId(studentId, 'Student ID');
  const { subject, enrollments } = await subjectStudents(teacherId, subjectId);
  const enrollment = enrollments.find(row => row.studentId?._id === studentId);
  if (!enrollment) throw Object.assign(new Error('Approved student enrollment not found for this class'), { statusCode: 404 });
  const client = getSupabaseStorageClient();
  const assessments = (await readProfileRows('assessments', 'created_by', teacherId))
    .filter(row => row.subjectId === subjectId && row.assignmentScope === 'handled_class'
      && Array.isArray(row.assignedStudentIds) && row.assignedStudentIds.includes(studentId));
  // Clean up assignments before deleting membership; failures keep the enrollment
  // available for a retry rather than falsely reporting a successful removal.
  for (const assessment of assessments) {
    const { error } = await client.from('assessments').update({
      assigned_student_ids: assessment.assignedStudentIds.filter(id => id !== studentId),
      updated_at: new Date().toISOString(),
    }).eq('id', assessment.id).eq('created_by', String(teacherId)).eq('subject_id', subjectId);
    if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  }
  const { data, error } = await client.from('subject_enrollments').delete()
    .eq('id', enrollment.id).eq('teacher_id', String(teacherId)).eq('subject_id', subjectId)
    .eq('student_id', studentId).eq('status', 'approved').select('id').maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
  if (!data) throw Object.assign(new Error('Enrollment changed; refresh the student list'), { statusCode: 409 });
  return { subject, enrollment };
}
async function saveStudentProgress(student, mastery) {
  const { error } = await getSupabaseStorageClient().from('users').update({
    enrollment: { ...(student.enrollment || {}), progress: {
      masteryProgress: mastery.masteryProgress, averageScore: mastery.averageScore,
      completedAssessments: mastery.completedAssessments, lastCalculatedAt: mastery.lastCalculatedAt,
    } },
  }).eq('id', String(student._id));
  if (error) throw Object.assign(new Error(error.message), { statusCode: 500 });
}
module.exports = { subjectStudents, removeSubjectStudent, requireTeacherSubject, saveStudentProgress };
