# 04 · Источники данных

Правило проекта: **важное поле дома — минимум из двух независимых источников**, источники пишутся в `buildings.field_sources`.
Фото и тексты объявлений — чужая собственность: храним ссылки, показываем со ссылкой на источник.

## Рынок
### Willhaben (willhaben.at) — работает с сервера Supabase
- Аренда: `https://www.willhaben.at/iad/immobilien/mietwohnungen/wien/wien-1XX0-<slug>?rows=90&page=N&PRICE_TO=2200&ESTATE_SIZE/LIVING_AREA_FROM=38`
- Продажа: `.../iad/immobilien/eigentumswohnung/wien/wien-1XX0-<slug>?rows=90&page=N&PRICE_TO=1500000&ESTATE_SIZE/LIVING_AREA_FROM=30`
- Slug районов: innere-stadt, leopoldstadt, landstrasse, wieden, margareten, mariahilf, neubau, josefstadt, alsergrund, favoriten, simmering,
  meidling, hietzing, penzing, rudolfsheim-fuenfhaus, ottakring, hernals, waehring, doebling, brigittenau, floridsdorf, donaustadt, liesing.
- Данные: `<script id="__NEXT_DATA__">` → `props.pageProps.searchResult.advertSummaryList.advertSummary[]`, `rowsFound` — всего.
  Атрибуты `attributes.attribute[] {name, values[0]}`: `HEADING`, `PRICE`, `ESTATE_SIZE/LIVING_AREA`, `NUMBER_OF_ROOMS`, `ADDRESS`, `POSTCODE`,
  `COORDINATES` ("lat,lng"), `SEO_URL`, `ISPRIVATE`, `PUBLISHED_String`, `MMO` (картинка), `FLOOR`, **`PROJECT_ID`** (объявление из проекта застройщика = новостройка),
  `ORGNAME` (агентство/застройщик), `FREE_AREA_TYPE_NAME`, `PRICE/SQUARE_METER`.
- Страница объявления: `__NEXT_DATA__` → `props.pageProps.advertDetails` (attributes, `advertImageList.advertImage[]` mainImageUrl, `equipmentList`, описание).
- Пагинация до 8 стр. (аренда) / 30 стр. (продажа), пауза 700/350 мс. Объём: Фаворитен продажа ~2 100.

### ImmoScout24 (immobilienscout24.at)
- `https://www.immobilienscout24.at/regional/wien/wien/<n>-bezirk-<slug>/wohnung-mieten|wohnung-kaufen[/seite-N]`
- Данные: `window.__INITIAL_STATE__=` — после объекта идёт ещё JS, поэтому вырезаем объект **сбалансированными скобками** (`jsonAt`), `:undefined` → `:null`.
  Хиты — массивы объектов с `exposeId`: `addressString`, `primaryPrice`, `primaryArea`, `numberOfRooms`, `location.{lat,lon}`, `dateCreated`,
  `headline`, `links.absoluteURL`, `isPrivate`, `typedBadges`; `meta.hasChildren` = проект с подобъявлениями (пропускаем). `totalPages` — конец.

### Дедупликация между сайтами (в браузере)
Ключ: `building_id` или (улица+дом+индекс) + округлённая цена + округлённая площадь → одна карточка с несколькими источниками.

## Транспорт и дорога
- **Wiener Linien EFA** (тот же движок, что WienMobil): `https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2`,
  `outputFormat=rapidJSON`, `itdTripDateTimeDepArr=dep`, `calcNumberOfTrips` ≤ 6, **`changeSpeed=fast`** (бодрый шаг). Через edge `route` (CORS нет).
  Время: следующий вторник 08:00 (будний типичный). Фильтр: скрываем варианты с пешим отрезком ≥ 15 мин, если есть разумные без него.
- **Mapbox Directions** `driving-traffic` с `depart_at` (будни 08:00, пробки) + `driving` (без пробок).
- **Линии**: OSM через Overpass (route relations, ODbL) → `transit_lines_v2`. Станции U — `data/ubahn_stations.json`; строящиеся U5/U2 — `data/planned.json` (схема по станциям, Wiener Linien: первые очереди 2030).
- **Районы**: `data/wien_bezirke.json` (Statistik Austria / Flooh Perlot, CC BY 4.0).

## Шум (Strategische Lärmkarten 2022, BMK / Umweltbundesamt)
- WMS для слоя на карте: `https://inspire.lfrz.gv.at/000804/wms`, слои `2022_{STRASSE|SCHIENE|IPPC|FLUGHAEFEN}_{24H|NACHT}_ZONEN_OE`.
  **Тайлы 1024×1024** — иначе на малом масштабе сервер рисует линии вместо зон.
- OGC API Features для шума у фасада: `https://gis.lfrz.gv.at/api/geodata/i000804/ogc/features/v1/collections/i000804:laerm_2022_<src>_<lden|lnight>/items?f=json&bbox=…`
  bbox контура дома + ~8 м (0.00011° по долготе, 0.00007° по широте).

## Рядом с домом
- **Overpass** (overpass-api.de; нестабилен → запросы разбиты, повторы, fallback по bbox): `shop=supermarket`, `amenity=pharmacy`, `amenity=post_office`,
  `amenity=parcel_locker` в границах Вены → `private.ov_cache` → `private.ov_load()`.
- **Österreichische Post** официальный список: `https://secure.post.at/downloads/DepositoriesV2.csv` (типы ParcelLocker, PostOffice, HPS = Post Partner).
- **Дежурные аптеки**: Apothekerkammer POST-поиск
  `https://www.apothekerkammer.at/apothekensuche?tx_theme_pharmacysearch[action]=perform&tx_theme_pharmacysearch[controller]=PharmacySearch&cHash=00471e8b07ebf8dcf0721d08bcc1b305`
  с `nightShift=1` и координатами центра; дежурные = записи с «Bereitschaft von …» (без этого фильтра возвращаются все 346).
- DHL в Австрии своих Packstation не ставит — их боксы это myflexbox/Storebox/Tamburi; официального списка myflexbox пока нет (95 из OSM).

## Дома
- Контур и высота — из векторной геометрии Mapbox (`queryRenderedFeatures` слоя зданий), площадь < 20 000 м² (защита от целого квартала).
- Факты — сайты ЖК, архитекторов, застройщиков, Structurae, Wikipedia, объявления (описания), energieausweis в объявлениях.
- **Фото (v3)** — `buildings.official_url` + `buildings.photo_pages` (сайт ЖК, застройщик/продавец, архитектор, wien.gv.at «gebaut», heinze.de): og:image, `<img>` с alt/srcset (берётся крупнейший), крупные jpg. Классификация по alt/имени файла: **снаружи → общие зоны → квартиры (официальные) → проект**, затем фото квартир из объявлений Willhaben и ImmoScout24. До 40 фото, дубли разных размеров схлопываются, мусор (логотипы, планы, церемонии стройки) отсекается. Новые дома — cron `photos-new` каждые 10 мин; все — `photos-daily`.
- **Опознание дома по клику**: адрес — ближайший к точке; `height_m` из Mapbox — реальная высота здания. Высота > 35 м → ищем высотку/ЖК в точке (пример: «Prandaugasse 8», 153 м = VIENNA TWENTYTWO Tower Homes; «Straße der Menschenrechte 2», 105 м = VIENNA TWENTYTWO Living).
- Геокодинг: Mapbox Search Box (название ЖК / адрес), reverse geocode v6 (клик по карте).

## Покупка: правила и ставки (проверено 13.11.2026)
- KIM-V (жёсткие правила ипотеки) истекла 30.06.2025; FMA продолжает рекомендовать: ≥ 20% своих, платёж ≤ 40% чистого дохода, срок ≤ 35 лет.
- Расходы покупателя: GrESt 3,5%; Grundbuch 1,1% (льгота для первого жилья закончилась 30.06.2026); запись залога 1,2% от суммы залога;
  маклер до 3% + 20% USt; договор/нотариус ~1,5–2% + USt. Итого обычно 9–12%.
- Ставки ориентир (осень 2026): плавающая ~2,8%, фикс 10 лет ~3,15%.
