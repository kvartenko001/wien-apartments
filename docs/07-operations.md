# 07 · Эксплуатация

## Где что живёт
| Что | Где |
|---|---|
| Сайт | GitHub `kvartenko001/wien-apartments` (public), ветка main → GitHub Pages `https://kvartenko001.github.io/wien-apartments/` |
| База, функции, cron | Supabase проект **Apartment Win** `nyxvpcrftzsoprhnethq` (eu-west-3), **личный аккаунт** (не СЕНАТ — подключён через кастомный MCP-коннектор с project_ref) |
| Карта | Mapbox, токен «Wien Apartments» (`pk.`), ограничен доменом `kvartenko001.github.io` (по пути ограничение не работает). Для вызовов из SQL нужен заголовок Referer с этим доменом |
| Автоматический разбор домов | Claude scheduled task «Разбор новых домов (Wien apartments)», `CRON_TZ=Europe/Vienna 13 8-20/3 * * *`, пуш-уведомления |
| Документация | `docs/` в репозитории + документы claude.ai Project + папка проекта на компьютере |

## Ключи
- `config.js` (публичные, можно в репозиторий): Supabase URL + publishable key, Mapbox `pk.` токен.
- **Ключ сборщика** (`<COLLECTOR_KEY>` в репозитории): хранится только в коде edge-функций collect/photos/nightpharm/refresh и в SQL `private.collect_one` + cron.
  Посмотреть: Supabase → Edge Functions → collect → код, или `select pg_get_functiondef('private.collect_one(text,int,text)'::regprocedure)`.
  Сменить: заменить строку во всех 4 функциях и в `private.collect_one` (обе версии) и cron nightpharm/photos.
- service_role — только в окружении edge-функций (автоматически).
- Участники: таблица `members` (email, person p/a). Добавить человека = insert в `members` (через SQL под service_role).

## Деплой
- Сайт: правка файлов → поменять `?v=` у app.js/style.css в index.html (`sed -E "s/(app\.js|style\.css)\?v=[0-9]+/\1?v=$(date +%s)/g" index.html`) → commit → push. Pages обновляется за ~1 мин.
- Edge-функция: Supabase MCP `deploy_edge_function` (или `supabase functions deploy <name>`), исходники — `supabase/functions/<name>/index.ts`
  (подставить настоящий ключ вместо `<COLLECTOR_KEY>`). verify_jwt: route/listing/refresh = true; collect/photos/nightpharm = false (проверяют ключ сами).
- SQL: миграции через `apply_migration` (аддитивно! деструктивные требуют подтверждения пользователя).

## Восстановление с нуля
1. Новый проект Supabase → включить расширения postgis, http, pg_cron.
2. Выполнить `supabase/sql/01_migrations.sql`, затем `02_outside_migrations.sql` (с настоящим ключом).
3. Задеплоить 6 функций из `supabase/functions`.
4. Вставить участников в `members`, точки в `poi`.
5. Импорт линий транспорта (Overpass → transit_lines_v2), OSM POI (Overpass → ov_cache → `ov_load()`), CSV Post.
6. Дома: через сайт «Добавить дом», разбор — по правилу ≥ 2 источников.
7. В `config.js` — новые URL/ключи; Mapbox токен с ограничением на домен.
Рынок наполнится сам за первую ночь (cron).

## Мониторинг
- Запуски сборщика: `select source, district, found, error, finished_at from market_runs order by id desc limit 50;`
- Сколько объявлений: `select deal_type, count(*) from market_listings where removed_at is null group by 1;`
- Медианы: `select * from district_stats order by district;`
- Cron: `select jobname, schedule from cron.job order by jobname;` и `cron.job_run_details`.

## Расходы и лимиты
Supabase Free (500 MB БД, edge-функции 500k вызовов/мес — используем ~3k), GitHub Pages бесплатно, Mapbox Free tier (50k загрузок карты/мес).
Рост объёма: продажа ~25–30k строк + аренда ~5k в день обновлений; история цен растёт медленно. Следить за размером БД при переходе в продукт.
Сборщик и разбор домов **не тратят токены Claude** (кроме scheduled task разбора — она работает только когда в очереди есть дома).
