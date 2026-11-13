-- Разбор домов из очереди, выполнен вручную 13.11.2026 15:10 (Supabase-коннектор был недоступен — применить, когда вернётся).
-- После применения: select public.market_match();

-- ---------- Momento Vienna (DS90), Dresdner Straße 90, 1200 ----------
update public.buildings set
  name = 'Momento Vienna (DS90)',
  aliases = '{Momento Vienna,Momento,DS90,DS 90,Momento by Greystar,Dresdner Straße 90}',
  street = coalesce(street, 'Dresdner Straße'), house_no = coalesce(house_no, '90'), zip = coalesce(zip, '1200'), district = 20,
  year_built = 2025, floors_total = 27, units_total = 382,
  has_lift = true, has_gym = true, has_lounge = true, has_roof_terrace = true,
  heating_type = 'Fernwärme (Fußbodenheizung) + Bauteilaktivierung, Deckenkühlung',
  developer = 'S+B Plan & Bau (Bauherr); Eigentümer/Betreiber Greystar; Vermarktung EHL Wohnen; Architektur querkraft',
  notes = 'Арендная высотка Greystar у будущего квартала Nordwestbahnhof: 262 квартиры (с мебелью или без) + 120 serviced apartments, договоры от 6 месяцев, коворкинг, фитнес/йога, кино, терраса на крыше. Дорого: студия ~31 м² ≈ 1 170 €/мес (37,7 €/м²), 2-комн. с мебелью ~1 625 €. Высота по источникам 80 м, у Mapbox 93 м; этажей 27 или 29 — источники расходятся.',
  field_sources = coalesce(field_sources,'{}'::jsonb) || jsonb_build_object(
    'year_built', jsonb_build_object('value', 2025, 'sources', jsonb_build_array('heinze.de: Fertigstellung 11.2025', 'EHL (immomarktplatz.at): Baujahr 2025'), 'conflict', 'ImmoScout-объявления Greystar: Baujahr 2022'),
    'floors_total', jsonb_build_object('value', 27, 'sources', jsonb_build_array('vienna.at: 27 Stockwerke', 'leadersnet.at: квартиры с 6-го по 27-й этаж'), 'conflict', 'EHL: «a total of 29 floors»'),
    'units_total', jsonb_build_object('value', 382, 'sources', jsonb_build_array('vienna.at: 382 = 262 Mietwohnungen + 120 flexible Apartments', 'fcp.at: approx. 380 flats', 'leadersnet.at: 262 Wohnungen')),
    'height', jsonb_build_object('value_m', 80, 'sources', jsonb_build_array('heinze.de: 80 Meter hohe Hochhaus', 'fcp.at: 80 m high'), 'conflict', 'Mapbox height 93 м'),
    'has_lift', jsonb_build_object('value', true, 'sources', jsonb_build_array('ImmoScout (Momento by Greystar): Personenaufzug', 'высотка 27 этажей (вывод, не источник)'), 'single_source', true),
    'has_gym', jsonb_build_object('value', true, 'sources', jsonb_build_array('leadersnet.at: Fitness- und Yoga-Studio', 'EHL: fitness studio, yoga studio', 'ImmoScout: Zugang zu Fitness')),
    'has_lounge', jsonb_build_object('value', true, 'sources', jsonb_build_array('heinze.de: Lounge', 'EHL: residents'' lounge')),
    'has_roof_terrace', jsonb_build_object('value', true, 'sources', jsonb_build_array('heinze.de: Dachterrasse', 'EHL: rooftop terrace with garden', 'ImmoScout: Dachterrasse')),
    'garage_underground', jsonb_build_object('value', null, 'note', 'не найдено ни в одном источнике'),
    'developer', jsonb_build_object('sources', jsonb_build_array('wien.gv.at «gebaut 2025»: Auftraggeber S+B Plan & Bau, querkraft architekten', 'leadersnet.at: Eigentümer Greystar, Vermarktung EHL', 'fcp.at: Client Greystar/Modern Living GmbH')),
    'heating_type', jsonb_build_object('sources', jsonb_build_array('EHL (infina.at): underfloor heating using district heating, ceiling cooling', 'fcp.at / heinze.de: element activation, photovoltaic'))),
  research_status = 'done', research_note = 'Разобран 13.11.2026 вручную (Claude)'
where research_status = 'queued' and (name ilike '%momento%' or (street ilike 'Dresdner%' and house_no like '90%'));

-- ---------- Prandaugasse 8, 1220 (Kagran) ----------
-- Публичных данных о доме почти нет: не найден ни как ЖК/проект, ни в объявлениях (поиск по адресу 13.11.2026).
-- Рядом: VS Prandaugasse (Nr. 4–5), трамвай 25 «Prandaugasse», U1 Kagran ~5 мин пешком; ~350 м от работы Ариши.
-- Факты (лифт, год, этажи) — дождаться объявлений по адресу в market_listings или проверить на месте/в Energieausweis.
update public.buildings set
  zip = coalesce(zip, '1220'), district = 22,
  notes = 'Обычный жилой дом у U1 Kagran (5 мин пешком), трамвай 25 «Prandaugasse» у двери, ~350 м до работы Ариши. Ни как ЖК, ни в объявлениях на 13.11.2026 не найден — лифт, год и этажность не подтверждены; ждём объявлений по адресу.',
  field_sources = coalesce(field_sources,'{}'::jsonb) || jsonb_build_object(
    'search', jsonb_build_object('date', '2026-11-13', 'result', 'нет данных о доме; найдены только соседние адреса (VS Prandaugasse 4/5, Prandaugasse 60 — проект pg60 с санацией)')),
  research_status = 'done', research_note = 'Разобран 13.11.2026 вручную: данных мало, нужен повторный разбор при появлении объявлений'
where research_status = 'queued' and street ilike 'Prandau%';
