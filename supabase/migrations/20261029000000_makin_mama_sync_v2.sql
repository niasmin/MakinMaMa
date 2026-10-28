-- v2: เขียนแบบรายรายการ + ส่วนต่างตัวเลข (กันเขียนทับกันระหว่างอุปกรณ์), ปิดการตั้งรหัสร้านครั้งแรกจากฝั่งแอป,
-- จำกัดการเดารหัสร้าน

alter table public.mm_records add column created_at timestamptz not null default now();
create index mm_records_coll_updated_idx on public.mm_records (coll, updated_at);

-- บันทึกการใส่รหัสร้านผิด ใช้จำกัดการเดารหัส (เข้าถึงผ่านฟังก์ชันเท่านั้น)
create table public.mm_join_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index mm_join_attempts_user_at_idx on public.mm_join_attempts (user_id, at);
alter table public.mm_join_attempts enable row level security;
revoke all on public.mm_join_attempts from anon, authenticated;

-- รหัสร้านต้องตั้งจากฝั่งผู้ดูแล (SQL) เท่านั้น แอปเข้าร่วมได้อย่างเดียว — ใส่ผิดได้ 5 ครั้งต่อ 15 นาทีต่อผู้ใช้
create or replace function public.mm_join(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h text; uid uuid := (select auth.uid());
begin
  if uid is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.mm_members where user_id = uid) then return true; end if;
  select code_hash into h from public.mm_shop where id = 1;
  if h is null then raise exception 'ร้านยังไม่ได้ตั้งรหัส'; end if;
  if (select count(*) from public.mm_join_attempts where user_id = uid and at > now() - interval '15 minutes') >= 5 then
    raise exception 'ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 15 นาที';
  end if;
  if h <> extensions.crypt(coalesce(p_code, ''), h) then
    delete from public.mm_join_attempts where at < now() - interval '1 day';
    insert into public.mm_join_attempts (user_id) values (uid);
    return false;
  end if;
  insert into public.mm_members (user_id) values (uid) on conflict do nothing;
  return true;
end $$;

create or replace function public.mm_set_code(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.mm_is_member() then raise exception 'not a member'; end if;
  if length(coalesce(p_code, '')) < 8 then raise exception 'รหัสร้านต้องยาวอย่างน้อย 8 ตัวอักษร'; end if;
  update public.mm_shop set code_hash = extensions.crypt(p_code, extensions.gen_salt('bf')) where id = 1;
end $$;

-- เขียนหลายรายการในครั้งเดียว p_rows = [{id, data, delta?}] — ฟิลด์ใน delta จะถูก "บวกเพิ่ม" จากค่าบนเซิร์ฟเวอร์
-- (เช่น qty: -2 = ตัดสต๊อก 2) แทนการเขียนทับ จึงไม่หายเมื่อหลายเครื่องตัดสต๊อกพร้อมกัน คืนค่าแถวหลังบันทึก
-- security invoker: RLS ของ mm_records ยังบังคับใช้ตามปกติ
create function public.mm_push(p_coll text, p_rows jsonb, p_deletes text[]) returns setof public.mm_records
language plpgsql security invoker set search_path = '' as $$
declare r jsonb; res public.mm_records;
begin
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into public.mm_records as m (coll, id, data) values (p_coll, r->>'id', r->'data')
    on conflict (coll, id) do update set data = case
      when jsonb_typeof(r->'delta') = 'object' and jsonb_typeof(m.data) = 'object' and jsonb_typeof(excluded.data) = 'object' then
        excluded.data || coalesce((
          select jsonb_object_agg(d.key, to_jsonb(
            case when jsonb_typeof(m.data->d.key) = 'number' then (m.data->>d.key)::numeric else 0 end + (d.value #>> '{}')::numeric))
          from jsonb_each(r->'delta') d where jsonb_typeof(d.value) = 'number'), '{}'::jsonb)
      else excluded.data end
    returning * into res;
    return next res;
  end loop;
  if coalesce(array_length(p_deletes, 1), 0) > 0 then
    delete from public.mm_records where coll = p_coll and id = any (p_deletes);
  end if;
end $$;
revoke all on function public.mm_push(text, jsonb, text[]) from public, anon;
grant execute on function public.mm_push(text, jsonb, text[]) to authenticated;
