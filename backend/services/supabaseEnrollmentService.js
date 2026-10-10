const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { listSupabaseAccounts } = require('./supabaseAccountService');
const { mapSubject } = require('./subjectService');

function enrollmentError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseEnrollmentError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function mapEnrollment(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    subjectId: row.subject_id,
    teacherId: row.teacher_id,
    studentId: row.student_id,
    sectionId: row.section_id || undefined,
    sectionName: String(row.section_name || '').trim(),
    status: String(row.status || 'pending').trim(),
    requestedAt: row.requested_at || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function findEnrollment({ studentId, subjectId, teacherId = '', status = '' }) {
  const normalizedStudentId = referenceId(studentId);
  const normalizedSubjectId = referenceId(subjectId);
  if (!normalizedStudentId || !normalizedSubjectId) return null;
  let query = getSupabaseStorageClient().from('subject_enrollments').select('*')
    .eq('student_id', normalizedStudentId).eq('subject_id', normalizedSubjectId);
  if (referenceId(teacherId)) query = query.eq('teacher_id', referenceId(teacherId));
  if (String(status || '').trim()) query = query.eq('status', String(status).trim());
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw enrollmentError(error, 'Failed to read enrollment from Supabase');
  return mapEnrollment(data);
}

async function saveEnrollmentRequest({ studentId, subjectId, teacherId, sectionId = null, sectionName = '' }) {
  const now = new Date().toISOString();
  const values = {
    student_id: referenceId(studentId),
    subject_id: referenceId(subjectId),
    teacher_id: referenceId(teacherId),
    section_id: referenceId(sectionId) || null,
    section_name: String(sectionName || '').trim(),
    status: 'pending',
    requested_at: now,
    decided_at: null,
    updated_at: now,
  };
  const { data, error } = await getSupabaseStorageClient().from('subject_enrollments')
    .upsert(values, { onConflict: 'subject_id,student_id' }).select('*').single();
  if (error) throw enrollmentError(error, 'Failed to save enrollment request in Supabase');
  return mapEnrollment(data);
}

async function listStudentEnrollments(studentId, status = '') {
  const normalizedStudentId = referenceId(studentId);
  if (!normalizedStudentId) return [];
  let query = getSupabaseStorageClient().from('subject_enrollments').select('*')
    .eq('student_id', normalizedStudentId).order('created_at', { ascending: false });
  if (String(status || '').trim()) query = query.eq('status', String(status).trim());
  const { data, error } = await query;
  if (error) throw enrollmentError(error, 'Failed to list enrollments from Supabase');
  return (data || []).map(mapEnrollment);
}

async function listHydratedStudentEnrollments(studentId, status = '') {
  const enrollments = await listStudentEnrollments(studentId, status);
  if (enrollments.length === 0) return [];
  const subjectIds = [...new Set(enrollments.map((row) => referenceId(row.subjectId)).filter(Boolean))];
  const [{ data: subjectRows, error }, accounts] = await Promise.all([
    getSupabaseStorageClient().from('subjects').select('*').in('id', subjectIds),
    listSupabaseAccounts(),
  ]);
  if (error) throw enrollmentError(error, 'Failed to hydrate enrollment classes from Supabase');
  const subjectsById = new Map((subjectRows || []).map((row) => [String(row.id), mapSubject(row)]));
  const accountsById = new Map(accounts.map((account) => [referenceId(account), account]));
  return enrollments.map((row) => ({
    ...row,
    subjectId: subjectsById.get(referenceId(row.subjectId)) || row.subjectId,
    teacherId: accountsById.get(referenceId(row.teacherId)) || row.teacherId,
  }));
}

module.exports = {
  findEnrollment,
  listHydratedStudentEnrollments,
  listStudentEnrollments,
  mapEnrollment,
  saveEnrollmentRequest,
};
