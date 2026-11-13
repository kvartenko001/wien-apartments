# 02 · Архитектура

```
 Браузер (GitHub Pages: kvartenko001.github.io/wien-apartments)
   index.html + app.js + style.css + config.js (публичные ключи) + data/*.json
   ├─ Mapbox GL JS v3, стиль Mapbox Standard (3D, темы), Search Box API, Geocoding v6, Directions (driving-traffic)
   ├─ WMS шумовых карт inspire.lfrz.gv.at (тайлы прямо в карту)
   └─ supabase-js → Supabase (Auth magic link, PostgREST под RLS, Edge Functions)

 Supabase «Apartment Win» (nyxvpcrftzsoprhnethq, eu-west-3 Париж) — ЛИЧНЫЙ аккаунт (не СЕНАТ!)
   Postgres + PostGIS + pg_cron + http (extensions.http_get = мост в интернет из SQL)
   Edge Functions (Deno):
     route       (JWT+member) — прокси планировщика Wiener Linien (EFA) + шум у фасада (OGC API)
     listing     (JWT+member) — разбор страницы объявления (фото, факты, описание) для просмотра внутри сайта
     refresh     (JWT+member) — «↻ Обновить»: запускает collect по выбранным районам в фоне
     collect     (ключ)       — сборщик Willhaben/ImmoScout, аренда/продажа, один район за вызов
     photos      (ключ)       — фото домов (официальный сайт + объявления)
     nightpharm  (ключ)       — дежурные аптеки (Apothekerkammer)
     route-probe              — заглушка 410 (отладочная, выключена)
   pg_cron: 46 задач аренды + 46 продажи + аптеки×2 + фото → вызывают функции через http_get

 Claude (scheduled task «Разбор новых домов», 8:13–20:13 по Вене каждые 3 ч):
   берёт дома research_status='queued' → ищет данные (≥ 2 источника) → пишет в buildings + field_sources → market_match()
```

## Почему так
- **Статический сайт + Supabase**: бесплатно, без своего сервера, RLS даёт безопасность прямо в БД.
- **Edge-функции как прокси**: у EFA Wiener Linien нет CORS; Willhaben/ImmoScout не отдаются браузеру с чужого домена; ключ сборщика не должен быть в браузере.
- **http_get из SQL** — потому что контейнер ассистента не имеет доступа к большинству сайтов, а Supabase имеет: все загрузки (Overpass, CSV Post) идут через БД.
- **Дом ≠ объявление**: дом живёт годами, объявления приходят и уходят — история по адресу копится.
- **market_listings отдельно от listings**: listings — ручные/проверенные записи; market_listings — сырой рынок, тысячи строк, своя жизнь (first_seen/last_seen/removed_at).

## Безопасность
- Все таблицы под RLS; чтение и запись — только `private.is_member()` (email из JWT в таблице `members`, у которой нет политик).
- Публичные ключи в `config.js`: Supabase publishable (без входа ничего не отдаёт), Mapbox `pk.` ограничен доменом сайта.
- Ключ сборщика — только в edge-функциях и SQL cron (в репозитории `<COLLECTOR_KEY>`). service_role — только в окружении функций.
- Временные anon-insert политики для импорта закрываются сразу после импорта (`with check (false)`).
