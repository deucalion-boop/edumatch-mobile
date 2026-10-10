const crypto = require('crypto');
const { getSupabaseStorageClient } = require('./supabaseStorageService');

function subjectError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseSubjectError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function referenceId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function mapSubject(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: String(row.name || '').trim(),
    className: String(row.class_name || '').trim(),
    code: String(row.code || '').trim(),
    track: String(row.track || '').trim(),
    subjectCategory: String(row.subject_category || '').trim(),
    department: String(row.department || '').trim(),
    description: String(row.description || '').trim(),
    teacherId: String(row.teacher_id || '').trim(),
    isActive: row.is_active === true,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function buildCodePrefix(name) {
  const compact = String(name || '').trim()
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => part.slice(0, 3).toUpperCase())
    .join('')
    .slice(0, 3);
  return compact || 'SUB';
}

function buildRandomSuffix(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

async function generateUniqueSubjectCode(name) {
  const client = getSupabaseStorageClient();
  const prefix = buildCodePrefix(name);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = `${prefix}-${buildRandomSuffix(5)}`;
    const { data, error } = await client.from('subjects').select('id').eq('code', code).limit(1).maybeSingle();
    if (error) throw subjectError(error, 'Failed to check class code in Supabase');
    if (!data) return code;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

async function findTeacherSubject(teacherId, subjectId, { includeInactive = false } = {}) {
  const normalizedTeacherId = referenceId(teacherId);
  const normalizedSubjectId = referenceId(subjectId);
  if (!normalizedTeacherId || !normalizedSubjectId) return null;
  let query = getSupabaseStorageClient().from('subjects').select('*')
    .eq('id', normalizedSubjectId).eq('teacher_id', normalizedTeacherId);
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw subjectError(error, 'Failed to read class from Supabase');
  return mapSubject(data);
}

async function findSubjectByCode(code) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) return null;
  const { data, error } = await getSupabaseStorageClient().from('subjects').select('*')
    .eq('code', normalizedCode).eq('is_active', true).limit(1).maybeSingle();
  if (error) throw subjectError(error, 'Failed to read class code from Supabase');
  return mapSubject(data);
}

async function listTeacherSubjects(teacherId) {
  const normalizedTeacherId = referenceId(teacherId);
  if (!normalizedTeacherId) return [];
  const { data, error } = await getSupabaseStorageClient().from('subjects').select('*')
    .eq('teacher_id', normalizedTeacherId).eq('is_active', true)
    .order('name', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw subjectError(error, 'Failed to list classes from Supabase');
  return (data || []).map(mapSubject);
}

async function ensureTeacherSubject({ teacherId, name, track, subjectCategory = '', className = '', description = '', department = '' }) {
  const normalizedTeacherId = referenceId(teacherId);
  const normalizedName = String(name || '').trim();
  const normalizedTrack = String(track || '').trim();
  const normalizedClassName = String(className || '').trim();
  if (!normalizedTeacherId || !normalizedName || !normalizedTrack) {
    const error = new Error('teacherId, name, and track are required');
    error.statusCode = 400;
    throw error;
  }

  const client = getSupabaseStorageClient();
  const { data: existing, error: findError } = await client.from('subjects').select('*')
    .eq('teacher_id', normalizedTeacherId).ilike('name', normalizedName)
    .ilike('track', normalizedTrack).ilike('class_name', normalizedClassName)
    .limit(1).maybeSingle();
  if (findError) throw subjectError(findError, 'Failed to check class in Supabase');

  const values = {
    teacher_id: normalizedTeacherId,
    name: normalizedName,
    class_name: normalizedClassName,
    track: normalizedTrack,
    subject_category: String(subjectCategory || '').trim(),
    department: String(department || '').trim(),
    description: String(description || '').trim(),
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const operation = existing
    ? client.from('subjects').update(values).eq('id', existing.id)
    : client.from('subjects').insert({ ...values, code: await generateUniqueSubjectCode(normalizedName) });
  const { data, error } = await operation.select('*').single();
  if (error) throw subjectError(error, existing ? 'Failed to update class in Supabase' : 'Failed to create class in Supabase');
  return mapSubject(data);
}

async function updateTeacherSubject(teacherId, subjectId, changes = {}) {
  const subject = await findTeacherSubject(teacherId, subjectId);
  if (!subject) return null;
  const values = { updated_at: new Date().toISOString() };
  if (changes.className !== undefined) values.class_name = String(changes.className || '').trim();
  if (changes.description !== undefined) values.description = String(changes.description || '').trim();
  if (changes.isActive !== undefined) values.is_active = changes.isActive === true;
  const { data, error } = await getSupabaseStorageClient().from('subjects').update(values)
    .eq('id', subject.id).eq('teacher_id', subject.teacherId).select('*').single();
  if (error) throw subjectError(error, 'Failed to update class in Supabase');
  return mapSubject(data);
}

async function deleteTeacherSubject(teacherId, subjectId) {
  const subject = await findTeacherSubject(teacherId, subjectId, { includeInactive: true });
  if (!subject) return null;
  const { error } = await getSupabaseStorageClient().from('subjects').delete()
    .eq('id', subject.id).eq('teacher_id', subject.teacherId);
  if (error) throw subjectError(error, 'Failed to delete class from Supabase');
  return subject;
}

async function updateAttendanceClassName(teacherId, subjectId, className) {
  const { error } = await getSupabaseStorageClient().from('attendance_records')
    .update({ class_name: String(className || '').trim(), updated_at: new Date().toISOString() })
    .eq('teacher_id', referenceId(teacherId)).eq('subject_id', referenceId(subjectId));
  if (error) throw subjectError(error, 'Failed to update attendance class name in Supabase');
}

async function getTeacherSubjectCounts(teacherId) {
  const normalizedTeacherId = referenceId(teacherId);
  const client = getSupabaseStorageClient();
  const results = await Promise.all([
    client.from('lessons').select('subject_id').eq('created_by', normalizedTeacherId).not('subject_id', 'is', null),
    client.from('assessments').select('subject_id').eq('created_by', normalizedTeacherId).not('subject_id', 'is', null),
    client.from('subject_enrollments').select('subject_id,status').eq('teacher_id', normalizedTeacherId),
    client.from('attendance_records').select('subject_id').eq('teacher_id', normalizedTeacherId)
      .eq('attendance_scope', 'handled_class').not('subject_id', 'is', null),
  ]);
  const failed = results.find((result) => result.error);
  if (failed) throw subjectError(failed.error, 'Failed to count class records in Supabase');
  const countBy = (rows, predicate = () => true) => (rows || []).reduce((map, row) => {
    if (predicate(row) && row.subject_id) map.set(String(row.subject_id), (map.get(String(row.subject_id)) || 0) + 1);
    return map;
  }, new Map());
  return {
    lessons: countBy(results[0].data),
    assessments: countBy(results[1].data),
    approvedEnrollments: countBy(results[2].data, (row) => row.status === 'approved'),
    pendingEnrollments: countBy(results[2].data, (row) => row.status === 'pending'),
    attendance: countBy(results[3].data),
  };
}

module.exports = {
  deleteTeacherSubject,
  ensureTeacherSubject,
  findSubjectByCode,
  findTeacherSubject,
  getTeacherSubjectCounts,
  listTeacherSubjects,
  mapSubject,
  updateAttendanceClassName,
  updateTeacherSubject,
};
