begin;

create table if not exists public.mobile_devices (
  installation_id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.sessions(id) on delete cascade,
  token_version integer not null,
  expo_push_token text not null unique,
  platform text not null check (platform in ('android','ios')),
  project_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mobile_devices_user_idx on public.mobile_devices(user_id) where enabled;

create table if not exists public.mobile_push_jobs (
  id bigint generated always as identity primary key,
  notification_id text not null references public.notifications(id) on delete cascade,
  installation_id text not null references public.mobile_devices(installation_id) on delete cascade,
  session_id text not null references public.sessions(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','sending','ticket','delivered','dead','cancelled')),
  attempts integer not null default 0,
  ticket_id text,
  last_error text,
  available_at timestamptz not null default now(),
  ticket_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id,installation_id)
);
create index if not exists mobile_push_due_idx on public.mobile_push_jobs(status,available_at);
alter table public.mobile_devices enable row level security;
alter table public.mobile_push_jobs enable row level security;
revoke all on table public.mobile_devices,public.mobile_push_jobs from anon,authenticated;
grant all on table public.mobile_devices,public.mobile_push_jobs to service_role;
grant usage,select on sequence public.mobile_push_jobs_id_seq to service_role;

create or replace function public.mobile_device_eligible(p_installation_id text,p_session_id text,p_recipient_id text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.mobile_devices d join public.users u on u.id=d.user_id
    join public.sessions s on s.id=d.session_id
    left join public.app_settings settings on settings.key='global'
    where d.installation_id=p_installation_id and d.session_id=p_session_id and d.user_id=p_recipient_id and d.enabled
      and u.status='active' and not u.force_password_change and u.token_version=d.token_version
      and s.user_id=u.id and s.revoked_at is null and s.expires_at>now()
      and s.last_seen_at>now()-make_interval(mins => case
        when settings.value#>>'{security,sessionTimeoutMinutes}' ~ '^[0-9]{1,4}$'
          and (settings.value#>>'{security,sessionTimeoutMinutes}')::integer between 5 and 1440
        then (settings.value#>>'{security,sessionTimeoutMinutes}')::integer else 120 end)
      and (u.role='admin' or coalesce(settings.value#>>'{maintenance,maintenanceModeEnabled}','false')<>'true'));
$$;

create or replace function public.mobile_notification_allowed(p_user_id text,p_type text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((select case
    when p_type='announcement_published' then coalesce(notification_preferences->>'announcements','true')<>'false'
    when p_type in ('lesson_published','activity_assigned','assessment_assigned','activity_submitted','assessment_submitted')
      then coalesce(notification_preferences->>'lessons','true')<>'false'
    when p_type='deadline_upcoming' then coalesce(notification_preferences->>'deadlines','true')<>'false'
    when p_type in ('grade_released','grade_updated','teacher_feedback','recommendation_ready','recommendation_progress')
      then coalesce(notification_preferences->>'results','true')<>'false'
    when p_type in ('enrollment_approved','enrollment_rejected','enrollment_updated')
      then coalesce(notification_preferences->>'enrollment','true')<>'false'
    else true end from public.student_settings where student_id=p_user_id),true);
$$;

create or replace function public.mobile_register_device(p_user_id text,p_installation_id text,p_expo_push_token text,
  p_platform text,p_project_id text,p_session_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare existing public.mobile_devices; created public.mobile_devices; version integer;
begin
  if p_installation_id !~ '^[a-zA-Z0-9_-]{16,100}$' or p_expo_push_token !~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,200}\]$'
    or p_platform not in ('android','ios') or p_project_id='' then raise exception 'Invalid device registration' using errcode='22023'; end if;
  if not exists(select 1 from public.sessions where id=p_session_id and user_id=p_user_id and revoked_at is null and expires_at>now()) then
    raise exception 'Active account session required' using errcode='42501'; end if;
  select token_version into version from public.users where id=p_user_id and status='active';
  if not found then raise exception 'Active account required' using errcode='42501'; end if;
  -- A common lock serializes both unique constraints including initial inserts.
  perform pg_advisory_xact_lock(hashtextextended('mobile-device-registration',0));
  select * into existing from public.mobile_devices where installation_id=p_installation_id for update;
  if found and existing.user_id<>p_user_id and public.mobile_device_eligible(existing.installation_id,existing.session_id,existing.user_id) then
    raise exception 'This installation is registered to another active account. Sign out there first.' using errcode='42501'; end if;
  select * into existing from public.mobile_devices where expo_push_token=p_expo_push_token and installation_id<>p_installation_id for update;
  if found then
    if existing.user_id<>p_user_id and public.mobile_device_eligible(existing.installation_id,existing.session_id,existing.user_id) then
      raise exception 'This push token belongs to another active account' using errcode='42501'; end if;
    -- Disable old identity before freeing the unique Expo token.
    delete from public.mobile_devices where installation_id=existing.installation_id;
  end if;
  insert into public.mobile_devices(installation_id,user_id,session_id,token_version,expo_push_token,platform,project_id,enabled)
    values(p_installation_id,p_user_id,p_session_id,version,p_expo_push_token,p_platform,p_project_id,true)
    on conflict(installation_id) do update set user_id=excluded.user_id,session_id=excluded.session_id,token_version=excluded.token_version,
      expo_push_token=excluded.expo_push_token,platform=excluded.platform,project_id=excluded.project_id,enabled=true,updated_at=now()
    returning * into created;
  update public.mobile_push_jobs set status='cancelled',updated_at=now()
    where installation_id=p_installation_id and session_id<>p_session_id and status in ('pending','sending','ticket');
  return to_jsonb(created)-'expo_push_token';
end $$;

create or replace function public.mobile_enqueue_notification_push()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not new.is_cleared and public.mobile_notification_allowed(new.recipient_id,new.type) then
    insert into public.mobile_push_jobs(notification_id,installation_id,session_id)
      select new.id,d.installation_id,d.session_id from public.mobile_devices d
      where d.user_id=new.recipient_id and public.mobile_device_eligible(d.installation_id,d.session_id,new.recipient_id)
      on conflict(notification_id,installation_id) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists mobile_enqueue_notification_push on public.notifications;
create trigger mobile_enqueue_notification_push after insert on public.notifications
  for each row execute function public.mobile_enqueue_notification_push();

create or replace function public.mobile_claim_push_jobs(p_project_id text,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare claimed jsonb;
begin
  -- Network/process failure may leave a send leased. Expo delivery is at least once.
  update public.mobile_push_jobs set status=case when attempts>=5 then 'dead' else 'pending' end,
    available_at=now(),last_error='Sending lease expired',updated_at=now()
    where status='sending' and updated_at<now()-interval '5 minutes';
  update public.mobile_push_jobs j set status='cancelled',updated_at=now()
    from public.notifications n where n.id=j.notification_id and j.status in ('pending','sending','ticket')
    and (not public.mobile_device_eligible(j.installation_id,j.session_id,n.recipient_id)
      or n.is_cleared or not public.mobile_notification_allowed(n.recipient_id,n.type));
  with candidates as (
    select j.id from public.mobile_push_jobs j join public.mobile_devices d on d.installation_id=j.installation_id
      where j.status='pending' and j.available_at<=now() and d.project_id=p_project_id
      order by j.id for update of j skip locked limit least(greatest(p_limit,1),100)
  ), updated as (
    update public.mobile_push_jobs j set status='sending',attempts=j.attempts+1,updated_at=now()
      from candidates c where j.id=c.id returning j.*
  ) select coalesce(jsonb_agg(to_jsonb(j)||jsonb_build_object('expoPushToken',d.expo_push_token,
    'notificationId',n.id,'notificationType',n.type,'urgent',n.urgent)), '[]'::jsonb)
    into claimed from updated j join public.mobile_devices d on d.installation_id=j.installation_id
      join public.notifications n on n.id=j.notification_id;
  return claimed;
end $$;

revoke all on function public.mobile_device_eligible(text,text,text),public.mobile_notification_allowed(text,text),
  public.mobile_register_device(text,text,text,text,text,text),public.mobile_enqueue_notification_push(),
  public.mobile_claim_push_jobs(text,integer) from public,anon,authenticated;
grant execute on function public.mobile_device_eligible(text,text,text),public.mobile_notification_allowed(text,text),
  public.mobile_register_device(text,text,text,text,text,text),public.mobile_claim_push_jobs(text,integer) to service_role;
commit;
