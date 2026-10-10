const { getSupabaseStorageClient } = require('./supabaseStorageService');
const { findSupabaseAccount, listSupabaseAccounts } = require('./supabaseAccountService');
const { DEFAULT_SECTION_NAMES, normalizeSectionName } = require('../constants/sections');
const { ROLE_TEACHER, ROLE_STUDENT } = require('../constants/userRoles');

function normalizeSectionId(value) {
  return String(value?._id || value?.id || value || '').trim();
}

function sectionError(error, fallbackMessage) {
  const normalized = new Error(String(error?.message || fallbackMessage));
  normalized.name = 'SupabaseSectionError';
  normalized.code = error?.code;
  normalized.details = error?.details;
  normalized.hint = error?.hint;
  normalized.statusCode = error?.code === '23505' ? 409 : 500;
  return normalized;
}

function mapSectionRow(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: normalizeSectionName(row.name),
    isActive: row.is_active === true,
    description: String(row.description || '').trim(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function ensureDefaultSections() {
  const rows = DEFAULT_SECTION_NAMES
    .map(normalizeSectionName)
    .filter(Boolean)
    .map((name) => ({ name, is_active: true, description: '' }));
  if (rows.length === 0) return;

  const client = getSupabaseStorageClient();
  const { error } = await client
    .from('sections')
    .upsert(rows, { onConflict: 'name', ignoreDuplicates: true });
  if (error) throw sectionError(error, 'Failed to create default sections in Supabase');
}

async function findSectionById(sectionId, { includeInactive = false } = {}) {
  const normalizedSectionId = normalizeSectionId(sectionId);
  if (!normalizedSectionId) return null;

  const client = getSupabaseStorageClient();
  let query = client.from('sections').select('*').eq('id', normalizedSectionId);
  if (!includeInactive) query = query.eq('is_active', true);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw sectionError(error, 'Failed to read section from Supabase');
  return mapSectionRow(data);
}

async function getSectionOrThrow(sectionId, options = {}) {
  const normalizedSectionId = normalizeSectionId(sectionId);
  if (!normalizedSectionId) {
    const error = new Error('sectionId is required');
    error.statusCode = 400;
    throw error;
  }

  const section = await findSectionById(normalizedSectionId, options);
  if (!section) {
    const error = new Error(options.message || 'Section not found');
    error.statusCode = 404;
    throw error;
  }
  return section;
}

async function findTeacherByAdvisorySection(sectionId) {
  const normalizedSectionId = normalizeSectionId(sectionId);
  if (!normalizedSectionId) return null;

  const accounts = await listSupabaseAccounts();
  return accounts.find((account) => (
    String(account?.role || '').trim() === ROLE_TEACHER
    && normalizeSectionId(account?.advisorySectionId) === normalizedSectionId
  )) || null;
}

async function syncStudentsForSection(sectionId) {
  const normalizedSectionId = normalizeSectionId(sectionId);
  if (!normalizedSectionId) return;

  const accounts = await listSupabaseAccounts();
  const teacher = accounts.find((account) => (
    String(account?.role || '').trim() === ROLE_TEACHER
    && normalizeSectionId(account?.advisorySectionId) === normalizedSectionId
  )) || null;
  const students = accounts.filter((account) => (
    String(account?.role || '').trim() === ROLE_STUDENT
    && normalizeSectionId(account?.sectionId) === normalizedSectionId
  ));

  await Promise.all(students.map(async (student) => {
    const enrollment = { ...(student.enrollment || {}) };
    if (teacher) {
      student.managedBy = teacher._id || teacher.id;
      student.department = String(teacher.department || '').trim();
      enrollment.teacherId = teacher._id || teacher.id;
      enrollment.status = 'approved';
      enrollment.approvedAt = new Date().toISOString();
    } else {
      student.managedBy = null;
      student.department = '';
      enrollment.teacherId = null;
      enrollment.status = '';
      enrollment.approvedAt = null;
    }
    student.enrollment = enrollment;
    await student.save();
  }));
}

async function syncStudentSectionAdviser(studentId) {
  const normalizedStudentId = String(studentId?._id || studentId?.id || studentId || '').trim();
  if (!normalizedStudentId) return null;

  const student = await findSupabaseAccount('id', normalizedStudentId);
  if (!student || String(student.role || '').trim() !== ROLE_STUDENT) return null;

  const sectionId = normalizeSectionId(student.sectionId);
  if (!sectionId) {
    student.managedBy = null;
    student.department = '';
    student.enrollment = {
      ...(student.enrollment || {}),
      teacherId: null,
      status: '',
      approvedAt: null,
    };
    await student.save();
    return null;
  }

  await syncStudentsForSection(sectionId);
  return sectionId;
}

async function syncTeacherAdvisoryAssignments({ previousSectionId = '', nextSectionId = '' } = {}) {
  const uniqueSectionIds = [...new Set(
    [previousSectionId, nextSectionId].map(normalizeSectionId).filter(Boolean)
  )];
  await Promise.all(uniqueSectionIds.map(syncStudentsForSection));
}

async function listSectionsWithAdvisers() {
  await ensureDefaultSections();

  const client = getSupabaseStorageClient();
  const [{ data: rows, error }, accounts] = await Promise.all([
    client.from('sections').select('*').order('name', { ascending: true }),
    listSupabaseAccounts(),
  ]);
  if (error) throw sectionError(error, 'Failed to list sections from Supabase');

  const advisers = accounts.filter((account) => String(account?.role || '').trim() === ROLE_TEACHER);
  const students = accounts.filter((account) => String(account?.role || '').trim() === ROLE_STUDENT);
  const adviserBySectionId = new Map(
    advisers
      .map((teacher) => [normalizeSectionId(teacher.advisorySectionId), teacher])
      .filter(([sectionId]) => Boolean(sectionId))
  );
  const studentCountBySectionId = new Map();
  students.forEach((student) => {
    const sectionId = normalizeSectionId(student.sectionId);
    if (!sectionId) return;
    studentCountBySectionId.set(sectionId, (studentCountBySectionId.get(sectionId) || 0) + 1);
  });

  return (rows || []).map((row) => {
    const section = mapSectionRow(row);
    const adviser = adviserBySectionId.get(section.id) || null;
    return {
      ...section,
      studentCount: Number(studentCountBySectionId.get(section.id) || 0),
      adviser: adviser
        ? {
          id: String(adviser._id || adviser.id || '').trim(),
          name: String(adviser.name || '').trim(),
          email: String(adviser.email || '').trim(),
          department: String(adviser.department || '').trim(),
          subject: String(adviser.subject || adviser.department || '').trim(),
          status: String(adviser.status || '').trim().toLowerCase(),
          profileImage: String(adviser.profileImage || '').trim(),
        }
        : null,
    };
  });
}

module.exports = {
  ensureDefaultSections,
  findSectionById,
  getSectionOrThrow,
  findTeacherByAdvisorySection,
  syncStudentsForSection,
  syncStudentSectionAdviser,
  syncTeacherAdvisoryAssignments,
  listSectionsWithAdvisers,
  normalizeSectionId,
};
