-- =====================================================================
-- Этап 8b — Радар новостроек. ГОТОВО К ПРИМЕНЕНИЮ (13.11.2026), ещё не применено:
-- Supabase-коннектор был недоступен. Применять через apply_migration, аддитивно.
-- =====================================================================

-- ---------- застройщики ----------
create table if not exists public.developers (
  id bigserial primary key,
  name text not null unique,
  aliases text[] default '{}',             -- как пишется в объявлениях (ORGNAME), на wiew.at, в прессе
  kind text not null default 'commercial'   -- commercial | nonprofit (gemeinnützig, WGG) | municipal (WIGEBA/Wiener Wohnen) | broker | area (Wien 3420 и т.п.)
    check (kind in ('commercial','nonprofit','municipal','broker','area')),
  tier text check (tier in ('large','mid','small')),   -- large: 10+ проектов в Вене или сотни квартир в год; mid: 3–9; small: 1–2
  website text,
  website_verified boolean default false,   -- сайт подтверждён источником (не по памяти)
  projects_page text,                       -- страница «Projekte/aktuell» для мониторинга
  wiew_slug text,                           -- /de/bautraeger/wien/<slug> на wiew.at
  wiew_projects int, wiew_avg_ppm numeric,  -- со страницы wiew.at (снимок)
  segments text[] default '{}',             -- eigentum | vorsorge | miete_frei | miete_gefoerdert | smart | luxus
  districts int[] default '{}',             -- где активен
  monitor boolean default true,             -- мониторить сайт
  notes text,
  field_sources jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table public.developers enable row level security;
create policy read_dev_co on public.developers for select to authenticated using (private.is_member());

-- ---------- проекты (расширяем dev_projects из схемы v0) ----------
alter table public.dev_projects
  add column if not exists slug text,                         -- уникальный ключ источника: 'wiew:<district>/<slug>' или 'wh:<PROJECT_ID>'
  add column if not exists source text,                       -- wiew | willhaben | developer | wohnfonds | press | manual
  add column if not exists url text,
  add column if not exists official_url text,
  add column if not exists developer_names text[] default '{}',
  add column if not exists developer_id bigint references public.developers(id) on delete set null,
  add column if not exists zip text, add column if not exists lat double precision, add column if not exists lng double precision,
  add column if not exists segment text,                      -- eigentum | vorsorge | miete | gefoerdert | gemischt
  add column if not exists units_available int, add column if not exists units_reserved int,
  add column if not exists area_min numeric, add column if not exists area_max numeric,
  add column if not exists rooms_min numeric, add column if not exists rooms_max numeric,
  add column if not exists price_min numeric, add column if not exists price_max numeric,
  add column if not exists ppm_min numeric, add column if not exists ppm_max numeric, add column if not exists ppm_median numeric,
  add column if not exists completion_year int, add column if not exists energy_class text, add column if not exists hwb numeric,
  add column if not exists amenities text[] default '{}',
  add column if not exists building_id uuid references public.buildings(id) on delete set null,
  add column if not exists first_seen timestamptz default now(), add column if not exists last_seen timestamptz default now(),
  add column if not exists removed_at timestamptz,
  add column if not exists updated_at timestamptz,
  add column if not exists raw jsonb;
create unique index if not exists dev_projects_slug_uq on public.dev_projects(slug);

-- ---------- квартиры проекта (инвентарь) — основа «скорости продаж» ----------
create table if not exists public.dev_units (
  id bigserial primary key,
  project_id uuid not null references public.dev_projects(id) on delete cascade,
  unit_ref text not null,                 -- «Top 17.59»
  floor text, orientation text, rooms numeric, area_m2 numeric, outdoor_m2 numeric,
  price numeric, ppm numeric,
  status text,                            -- available | reserved | sold | gone
  first_seen timestamptz default now(), last_seen timestamptz default now(),
  reserved_at timestamptz, gone_at timestamptz,   -- исчезла из списка = скорее всего продана
  price_history jsonb not null default '[]'::jsonb,
  unique (project_id, unit_ref)
);
alter table public.dev_units enable row level security;
create policy read_dev_units on public.dev_units for select to authenticated using (private.is_member());

create or replace function private.dev_unit_hist() returns trigger language plpgsql as $$
begin
  if new.price is distinct from old.price and old.price is not null then
    new.price_history := coalesce(old.price_history,'[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'from', old.price, 'to', new.price));
  end if;
  if new.status = 'reserved' and coalesce(old.status,'') <> 'reserved' then new.reserved_at := now(); end if;
  new.first_seen := old.first_seen;
  return new;
end $$;
drop trigger if exists dev_unit_hist on public.dev_units;
create trigger dev_unit_hist before update on public.dev_units for each row execute function private.dev_unit_hist();

-- ---------- журнал радара ----------
create table if not exists public.radar_runs (id bigserial primary key, source text, started_at timestamptz default now(),
  finished_at timestamptz, projects int, units int, error text);
alter table public.radar_runs enable row level security;
create policy read_radar_runs on public.radar_runs for select to authenticated using (private.is_member());

-- ---------- аналитика проекта ----------
-- скорость продаж: сколько квартир ушло (gone) или зарезервировано за 30 дней; «премия новостройки» к медиане продажи района
create or replace view public.dev_projects_stats with (security_invoker = true) as
select p.id, p.name, p.district, p.developer_names, p.completion_year, p.status, p.units_total, p.units_available,
  p.ppm_min, p.ppm_max, p.ppm_median, p.lat, p.lng, p.url, p.official_url, p.energy_class, p.first_seen,
  (select count(*) from public.dev_units u where u.project_id = p.id and u.gone_at > now() - interval '30 days') sold_30d,
  (select count(*) from public.dev_units u where u.project_id = p.id and u.reserved_at > now() - interval '30 days') reserved_30d,
  (select count(*) from public.dev_units u where u.project_id = p.id and jsonb_array_length(u.price_history) > 0) units_repriced,
  case when ds.buy_ppm > 0 and p.ppm_median > 0 then round(((p.ppm_median / ds.buy_ppm - 1) * 100)::numeric, 1) end premium_vs_district_pct
from public.dev_projects p left join public.district_stats ds on ds.district = p.district
where p.removed_at is null;
grant select on public.dev_projects_stats to authenticated;
