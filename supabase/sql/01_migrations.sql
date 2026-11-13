-- =====================================================================
-- Wien Apartments — история миграций Supabase (проект nyxvpcrftzsoprhnethq, eu-west-3)
-- Выгружено из supabase_migrations.schema_migrations 13.11.2026.
-- Ключ сборщика заменён на <COLLECTOR_KEY> (настоящий — только в Supabase).
-- Порядок применения = порядок в файле. Объекты, созданные вне миграций, — в 02_outside_migrations.sql
-- =====================================================================

-- ---------- 01_extensions_and_enums (20261112182137) ----------
create extension if not exists postgis with schema extensions;
create type building_class  as enum ('altbau','neubau','other');
create type our_status      as enum ('idea','watching','contacted','viewed','shortlist','rejected');
create type deal_type       as enum ('rent','buy');
create type listing_status  as enum ('active','gone','reserved','unknown');
create type listing_source  as enum ('willhaben','immoscout','derstandard','developer','manual','other');
create type furnished_state as enum ('empty','kitchen_only','partial','full');
create type rent_regime     as enum ('richtwert','kategorie','frei','gemeinnuetzig','unknown');
create type outdoor_type    as enum ('none','balkon','terrasse','loggia','garten');
create type person_ref      as enum ('p','a');
create type poi_owner       as enum ('p','a','both');
create type travel_mode     as enum ('transit','walk','bike','car');
create type dev_status      as enum ('announced','planning','under_construction','completed');
create type poi_kind        as enum ('supermarket','discounter','organic','pharmacy','bakery',
  'gas_station','dog_zone','playground','park','school','kindergarten','transit_stop');

-- ---------- 02_buildings_and_listings (20261112182207) ----------
create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  name text, aliases text[] default '{}', street text, house_no text, zip text,
  district int check (district between 1 and 23),
  geom extensions.geography(Point,4326), osm_building_id text, official_url text,
  building_class building_class, year_built int, renovated boolean default false, renovation_year int,
  floors_total int, units_total int, has_lift boolean, heating_type text,
  hwb_kwh_m2a numeric(6,2), hwb_class text, fgee numeric(4,2), developer text,
  garage_underground boolean default false, garage_price_month numeric(8,2), parking_outdoor boolean default false,
  has_gym boolean default false, has_pool boolean default false, has_sauna boolean default false,
  has_lounge boolean default false, has_roof_terrace boolean default false, has_courtyard boolean default false,
  has_playground boolean default false, has_bike_room boolean default false, has_concierge boolean default false,
  noise_lden_db numeric(5,2), noise_night_db numeric(5,2), green_nearest_m int, green_nearest_name text,
  nearest_stops jsonb default '[]'::jsonb, transit_score numeric(5,2),
  construction_nearby boolean default false, construction_note text, flood_zone boolean default false,
  our_status our_status default 'idea', rejection_reason text,
  priority int check (priority between 1 and 3), interest_mode deal_type[] default '{rent}', notes text,
  field_sources jsonb default '{}'::jsonb,   -- провенанс по полям: {"year_built":{"url":"...","fetched":"2026-11-12"}}
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index buildings_geom_idx on public.buildings using gist (geom);
create index buildings_district_idx on public.buildings (district);
create index buildings_status_idx on public.buildings (our_status);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  source listing_source not null default 'manual', source_listing_id text, url text,
  deal_type deal_type not null default 'rent', status listing_status not null default 'active',
  published_at date, first_seen timestamptz default now(), last_checked timestamptz,
  area_m2 numeric(7,2), rooms numeric(3,1), floor int, orientation text,
  outdoor outdoor_type default 'none', outdoor_m2 numeric(6,2), furnished furnished_state default 'empty',
  rent_net numeric(10,2), betriebskosten numeric(10,2), ust_pct numeric(5,2) default 10, rent_gross numeric(10,2),
  heating_included boolean, kaution_months numeric(4,1), kaution_amount numeric(10,2),
  provision_months numeric(4,1), provisionsfrei boolean default false, ablose_amount numeric(10,2), furnishing_est numeric(10,2),
  befristet boolean, befristet_years numeric(4,1), regime rent_regime default 'unknown', pets_allowed boolean, mrg_note text,
  purchase_price numeric(12,2), nebenkosten_pct numeric(5,2) default 9.6, "betriebskosten_月" numeric(10,2), ruecklage numeric(10,2),
  price_per_m2 numeric(10,2) generated always as (case when area_m2 > 0 then rent_gross / area_m2 end) stored,
  true_monthly_cost numeric(10,2), fairness_score numeric(5,2), fit_score numeric(5,2),
  photo_links jsonb default '[]'::jsonb,   -- только ссылки, не копии
  raw jsonb default '{}'::jsonb,           -- сырой блок источника
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (source, source_listing_id)
);
create index listings_building_idx on public.listings (building_id);
create index listings_status_idx on public.listings (status);
create index listings_deal_idx on public.listings (deal_type);

-- ---------- 03_fix_column_typo ----------
alter table public.listings rename column "betriebskosten_月" to betriebskosten_monthly;

-- ---------- 04_supporting_tables ----------
create table public.price_history (id bigserial primary key,
  listing_id uuid not null references public.listings(id) on delete cascade,
  observed_at timestamptz not null default now(), price numeric(12,2), status listing_status);
create index price_history_listing_idx on public.price_history (listing_id, observed_at desc);

create table public.poi (id uuid primary key default gen_random_uuid(), label text not null, address text,
  geom extensions.geography(Point,4326) not null, owner poi_owner not null default 'both',
  weight numeric(4,2) default 1.0, preferred_mode travel_mode default 'transit', created_at timestamptz default now());
create index poi_geom_idx on public.poi using gist (geom);

create table public.commute (building_id uuid not null references public.buildings(id) on delete cascade,
  poi_id uuid not null references public.poi(id) on delete cascade, mode travel_mode not null,
  minutes numeric(6,2), transfers int, route_note text, computed_at timestamptz default now(),
  primary key (building_id, poi_id, mode));

create table public.ratings (id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('building','listing')), subject_id uuid not null,
  person person_ref not null, score int check (score between 1 and 10), criteria_scores jsonb default '{}'::jsonb,
  notes text, rated_at timestamptz default now(), unique (subject_type, subject_id, person));

create table public.visits (id uuid primary key default gen_random_uuid(),
  building_id uuid references public.buildings(id) on delete set null, listing_id uuid references public.listings(id) on delete set null,
  visited_on date, agent_name text, agent_contact text, impression text, verdict text,
  photo_links jsonb default '[]'::jsonb, created_at timestamptz default now());

create table public.district_benchmarks (id bigserial primary key, district int not null check (district between 1 and 23),
  deal_type deal_type not null, period text not null, median_eur_m2 numeric(8,2), p25_eur_m2 numeric(8,2), p75_eur_m2 numeric(8,2),
  sample_n int, source text, collected_at timestamptz default now(), unique (district, deal_type, period));

create table public.poi_proximity (id bigserial primary key, building_id uuid not null references public.buildings(id) on delete cascade,
  kind poi_kind not null, brand text, name text, distance_m int, walk_min numeric(5,1), computed_at timestamptz default now());
create index poi_proximity_building_idx on public.poi_proximity (building_id, kind);

create table public.dev_projects (id uuid primary key default gen_random_uuid(), name text not null,
  district int check (district between 1 and 23), address text, geom extensions.geography(Point,4326), developer text,
  status dev_status default 'announced', expected_completion text, units_total int, price_from_eur_m2 numeric(10,2),
  infra_catalysts text[] default '{}', thesis text, confidence int check (confidence between 1 and 5), source_url text,
  created_at timestamptz default now());
create index dev_projects_geom_idx on public.dev_projects using gist (geom);

-- ---------- 05_rls_triggers_views ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql security invoker set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger buildings_touch before update on public.buildings for each row execute function public.touch_updated_at();
create trigger listings_touch before update on public.listings for each row execute function public.touch_updated_at();

create or replace view public.listings_enriched with (security_invoker = true) as
select l.*,
  case when l.published_at is not null then (current_date - l.published_at) end as days_online,
  case when l.rent_gross > 0 and l.true_monthly_cost is not null then round((l.true_monthly_cost / l.rent_gross - 1) * 100, 1) end as hidden_cost_pct
from public.listings l;

alter table public.buildings enable row level security;  alter table public.listings enable row level security;
alter table public.price_history enable row level security; alter table public.poi enable row level security;
alter table public.commute enable row level security;  alter table public.ratings enable row level security;
alter table public.visits enable row level security;   alter table public.district_benchmarks enable row level security;
alter table public.poi_proximity enable row level security; alter table public.dev_projects enable row level security;
-- (политики read_* / write_* созданы здесь, в 07 переведены на private.is_member())

-- ---------- 06_money_buckets_additive — три кошелька ----------
alter table public.listings
  add column heating_est numeric(10,2), add column utilities_est numeric(10,2), add column internet_est numeric(10,2),
  add column garage_cost numeric(10,2), add column setup_sunk numeric(10,2),
  add column furnishing_recovery_pct numeric(5,2) default 40,
  add column monthly_total numeric(12,2) generated always as (
    coalesce(rent_gross,0)+coalesce(heating_est,0)+coalesce(utilities_est,0)+coalesce(internet_est,0)+coalesce(garage_cost,0)) stored;
-- true_monthly_cost — УСТАРЕЛО (старая модель с мебелью внутри аренды)
create view public.cost_summary with (security_invoker = true) as
select l.id listing_id, l.building_id, b.name building_name, l.area_m2, l.rooms, l.rent_gross, l.monthly_total,
  coalesce(l.setup_sunk,0) setup_sunk, coalesce(l.furnishing_est,0) setup_furnishing, coalesce(l.kaution_amount,0) deposit_returnable,
  coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0) setup_total,
  coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0)*(1-coalesce(l.furnishing_recovery_pct,40)/100) setup_net_of_resale,
  round(l.monthly_total+(coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0)*(1-coalesce(l.furnishing_recovery_pct,40)/100))/12,0) avg_12m,
  round(l.monthly_total+(coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0)*(1-coalesce(l.furnishing_recovery_pct,40)/100))/24,0) avg_24m,
  round(l.monthly_total+(coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0)*(1-coalesce(l.furnishing_recovery_pct,40)/100))/36,0) avg_36m,
  round(l.monthly_total+(coalesce(l.setup_sunk,0)+coalesce(l.furnishing_est,0)*(1-coalesce(l.furnishing_recovery_pct,40)/100))/60,0) avg_60m,
  case when l.published_at is not null then (current_date - l.published_at) end days_online
from public.listings l join public.buildings b on b.id = l.building_id;

-- ---------- 07_map_view_and_members + 08_move_is_member_private ----------
create table public.members (email text primary key, person person_ref not null, display_name text, created_at timestamptz default now());
alter table public.members enable row level security;  -- политик нет намеренно
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.is_member() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where lower(m.email) = lower((select auth.jwt() ->> 'email'))); $$;
revoke all on function private.is_member() from public, anon;
grant execute on function private.is_member() to authenticated;
-- Все read_* политики: for select to authenticated using (private.is_member())
-- write_buildings / write_listings / write_ratings / write_visits: for all to authenticated using/with check (private.is_member())

-- ---------- 09_poi_map_view ----------
create view public.poi_map with (security_invoker = true) as
select id, label, address, owner, weight, preferred_mode,
  extensions.st_x(geom::extensions.geometry) lng, extensions.st_y(geom::extensions.geometry) lat from public.poi;

-- ---------- 10_building_footprints ----------
alter table public.buildings add column footprint jsonb, add column height_m numeric(6,1), add column footprint_source text;
-- footprint: GeoJSON Polygon/MultiPolygon из той же геометрии, что рисует Mapbox

-- ---------- 11–14 transit_lines → transit_lines_v2 (одно направление на линию) ----------
create table public.transit_lines (id bigserial primary key, mode text not null check (mode in ('subway','tram','sbahn','bus')),
  ref text not null, colour text, geom jsonb not null, source text default 'OpenStreetMap contributors (ODbL), via Overpass',
  imported_at timestamptz default now(), unique (mode, ref));
create table public.transit_lines_v2 (like public.transit_lines including all);
alter table public.transit_lines enable row level security; alter table public.transit_lines_v2 enable row level security;
create policy read_transit_v2 on public.transit_lines_v2 for select to authenticated using (private.is_member());
-- временные anon-insert политики для импорта из браузера закрыты (with check (false)) сразу после импорта

-- ---------- 15_http_extension_for_data_fetch ----------
create extension if not exists http with schema extensions;   -- мост в интернет из SQL

-- ---------- 16_add_building_queue + 17_buildings_map_research_cols ----------
alter table public.buildings add column if not exists research_status text not null default 'done',
  add column if not exists research_requested_at timestamptz, add column if not exists research_note text;

create or replace function public.add_building(p_name text, p_street text, p_house_no text, p_zip text,
  p_lng double precision, p_lat double precision, p_footprint jsonb default null, p_height numeric default null, p_query text default null)
returns uuid language plpgsql security invoker set search_path = public, extensions as $$
declare v_id uuid; v_d int;
begin
  if not private.is_member() then raise exception 'not a member'; end if;
  v_d := case when p_zip ~ '^1\d\d0$' then substring(p_zip from 2 for 2)::int else null end;
  insert into public.buildings(name, street, house_no, zip, district, geom, footprint, height_m, footprint_source,
                               our_status, research_status, research_requested_at, research_note, notes)
  values (nullif(p_name,''), p_street, p_house_no, p_zip, v_d,
          extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography,
          p_footprint, p_height, case when p_footprint is not null then 'mapbox' end,
          'idea', 'queued', now(), p_query, 'Добавлен с сайта — ждёт разбора')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.add_building(text,text,text,text,double precision,double precision,jsonb,numeric,text) to authenticated;
-- buildings_map: см. актуальную версию в 02_outside_migrations.sql (с photos и research-колонками)

-- ---------- 18_market_listings — рынок целиком ----------
create table if not exists public.market_listings (
  id bigserial primary key, source text not null, ext_id text not null, url text, title text,
  street text, house_no text, zip text, district int, lng double precision, lat double precision,
  price numeric, area_m2 numeric, rooms numeric, is_private boolean, published_at timestamptz,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), removed_at timestamptz,
  price_history jsonb not null default '[]'::jsonb,
  building_id uuid references public.buildings(id) on delete set null, raw jsonb,
  unique (source, ext_id));
create index if not exists market_listings_district_idx on public.market_listings(district) where removed_at is null;
create index if not exists market_listings_building_idx on public.market_listings(building_id);
create table if not exists public.market_favorites (user_id uuid not null default auth.uid(),
  listing_id bigint not null references public.market_listings(id) on delete cascade, note text,
  created_at timestamptz not null default now(), primary key (user_id, listing_id));
create table if not exists public.market_runs (id bigserial primary key, source text, district int,
  started_at timestamptz default now(), finished_at timestamptz, found int, inserted int, error text);
alter table public.market_listings enable row level security; alter table public.market_favorites enable row level security;
alter table public.market_runs enable row level security;
create policy read_market on public.market_listings for select to authenticated using (private.is_member());
create policy read_runs on public.market_runs for select to authenticated using (private.is_member());
create policy fav_all on public.market_favorites for all to authenticated using (private.is_member()) with check (private.is_member());

create or replace function private.market_price_hist() returns trigger language plpgsql as $$
begin
  if new.price is distinct from old.price and old.price is not null then
    new.price_history := coalesce(old.price_history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'from', old.price, 'to', new.price));
  end if;
  new.first_seen := old.first_seen;
  return new;
end $$;
create trigger market_price_hist before update on public.market_listings for each row execute function private.market_price_hist();

-- ---------- 19_cron_collect ----------
create extension if not exists pg_cron;
create or replace function private.collect_one(p_source text, p_district int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '150');
  select content into r from extensions.http_get(
    'https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/collect?key=<COLLECTOR_KEY>&source=' || p_source || '&district=' || p_district);
  return r;
exception when others then
  insert into public.market_runs(source, district, finished_at, error) values (p_source, p_district, now(), sqlerrm);
  return sqlerrm;
end $$;
revoke all on function private.collect_one(text,int) from public;
-- cron-задачи collect-<source>-<district> — см. 02_outside_migrations.sql (сейчас 23 района × 2 сайта × аренда/продажа)

-- ---------- 20_market_match_stricter — сопоставление объявлений с нашими домами ----------
create or replace function public.market_match() returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  with b as (
    select id, lower(regexp_replace(coalesce(street,''), 'stra(ss|ß)e', 'str', 'gi')) st, lower(coalesce(house_no,'')) hn, zip,
           geom, array_append(coalesce(aliases,'{}'), name) names
    from buildings),
  m as (
    select distinct on (ml.id) ml.id mid, b.id bid
    from market_listings ml join b on (
      -- 1) та же улица + тот же номер дома (или без номера, но ≤150 м)
      (lower(regexp_replace(coalesce(ml.street,''), 'stra(ss|ß)e', 'str', 'gi')) = b.st and b.st <> '' and
        ( (ml.house_no is not null and lower(ml.house_no) = b.hn)
          or (ml.house_no is null and ml.lat is not null and st_dwithin(b.geom, st_setsrid(st_makepoint(ml.lng, ml.lat),4326)::geography, 150)) ))
      -- 2) название ЖК в заголовке + тот же индекс + ≤350 м («Grünblick» — ещё и обычное слово)
      or (ml.zip = b.zip and ml.lat is not null
          and st_dwithin(b.geom, st_setsrid(st_makepoint(ml.lng, ml.lat),4326)::geography, 350)
          and exists (select 1 from unnest(b.names) nm where length(nm) >= 5 and position(lower(nm) in lower(ml.title)) > 0))
    )
    where ml.building_id is null
    order by ml.id)
  update market_listings ml set building_id = m.bid from m where ml.id = m.mid;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.market_match() from public, anon, authenticated;
grant execute on function public.market_match() to service_role;

-- ---------- buy_mode_collect_stats (20261113100641) ----------
create or replace function private.collect_one(p_source text, p_district integer, p_deal text)
 returns text language plpgsql security definer set search_path to 'public','extensions' as $f$
declare r text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '200');
  select content into r from extensions.http_get(
    'https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/collect?key=<COLLECTOR_KEY>&source='
    || p_source || '&district=' || p_district || '&deal=' || coalesce(p_deal,'rent'));
  return r;
exception when others then
  insert into public.market_runs(source, district, finished_at, error) values (p_source||':'||p_deal, p_district, now(), sqlerrm);
  return sqlerrm;
end $f$;
revoke all on function private.collect_one(text,integer,text) from public, anon, authenticated;

-- разовая догрузка продажи по всем районам: очередь + шаг каждые 3 минуты, задача сама себя снимает
create table if not exists private.fill_queue(id serial primary key, source text, district int, deal text);
create or replace function private.fill_step() returns void language plpgsql security definer set search_path to 'public','extensions' as $f$
declare q record;
begin
  delete from private.fill_queue where id = (select min(id) from private.fill_queue) returning * into q;
  if q is null then perform cron.unschedule('fill-buy'); return; end if;
  perform private.collect_one(q.source, q.district, q.deal);
end $f$;

-- медианы €/м² по районам (аренда и продажа) — основа «% к району», доходности и fairness
create or replace view public.district_stats with (security_invoker = true) as
with x as (
  select district, deal_type, price / nullif(area_m2,0) ppm
  from public.market_listings
  where removed_at is null and price > 0 and area_m2 >= 20
    and ((deal_type='rent' and price/area_m2 between 5 and 60) or (deal_type='buy' and price/area_m2 between 1500 and 30000))
)
select district,
  percentile_cont(0.5)  within group (order by ppm) filter (where deal_type='rent') rent_ppm,
  count(*) filter (where deal_type='rent') rent_n,
  percentile_cont(0.5)  within group (order by ppm) filter (where deal_type='buy') buy_ppm,
  count(*) filter (where deal_type='buy') buy_n,
  percentile_cont(0.25) within group (order by ppm) filter (where deal_type='buy') buy_p25,
  percentile_cont(0.75) within group (order by ppm) filter (where deal_type='buy') buy_p75
from x group by district;
grant select on public.district_stats to authenticated;
