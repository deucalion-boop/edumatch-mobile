'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* optional isolated DB dev dependency */ }

const backend = process.env.EDUMATCH_BACKEND_ROOT || path.resolve(__dirname, '../../../Edumatch/backend');
const migrationRoot = path.join(backend, 'supabase/migrations');
const available = Boolean(PGlite && fs.existsSync(migrationRoot));

test('existing migrations + additive mobile SQL execute real PostgreSQL workflows', { skip: !available, timeout: 120000 }, async (t) => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    for (const file of fs.readdirSync(migrationRoot).filter((file) => /^0(?:0[1-9]|1[0-2])_.*\.sql$/.test(file)).sort()) {
      await db.exec(fs.readFileSync(path.join(migrationRoot, file), 'utf8'));
    }
    for (const file of ['013_mobile_attendance.sql', '014_mobile_push.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const rpc = async (expression, params = []) => (await one(`select ${expression} as result`, params)).result;
    const rejects = async (sql, code) => assert.rejects(db.query(sql), (error) => error.code === code);

    await db.exec(`insert into public.users(id,name,email,username,role,status,department) values
      ('qa-teacher','Teacher One','qa-teacher@example.com','qa-teacher','teacher','active','Science'),
      ('qa-other','Teacher Two','qa-other@example.com','qa-other','teacher','active','Science'),
      ('qa-student','Student One','qa-student@example.com','qa-student','student','active','Science'),
      ('qa-student-two','Student Two','qa-student-two@example.com','qa-student-two','student','active','Science'),
      ('qa-unenrolled','Other Student','qa-unenrolled@example.com','qa-unenrolled','student','active','Science');
      insert into public.subjects(id,name,class_name,code,track,teacher_id) values
        ('qa-class','Biology','Class One','QA-BIO','STEM','qa-teacher');
      insert into public.subject_enrollments(subject_id,teacher_id,student_id,status) values
        ('qa-class','qa-teacher','qa-student','approved'),('qa-class','qa-teacher','qa-student-two','approved');
      insert into public.sessions(id,user_id,token_id,expires_at) values
        ('qa-session','qa-teacher','qa-token',now()+interval '1 day'),
        ('qa-session-other','qa-other','qa-token-other',now()+interval '1 day');`);
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);

    await t.test('RLS and RPC privileges prevent direct mobile client writes', async () => {
      const access = await one("select has_function_privilege('anon','public.mobile_scan_attendance(text,text,text)','EXECUTE') as anon_rpc, has_table_privilege('authenticated','public.mobile_attendance_scans','INSERT') as client_insert");
      assert.equal(access.anon_rpc, false);
      assert.equal(access.client_insert, false);
    });
    await t.test('session creation authorizes assigned teacher and snapshots approved roster', async () => {
      await rejects(`select public.mobile_create_attendance_session('qa-invalid','qa-other','qa-class','2026-10-09','${hash1}',15,5)`, '42501');
      const session = await rpc('public.mobile_create_attendance_session($1,$2,$3,$4,$5,15,5)', ['qa-qr','qa-teacher','qa-class','2026-10-09',hash1]);
      assert.equal(session.status, 'open');
      assert.equal('token_hash' in session, false);
      const stored = await one("select jsonb_array_length(roster) as size from public.mobile_attendance_sessions where id='qa-qr'");
      assert.equal(stored.size, 2);
      await rejects(`select public.mobile_create_attendance_session('qa-invalid','qa-teacher','qa-class','2026-10-09','${hash1}',15,5)`, '55000');
    });
    await t.test('open QR blocks manual web writes and unauthorized scans', async () => {
      await rejects(`insert into public.attendance_records(subject_id,teacher_id,date_key,attendance_date) values('qa-class','qa-teacher','2026-10-09',now())`, '55000');
      await rejects(`select public.mobile_scan_attendance('qa-qr','qa-unenrolled','${hash1}')`, '42501');
      await rejects(`select public.mobile_scan_attendance('qa-qr','qa-student','${hash2}')`, '22023');
    });
    await t.test('duplicate scans keep first timestamp/status and create one row', async () => {
      const first = await rpc('public.mobile_scan_attendance($1,$2,$3)', ['qa-qr','qa-student',hash1]);
      const duplicate = await rpc('public.mobile_scan_attendance($1,$2,$3)', ['qa-qr','qa-student',hash1]);
      assert.equal(first.duplicate, false);
      assert.equal(duplicate.duplicate, true);
      assert.equal(first.attendance.scannedAt, duplicate.attendance.scannedAt);
      assert.equal(first.attendance.status, 'Present');
      assert.equal((await one("select count(*)::integer as count from public.mobile_attendance_scans where session_id='qa-qr'")).count, 1);
    });
    await t.test('QR rotation revokes old secret and server time determines late status', async () => {
      await rpc('public.mobile_rotate_attendance_session($1,$2,$3)', ['qa-qr','qa-teacher',hash2]);
      await rejects(`select public.mobile_scan_attendance('qa-qr','qa-student-two','${hash1}')`, '22023');
      await db.exec("update public.mobile_attendance_sessions set late_after=now()-interval '1 second' where id='qa-qr'");
      const late = await rpc('public.mobile_scan_attendance($1,$2,$3)', ['qa-qr','qa-student-two',hash2]);
      assert.equal(late.attendance.status, 'Late');
    });
    await t.test('finalization validates full snapshot and writes server totals into existing web table', async () => {
      await rejects("select public.mobile_finalize_attendance('qa-qr','qa-other','[]')", 'P0002');
      await rejects("select public.mobile_finalize_attendance('qa-qr','qa-teacher','[{\"studentId\":\"qa-student\",\"status\":\"Present\"},{\"studentId\":\"qa-student\",\"status\":\"Late\"}]')", '22023');
      const finalized = await rpc('public.mobile_finalize_attendance($1,$2,$3::jsonb)', ['qa-qr','qa-teacher',JSON.stringify([{ studentId:'qa-student-two',status:'Excused' }])]);
      assert.equal(finalized.session.status, 'finalized');
      assert.equal(finalized.record.is_locked, true);
      assert.deepEqual(finalized.record.summary, { totalStudents:2,presentCount:1,lateCount:0,absentCount:0,excusedCount:1 });
      assert.equal((await one('select id from public.attendance_records where id=$1',[finalized.record.id])).id,finalized.record.id);
      const retry = await rpc('public.mobile_finalize_attendance($1,$2,$3::jsonb)', ['qa-qr','qa-teacher','[]']);
      assert.equal(retry.record.id, finalized.record.id);
      await rejects(`update public.attendance_records set entries='[]' where id='${finalized.record.id}'`, '55000');
      await rejects(`update public.attendance_records set is_locked=false where id='${finalized.record.id}'`, '55000');
      await rejects(`select public.mobile_scan_attendance('qa-qr','qa-student','${hash2}')`, '55000');
      await rejects("select public.mobile_cancel_attendance_session('qa-qr','qa-teacher')", '55000');
    });
    await t.test('expired window rejects scans but unscanned students become absent at finalization', async () => {
      await rpc('public.mobile_create_attendance_session($1,$2,$3,$4,$5,15,5)', ['qa-expired','qa-teacher','qa-class','2026-10-10',hash1]);
      await db.exec("update public.mobile_attendance_sessions set expires_at=now()-interval '1 second' where id='qa-expired'");
      await rejects(`select public.mobile_scan_attendance('qa-expired','qa-student','${hash1}')`, '55000');
      const finalized = await rpc('public.mobile_finalize_attendance($1,$2,$3::jsonb)', ['qa-expired','qa-teacher','[]']);
      assert.equal(finalized.record.summary.absentCount, 2);
    });
    await t.test('device registration binds session and refuses live cross-account takeover', async () => {
      await rpc('public.mobile_register_device($1,$2,$3,$4,$5,$6)', ['qa-teacher','qa-installation-one','ExpoPushToken[qaabcdefghijk]','android','qa-project','qa-session']);
      await rejects("select public.mobile_register_device('qa-other','qa-installation-one','ExpoPushToken[qaabcdefghijk]','android','qa-project','qa-session-other')", '42501');
      await rejects("select public.mobile_register_device('qa-other','qa-installation-two','ExpoPushToken[qaabcdefghijk]','android','qa-project','qa-session-other')", '42501');
      const row = await one("select user_id,session_id,token_version from public.mobile_devices where installation_id='qa-installation-one'");
      assert.deepEqual(row,{user_id:'qa-teacher',session_id:'qa-session',token_version:0});
    });
    await t.test('existing notifications enqueue one device job; active session filter blocks revocation', async () => {
      await db.exec("insert into public.notifications(id,recipient_id,recipient_role,title,message,subject,preview,event_key) values ('qa-notification','qa-teacher','teacher','School update','School update','School','School update','qa-event')");
      const jobs = await rpc('public.mobile_claim_push_jobs($1,100)', ['qa-project']);
      assert.equal(jobs.length,1);
      assert.equal(jobs[0].notificationId,'qa-notification');
      assert.equal(jobs[0].attempts,1);
      await db.exec("update public.mobile_push_jobs set status='pending'; update public.sessions set revoked_at=now() where id='qa-session'");
      const cancelled = await rpc('public.mobile_claim_push_jobs($1,100)', ['qa-project']);
      assert.equal(cancelled.length,0);
      assert.equal((await one("select status from public.mobile_push_jobs where notification_id='qa-notification'")).status,'cancelled');
      const eligible = await rpc('public.mobile_device_eligible($1,$2,$3)', ['qa-installation-one','qa-session','qa-teacher']);
      assert.equal(eligible,false);
    });
  } finally { await db.close(); }
});
