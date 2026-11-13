# 03 · База данных (Supabase Postgres)

Полный SQL: `supabase/sql/01_migrations.sql` и `02_outside_migrations.sql`. Здесь — смысл.
Состояние на 13.11.2026: домов 6, объявлений рынка активных ~7 400 (аренда ~5 200 + продажа, догружается), osm_poi 2 329, дежурных аптек 32, линий транспорта 114.

## Ядро
| Таблица | Назначение | Важное |
|---|---|---|
| `buildings` | Дом/ЖК — главная сущность на карте | адрес, `geom` (PostGIS point), `footprint` (GeoJSON контур из Mapbox), `height_m`; физика (год, этажи, квартиры, лифт, HWB, fGEE, отопление, застройщик); amenities bool (подземный паркинг, зал, бассейн, сауна, лаунж, терраса, двор, площадка, велокомната, консьерж); шум; наше отношение (`our_status` idea→watching→contacted→viewed→shortlist/rejected, `rejection_reason`, `priority`, `interest_mode` rent/buy); **`field_sources`** jsonb — источник каждого поля; `research_status` (queued/done) + `research_note`; `photos` jsonb [{url,source,page,desc}] |
| `listings` | Ручные/проверенные объявления, привязаны к дому | деньги аренды (net, BK, USt, **gross**), Kaution, Provision, Ablöse; три кошелька: `heating_est`, `utilities_est`, `internet_est`, `garage_cost` → **`monthly_total`** (generated), `setup_sunk`, `furnishing_est` + `furnishing_recovery_pct` (40%); юр. флаги (befristet, режим MRG, животные); поля покупки; `fairness_score`, `fit_score` (пока пустые) |
| `market_listings` | Весь рынок из сборщика | `source`+`ext_id` уникальны; адрес, `district`, `lat/lng`, `price`, `area_m2`, `rooms`, `is_private`, `published_at`, `first_seen`, `last_seen`, **`removed_at`** (снято), **`price_history`** [{at,from,to}] (триггер), `building_id` (сопоставление), **`deal_type`** rent/buy, `raw` (address, image, floor, **project_id**, org, free_area, badges) |
| `market_favorites` | Избранное (★) | (user_id, listing_id) |
| `market_runs` | Журнал запусков сборщика | source (`willhaben`, `immoscout:buy`…), district, found, error |
| `members` | Белый список (2 email) | политик нет — читает только `private.is_member()` |

## Окружение
| Таблица | Назначение |
|---|---|
| `poi` (+ view `poi_map`) | Наши точки: работа (он), работа (Ариша), зал; owner p/a/both |
| `transit_lines_v2` | Линии U/S/трам/автобус из OSM, одно направление на линию (`transit_lines` — старая, двоилась) |
| `osm_poi` | Супермаркеты (бренды), аптеки, почта (официальный CSV Post + OSM), посылочные боксы |
| `night_pharmacy` | Дежурные аптеки сейчас (обновление 2×/день) |
| `price_history`, `commute`, `ratings`, `visits`, `district_benchmarks`, `poi_proximity`, `dev_projects` | Заложены в схеме v0; часть пока пустая. `dev_projects` — основа радара новостроек |
| `private.ov_cache`, `private.post_csv`, `private.fill_queue` | Служебные: сырые ответы Overpass/CSV, очередь разовой догрузки |

## Представления
- `buildings_map` — дома для карты: lng/lat числами, факты, контур, фото, сводка по активным объявлениям (rent).
- `district_stats` — **медианы €/м² по районам**: `rent_ppm`, `rent_n`, `buy_ppm`, `buy_n`, `buy_p25`, `buy_p75` (из живых market_listings; отсечка выбросов: аренда 5–60 €/м², продажа 1 500–30 000 €/м², площадь ≥ 20 м²).
- `cost_summary` — справочные средние по срокам 12/24/36/60 мес (три кошелька).
- `listings_enriched` — + `days_online`.

## Функции
| Функция | Кто вызывает | Что делает |
|---|---|---|
| `private.is_member()` | все политики RLS | email из JWT есть в `members` |
| `public.add_building(...)` | сайт («Добавить дом», «Отслеживать этот дом») | создаёт дом с контуром, `research_status='queued'` |
| `public.market_match()` | collect (service_role) | привязывает объявления к домам: улица+номер (или ≤150 м без номера) ИЛИ название ЖК в заголовке + индекс + ≤350 м |
| `public.market_rematch()` | сайт (участник) | то же по кнопке |
| `private.market_price_hist()` | триггер | при смене цены дописывает {at,from,to}, сохраняет first_seen |
| `private.collect_one(src, d[, deal])` | cron | http_get → edge `collect`; ошибки → market_runs |
| `private.fill_step()` | cron `fill-buy` | разовая догрузка по очереди, снимает себя |
| `private.ov_load()` | вручную | разбор Overpass JSON → osm_poi с нормализацией брендов |

## Расписание (pg_cron, UTC)
| Задачи | Когда | Что |
|---|---|---|
| `collect-buy-<src>-<1..23>` (46) | 01:00–03:18, шаг 3 мин | продажа |
| `collect-<src>-<1..23>` (46) | с 04:02, шаг 2 мин | аренда |
| `photos-daily` | 06:17 | фото домов |
| `nightpharm-am/pm` | 06:47, 15:43 | дежурные аптеки |
| `fill-buy` | каждые 3 мин до опустошения очереди | разовая догрузка продажи (13.11.2026) |
