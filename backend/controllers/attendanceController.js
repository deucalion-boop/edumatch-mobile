const { studentAttendance } = require('../services/supabaseStudentDashboardService');
const { ROLE_TEACHER } = require('../constants/userRoles');
const { sendSuccess } = require('../utils/responseHelper');
const { getSectionOrThrow, normalizeSectionId } = require('../services/sectionService');
const { listSupabaseAccounts } = require('../services/supabaseAccountService');
const { findTeacherSubject } = require('../services/subjectService');
const { getSupabaseStorageClient } = require('../services/supabaseStorageService');
const { readProfileRows } = require('../services/supabaseUserProfileService');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ATTENDANCE_STATUS_MAP = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  excused: 'Excused',
};
const ATTENDANCE_SCOPES = ['handled_class', 'advisory_class'];

function hydrateAttendanceRow(row) {
  if (!row) return null;
  return Object.fromEntries([
    ['_id', row.id],
    ...Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]),
  ]);
}

function attendanceDatabaseRow(record) {
  return {
    attendance_scope: record.attendanceScope,
    subject_id: record.subjectId || null,
    section_id: record.sectionId || null,
    teacher_id: String(record.teacherId),
    date_key: record.dateKey,
    attendance_date: new Date(record.attendanceDate).toISOString(),
    subject_name: record.subjectName || '',
    subject_code: record.subjectCode || '',
    class_name: record.className || '',
    section_name: record.sectionName || '',
    track: record.track || '',
    teacher_name: record.teacherName || '',
    teacher_subject: record.teacherSubject || '',
    teacher_department: record.teacherDepartment || '',
    entries: Array.isArray(record.entries) ? record.entries : [],
    summary: record.summary || {},
    is_locked: record.isLocked === true,
    locked_at: record.lockedAt ? new Date(record.lockedAt).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
}

function applyAttendanceQueryFilters(query, filters = {}) {
  let filtered = query;
  const columnByField = {
    id: 'id', attendanceScope: 'attendance_scope', subjectId: 'subject_id', sectionId: 'section_id',
    teacherId: 'teacher_id', dateKey: 'date_key', isLocked: 'is_locked',
  };
  Object.entries(filters).forEach(([field, value]) => {
    if (value === undefined || value === null || value === '') return;
    const column = columnByField[field];
    if (column) filtered = filtered.eq(column, typeof value === 'boolean' ? value : String(value));
  });
  return filtered;
}

async function findAttendanceRecord(filters) {
  const query = applyAttendanceQueryFilters(
    getSupabaseStorageClient().from('attendance_records').select('*'),
    filters
  );
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw Object.assign(new Error(error.message || 'Unable to read attendance'), { statusCode: 500 });
  return hydrateAttendanceRow(data);
}

async function listAttendanceRecords(filters = {}, limit = 200) {
  const query = applyAttendanceQueryFilters(
    getSupabaseStorageClient().from('attendance_records').select('*'),
    filters
  ).order('date_key', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  const { data, error } = await query;
  if (error) throw Object.assign(new Error(error.message || 'Unable to read attendance'), { statusCode: 500 });
  return (data || []).map(hydrateAttendanceRow);
}

async function persistAttendanceRecord(record) {
  const row = attendanceDatabaseRow(record);
  const table = getSupabaseStorageClient().from('attendance_records');
  const { data, error } = record._id
    ? await table.update(row).eq('id', String(record._id)).select('*').single()
    : await table.insert(row).select('*').single();
  if (error) {
    const statusCode = error.code === '23505' ? 409 : 500;
    throw Object.assign(new Error(error.message || 'Unable to save attendance'), { statusCode, code: error.code });
  }
  return hydrateAttendanceRow(data);
}

function throwHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDateKey(value) {
  const dateKey = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throwHttpError('Attendance date must use YYYY-MM-DD format');
  }

  const attendanceDate = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(attendanceDate.getTime())) {
    throwHttpError('Attendance date is invalid');
  }

  return {
    dateKey,
    attendanceDate,
  };
}

function normalizeAttendanceStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const resolved = ATTENDANCE_STATUS_MAP[normalized];
  if (!resolved) {
    throwHttpError('Attendance status must be Present, Late, Absent, or Excused');
  }
  return resolved;
}

function normalizeAttendanceScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'handled_class';
  if (!ATTENDANCE_SCOPES.includes(normalized)) {
    throwHttpError(`Attendance scope must be one of: ${ATTENDANCE_SCOPES.join(', ')}`);
  }
  return normalized;
}

function buildAttendanceSummary(entries, totalStudentsOverride = null) {
  const summary = {
    totalStudents: Number(totalStudentsOverride ?? (Array.isArray(entries) ? entries.length : 0)) || 0,
    presentCount: 0,
    lateCount: 0,
    absentCount: 0,
    excusedCount: 0,
  };

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const status = String(entry?.status || '').trim();
    if (status === 'Present') summary.presentCount += 1;
    if (status === 'Late') summary.lateCount += 1;
    if (status === 'Absent') summary.absentCount += 1;
    if (status === 'Excused') summary.excusedCount += 1;
  });

  return summary;
}

function mapAttendanceRecord(record, { includeEntries = true } = {}) {
  const entries = Array.isArray(record?.entries) ? record.entries : [];
  const attendanceScope = normalizeAttendanceScope(record?.attendanceScope || 'handled_class');
  const resolvedSectionName = String(record?.sectionName || record?.sectionId?.name || '').trim();
  const resolvedSubjectName = String(record?.subjectName || record?.subjectId?.name || '').trim();
  const resolvedClassName = String(record?.className || record?.subjectId?.className || '').trim();
  return {
    id: String(record?._id || ''),
    attendanceScope,
    title: attendanceScope === 'advisory_class'
      ? `Advisory - ${resolvedSectionName || 'Section'}`
      : resolvedClassName || resolvedSubjectName || 'Handled Class Attendance',
    dateKey: String(record?.dateKey || '').trim(),
    attendanceDate: record?.attendanceDate || null,
    isLocked: record?.isLocked === true,
    lockedAt: record?.lockedAt || null,
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null,
    summary: {
      totalStudents: Number(record?.summary?.totalStudents || 0),
      presentCount: Number(record?.summary?.presentCount || 0),
      lateCount: Number(record?.summary?.lateCount || 0),
      absentCount: Number(record?.summary?.absentCount || 0),
      excusedCount: Number(record?.summary?.excusedCount || 0),
    },
    subject: {
      id: String(record?.subjectId?._id || record?.subjectId || ''),
      name: resolvedSubjectName || (attendanceScope === 'advisory_class' ? 'Advisory Attendance' : ''),
      code: String(record?.subjectCode || record?.subjectId?.code || '').trim(),
      className: resolvedClassName || resolvedSectionName,
      track: String(record?.track || record?.subjectId?.track || '').trim(),
    },
    section: {
      id: normalizeSectionId(record?.sectionId?._id || record?.sectionId || ''),
      name: resolvedSectionName,
    },
    teacher: {
      id: String(record?.teacherId?._id || record?.teacherId || ''),
      name: String(record?.teacherName || record?.teacherId?.name || 'Teacher').trim() || 'Teacher',
      subject: String(record?.teacherSubject || record?.teacherId?.subject || '').trim(),
      department: String(record?.teacherDepartment || record?.teacherId?.department || '').trim(),
      email: String(record?.teacherId?.email || '').trim(),
      status: String(record?.teacherId?.status || '').trim(),
    },
    entries: includeEntries
      ? entries.map((entry) => ({
        studentId: String(entry?.studentId?._id || entry?.studentId || ''),
        studentName: String(entry?.studentName || entry?.studentId?.name || 'Student').trim() || 'Student',
        studentEmail: String(entry?.studentEmail || entry?.studentId?.email || '').trim(),
        sectionId: normalizeSectionId(entry?.sectionId?._id || entry?.sectionId || ''),
        sectionName: String(entry?.sectionName || entry?.sectionId?.name || '').trim(),
        gradeLevel: String(entry?.gradeLevel || '').trim(),
        department: String(entry?.department || '').trim(),
        status: String(entry?.status || '').trim(),
        markedAt: entry?.markedAt || null,
      }))
      : [],
  };
}

function applyDateRange(records, { from = '', to = '' } = {}) {
  const normalizedFrom = String(from || '').trim();
  const normalizedTo = String(to || '').trim();
  return (Array.isArray(records) ? records : []).filter((record) => {
    const dateKey = String(record?.dateKey || '').trim();
    if (normalizedFrom && dateKey < normalizedFrom) return false;
    if (normalizedTo && dateKey > normalizedTo) return false;
    return true;
  });
}

async function findTeacherSubjectOrThrow({ teacherId, subjectId }) {
  const normalizedSubjectId = String(subjectId || '').trim();
  if (!normalizedSubjectId) {
    throwHttpError('subjectId is required');
  }

  const subject = await findTeacherSubject(teacherId, normalizedSubjectId);

  if (!subject) {
    throwHttpError('Subject not found', 404);
  }

  return subject;
}

async function findTeacherAdvisorySectionOrThrow({ teacher }) {
  const advisorySectionId = normalizeSectionId(teacher?.advisorySectionId);
  if (!advisorySectionId) {
    throwHttpError('You do not have an advisory section assigned yet', 409);
  }

  return getSectionOrThrow(advisorySectionId, {
    message: 'Your advisory section assignment is invalid or inactive',
  });
}

async function resolveTeacherAttendanceContext({ teacher, attendanceScope, subjectId }) {
  if (attendanceScope === 'advisory_class') {
    const section = await findTeacherAdvisorySectionOrThrow({ teacher });
    return {
      attendanceScope,
      subject: null,
      section,
    };
  }

  const subject = await findTeacherSubjectOrThrow({
    teacherId: teacher._id,
    subjectId,
  });

  return {
    attendanceScope,
    subject,
    section: null,
  };
}

async function getApprovedRoster({ teacherId, subjectId, attendanceScope = 'handled_class', sectionId = '' }) {
  if (attendanceScope === 'advisory_class') {
    const [accounts, sections] = await Promise.all([
      listSupabaseAccounts(),
      readProfileRows('sections', 'id', sectionId),
    ]);
    const sectionName = String(sections[0]?.name || '').trim();
    const students = accounts.filter((student) => (
      String(student?.role || '') === 'student'
      && normalizeSectionId(student?.sectionId) === normalizeSectionId(sectionId)
      && student?.archive?.isArchived !== true
    ));

    return uniqueBy(students, (student) => String(student?._id || ''))
      .map((student) => ({
        id: String(student?._id || ''),
        name: String(student?.name || 'Student').trim() || 'Student',
        email: String(student?.email || '').trim(),
        status: String(student?.status || 'active').trim().toLowerCase(),
        gradeLevel: String(student?.gradeLevel || '').trim(),
        department: String(student?.department || '').trim(),
        sectionId: normalizeSectionId(student?.sectionId || ''),
        sectionName,
      }))
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  }

  const enrollments = (await readProfileRows('subject_enrollments', 'subject_id', subjectId))
    .filter((row) => String(row.teacherId) === String(teacherId) && row.status === 'approved');
  const studentIds = [...new Set(enrollments.map((row) => String(row.studentId || '')).filter(Boolean))];
  if (studentIds.length === 0) return [];
  const students = await readProfileRows('users', 'id', studentIds);
  const sectionIds = [...new Set(students.map((student) => normalizeSectionId(student.sectionId)).filter(Boolean))];
  const sections = sectionIds.length > 0 ? await readProfileRows('sections', 'id', sectionIds) : [];
  const sectionNameById = new Map(sections.map((section) => [String(section.id), String(section.name || '')]));

  return uniqueBy(
    students.filter((student) => student?._id && student.role === 'student' && student.status === 'active'
      && student?.archive?.isArchived !== true),
    (student) => String(student?._id || '')
  )
    .map((student) => ({
      id: String(student?._id || ''),
      name: String(student?.name || 'Student').trim() || 'Student',
      email: String(student?.email || '').trim(),
      status: String(student?.status || 'active').trim().toLowerCase(),
      gradeLevel: String(student?.gradeLevel || '').trim(),
      department: String(student?.department || '').trim(),
      sectionId: normalizeSectionId(student?.sectionId || ''),
      sectionName: sectionNameById.get(normalizeSectionId(student?.sectionId)) || '',
    }))
    .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function buildTeacherRosterPayload({ attendanceScope, subject, section, attendance, approvedStudents }) {
  const entriesByStudentId = new Map(
    (Array.isArray(attendance?.entries) ? attendance.entries : [])
      .map((entry) => [String(entry?.studentId?._id || entry?.studentId || ''), entry])
  );

  return {
    attendanceScope,
    subject: {
      id: String(subject?._id || ''),
      name: String(subject?.name || '').trim() || (attendanceScope === 'advisory_class' ? 'Advisory Attendance' : ''),
      code: String(subject?.code || '').trim(),
      className: attendanceScope === 'advisory_class'
        ? String(section?.name || '').trim()
        : String(subject?.className || '').trim(),
      track: String(subject?.track || '').trim(),
    },
    section: {
      id: normalizeSectionId(section?._id || section || ''),
      name: String(section?.name || '').trim(),
    },
    dateKey: String(attendance?.dateKey || '').trim(),
    attendance: attendance ? mapAttendanceRecord(attendance, { includeEntries: false }) : null,
    students: approvedStudents.map((student) => {
      const entry = entriesByStudentId.get(String(student.id || '')) || null;
      return {
        ...student,
        attendanceStatus: String(entry?.status || '').trim() || '',
      };
    }),
  };
}

async function saveAttendanceRecord({ teacher, attendanceScope, subject, section, dateKey, attendanceDate, entries }) {
  const approvedStudents = await getApprovedRoster({
    teacherId: teacher._id,
    subjectId: subject?._id,
    attendanceScope,
    sectionId: section?._id,
  });

  if (approvedStudents.length === 0) {
    throwHttpError(
      attendanceScope === 'advisory_class'
        ? 'Attendance cannot be recorded because this advisory section has no students'
        : 'Attendance cannot be recorded because this subject has no approved students',
      409
    );
  }

  const entriesByStudentId = new Map();
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const studentId = String(entry?.studentId || '').trim();
    if (!studentId) {
      throwHttpError('Every attendance entry must include a studentId');
    }
    if (entriesByStudentId.has(studentId)) {
      throwHttpError('Duplicate student attendance entry detected');
    }
    entriesByStudentId.set(studentId, {
      studentId,
      status: normalizeAttendanceStatus(entry?.status),
    });
  });

  if (entriesByStudentId.size !== approvedStudents.length) {
    throwHttpError('Attendance must include all approved students under this subject');
  }

  const preparedEntries = approvedStudents.map((student) => {
    const selectedEntry = entriesByStudentId.get(String(student.id || ''));
    if (!selectedEntry) {
      throwHttpError('Attendance must include all approved students under this subject');
    }

    return {
      studentId: student.id,
      studentName: student.name,
      studentEmail: student.email,
      sectionId: student.sectionId || undefined,
      sectionName: student.sectionName,
      gradeLevel: student.gradeLevel,
      department: student.department,
      status: selectedEntry.status,
      markedAt: new Date(),
    };
  });

  const attendanceLookup = attendanceScope === 'advisory_class'
    ? {
      attendanceScope,
      teacherId: teacher._id,
      sectionId: section._id,
      dateKey,
    }
    : {
      attendanceScope,
      subjectId: subject._id,
      dateKey,
    };

  let attendance = await findAttendanceRecord(attendanceLookup);

  const isNewRecord = !attendance;
  if (attendance && String(attendance.teacherId || '') !== String(teacher._id || '')) {
    throwHttpError('You are not allowed to update this attendance record', 403);
  }
  if (attendance?.isLocked) {
    throwHttpError(
      attendanceScope === 'advisory_class'
        ? 'Attendance is already locked for this advisory section and date'
        : 'Attendance is already locked for this subject and date',
      409
    );
  }

  if (!attendance) attendance = { ...attendanceLookup };

  attendance.attendanceScope = attendanceScope;
  attendance.subjectId = subject?._id || undefined;
  attendance.sectionId = section?._id || undefined;
  attendance.teacherId = teacher._id;
  attendance.dateKey = dateKey;
  attendance.attendanceDate = attendanceDate;
  attendance.subjectName = attendanceScope === 'advisory_class'
    ? 'Advisory Attendance'
    : String(subject?.name || '').trim();
  attendance.subjectCode = String(subject?.code || '').trim();
  attendance.className = attendanceScope === 'advisory_class'
    ? String(section?.name || '').trim()
    : String(subject?.className || '').trim();
  attendance.sectionName = String(section?.name || '').trim();
  attendance.track = String(subject?.track || '').trim();
  attendance.teacherName = String(teacher?.name || 'Teacher').trim() || 'Teacher';
  attendance.teacherSubject = String(teacher?.subject || '').trim();
  attendance.teacherDepartment = String(teacher?.department || '').trim();
  attendance.entries = preparedEntries;
  attendance.summary = buildAttendanceSummary(preparedEntries, approvedStudents.length);
  attendance.isLocked = false;
  attendance.lockedAt = null;

  try {
    attendance = await persistAttendanceRecord(attendance);
  } catch (error) {
    if (error?.code === '23505' || error?.statusCode === 409) {
      throwHttpError(
        attendanceScope === 'advisory_class'
          ? 'Attendance already exists for this advisory section and date'
          : 'Attendance already exists for this subject and date',
        409
      );
    }
    throw error;
  }

  return {
    attendance,
    approvedStudents,
    isNewRecord,
  };
}

function buildCountsFromRecords(records) {
  const summary = {
    totalRecords: Array.isArray(records) ? records.length : 0,
    totalStudents: 0,
    presentCount: 0,
    lateCount: 0,
    absentCount: 0,
    excusedCount: 0,
    lockedCount: 0,
  };

  const uniqueStudentIds = new Set();
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (record?.isLocked) summary.lockedCount += 1;
    const mapped = mapAttendanceRecord(record);
    summary.presentCount += mapped.summary.presentCount;
    summary.lateCount += mapped.summary.lateCount;
    summary.absentCount += mapped.summary.absentCount;
    summary.excusedCount += mapped.summary.excusedCount;
    mapped.entries.forEach((entry) => {
      if (entry.studentId) uniqueStudentIds.add(entry.studentId);
    });
  });
  summary.totalStudents = uniqueStudentIds.size;

  return summary;
}

const getTeacherAttendanceRoster = asyncHandler(async (req, res) => {
  const attendanceScope = normalizeAttendanceScope(req.query?.scope || req.query?.attendanceScope);
  const { subject, section } = await resolveTeacherAttendanceContext({
    teacher: req.user,
    attendanceScope,
    subjectId: req.query?.subjectId,
  });
  const { dateKey } = normalizeDateKey(req.query?.date || req.query?.dateKey);

  const [approvedStudents, attendance] = await Promise.all([
    getApprovedRoster({
      teacherId: req.user._id,
      subjectId: subject?._id,
      attendanceScope,
      sectionId: section?._id,
    }),
    findAttendanceRecord(
      attendanceScope === 'advisory_class'
        ? { attendanceScope, teacherId: req.user._id, sectionId: section._id, dateKey }
        : { attendanceScope, subjectId: subject._id, dateKey }
    ),
  ]);

  return sendSuccess(res, 200, 'Attendance roster fetched successfully', buildTeacherRosterPayload({
    attendanceScope,
    subject,
    section,
    attendance: attendance ? { ...attendance, dateKey } : null,
    approvedStudents,
  }));
});

const listTeacherAttendanceRecords = asyncHandler(async (req, res) => {
  const attendanceScope = normalizeAttendanceScope(req.query?.scope || req.query?.attendanceScope);
  const subjectId = String(req.query?.subjectId || '').trim();
  const dateFrom = String(req.query?.from || '').trim();
  const dateTo = String(req.query?.to || '').trim();
  const limit = Math.max(1, Math.min(Number(req.query?.limit || 90) || 90, 180));

  let query = { teacherId: req.user._id, attendanceScope };
  if (attendanceScope === 'handled_class' && subjectId) {
    await findTeacherSubjectOrThrow({ teacherId: req.user._id, subjectId });
    query = { ...query, subjectId };
  }
  if (attendanceScope === 'advisory_class') {
    const section = await findTeacherAdvisorySectionOrThrow({ teacher: req.user });
    query = { ...query, sectionId: section._id };
  }

  const records = await listAttendanceRecords(query, limit);

  const filtered = applyDateRange(records, { from: dateFrom, to: dateTo });

  return sendSuccess(res, 200, 'Attendance records fetched successfully', {
    records: filtered.map((record) => mapAttendanceRecord(record, { includeEntries: false })),
    summary: buildCountsFromRecords(filtered),
  });
});

const saveTeacherAttendance = asyncHandler(async (req, res) => {
  const attendanceScope = normalizeAttendanceScope(req.body?.scope || req.body?.attendanceScope);
  const { subject, section } = await resolveTeacherAttendanceContext({
    teacher: req.user,
    attendanceScope,
    subjectId: req.body?.subjectId,
  });
  const { dateKey, attendanceDate } = normalizeDateKey(req.body?.date || req.body?.dateKey);

  const { attendance, approvedStudents, isNewRecord } = await saveAttendanceRecord({
    teacher: req.user,
    attendanceScope,
    subject,
    section,
    dateKey,
    attendanceDate,
    entries: req.body?.entries,
  });

  return sendSuccess(
    res,
    isNewRecord ? 201 : 200,
    isNewRecord ? 'Attendance saved successfully' : 'Attendance updated successfully',
    {
      ...buildTeacherRosterPayload({
        attendanceScope,
        subject,
        section,
        attendance,
        approvedStudents,
      }),
      record: mapAttendanceRecord(attendance),
    }
  );
});

const lockTeacherAttendance = asyncHandler(async (req, res) => {
  const attendanceId = String(req.params?.id || '').trim();
  if (!attendanceId) {
    throwHttpError('Attendance record id is required');
  }

  let attendance = await findAttendanceRecord({
    id: attendanceId,
    teacherId: req.user._id,
  });

  if (!attendance) {
    throwHttpError('Attendance record not found', 404);
  }
  if (attendance.isLocked) {
    throwHttpError('Attendance is already locked', 409);
  }

  attendance.isLocked = true;
  attendance.lockedAt = new Date();
  attendance = await persistAttendanceRecord(attendance);

  return sendSuccess(res, 200, 'Attendance locked successfully', {
    record: mapAttendanceRecord(attendance),
  });
});

const getStudentAttendanceHistory = asyncHandler(async (req, res) => {
  const records = await studentAttendance(req.user._id);

  const attendanceRecords = records.map((record) => {
    const mapped = mapAttendanceRecord(record);
    const ownEntry = mapped.entries.find((entry) => entry.studentId === String(req.user._id || '')) || null;
    return {
      id: mapped.id,
      dateKey: mapped.dateKey,
      attendanceDate: mapped.attendanceDate,
      status: ownEntry?.status || '',
      isLocked: mapped.isLocked,
      lockedAt: mapped.lockedAt,
      attendanceScope: mapped.attendanceScope,
      subject: mapped.subject,
      section: mapped.section,
      title: mapped.title,
      teacher: mapped.teacher,
      updatedAt: mapped.updatedAt,
    };
  });

  const summary = attendanceRecords.reduce((accumulator, record) => {
    accumulator.totalRecords += 1;
    if (record.status === 'Present') accumulator.presentCount += 1;
    if (record.status === 'Late') accumulator.lateCount += 1;
    if (record.status === 'Absent') accumulator.absentCount += 1;
    if (record.status === 'Excused') accumulator.excusedCount += 1;
    return accumulator;
  }, {
    totalRecords: 0,
    presentCount: 0,
    lateCount: 0,
    absentCount: 0,
    excusedCount: 0,
  });

  return sendSuccess(res, 200, 'Attendance history fetched successfully', {
    records: attendanceRecords,
    summary,
  });
});

const getSecretaryAttendanceOverview = asyncHandler(async (req, res) => {
  const dateFrom = String(req.query?.from || '').trim();
  const dateTo = String(req.query?.to || '').trim();
  const records = applyDateRange(
    await listAttendanceRecords({}, 200),
    { from: dateFrom, to: dateTo }
  );

  const studentSummariesMap = new Map();
  records.forEach((record) => {
    const mapped = mapAttendanceRecord(record);
    mapped.entries.forEach((entry) => {
      const current = studentSummariesMap.get(entry.studentId) || {
        studentId: entry.studentId,
        name: entry.studentName,
        email: entry.studentEmail,
        sectionName: entry.sectionName,
        gradeLevel: entry.gradeLevel,
        department: entry.department,
        total: 0,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        excusedCount: 0,
        lastStatus: '',
        lastDate: '',
        lastScope: '',
      };

      current.total += 1;
      if (entry.status === 'Present') current.presentCount += 1;
      if (entry.status === 'Late') current.lateCount += 1;
      if (entry.status === 'Absent') current.absentCount += 1;
      if (entry.status === 'Excused') current.excusedCount += 1;
      if (!current.lastDate || mapped.dateKey > current.lastDate) {
        current.lastDate = mapped.dateKey;
        current.lastStatus = entry.status;
        current.lastScope = mapped.attendanceScope;
      }
      studentSummariesMap.set(entry.studentId, current);
    });
  });

  return sendSuccess(res, 200, 'Attendance overview fetched successfully', {
    summary: buildCountsFromRecords(records),
    studentSummaries: Array.from(studentSummariesMap.values())
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    recentRecords: records
      .slice(0, 30)
      .map((record) => mapAttendanceRecord(record)),
  });
});

const getHeadTeacherAttendanceOverview = asyncHandler(async (req, res) => {
  const department = String(req.user?.department || '').trim();
  if (!department) {
    throwHttpError('Your HeadTeacher account is missing a department assignment', 400);
  }

  const headTeacherId = String(req.user?._id || req.user?.id || '').trim();
  const accounts = await listSupabaseAccounts();
  const teachers = accounts.filter((account) => (
    String(account?.role || '').trim() === ROLE_TEACHER
    && String(account?.department || '').trim() === department
    && String(account?.managedBy?._id || account?.managedBy?.id || account?.managedBy || '').trim() === headTeacherId
  ));
  const teacherIds = new Set(teachers.map((teacher) => String(teacher?._id || teacher?.id || '').trim()).filter(Boolean));
  const records = teacherIds.size > 0
    ? (await listAttendanceRecords({}, 200)).filter((record) => teacherIds.has(String(record.teacherId || '')))
    : [];

  const teacherSummaryMap = new Map(
    teachers.map((teacher) => [String(teacher._id || teacher.id), {
      teacherId: String(teacher._id || teacher.id),
      name: String(teacher.name || 'Teacher').trim() || 'Teacher',
      email: String(teacher.email || '').trim(),
      subject: String(teacher.subject || teacher.department || '').trim(),
      department: String(teacher.department || '').trim(),
      advisorySectionName: String(teacher?.advisorySection?.name || '').trim(),
      status: String(teacher.status || 'active').trim().toLowerCase(),
      totalRecords: 0,
      handledRecordCount: 0,
      advisoryRecordCount: 0,
      totalStudents: 0,
      presentCount: 0,
      lateCount: 0,
      absentCount: 0,
      excusedCount: 0,
      lockedCount: 0,
      lastDate: '',
    }])
  );

  records.forEach((record) => {
    const teacherId = String(record?.teacherId || '');
    const current = teacherSummaryMap.get(teacherId);
    if (!current) return;
    const mapped = mapAttendanceRecord(record);
    const uniqueStudents = new Set(mapped.entries.map((entry) => entry.studentId).filter(Boolean));

    current.totalRecords += 1;
    if (mapped.attendanceScope === 'advisory_class') current.advisoryRecordCount += 1;
    if (mapped.attendanceScope === 'handled_class') current.handledRecordCount += 1;
    current.totalStudents += uniqueStudents.size;
    current.presentCount += mapped.summary.presentCount;
    current.lateCount += mapped.summary.lateCount;
    current.absentCount += mapped.summary.absentCount;
    current.excusedCount += mapped.summary.excusedCount;
    current.lockedCount += mapped.isLocked ? 1 : 0;
    if (!current.lastDate || mapped.dateKey > current.lastDate) {
      current.lastDate = mapped.dateKey;
    }
  });

  return sendSuccess(res, 200, 'Managed attendance overview fetched successfully', {
    summary: {
      department,
      ...buildCountsFromRecords(records),
      totalTeachers: teachers.length,
    },
    teacherSummaries: Array.from(teacherSummaryMap.values())
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''))),
    recentRecords: records
      .slice(0, 30)
      .map((record) => mapAttendanceRecord(record)),
  });
});

const getAdminAttendanceReport = asyncHandler(async (req, res) => {
  const dateFrom = String(req.query?.from || '').trim();
  const dateTo = String(req.query?.to || '').trim();
  const accounts = await listSupabaseAccounts();
  const teachers = accounts.filter((account) => String(account?.role || '') === ROLE_TEACHER);

  const teacherMap = new Map(teachers.map((teacher) => [String(teacher._id), teacher]));
  const allRecords = await listAttendanceRecords({}, 400);
  const records = applyDateRange(allRecords, { from: dateFrom, to: dateTo });

  const teacherSummariesMap = new Map();
  const subjectSummariesMap = new Map();

  records.forEach((record) => {
    const mapped = mapAttendanceRecord(record);
    const teacherId = String(mapped.teacher.id || '');
    const subjectId = String(mapped.subject.id || '');
    const teacher = teacherMap.get(teacherId) || null;

    if (teacherId) {
      const teacherSummary = teacherSummariesMap.get(teacherId) || {
        teacherId,
        name: String(teacher?.name || mapped.teacher.name || 'Teacher').trim() || 'Teacher',
        email: String(teacher?.email || '').trim(),
        subject: String(teacher?.subject || mapped.teacher.subject || '').trim(),
        department: String(teacher?.department || mapped.teacher.department || '').trim(),
        advisorySectionName: String(teacher?.advisorySectionId?.name || '').trim(),
        status: String(teacher?.status || '').trim().toLowerCase(),
        totalRecords: 0,
        handledRecordCount: 0,
        advisoryRecordCount: 0,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        excusedCount: 0,
        lockedCount: 0,
        lastDate: '',
      };

      teacherSummary.totalRecords += 1;
      if (mapped.attendanceScope === 'advisory_class') teacherSummary.advisoryRecordCount += 1;
      if (mapped.attendanceScope === 'handled_class') teacherSummary.handledRecordCount += 1;
      teacherSummary.presentCount += mapped.summary.presentCount;
      teacherSummary.lateCount += mapped.summary.lateCount;
      teacherSummary.absentCount += mapped.summary.absentCount;
      teacherSummary.excusedCount += mapped.summary.excusedCount;
      teacherSummary.lockedCount += mapped.isLocked ? 1 : 0;
      if (!teacherSummary.lastDate || mapped.dateKey > teacherSummary.lastDate) {
        teacherSummary.lastDate = mapped.dateKey;
      }
      teacherSummariesMap.set(teacherId, teacherSummary);
    }

    if (subjectId) {
      const subjectSummary = subjectSummariesMap.get(subjectId) || {
        subjectId,
        name: mapped.subject.name,
        code: mapped.subject.code,
        className: mapped.subject.className,
        track: mapped.subject.track,
        teacherName: mapped.teacher.name,
        totalRecords: 0,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        excusedCount: 0,
        lockedCount: 0,
        lastDate: '',
      };

      subjectSummary.totalRecords += 1;
      subjectSummary.presentCount += mapped.summary.presentCount;
      subjectSummary.lateCount += mapped.summary.lateCount;
      subjectSummary.absentCount += mapped.summary.absentCount;
      subjectSummary.excusedCount += mapped.summary.excusedCount;
      subjectSummary.lockedCount += mapped.isLocked ? 1 : 0;
      if (!subjectSummary.lastDate || mapped.dateKey > subjectSummary.lastDate) {
        subjectSummary.lastDate = mapped.dateKey;
      }
      subjectSummariesMap.set(subjectId, subjectSummary);
    }
  });

  return sendSuccess(res, 200, 'Attendance report fetched successfully', {
    summary: {
      ...buildCountsFromRecords(records),
      totalTeachers: teachers.length,
    },
    teacherSummaries: Array.from(teacherSummariesMap.values())
      .sort((left, right) => right.absentCount - left.absentCount || String(left.name || '').localeCompare(String(right.name || '')))
      .slice(0, 20),
    subjectSummaries: Array.from(subjectSummariesMap.values())
      .sort((left, right) => right.absentCount - left.absentCount || String(left.name || '').localeCompare(String(right.name || '')))
      .slice(0, 20),
    recentRecords: records
      .slice(0, 30)
      .map((record) => mapAttendanceRecord(record, { includeEntries: false })),
  });
});

module.exports = {
  getTeacherAttendanceRoster,
  listTeacherAttendanceRecords,
  saveTeacherAttendance,
  lockTeacherAttendance,
  getStudentAttendanceHistory,
  getSecretaryAttendanceOverview,
  getHeadTeacherAttendanceOverview,
  getAdminAttendanceReport,
};
