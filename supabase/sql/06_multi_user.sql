-- 06. Несколько пользователей: у каждого своё рабочее пространство (ws).
-- Общие данные (лента, радар, слои, оценка места, каталог домов) — для всех участников.
-- Личные данные (свой список домов, подборки, избранное, точки, настройки) — только своего ws.
-- Админ (role = 'admin') видит всё и выдаёт доступ.

-- 1. участники
alter table public.members
  add column if not exists ws text,
  add column if not exists role text not null default 'user',
  add column if not exists active boolean not null default true,
  add column if not exists paid_until date,
  add column if not exists max_devices int not null default 2,
  add column if not exists note text,
  add column if not exists last_seen timestamptz;
alter table public.members alter column person drop not null;
update public.members set ws = 'main' where ws is null;
update public.members set role = 'admin', max_devices = 5 where lower(email) = 'kvartenko001@gmail.com';
update public.members set max_devices = 3 where ws = 'main' and role <> 'admin';
alter table public.members alter column ws set not null;
alter table public.members enable row level security;
drop policy if exists members_self on public.members;

create or replace function private.me() returns public.members
language sql stable security definer set search_path = '' as $$
  select m from public.members m
  where lower(m.email) = lower((select auth.jwt() ->> 'email'))
    and m.active and (m.paid_until is null or m.paid_until >= current_date)
$$;
create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$ select (private.me()).email is not null $$;
create or replace function private.my_ws() returns text
language sql stable security definer set search_path = '' as $$ select (private.me()).ws $$;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce((private.me()).role = 'admin', false) $$;

create policy members_self on public.members for select using (lower(email) = lower((select auth.jwt() ->> 'email')) or private.is_admin());

-- 2. личный список домов
create table if not exists public.ws_buildings as
  select 'main'::text as ws, id as building_id, our_status, priority, interest_mode, notes, rejection_reason, created_at as added_at
  from public.buildings where research_status is distinct from 'duplicate';
alter table public.ws_buildings
  alter column ws set not null, alter column building_id set not null,
  alter column ws set default private.my_ws(),
  alter column our_status set default 'idea', alter column interest_mode set default '{rent}', alter column added_at set default now();
alter table public.ws_buildings add primary key (ws, building_id);
alter table public.ws_buildings add foreign key (building_id) references public.buildings(id) on delete cascade;
alter table public.ws_buildings enable row level security;
create policy wsb_own on public.ws_buildings for all using (ws = private.my_ws() or private.is_admin()) with check (ws = private.my_ws() or private.is_admin());

-- каталог домов: видно только свои дома (админ — все), менять — только админ и функции
drop policy if exists read_buildings on public.buildings;
drop policy if exists write_buildings on public.buildings;
create policy read_buildings on public.buildings for select using (
  private.is_admin() or exists (select 1 from public.ws_buildings w where w.building_id = buildings.id and w.ws = private.my_ws()));
create policy write_buildings on public.buildings for all using (private.is_admin()) with check (private.is_admin());

drop policy if exists read_listings on public.listings;
drop policy if exists write_listings on public.listings;
create policy read_listings on public.listings for select using (
  private.is_admin() or exists (select 1 from public.ws_buildings w where w.building_id = listings.building_id and w.ws = private.my_ws()));
create policy write_listings on public.listings for all using (private.is_admin()) with check (private.is_admin());

-- 3. подборки, избранное, точки, оценки, визиты — по ws
alter table public.building_collections add column if not exists ws text;
update public.building_collections set ws = 'main' where ws is null;
alter table public.building_collections alter column ws set not null, alter column ws set default private.my_ws();
alter table public.building_collections drop constraint if exists building_collections_pkey;
alter table public.building_collections add primary key (ws, building_id, coll);
drop policy if exists bc_del on public.building_collections;
drop policy if exists bc_ins on public.building_collections;
drop policy if exists bc_read on public.building_collections;
create policy bc_own on public.building_collections for all using (ws = private.my_ws()) with check (ws = private.my_ws());

alter table public.market_favorites add column if not exists ws text;
update public.market_favorites set ws = 'main' where ws is null;
alter table public.market_favorites alter column ws set not null, alter column ws set default private.my_ws();
drop policy if exists fav_all on public.market_favorites;
create policy fav_own on public.market_favorites for all using (ws = private.my_ws()) with check (ws = private.my_ws());

alter table public.poi add column if not exists ws text;
update public.poi set ws = 'main' where ws is null;
alter table public.poi alter column ws set not null, alter column ws set default private.my_ws();
drop policy if exists read_poi on public.poi;
create policy poi_own on public.poi for all using (ws = private.my_ws()) with check (ws = private.my_ws());
create or replace view public.poi_map with (security_invoker = true) as
  select id, label, address, owner, weight, preferred_mode, st_x(geom::geometry) as lng, st_y(geom::geometry) as lat from public.poi;

alter table public.ratings add column if not exists ws text default private.my_ws();
update public.ratings set ws = 'main' where ws is null;
drop policy if exists read_ratings on public.ratings;
drop policy if exists write_ratings on public.ratings;
create policy ratings_own on public.ratings for all using (ws = private.my_ws()) with check (ws = private.my_ws());
alter table public.visits add column if not exists ws text default private.my_ws();
update public.visits set ws = 'main' where ws is null;
drop policy if exists read_visits on public.visits;
drop policy if exists write_visits on public.visits;
create policy visits_own on public.visits for all using (ws = private.my_ws()) with check (ws = private.my_ws());

-- 4. дома на карте = только свои
create or replace view public.buildings_map with (security_invoker = true) as
 SELECT b.id, b.name, b.street, b.house_no, b.zip, b.district,
    st_x((b.geom)::geometry) AS lng, st_y((b.geom)::geometry) AS lat,
    b.building_class, b.year_built, b.floors_total, b.has_lift, b.hwb_class, b.fgee, b.garage_underground,
    b.has_gym, b.has_pool, b.has_sauna, b.has_lounge, b.has_roof_terrace, b.has_courtyard, b.has_playground, b.has_concierge,
    b.nearest_stops, w.our_status, w.priority, w.interest_mode, w.notes,
    l.cnt AS listings_active, l.min_gross AS min_rent_gross, l.min_monthly AS min_monthly_total, l.min_area AS min_area_m2, l.max_area AS max_area_m2,
    b.footprint, b.height_m, b.research_status, b.research_requested_at, b.photos
   FROM public.buildings b
     JOIN public.ws_buildings w ON w.building_id = b.id AND w.ws = private.my_ws()
     LEFT JOIN LATERAL ( SELECT count(*) AS cnt, min(x.rent_gross) AS min_gross, min(x.monthly_total) AS min_monthly, min(x.area_m2) AS min_area, max(x.area_m2) AS max_area
           FROM public.listings x
          WHERE x.building_id = b.id AND x.status = 'active'::listing_status AND x.deal_type = 'rent'::deal_type) l ON true
  WHERE b.research_status IS DISTINCT FROM 'duplicate';

-- 5. добавить дом: если он уже есть в каталоге — просто добавляем в свой список (без повторного разбора)
create or replace function public.add_building(p_name text, p_street text, p_house_no text, p_zip text, p_lng double precision, p_lat double precision,
  p_footprint jsonb default null, p_height numeric default null, p_query text default null)
returns uuid language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_id uuid; v_d int; v_ws text := private.my_ws();
  v_pt geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
begin
  if v_ws is null then raise exception 'not a member'; end if;
  select b.id into v_id from public.buildings b
   where b.research_status is distinct from 'duplicate'
     and ( st_dwithin(b.geom, v_pt, 25)
        or (b.footprint is not null and st_intersects(st_geomfromgeojson(b.footprint::text), v_pt::geometry))
        or (p_street is not null and p_house_no is not null and (
              (lower(b.street) = lower(p_street) and b.house_no = p_house_no)
              or (p_street || ' ' || p_house_no) = any(b.aliases))) )
   order by st_distance(b.geom, v_pt) limit 1;
  if v_id is null then
    v_d := case when p_zip ~ '^1\d\d0$' then substring(p_zip from 2 for 2)::int else null end;
    insert into public.buildings(name, street, house_no, zip, district, geom, footprint, height_m, footprint_source,
                                 our_status, research_status, research_requested_at, research_note, notes)
    values (nullif(p_name,''), p_street, p_house_no, p_zip, v_d, v_pt, p_footprint, p_height,
            case when p_footprint is not null then 'mapbox' end, 'idea', 'queued', now(), p_query, null)
    returning id into v_id;
  end if;
  insert into public.ws_buildings(ws, building_id, notes) values (v_ws, v_id, 'Добавлен с сайта') on conflict do nothing;
  return v_id;
end $$;
-- убрать дом из своего списка (каталог не трогаем)
create or replace function public.remove_building(p_id uuid) returns void language sql security definer set search_path = '' as $$
  delete from public.ws_buildings where ws = private.my_ws() and building_id = p_id;
$$;

-- 6. настройки пользователя (фильтры, поиски) — чтобы работали с любого устройства и были видны админу
create table if not exists public.user_settings (
  email text primary key default lower(auth.jwt() ->> 'email'),
  ws text default private.my_ws(),
  data jsonb not null default '{}',
  updated_at timestamptz not null default now());
alter table public.user_settings enable row level security;
create policy us_own on public.user_settings for all
  using (email = lower((select auth.jwt() ->> 'email')) or private.is_admin())
  with check (email = lower((select auth.jwt() ->> 'email')));

-- 7. лимит устройств: новые входы вытесняют самые старые сессии сверх лимита
create or replace function public.session_check() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me public.members := private.me(); v_uid uuid := auth.uid();
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid; v_n int; v_kicked int;
begin
  if v_me.email is null then
    return jsonb_build_object('ok', false, 'reason', 'no_access');
  end if;
  update public.members set last_seen = now() where email = v_me.email;
  with keep as (
    select id from auth.sessions where user_id = v_uid order by created_at desc limit greatest(v_me.max_devices, 1))
  delete from auth.sessions s where s.user_id = v_uid and s.id not in (select id from keep);
  get diagnostics v_kicked = row_count;
  select count(*) into v_n from auth.sessions where user_id = v_uid;
  return jsonb_build_object('ok', v_sid is null or exists (select 1 from auth.sessions where id = v_sid),
    'devices', v_n, 'max', v_me.max_devices, 'kicked', v_kicked, 'role', v_me.role, 'ws', v_me.ws, 'paid_until', v_me.paid_until);
end $$;
revoke all on function public.session_check() from public, anon;
grant execute on function public.session_check() to authenticated;

-- 8. админ: обзор участников
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = 'public', 'extensions' as $$
begin
  if not private.is_admin() then raise exception 'forbidden'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'email', m.email, 'name', m.display_name, 'ws', m.ws, 'role', m.role, 'active', m.active,
      'paid_until', m.paid_until, 'max_devices', m.max_devices, 'note', m.note, 'created_at', m.created_at, 'last_seen', m.last_seen,
      'devices', (select count(*) from auth.sessions s join auth.users u on u.id = s.user_id where lower(u.email) = lower(m.email)),
      'last_sign_in', (select max(u.last_sign_in_at) from auth.users u where lower(u.email) = lower(m.email)),
      'has_login', exists (select 1 from auth.users u where lower(u.email) = lower(m.email)),
      'houses', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', coalesce(b.name, b.street || ' ' || coalesce(b.house_no, '')), 'district', b.district, 'added', w.added_at) order by w.added_at desc), '[]')
                 from public.ws_buildings w join public.buildings b on b.id = w.building_id where w.ws = m.ws),
      'favorites', (select count(*) from public.market_favorites f where f.ws = m.ws),
      'settings', (select us.data from public.user_settings us where us.email = lower(m.email)),
      'settings_at', (select us.updated_at from public.user_settings us where us.email = lower(m.email))
    ) order by m.role, m.created_at), '[]') from public.members m);
end $$;
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

-- 9. админ: выдать / продлить / отключить (без создания логина — его делает функция admin)
create or replace function public.admin_upsert_member(p_email text, p_name text, p_ws text, p_paid_until date, p_max_devices int, p_note text, p_active boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden'; end if;
  insert into public.members(email, person, display_name, ws, role, paid_until, max_devices, note, active)
  values (lower(trim(p_email)), null, nullif(p_name, ''), coalesce(nullif(p_ws, ''), lower(trim(p_email))), 'user', p_paid_until, coalesce(p_max_devices, 2), p_note, coalesce(p_active, true))
  on conflict (email) do update set display_name = coalesce(excluded.display_name, members.display_name),
    ws = coalesce(nullif(p_ws, ''), members.ws), paid_until = excluded.paid_until,
    max_devices = excluded.max_devices, note = excluded.note, active = excluded.active;
end $$;
revoke all on function public.admin_upsert_member(text, text, text, date, int, text, boolean) from public, anon;
grant execute on function public.admin_upsert_member(text, text, text, date, int, text, boolean) to authenticated;
