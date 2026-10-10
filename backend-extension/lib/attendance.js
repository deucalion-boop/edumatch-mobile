'use strict';

const crypto = require('node:crypto');
const { assertRole, userId, fail, databaseResult } = require('./errors');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)
    || !Number.isFinite(new Date(`${value}T00:00:00Z`).getTime())
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail('dateKey must be a valid YYYY-MM-DD date');
  return value;
}

function sessionId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail('Invalid attendance session');
  return value;
}

function parseQr(qrPayload) {
  if (typeof qrPayload !== 'string' || qrPayload.length > 300) throw fail('Invalid EduMatch attendance QR code');
  let url;
  try { url = new URL(qrPayload); } catch { throw fail('Invalid EduMatch attendance QR code'); }
  const id = url.pathname.replace(/^\//, '');
  const token = url.searchParams.get('token');
  if (url.protocol !== 'edumatch:' || url.hostname !== 'attendance' || !ID.test(id)
    || !TOKEN.test(token || '') || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'token')) {
    throw fail('Invalid EduMatch attendance QR code');
  }
  return { id, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

function createQr(id) {
  const token = crypto.randomBytes(32).toString('base64url');
  return { qrPayload: `edumatch://attendance/${id}?token=${token}`, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

function sessionDto(row) {
  return { id: row.id, subjectId: row.subject_id, dateKey: row.date_key, status: row.status,
    expiresAt: row.expires_at, lateAfter: row.late_after, createdAt: row.created_at,
    attendanceRecordId: row.attendance_record_id || null, scanCount: Number(row.scan_count || 0) };
}

function recordDto(row) {
  return { id: row.id, dateKey: row.date_key, isLocked: row.is_locked, lockedAt: row.locked_at,
    subject: { id: row.subject_id, name: row.subject_name, className: row.class_name },
    entries: row.entries, summary: row.summary };
}

function createAttendanceService(client, { now = () => new Date() } = {}) {
  async function ownedSession(user, id) {
    assertRole(user, 'teacher');
    const row = databaseResult(await client.from('mobile_attendance_sessions').select('*')
      .eq('id', sessionId(id)).eq('teacher_id', userId(user)).maybeSingle());
    if (!row) throw fail('Attendance session not found', 404);
    return row;
  }

  return {
    async create(user, body) {
      assertRole(user, 'teacher');
      const subjectId = sessionId(body.subjectId);
      const dateKey = validDate(body.dateKey);
      // A live attendance QR belongs to today's school day, calculated by server.
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: process.env.SCHOOL_TIMEZONE || 'Asia/Manila',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now()).map(({ type, value }) => [type, value]));
      const schoolToday = `${parts.year}-${parts.month}-${parts.day}`;
      if (dateKey !== schoolToday) throw fail('QR attendance must be opened for the current school day');
      const duration = body.durationMinutes ?? 15;
      const lateAfter = body.lateAfterMinutes ?? 5;
      if (!Number.isInteger(duration) || duration < 1 || duration > 120
        || !Number.isInteger(lateAfter) || lateAfter < 0 || lateAfter > duration) throw fail('Invalid attendance time window');
      const id = crypto.randomUUID();
      const qr = createQr(id);
      const row = databaseResult(await client.rpc('mobile_create_attendance_session', {
        p_id: id, p_teacher_id: userId(user), p_subject_id: subjectId, p_date_key: dateKey,
        p_token_hash: qr.tokenHash, p_duration_minutes: duration, p_late_after_minutes: lateAfter,
      }));
      return { session: sessionDto(row), qrPayload: qr.qrPayload };
    },
    async list(user, query = {}) {
      assertRole(user, 'teacher');
      let request = client.from('mobile_attendance_sessions').select('*').eq('teacher_id', userId(user));
      if (query.subjectId) request = request.eq('subject_id', sessionId(query.subjectId));
      const rows = databaseResult(await request.order('created_at', { ascending: false }).limit(50));
      return { sessions: (rows || []).map(sessionDto) };
    },
    async detail(user, id) {
      const row = await ownedSession(user, id);
      const scans = databaseResult(await client.from('mobile_attendance_scans').select('student_id,status,scanned_at')
        .eq('session_id', row.id));
      const byStudent = new Map((scans || []).map((scan) => [scan.student_id, scan]));
      return { session: { ...sessionDto(row), scanCount: scans.length },
        roster: row.roster.map((student) => ({ studentId: student.studentId, studentName: student.studentName,
          status: byStudent.get(student.studentId)?.status || null,
          scannedAt: byStudent.get(student.studentId)?.scanned_at || null })) };
    },
    async rotate(user, id) {
      await ownedSession(user, id);
      const qr = createQr(id);
      const row = databaseResult(await client.rpc('mobile_rotate_attendance_session', {
        p_session_id: id, p_teacher_id: userId(user), p_token_hash: qr.tokenHash,
      }));
      return { session: sessionDto(row), qrPayload: qr.qrPayload };
    },
    async scan(user, body) {
      assertRole(user, 'student');
      const qr = parseQr(body.qrPayload);
      const result = databaseResult(await client.rpc('mobile_scan_attendance', {
        p_session_id: qr.id, p_student_id: userId(user), p_token_hash: qr.tokenHash,
      }));
      return result;
    },
    async finalize(user, id, body = {}) {
      assertRole(user, 'teacher');
      sessionId(id);
      const overrides = body.overrides ?? [];
      if (!Array.isArray(overrides) || overrides.length > 1000) throw fail('Invalid attendance overrides');
      const seen = new Set();
      for (const entry of overrides) {
        if (!entry || !ID.test(entry.studentId || '') || seen.has(entry.studentId)
          || !['Present', 'Late', 'Absent', 'Excused'].includes(entry.status)) throw fail('Invalid or duplicate attendance override');
        seen.add(entry.studentId);
      }
      const result = databaseResult(await client.rpc('mobile_finalize_attendance', {
        p_session_id: id, p_teacher_id: userId(user), p_overrides: overrides,
      }));
      return { session: sessionDto(result.session), record: recordDto(result.record) };
    },
    async cancel(user, id) {
      assertRole(user, 'teacher');
      const row = databaseResult(await client.rpc('mobile_cancel_attendance_session', {
        p_session_id: sessionId(id), p_teacher_id: userId(user),
      }));
      return { session: sessionDto(row) };
    },
  };
}

module.exports = { createAttendanceService, parseQr, validDate, sessionDto, recordDto };
