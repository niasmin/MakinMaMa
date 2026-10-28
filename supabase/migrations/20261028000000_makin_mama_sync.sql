-- มากิน มาม่า: ที่เก็บข้อมูลกลางสำหรับ index.html / pos-frontend.html / stock-system.html
-- ทุกแอปล็อกอินแบบ Anonymous แล้วต้อง "เข้าร่วมร้าน" ด้วยรหัสร้านก่อน จึงจะอ่าน/เขียนข้อมูลได้
-- (โปรเจกต์ Supabase นี้มีแอปอื่นที่ผู้ใช้ล็อกอินอยู่ด้วย จึงห้ามใช้แค่ "authenticated" เป็นเงื่อนไข)

-- รหัสร้าน (เก็บเป็น bcrypt hash แถวเดียว) — ไม่มี policy ใดๆ เข้าถึงได้ผ่านฟังก์ชันเท่านั้น
create table public.mm_shop (
  id smallint primary key default 1 check (id = 1),
  code_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.mm_shop enable row level security;

-- อุปกรณ์ (ผู้ใช้ anonymous) ที่ใส่รหัสร้านถูกแล้ว
create table public.mm_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now()
);
alter table public.mm_members enable row level security;

-- ข้อมูลทั้งหมด: coll = กลุ่มข้อมูล, id = คีย์ของเอกสาร
--   coll 'kv'            : เอกสารทั้งก้อนของหลังบ้าน/POS (menu, orders, stock, ...)
--   coll 'stock_items' / 'stock_moves' / 'stock_periods' : ระบบสต๊อก แยกรายรายการ
-- version เพิ่มเองทุกครั้งที่ update ใช้ทำ optimistic locking แทน transaction ของ Firebase
create table public.mm_records (
  coll text not null,
  id text not null,
  data jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);
alter table public.mm_records enable row level security;

create function public.mm_records_bump() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger mm_records_bump before update on public.mm_records
  for each row execute function public.mm_records_bump();

create function public.mm_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mm_members where user_id = (select auth.uid()));
$$;

-- ใส่รหัสร้านเพื่อเข้าร่วม — ครั้งแรกสุด (ยังไม่มีรหัส) รหัสที่ใส่จะถูกตั้งเป็นรหัสร้าน
create function public.mm_join(p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  if (select auth.uid()) is null then raise exception 'not signed in'; end if;
  select code_hash into h from public.mm_shop where id = 1 for update;
  if h is null then
    if length(coalesce(p_code, '')) < 6 then raise exception 'รหัสร้านต้องยาวอย่างน้อย 6 ตัวอักษร'; end if;
    insert into public.mm_shop (id, code_hash) values (1, extensions.crypt(p_code, extensions.gen_salt('bf')));
  elsif h <> extensions.crypt(coalesce(p_code, ''), h) then
    return false;
  end if;
  insert into public.mm_members (user_id) values ((select auth.uid())) on conflict do nothing;
  return true;
end $$;

-- เปลี่ยนรหัสร้าน (อุปกรณ์ที่เข้าร่วมแล้วยังใช้งานต่อได้)
create function public.mm_set_code(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.mm_is_member() then raise exception 'not a member'; end if;
  if length(coalesce(p_code, '')) < 6 then raise exception 'รหัสร้านต้องยาวอย่างน้อย 6 ตัวอักษร'; end if;
  update public.mm_shop set code_hash = extensions.crypt(p_code, extensions.gen_salt('bf')) where id = 1;
end $$;

revoke all on function public.mm_is_member(), public.mm_join(text), public.mm_set_code(text) from public, anon;
grant execute on function public.mm_is_member(), public.mm_join(text), public.mm_set_code(text) to authenticated;
revoke all on public.mm_shop, public.mm_members, public.mm_records from anon;

create policy mm_records_member_all on public.mm_records
  for all to authenticated
  using ((select public.mm_is_member()))
  with check ((select public.mm_is_member()));

alter publication supabase_realtime add table public.mm_records;
