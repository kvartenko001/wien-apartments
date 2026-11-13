-- =====================================================================
-- Объекты, созданные через execute_sql (вне миграций) — реконструкция по каталогу БД, 13.11.2026.
-- При восстановлении с нуля применять после 01_migrations.sql.
-- =====================================================================

-- ---------- рынок: тип сделки (аренда/продажа) ----------
alter table public.market_listings add column if not exists deal_type text not null default 'rent';
create index if not exists market_listings_deal_idx on public.market_listings(deal_type) where removed_at is null;
-- market_listings.raw (jsonb): address, image, floor, project_id (Willhaben PROJECT_ID → новостройка), org (ORGNAME), free_area, badges (ImmoScout)

-- ---------- фото домов ----------
alter table public.buildings add column if not exists photos jsonb;   -- [{url, source, page, desc}], до 30 шт.

-- ---------- актуальная выдача для карты ----------
-- buildings_map = все поля 17_buildings_map_research_cols + b.photos + research-колонки (research_status, research_requested_at, research_note),
-- official_url, developer, units_total, hwb_kwh_m2a, field_sources и т.п. — пересоздавалась несколько раз; брать за основу 17 и добавлять колонки buildings.

-- ---------- «рядом с домом»: точки из OSM + официальных списков ----------
create table if not exists public.osm_poi (
  osm_id text primary key,            -- 'node/123' / 'way/…' для OSM, 'post/<id>' для официального списка Post
  kind text,                          -- shop | pharmacy | post | locker
  brand text,                         -- Billa, Billa Plus, Spar, Eurospar, Interspar, Spar Gourmet, Hofer, Penny, Lidl, Другие;
                                      -- для боксов: Post, myflexbox, Amazon, Hermes PaketShop, DPD, GLS, DHL, Другие;
                                      -- для почты: Postfiliale, Post Partner
  name text, lng double precision, lat double precision,
  opening_hours text, operator text, updated_at timestamptz default now());
alter table public.osm_poi enable row level security;
create policy read_poi on public.osm_poi for select to authenticated using (private.is_member());

create table if not exists public.night_pharmacy (   -- дежурные аптеки, обновляет edge-функция nightpharm
  name text, address text, phone text, lat double precision, lng double precision,
  duty text,                          -- «Fr 13.11. 08:00 – Sa 14.11. 08:00» (из «Bereitschaft von …»)
  fetched_at timestamptz default now());
alter table public.night_pharmacy enable row level security;
create policy read_np on public.night_pharmacy for select to authenticated using (private.is_member());

-- сырые ответы Overpass и CSV Post (загружаются через extensions.http_get, разбираются SQL-ом)
create table if not exists private.ov_cache (id serial primary key, c text, fetched timestamptz default now());
create table if not exists private.post_csv (id serial primary key, c text);

create or replace function private.ov_load() returns integer language plpgsql as $function$
declare n int;
begin
with e as (select x from private.ov_cache, jsonb_array_elements(c::jsonb->'elements') x where left(c,1)='{'),
p as (select (x->>'type')||'/'||(x->>'id') osm_id, x->'tags' t,
   coalesce((x->>'lon')::float8, (x->'center'->>'lon')::float8) lng, coalesce((x->>'lat')::float8, (x->'center'->>'lat')::float8) lat from e),
k as (select osm_id, t, lng, lat,
  case when t->>'shop'='supermarket' then 'shop' when t->>'amenity'='pharmacy' then 'pharmacy'
       when t->>'amenity'='post_office' then 'post' else 'locker' end kind,
  lower(coalesce(t->>'brand','') || ' ' || coalesce(t->>'name','') || ' ' || coalesce(t->>'operator','')) s from p)
insert into public.osm_poi(osm_id, kind, brand, name, lng, lat, opening_hours, operator)
select osm_id, kind,
 case kind
  when 'shop' then case
    when s ~ 'billa plus|billa\+|merkur' then 'Billa Plus' when s ~ 'billa' then 'Billa'
    when s ~ 'interspar' then 'Interspar' when s ~ 'eurospar' then 'Eurospar' when s ~ 'spar gourmet' then 'Spar Gourmet'
    when s ~ '\mspar\M' then 'Spar' when s ~ 'hofer' then 'Hofer' when s ~ 'penny' then 'Penny' when s ~ 'lidl' then 'Lidl'
    else 'Другие' end
  when 'locker' then case
    when s ~ 'dhl' then 'DHL' when s ~ 'dpd' then 'DPD' when s ~ 'gls' then 'GLS' when s ~ 'amazon' then 'Amazon'
    when s ~ 'myflexbox|flexbox' then 'myflexbox' when s ~ 'post' then 'Post' else 'Другие' end
  when 'post' then case when s ~ 'partner' or t->>'post_office'='post_partner' then 'Post Partner' else 'Postfiliale' end
  else null end,
 t->>'name', lng, lat, t->>'opening_hours', t->>'operator'
from k where lng is not null
on conflict (osm_id) do update set kind=excluded.kind, brand=excluded.brand, name=excluded.name, lng=excluded.lng, lat=excluded.lat,
  opening_hours=excluded.opening_hours, operator=excluded.operator, updated_at=now();
get diagnostics n = row_count; return n; end $function$;

-- ---------- пересопоставление по кнопке из интерфейса (только участники) ----------
create or replace function public.market_rematch() returns integer language plpgsql security definer
set search_path to 'public','extensions' as $function$
begin
  if not private.is_member() then raise exception 'not a member'; end if;
  return public.market_match();
end $function$;
grant execute on function public.market_rematch() to authenticated;

-- ---------- расписание (pg_cron, время UTC; Вена = UTC+1 зимой, +2 летом) ----------
-- Аренда: 46 задач collect-<willhaben|immoscout>-<1..23>, утром с 04:02 UTC с шагом 2 мин:
--   select private.collect_one('<source>', <district>);
-- Продажа: 46 задач collect-buy-<source>-<district>, с 01:00 UTC с шагом 3 мин (до ~03:18):
--   select private.collect_one('<source>', <district>, 'buy');
-- Восстановить продажу:
do $$
declare d int; s text; i int := 0; m int;
begin
  for d in 1..23 loop foreach s in array array['willhaben','immoscout'] loop
    m := 60 + i*3;
    perform cron.schedule(format('collect-buy-%s-%s', s, d), format('%s %s * * *', m % 60, m / 60),
      format($q$select private.collect_one(%L, %s, 'buy')$q$, s, d));
    i := i + 1;
  end loop; end loop;
end $$;
-- Восстановить аренду (порядок: по району, оба сайта; 04:02 UTC + 2 мин на задачу):
do $$
declare d int; s text; i int := 0; m int;
begin
  for d in 1..23 loop foreach s in array array['willhaben','immoscout'] loop
    m := 4*60 + 2 + i*2;
    perform cron.schedule(format('collect-%s-%s', s, d), format('%s %s * * *', m % 60, m / 60),
      format($q$select private.collect_one(%L, %s)$q$, s, d));
    i := i + 1;
  end loop; end loop;
end $$;
-- Дежурные аптеки (дважды в день) и фото домов (каждое утро):
select cron.schedule('nightpharm-am', '47 6 * * *',
  $$select extensions.http_set_curlopt('CURLOPT_TIMEOUT','100'); select extensions.http_get('https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/nightpharm?key=<COLLECTOR_KEY>')$$);
select cron.schedule('nightpharm-pm', '43 15 * * *',
  $$select extensions.http_set_curlopt('CURLOPT_TIMEOUT','100'); select extensions.http_get('https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/nightpharm?key=<COLLECTOR_KEY>')$$);
select cron.schedule('photos-daily', '17 6 * * *',
  $$select extensions.http_set_curlopt('CURLOPT_TIMEOUT','150'); select extensions.http_get('https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/photos?key=<COLLECTOR_KEY>')$$);

-- ---------- 13.11.2026 вечер: радар новостроек (миграции 21_market_match_street_norm, 22_radar_schema применены) ----------
-- private.norm_street(text): «Dresdnerstraße» = «Dresdner Straße», «Doktor-…» = «Dr.-…» (используется в market_match)
create or replace function private.radar_call(p_mode text, p_n int default 40) returns text language plpgsql security definer set search_path to 'public','extensions' as $f$
declare r text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '280');
  select content into r from extensions.http_get('https://nyxvpcrftzsoprhnethq.supabase.co/functions/v1/radar?key=<COLLECTOR_KEY>&mode=' || p_mode || '&n=' || p_n);
  return r;
exception when others then
  insert into public.radar_runs(source, finished_at, error) values ('wiew:' || p_mode, now(), sqlerrm);
  return sqlerrm;
end $f$;
select cron.schedule('radar-list', '40 0 * * *', $$select private.radar_call('list')$$);          -- каталог wiew.at раз в день
select cron.schedule('radar-detail', '*/10 0-4 * * *', $$select private.radar_call('detail', 30)$$);  -- карточки и квартиры, ~750 за ночь
-- radar-fill: разовая догрузка каждые 4 мин, снимает себя (private.radar_fill)
