-- Apply after the existing EduMatch migrations 001-012. No replacement tables.
begin;

create table if not exists public.mobile_attendance_sessions (
  id text primary key,
  subject_id text not null references public.subjects(id) on delete cascade,
  teacher_id text not null references public.users(id) on delete cascade,
  date_key text not null,
  token_hash text not null,
  status text not null default 'open' check (status in ('open', 'finalized', 'cancelled')),
  expires_at timestamptz not null,
  late_after timestamptz not null,
  roster jsonb not null,
  attendance_record_id text references public.attendance_records(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mobile_attendance_one_open_idx
  on public.mobile_attendance_sessions(subject_id, date_key) where status = 'open';
create index if not exists mobile_attendance_teacher_idx
  on public.mobile_attendance_sessions(teacher_id, created_at desc);

create table if not exists public.mobile_attendance_scans (
  session_id text not null references public.mobile_attendance_sessions(id) on delete cascade,
  student_id text not null references public.users(id) on delete cascade,
  status text not null check (status in ('Present', 'Late')),
  scanned_at timestamptz not null default now(),
  primary key(session_id, student_id)
);
alter table public.mobile_attendance_sessions enable row level security;
alter table public.mobile_attendance_scans enable row level security;
revoke all on table public.mobile_attendance_sessions, public.mobile_attendance_scans from anon, authenticated;
grant all on table public.mobile_attendance_sessions, public.mobile_attendance_scans to service_role;

create or replace function public.mobile_create_attendance_session(
  p_id text, p_teacher_id text, p_subject_id text, p_date_key text, p_token_hash text,
  p_duration_minutes integer, p_late_after_minutes integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare roster_data jsonb; created public.mobile_attendance_sessions;
begin
  if p_duration_minutes not between 1 and 120 or p_late_after_minutes not between 0 and p_duration_minutes
    or p_token_hash !~ '^[a-f0-9]{64}$' or to_char(p_date_key::date,'YYYY-MM-DD') <> p_date_key then
    raise exception 'Invalid attendance time window or date' using errcode = '22023';
  end if;
  -- Same lock is acquired by the compatibility trigger for a concurrent web save.
  perform pg_advisory_xact_lock(hashtextextended(p_subject_id || ':' || p_date_key, 0));
  if not exists (select 1 from public.subjects s join public.users u on u.id = s.teacher_id
    where s.id = p_subject_id and s.teacher_id = p_teacher_id and s.is_active
      and u.role = 'teacher' and u.status = 'active') then
    raise exception 'Class is not assigned to this teacher' using errcode = '42501';
  end if;
  if exists (select 1 from public.attendance_records where subject_id = p_subject_id and date_key = p_date_key) then
    raise exception 'Attendance already exists for this class and date' using errcode = '55000';
  end if;
  if exists (select 1 from public.mobile_attendance_sessions where subject_id=p_subject_id and date_key=p_date_key and status='open') then
    raise exception 'An attendance session is already open for this class and date' using errcode='55000';
  end if;
  select jsonb_agg(jsonb_build_object('studentId', u.id, 'studentName', u.name, 'studentEmail', u.email,
    'sectionId', u.section_id, 'sectionName', coalesce(sec.name,''), 'gradeLevel', u.grade_level, 'department', u.department)
    order by u.name, u.id) into roster_data
    from public.subject_enrollments e join public.users u on u.id = e.student_id
    left join public.sections sec on sec.id = u.section_id
    where e.subject_id = p_subject_id and e.teacher_id = p_teacher_id and e.status = 'approved'
      and u.role = 'student' and u.status = 'active' and coalesce(u.archive->>'isArchived','false') <> 'true';
  if roster_data is null then raise exception 'This class has no approved active students' using errcode = '55000'; end if;
  insert into public.mobile_attendance_sessions(id, subject_id, teacher_id, date_key, token_hash, expires_at, late_after, roster)
    values (p_id,p_subject_id,p_teacher_id,p_date_key,p_token_hash,
      now() + make_interval(mins => p_duration_minutes),now() + make_interval(mins => p_late_after_minutes),roster_data)
    returning * into created;
  return to_jsonb(created) - 'token_hash' - 'roster';
end $$;

create or replace function public.mobile_scan_attendance(p_session_id text, p_student_id text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare attendance_session public.mobile_attendance_sessions; scan public.mobile_attendance_scans; duplicate boolean := false;
begin
  -- Serializes scan, rotate, cancel, and finalization on the session row.
  select * into attendance_session from public.mobile_attendance_sessions where id = p_session_id for update;
  if not found or attendance_session.token_hash <> p_token_hash then
    raise exception 'Attendance QR code is invalid' using errcode = '22023';
  end if;
  if attendance_session.status <> 'open' or attendance_session.expires_at <= now() then
    raise exception 'Attendance QR code is closed or expired' using errcode = '55000';
  end if;
  if not exists(select 1 from public.subjects where id=attendance_session.subject_id
    and teacher_id=attendance_session.teacher_id and is_active) then
    raise exception 'Class assignment has changed' using errcode='42501'; end if;
  if not exists (select 1 from public.users u join public.subject_enrollments e on e.student_id = u.id
    where u.id = p_student_id and u.role = 'student' and u.status = 'active'
      and coalesce(u.archive->>'isArchived','false') <> 'true'
      and e.subject_id = attendance_session.subject_id and e.teacher_id = attendance_session.teacher_id and e.status = 'approved')
    or not exists (select 1 from jsonb_array_elements(attendance_session.roster) r where r->>'studentId' = p_student_id) then
    raise exception 'You are not on the approved attendance roster' using errcode = '42501';
  end if;
  insert into public.mobile_attendance_scans(session_id,student_id,status)
    values(p_session_id,p_student_id,case when now() > attendance_session.late_after then 'Late' else 'Present' end)
    on conflict do nothing returning * into scan;
  if not found then
    duplicate := true;
    select * into scan from public.mobile_attendance_scans where session_id = p_session_id and student_id = p_student_id;
  end if;
  return jsonb_build_object('attendance',jsonb_build_object('sessionId',p_session_id,'subjectId',attendance_session.subject_id,
    'dateKey',attendance_session.date_key,'status',scan.status,'scannedAt',scan.scanned_at),'duplicate',duplicate);
end $$;

create or replace function public.mobile_rotate_attendance_session(p_session_id text,p_teacher_id text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare attendance_session public.mobile_attendance_sessions;
begin
  select * into attendance_session from public.mobile_attendance_sessions where id=p_session_id and teacher_id=p_teacher_id for update;
  if not found then raise exception 'Attendance session not found' using errcode='P0002'; end if;
  if attendance_session.status <> 'open' or attendance_session.expires_at <= now() then
    raise exception 'Attendance session is closed or expired' using errcode='55000'; end if;
  if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid QR token' using errcode='22023'; end if;
  update public.mobile_attendance_sessions set token_hash=p_token_hash,updated_at=now() where id=p_session_id returning * into attendance_session;
  return to_jsonb(attendance_session) - 'token_hash' - 'roster';
end $$;

create or replace function public.mobile_cancel_attendance_session(p_session_id text,p_teacher_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare attendance_session public.mobile_attendance_sessions;
begin
  select * into attendance_session from public.mobile_attendance_sessions where id=p_session_id and teacher_id=p_teacher_id for update;
  if not found then raise exception 'Attendance session not found' using errcode='P0002'; end if;
  if attendance_session.status = 'finalized' then raise exception 'Finalized attendance cannot be cancelled' using errcode='55000'; end if;
  update public.mobile_attendance_sessions set status='cancelled',updated_at=now() where id=p_session_id returning * into attendance_session;
  return to_jsonb(attendance_session) - 'token_hash' - 'roster';
end $$;

create or replace function public.mobile_finalize_attendance(p_session_id text,p_teacher_id text,p_overrides jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare attendance_session public.mobile_attendance_sessions; attendance_record public.attendance_records;
  class public.subjects; teacher public.users; student jsonb; override_status text; scan public.mobile_attendance_scans;
  entries_data jsonb := '[]'::jsonb; summary_data jsonb;
begin
  select * into attendance_session from public.mobile_attendance_sessions where id=p_session_id and teacher_id=p_teacher_id for update;
  if not found then raise exception 'Attendance session not found' using errcode='P0002'; end if;
  if not exists(select 1 from public.users where id=p_teacher_id and role='teacher' and status='active') then
    raise exception 'Teacher access required' using errcode='42501'; end if;
  if attendance_session.status = 'finalized' then
    select * into attendance_record from public.attendance_records where id=attendance_session.attendance_record_id;
    return jsonb_build_object('session',to_jsonb(attendance_session) - 'token_hash' - 'roster','record',to_jsonb(attendance_record));
  end if;
  if attendance_session.status <> 'open' then raise exception 'Attendance session is cancelled' using errcode='55000'; end if;
  if jsonb_typeof(p_overrides) <> 'array' or jsonb_array_length(p_overrides) > 1000 then
    raise exception 'Invalid attendance overrides' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_overrides) o where (o->>'studentId') is null
    or coalesce(o->>'status','') not in ('Present','Late','Absent','Excused')
    or not exists(select 1 from jsonb_array_elements(attendance_session.roster) r where r->>'studentId'=o->>'studentId'))
    or exists(select 1 from jsonb_array_elements(p_overrides) o group by o->>'studentId' having count(*)>1) then
    raise exception 'Invalid or duplicate attendance override' using errcode='22023'; end if;
  select * into class from public.subjects where id=attendance_session.subject_id and teacher_id=p_teacher_id and is_active;
  if not found then raise exception 'Class assignment has changed' using errcode='42501'; end if;
  select * into teacher from public.users where id=p_teacher_id;
  for student in select value from jsonb_array_elements(attendance_session.roster) loop
    select * into scan from public.mobile_attendance_scans where session_id=p_session_id and student_id=student->>'studentId';
    select o->>'status' into override_status from jsonb_array_elements(p_overrides) o where o->>'studentId'=student->>'studentId';
    entries_data := entries_data || jsonb_build_array(student || jsonb_build_object('status',coalesce(override_status,scan.status,'Absent'),
      'markedAt',coalesce(scan.scanned_at,now())));
  end loop;
  select jsonb_build_object('totalStudents',count(*),'presentCount',count(*) filter(where e->>'status'='Present'),
    'lateCount',count(*) filter(where e->>'status'='Late'),'absentCount',count(*) filter(where e->>'status'='Absent'),
    'excusedCount',count(*) filter(where e->>'status'='Excused')) into summary_data from jsonb_array_elements(entries_data) e;
  -- Lets only this transaction's finalization pass the compatibility trigger.
  perform set_config('edumatch.mobile_attendance_finalize',p_session_id,true);
  insert into public.attendance_records(attendance_scope,subject_id,teacher_id,date_key,attendance_date,subject_name,subject_code,
    class_name,track,teacher_name,teacher_subject,teacher_department,entries,summary,is_locked,locked_at)
    values('handled_class',class.id,p_teacher_id,attendance_session.date_key,(attendance_session.date_key || 'T00:00:00Z')::timestamptz,
      class.name,class.code,class.class_name,class.track,teacher.name,teacher.subject,teacher.department,entries_data,summary_data,true,now())
    returning * into attendance_record;
  update public.mobile_attendance_sessions set status='finalized',attendance_record_id=attendance_record.id,updated_at=now()
    where id=p_session_id returning * into attendance_session;
  return jsonb_build_object('session',to_jsonb(attendance_session) - 'token_hash' - 'roster','record',to_jsonb(attendance_record));
end $$;

-- Also hardens existing web save/lock races without changing the web response contract.
create or replace function public.mobile_guard_attendance_record()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare open_session text;
begin
  if tg_op='UPDATE' and old.is_locked and
    (new.entries is distinct from old.entries or new.summary is distinct from old.summary or not new.is_locked
      or new.teacher_id is distinct from old.teacher_id or new.subject_id is distinct from old.subject_id
      or new.date_key is distinct from old.date_key or new.attendance_scope is distinct from old.attendance_scope
      or new.section_id is distinct from old.section_id or new.locked_at is distinct from old.locked_at) then
    raise exception 'Finalized attendance cannot be changed' using errcode='55000';
  end if;
  if new.subject_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.subject_id || ':' || new.date_key,0));
    select id into open_session from public.mobile_attendance_sessions
      where subject_id=new.subject_id and date_key=new.date_key and status='open';
    if open_session is not null and coalesce(current_setting('edumatch.mobile_attendance_finalize',true),'') <> open_session then
      raise exception 'Finalize or cancel the open mobile QR attendance session before using manual attendance' using errcode='55000';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists mobile_guard_attendance_record on public.attendance_records;
create trigger mobile_guard_attendance_record before insert or update on public.attendance_records
  for each row execute function public.mobile_guard_attendance_record();

revoke all on function public.mobile_create_attendance_session(text,text,text,text,text,integer,integer),
  public.mobile_scan_attendance(text,text,text), public.mobile_rotate_attendance_session(text,text,text),
  public.mobile_cancel_attendance_session(text,text),public.mobile_finalize_attendance(text,text,jsonb),
  public.mobile_guard_attendance_record() from public, anon, authenticated;
grant execute on function public.mobile_create_attendance_session(text,text,text,text,text,integer,integer),
  public.mobile_scan_attendance(text,text,text), public.mobile_rotate_attendance_session(text,text,text),
  public.mobile_cancel_attendance_session(text,text),public.mobile_finalize_attendance(text,text,jsonb) to service_role;
commit;
