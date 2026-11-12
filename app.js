/* Wien — квартиры. Этап 2: ядро карты.
   Mapbox Standard + наши данные из Supabase. */
(() => {
const CFG = window.APP_CONFIG;
const AMBER = '#ffb300';
const BUILDINGS_TARGET = { featuresetId: 'buildings', importId: 'basemap' };

/* ---------- темы ---------- */
const THEMES = {
  a: { // графит, сумерки
    theme: 'monochrome', lightPreset: 'dusk',
    colorLand: '#1c1f24', colorWater: '#121a24', colorRoads: '#2e333a', colorMotorways: '#3a4049',
    colorBuildings: '#3a3f46', colorPlaceLabels: '#8b9199', colorRoadLabels: '#5f666e'
  },
  b: { // тёмно-синий, ночь
    theme: 'faded', lightPreset: 'night',
    colorLand: '#0d1628', colorWater: '#060d1a', colorRoads: '#1e2a40', colorMotorways: '#2a3a56',
    colorBuildings: '#22314d', colorPlaceLabels: '#7f8ca3', colorRoadLabels: '#4c576b'
  }
};
const COMMON = {
  colorBuildingSelect: AMBER, colorBuildingHighlight: '#ffcc4d',
  showPointOfInterestLabels: false, showTransitLabels: false, show3dObjects: true
};

/* ---------- состояние ---------- */
const S = {
  theme: localGet('theme', 'a'),
  mode: 'rent',
  buildings: [], listings: [], poi: [],
  selected: null, orbiting: false,
  f: {
    budget: CFG.BUDGET_DEFAULT, basis: 'gross', rooms: 2, area: 45,
    amen: new Set(['has_lift']), districts: new Set(), status: new Set(), hideFail: false
  },
  c: { months: 36, furn: 10000, rec: 40 }
};

const $ = id => document.getElementById(id);
const eur = n => n == null ? '—' : Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' €';
function localGet(k, d) { try { return localStorage.getItem('wa_' + k) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem('wa_' + k, v); } catch {} }
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }

/* ---------- карта ---------- */
if (!CFG.MAPBOX_TOKEN) {
  document.getElementById('map').innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa1aa;padding:30px;text-align:center">Карта ждёт ключ Mapbox с привязкой к адресу сайта.</div>';
  throw new Error('MAPBOX_TOKEN не задан');
}
mapboxgl.accessToken = CFG.MAPBOX_TOKEN;
document.body.className = 'theme-' + S.theme;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  config: { basemap: { ...THEMES[S.theme], ...COMMON } },
  center: [16.385, 48.195], zoom: 11.2, pitch: 0, bearing: 0,
  maxBounds: [[16.05, 48.05], [16.7, 48.36]],
  attributionControl: true
});
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

function applyTheme(t) {
  S.theme = t; localSet('theme', t);
  document.body.className = 'theme-' + t;
  const cfg = THEMES[t];
  for (const k in cfg) map.setConfigProperty('basemap', k, cfg[k]);
}

map.on('style.load', async () => {
  // освещение Mapbox (сумерки/ночь) затемняет и наши слои — даём им собственное свечение
  const _add = map.addLayer.bind(map);
  map.addLayer = (def, before) => {
    const k = { line: 'line', circle: 'circle', fill: 'fill', symbol: 'text' }[def.type];
    if (k) def.paint = { [k + '-emissive-strength']: 1, ...(def.paint || {}) };
    return _add(def, before);
  };
  const [bez, lines, stations] = await Promise.all(
    ['data/wien_bezirke.json', 'data/ubahn_lines.json', 'data/ubahn_stations.json'].map(u => fetch(u).then(r => r.json()))
  );

  // районы
  map.addSource('districts', { type: 'geojson', data: bez });
  map.addLayer({ id: 'district-fill', type: 'fill', source: 'districts', slot: 'middle',
    paint: { 'fill-color': AMBER, 'fill-opacity': 0.12 }, filter: ['in', ['get', 'district'], ['literal', []]] });
  map.addLayer({ id: 'district-line', type: 'line', source: 'districts', slot: 'top',
    paint: { 'line-color': '#8b9199', 'line-opacity': 0.45, 'line-width': 1 } });
  map.addLayer({ id: 'district-line-sel', type: 'line', source: 'districts', slot: 'top',
    paint: { 'line-color': AMBER, 'line-width': 2.2 }, filter: ['in', ['get', 'district'], ['literal', []]] });
  map.addLayer({ id: 'district-label', type: 'symbol', source: 'districts', slot: 'top', maxzoom: 13,
    layout: { 'text-field': ['to-string', ['get', 'district']], 'text-size': 13, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'] },
    paint: { 'text-color': '#8b9199', 'text-halo-color': '#0008', 'text-halo-width': 1 } });

  // метро
  map.addSource('ubahn', { type: 'geojson', data: lines });
  map.addLayer({ id: 'ubahn-casing', type: 'line', source: 'ubahn', slot: 'top',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#000', 'line-opacity': 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 9] } });
  map.addLayer({ id: 'ubahn-line', type: 'line', source: 'ubahn', slot: 'top',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 15, 5] } });
  map.addSource('stations', { type: 'geojson', data: stations });
  map.addLayer({ id: 'station-dot', type: 'circle', source: 'stations', slot: 'top',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 15, 5.5],
             'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'station-label', type: 'symbol', source: 'stations', slot: 'top', minzoom: 13,
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top',
              'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': '#e8eaed', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });

  // наши точки (работы, зал)
  map.addSource('poi', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'poi-dot', type: 'circle', source: 'poi', slot: 'top',
    paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'poi-label', type: 'symbol', source: 'poi', slot: 'top',
    layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top',
              'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } });

  // наши дома издалека: мягкое свечение, без булавок.
  // ближе 15-го зума отдельные здания уже рисуются, и светится сам дом.
  map.addSource('ours', { type: 'geojson', data: fc([]) });
  const fadeOut = ['interpolate', ['linear'], ['zoom'], 14.6, 1, 15.6, 0];
  map.addLayer({ id: 'ours-halo', type: 'circle', source: 'ours', slot: 'top',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 15, 30],
      'circle-color': ['case', ['get', 'pass'], AMBER, '#6b7280'],
      'circle-blur': 1,
      'circle-opacity': ['*', ['case', ['get', 'pass'], 0.55, 0.25], fadeOut]
    } });
  map.addLayer({ id: 'ours-core', type: 'circle', source: 'ours', slot: 'top',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 7],
      'circle-color': ['case', ['get', 'pass'], AMBER, '#6b7280'],
      'circle-opacity': fadeOut,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['case', ['get', 'sel'], 2, 0],
      'circle-stroke-opacity': fadeOut
    } });

  // клик по свечению
  map.on('click', 'ours-halo', e => select(e.features[0].properties.id));
  map.on('mouseenter', 'ours-halo', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'ours-halo', () => map.getCanvas().style.cursor = '');

  // клик по самому зданию: если это один из наших домов — открываем
  try {
    map.addInteraction('our-building-click', {
      type: 'click', target: BUILDINGS_TARGET,
      handler: e => {
        const b = nearestOurs(e.lngLat, 70);
        if (b) { select(b.id); return true; }
        return false;
      }
    });
  } catch (err) { console.warn('featureset interactions недоступны', err); }

  map.on('idle', paintBuildings);
  pushMapData();
  syncLayerToggles();
});

/* подсветка самих зданий: ищем отрисованное здание под каждой нашей точкой
   и ставим ему состояние select → оно красится в colorBuildingSelect (янтарь) */
let painted = [];
function paintBuildings() {
  if (!map.isStyleLoaded()) return;
  for (const f of painted) { try { map.setFeatureState(f, { select: false, highlight: false }); } catch {} }
  painted = [];
  if (map.getZoom() < 14.3) return;
  const bounds = map.getBounds();
  for (const b of S.buildings) {
    if (!b.pass && S.f.hideFail) continue;
    if (!bounds.contains([b.lng, b.lat])) continue;
    const p = map.project([b.lng, b.lat]);
    const r = b.pass ? 7 : 3;
    let feats = [];
    try { feats = map.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { target: BUILDINGS_TARGET }); } catch {}
    for (const f of feats) {
      try {
        map.setFeatureState(f, b.pass ? { select: true } : { highlight: true });
        painted.push(f);
      } catch {}
    }
  }
}

function nearestOurs(lngLat, maxMeters) {
  let best = null, bd = Infinity;
  for (const b of S.buildings) {
    const d = haversine(lngLat.lat, lngLat.lng, b.lat, b.lng);
    if (d < bd) { bd = d; best = b; }
  }
  return bd <= maxMeters ? best : null;
}
function haversine(a1, o1, a2, o2) {
  const R = 6371000, t = Math.PI / 180;
  const da = (a2 - a1) * t, d0 = (o2 - o1) * t;
  const x = Math.sin(da / 2) ** 2 + Math.cos(a1 * t) * Math.cos(a2 * t) * Math.sin(d0 / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fc = features => ({ type: 'FeatureCollection', features });

function pushMapData() {
  if (!map.getSource('ours')) return;
  map.getSource('ours').setData(fc(S.buildings
    .filter(b => b.pass || !S.f.hideFail)
    .map(b => ({ type: 'Feature', properties: { id: b.id, pass: b.pass, sel: S.selected === b.id },
                 geometry: { type: 'Point', coordinates: [b.lng, b.lat] } }))));
  const POI_COLORS = { p: '#3b82f6', a: '#ec4899', both: '#22c55e' };
  map.getSource('poi').setData(fc(S.poi.map(p => ({ type: 'Feature',
    properties: { label: p.label, color: POI_COLORS[p.owner] || '#22c55e' },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }))));
  const ds = [...S.f.districts];
  map.setFilter('district-fill', ['in', ['get', 'district'], ['literal', ds]]);
  map.setFilter('district-line-sel', ['in', ['get', 'district'], ['literal', ds]]);
  paintBuildings();
}

/* ---------- данные ---------- */
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);

async function load() {
  const [b, l, p] = await Promise.all([
    sb.from('buildings_map').select('*'),
    sb.from('listings').select('id,building_id,url,source,status,deal_type,area_m2,rooms,floor,outdoor,outdoor_m2,furnished,rent_net,betriebskosten,rent_gross,monthly_total,heating_est,utilities_est,internet_est,garage_cost,kaution_amount,setup_sunk,furnishing_est,furnishing_recovery_pct,befristet,befristet_years,pets_allowed,price_per_m2,published_at'),
    sb.from('poi_map').select('id,label,owner,address,lng,lat')
  ]);
  if (b.error) { toast('Ошибка базы: ' + b.error.message, 6000); return; }
  S.buildings = b.data.map(x => ({ ...x, lng: +x.lng, lat: +x.lat }));
  S.listings = l.data || [];
  S.poi = (p.data || []).map(x => ({ ...x, lng: +x.lng, lat: +x.lat }));
  if (!S.buildings.length) {
    $('gateText').textContent = 'Вход выполнен, но доступ к базе ещё не выдан. Напиши Claude — добавит твою почту в список.';
    showGate(true, true);
    return;
  }
  applyFilters();
}

/* ---------- фильтры ---------- */
const AMEN = [
  ['has_lift', 'Лифт'], ['garage_underground', 'Подземный паркинг'], ['has_gym', 'Зал'], ['has_pool', 'Бассейн'],
  ['has_sauna', 'Сауна'], ['has_lounge', 'Лаунж'], ['has_roof_terrace', 'Терраса на крыше'],
  ['has_courtyard', 'Двор'], ['has_playground', 'Детская площадка'], ['has_concierge', 'Консьерж']
];
const STATUS = { idea: 'идея', watching: 'наблюдаем', contacted: 'написали', viewed: 'смотрели', shortlist: 'шортлист', rejected: 'отказ' };

function buildFilterUI() {
  $('fAmen').innerHTML = AMEN.map(([k, t]) => `<button class="chip${S.f.amen.has(k) ? ' on' : ''}" data-k="${k}">${t}</button>`).join('');
  $('fDistricts').innerHTML = Array.from({ length: 23 }, (_, i) => i + 1).map(d => `<button class="chip" data-d="${d}">${d}</button>`).join('');
  $('fStatus').innerHTML = Object.entries(STATUS).map(([k, t]) => `<button class="chip" data-s="${k}">${t}</button>`).join('');

  $('fAmen').onclick = e => toggleChip(e, 'k', S.f.amen);
  $('fDistricts').onclick = e => toggleChip(e, 'd', S.f.districts, Number);
  $('fStatus').onclick = e => toggleChip(e, 's', S.f.status);
  $('fBudget').value = S.f.budget;
  $('fBudget').oninput = e => { S.f.budget = +e.target.value; applyFilters(); };
  $('budgetBasis').onclick = e => { const b = e.target.dataset.b; if (!b) return; S.f.basis = b; seg('budgetBasis', b, 'b'); applyFilters(); };
  $('fRooms').onchange = e => { S.f.rooms = +e.target.value; applyFilters(); };
  $('fArea').onchange = e => { S.f.area = +e.target.value; applyFilters(); };
  $('fHideFail').onchange = e => { S.f.hideFail = e.target.checked; applyFilters(); };
}
function toggleChip(e, attr, set, cast = x => x) {
  const el = e.target.closest('.chip'); if (!el) return;
  const v = cast(el.dataset[attr]);
  set.has(v) ? set.delete(v) : set.add(v);
  el.classList.toggle('on', set.has(v));
  applyFilters();
}
function seg(id, val, attr) { document.querySelectorAll('#' + id + ' button').forEach(b => b.classList.toggle('on', b.dataset[attr] === val)); }

/* проходит ли дом: по дому (amenities, район, статус) и есть ли хоть одно объявление под бюджет/комнаты/площадь */
function evaluate(b) {
  const why = [];
  for (const k of S.f.amen) if (!b[k]) why.push('нет: ' + AMEN.find(a => a[0] === k)[1].toLowerCase());
  if (S.f.districts.size && !S.f.districts.has(b.district)) why.push('не тот район');
  if (S.f.status.size && !S.f.status.has(b.our_status)) why.push('статус');
  if (S.mode === 'buy' && !(b.interest_mode || []).includes('buy')) why.push('не для покупки');

  const ls = S.listings.filter(l => l.building_id === b.id && l.status === 'active' && l.deal_type === S.mode);
  const fit = ls.filter(l => {
    const price = S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total;
    return price <= S.f.budget && (+l.rooms || 0) >= S.f.rooms && (+l.area_m2 || 0) >= S.f.area;
  });
  if (S.mode === 'rent') {
    if (!ls.length) why.push('нет активных объявлений');
    else if (!fit.length) {
      const cheapest = Math.min(...ls.map(l => S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total));
      if (cheapest > S.f.budget) why.push(`дороже потолка на ${eur(cheapest - S.f.budget)}`);
      else why.push('не подходит по комнатам/площади');
    }
  }
  return { pass: why.length === 0, why, ls, fit };
}

function applyFilters() {
  $('vBudget').textContent = eur(S.f.budget);
  for (const b of S.buildings) Object.assign(b, evaluate(b));
  renderList();
  pushMapData();
  if (S.selected) renderDetail(S.selected);
}

/* ---------- список ---------- */
function renderList() {
  const arr = S.buildings.filter(b => b.pass || !S.f.hideFail)
    .sort((a, b) => (b.pass - a.pass) || (minPrice(a) - minPrice(b)));
  $('cnt').textContent = S.buildings.filter(b => b.pass).length + '/' + S.buildings.length;
  $('list').innerHTML = arr.map(b => {
    const p = minPrice(b);
    return `<div class="bcard${b.pass ? '' : ' fail'}${S.selected === b.id ? ' sel' : ''}" data-id="${b.id}">
      <div class="bhead">
        <div>
          <div class="bname">${esc(b.name || b.street + ' ' + (b.house_no || ''))}<span class="status">${STATUS[b.our_status] || ''}</span></div>
          <div class="bmeta">${b.district}-й район${b.year_built ? ' · ' + b.year_built : ''}${b.ls.length ? ' · ' + b.ls.length + ' объявл.' : ''}</div>
        </div>
        <div class="bprice">${isFinite(p) ? 'от ' + eur(p) : '—'}<small>${S.f.basis === 'gross' ? 'грязная' : 'полная/мес'}</small></div>
      </div>
      ${b.pass ? '' : `<div class="why">${b.why.join(' · ')}</div>`}
    </div>`;
  }).join('') || '<p class="hint">Пусто. Ослабь фильтры.</p>';
  $('list').onclick = e => { const c = e.target.closest('.bcard'); if (c) select(c.dataset.id); };
}
function minPrice(b) {
  const ls = (b.fit && b.fit.length ? b.fit : b.ls) || [];
  if (!ls.length) return Infinity;
  return Math.min(...ls.map(l => S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total));
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- выбор дома: подлёт в 3D ---------- */
function select(id) {
  const b = S.buildings.find(x => x.id === id); if (!b) return;
  S.selected = id;
  stopOrbit();
  map.flyTo({ center: [b.lng, b.lat], zoom: 17.1, pitch: 62, bearing: -25, duration: 2600, essential: true, curve: 1.5 });
  map.once('moveend', paintBuildings);
  $('cam').hidden = false;
  renderDetail(id);
  renderList();
  pushMapData();
  $('sheet').classList.add('min');
}

function renderDetail(id) {
  const b = S.buildings.find(x => x.id === id); if (!b) return;
  const { months, furn, rec } = S.c;
  const am = AMEN.map(([k, t]) => `<span class="${b[k] ? '' : 'no'}">${t}</span>`).join('');
  const cards = b.ls.map(l => {
    const furnished = l.furnished === 'full';
    const setupF = furnished ? 0 : furn;
    const sunk = +l.setup_sunk || 0;
    const net = sunk + setupF * (1 - rec / 100);
    const avg = +l.monthly_total + net / months;
    const ok = (S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total) <= S.f.budget;
    return `<div class="lcard">
      <div class="lhead">
        <b>${(+l.area_m2).toFixed(0)} м² · ${+l.rooms} комн.${l.floor ? ' · ' + l.floor + ' эт.' : ''}${furnished ? ' · с мебелью' : ''}</b>
        ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">источник ↗</a>` : ''}
      </div>
      <dl class="rows">
        <dt>Грязная аренда</dt><dd${ok ? '' : ' style="color:var(--bad)"'}>${eur(l.rent_gross)}</dd>
        <dt>Полная в месяц</dt><dd class="hl">${eur(l.monthly_total)}</dd>
        <dt>€/м²</dt><dd>${l.price_per_m2 ? (+l.price_per_m2).toFixed(2) : '—'}</dd>
        <div class="sep"></div>
        <dt>Обустройство</dt><dd>${setupF ? eur(setupF) : '—'}</dd>
        <dt>Безвозвратно разово</dt><dd>${eur(sunk)}</dd>
        <dt>Залог (вернётся)</dt><dd>${eur(l.kaution_amount)}</dd>
        <div class="sep"></div>
        <dt>В среднем за ${months} мес</dt><dd>${eur(avg)}</dd>
      </dl>
    </div>`;
  }).join('') || '<p class="hint">Объявлений пока нет.</p>';

  $('detailBody').innerHTML = `
    <div class="dname">${esc(b.name || b.street)}</div>
    <div class="daddr">${esc([b.street, b.house_no].filter(Boolean).join(' '))}, ${esc(b.zip || '')} · ${b.district}-й район · ${STATUS[b.our_status] || ''}</div>
    <div class="facts">
      <div class="fact"><b>${b.year_built || '—'}</b><span>год</span></div>
      <div class="fact"><b>${b.floors_total || '—'}</b><span>этажей</span></div>
      <div class="fact"><b>${b.hwb_class || (b.fgee ? 'fGEE ' + b.fgee : '—')}</b><span>энергия</span></div>
    </div>
    <div class="amen">${am}</div>
    ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}
    ${b.pass ? '' : `<div class="why">Не проходит: ${b.why.join(' · ')}</div>`}
    ${cards}`;
  $('detail').hidden = false;
}

$('detailClose').onclick = () => {
  S.selected = null; stopOrbit();
  $('detail').hidden = true; $('cam').hidden = true;
  $('sheet').classList.remove('min');
  renderList(); pushMapData();
};

/* ---------- камера ---------- */
function orbitStep() {
  if (!S.orbiting) return;
  map.setBearing((map.getBearing() + 0.14) % 360);
  requestAnimationFrame(orbitStep);
}
function startOrbit() { S.orbiting = true; $('orbitBtn').classList.add('on'); if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 600 }); requestAnimationFrame(orbitStep); }
function stopOrbit() { S.orbiting = false; $('orbitBtn').classList.remove('on'); }
$('orbitBtn').onclick = () => S.orbiting ? stopOrbit() : startOrbit();
$('flatBtn').onclick = () => { stopOrbit(); map.easeTo({ pitch: 0, bearing: 0, duration: 900 }); };
$('tiltBtn').onclick = () => map.easeTo({ pitch: 62, duration: 900 });
['mousedown', 'touchstart', 'wheel'].forEach(ev => map.getCanvasContainer().addEventListener(ev, stopOrbit, { passive: true }));

/* ---------- шторка, вкладки, тема, режим ---------- */
$('tabs').onclick = e => {
  const t = e.target.closest('button'); if (!t) return;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t.dataset.tab));
  $('sheet').classList.remove('min');
};
$('grab').onclick = () => {
  const s = $('sheet');
  if (s.classList.contains('min')) s.classList.remove('min');
  else if (s.classList.contains('max')) { s.classList.remove('max'); s.classList.add('min'); }
  else s.classList.add('max');
};
$('themeBtn').onclick = () => applyTheme(S.theme === 'a' ? 'b' : 'a');
$('modeSeg').onclick = e => {
  const m = e.target.dataset.mode; if (!m) return;
  S.mode = m; seg('modeSeg', m, 'mode');
  if (m === 'buy') toast('Режим покупки — этап 8. Пока показываются только дома, отмеченные для покупки.', 4000);
  applyFilters();
};

/* слои */
function vis(ids, on) { ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')); }
function syncLayerToggles() {
  vis(['ubahn-casing', 'ubahn-line', 'station-dot', 'station-label'], $('lMetro').checked);
  vis(['district-line', 'district-label'], $('lDistricts').checked);
  vis(['poi-dot', 'poi-label'], $('lPoi').checked);
  map.setConfigProperty('basemap', 'show3dObjects', $('l3d').checked);
  map.setConfigProperty('basemap', 'showTransitLabels', $('lTransitLabels').checked);
  map.setConfigProperty('basemap', 'showPointOfInterestLabels', $('lPoiLabels').checked);
}
['lMetro', 'lDistricts', 'lPoi', 'l3d', 'lTransitLabels', 'lPoiLabels'].forEach(id => $(id).onchange = syncLayerToggles);

/* расчёт */
function bindCalc(id, key, out, fmt) {
  const el = $(id); el.value = S.c[key];
  const upd = () => {
    S.c[key] = +el.value; $(out).textContent = fmt(S.c[key]);
    document.querySelectorAll(`.presets[data-target="${id}"] button`).forEach(b => b.classList.toggle('on', +b.dataset.v === S.c[key]));
    if (S.selected) renderDetail(S.selected);
  };
  el.oninput = upd; upd();
}
bindCalc('cMonths', 'months', 'vMonths', v => v + ' мес');
bindCalc('cFurn', 'furn', 'vFurn', eur);
bindCalc('cRec', 'rec', 'vRec', v => v + ' %');
document.querySelectorAll('.presets').forEach(p => p.onclick = e => {
  const v = e.target.dataset.v; if (!v) return;
  const inp = $(p.dataset.target); inp.value = v; inp.oninput();
});

/* ---------- вход ---------- */
function showGate(on, signedIn = false) {
  $('gate').hidden = !on;
  $('gateForm').querySelector('input').hidden = signedIn;
  $('gateBtn').textContent = signedIn ? 'Выйти' : 'Прислать ссылку';
}
$('gateForm').onsubmit = async e => {
  e.preventDefault();
  if ($('gateEmail').hidden) { await sb.auth.signOut(); location.reload(); return; }
  const email = $('gateEmail').value.trim();
  $('gateBtn').disabled = true; $('gateNote').textContent = 'Отправляю…';
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $('gateBtn').disabled = false;
  $('gateNote').textContent = error ? 'Ошибка: ' + error.message : 'Готово. Открой письмо и нажми ссылку — вернёшься сюда уже внутри.';
};

buildFilterUI();
sb.auth.onAuthStateChange((ev, session) => {
  if (session) { showGate(false); load(); }
  else showGate(true);
});
})();
