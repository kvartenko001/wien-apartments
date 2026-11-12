/* Wien — квартиры.
   Mapbox Standard + наши данные из Supabase.
   Этап 2: карта, дома по настоящему контуру, подлёт.
   Этап 3: слои — метро, S-Bahn, трамваи, автобусы, зелень. */
(() => {
const CFG = window.APP_CONFIG;
const AMBER = '#ffb300';
const GREY = '#6b7280';
const BUILDINGS_TARGET = { featuresetId: 'buildings', importId: 'basemap' };
const DESKTOP = () => innerWidth >= 900;

/* ---------- темы ---------- */
const THEMES = {
  a: { theme: 'monochrome', lightPreset: 'dusk',
       colorLand: '#1c1f24', colorWater: '#121a24', colorRoads: '#2e333a', colorMotorways: '#3a4049',
       colorBuildings: '#3a3f46', colorPlaceLabels: '#8b9199', colorRoadLabels: '#5f666e', colorGreenspace: '#22262b' },
  b: { theme: 'faded', lightPreset: 'night',
       colorLand: '#0d1628', colorWater: '#060d1a', colorRoads: '#1e2a40', colorMotorways: '#2a3a56',
       colorBuildings: '#22314d', colorPlaceLabels: '#7f8ca3', colorRoadLabels: '#4c576b', colorGreenspace: '#0f1b30' }
};
const GREEN_ON = '#2f6b3f';
const COMMON = {
  colorBuildingSelect: AMBER, colorBuildingHighlight: '#ffcc4d',
  showPointOfInterestLabels: false, showTransitLabels: false, show3dObjects: true
};

/* ---------- состояние ---------- */
const S = {
  theme: localGet('theme', 'a'),
  mode: 'rent',
  buildings: [], listings: [], poi: [], transit: {},
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
const fc = features => ({ type: 'FeatureCollection', features });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- карта ---------- */
if (!CFG.MAPBOX_TOKEN) {
  $('map').innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa1aa;padding:30px;text-align:center">Карта ждёт ключ Mapbox.</div>';
  throw new Error('MAPBOX_TOKEN не задан');
}
mapboxgl.accessToken = CFG.MAPBOX_TOKEN;
document.body.className = 'theme-' + S.theme;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/standard',
  config: { basemap: { ...THEMES[S.theme], ...COMMON } },
  center: [16.385, 48.195], zoom: 11.2, pitch: 0, bearing: 0,
  maxBounds: [[16.05, 48.05], [16.7, 48.36]]
});
window.__map = map; // для отладки
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.setPadding(basePad());

function applyTheme(t) {
  S.theme = t; localSet('theme', t);
  document.body.classList.remove('theme-a', 'theme-b'); document.body.classList.add('theme-' + t);
  for (const [k, v] of Object.entries(THEMES[t])) map.setConfigProperty('basemap', k, v);
  if ($('lGreen').checked) map.setConfigProperty('basemap', 'colorGreenspace', GREEN_ON);
}

/* отступы камеры: дом центрируется в свободной части экрана, а не под панелями */
function basePad() {
  return DESKTOP() ? { left: 404, right: 0, top: 60, bottom: 0 } : { left: 0, right: 0, top: 60, bottom: Math.round(innerHeight * 0.42) };
}
function detailPad() {
  return DESKTOP() ? { left: 404, right: 424, top: 60, bottom: 20 } : { left: 0, right: 0, top: 60, bottom: Math.round(innerHeight * 0.52) };
}

const T = { // стили транспорта
  subway: { color: ['coalesce', ['get', 'colour'], '#e8eaed'], w: [10, 2.4, 16, 6], min: 0, labelMin: 12 },
  sbahn:  { color: ['coalesce', ['get', 'colour'], '#5fa8e8'], w: [10, 1.8, 16, 4.5], min: 0, labelMin: 12.5, dash: [3, 1.2] },
  tram:   { color: ['coalesce', ['get', 'colour'], '#e05a4f'], w: [11, 1, 16, 3.2], min: 11, labelMin: 14.5 },
  bus:    { color: '#7aa2f7', w: [12, 0.8, 16, 2.4], min: 12, labelMin: 15.5, opacity: 0.7 }
};

map.on('style.load', async () => {
  // освещение Mapbox гасит наши слои — даём им собственное свечение
  const _add = map.addLayer.bind(map);
  map.addLayer = (def, before) => {
    const k = { line: 'line', circle: 'circle', fill: 'fill', symbol: 'text', 'fill-extrusion': 'fill-extrusion' }[def.type];
    if (k) def.paint = { [k + '-emissive-strength']: 1, ...(def.paint || {}) };
    if (def.type === 'symbol') def.paint = { 'icon-emissive-strength': 1, ...def.paint };
    return _add(def, before);
  };

  const loadImg = (name, url) => new Promise(res => map.loadImage(url, (err, img) => { if (!err && !map.hasImage(name)) map.addImage(name, img, { pixelRatio: 2 }); res(); }));
  const [bez, ust] = await Promise.all([
    fetch('data/wien_bezirke.json').then(r => r.json()),
    fetch('data/ubahn_stations.json').then(r => r.json()),
    loadImg('badge-u', 'img/ubahn.png'),
    loadImg('badge-s', 'img/sbahn.png')
  ]);

  // районы
  map.addSource('districts', { type: 'geojson', data: bez });
  map.addLayer({ id: 'district-fill', type: 'fill', source: 'districts', slot: 'middle',
    paint: { 'fill-color': AMBER, 'fill-opacity': 0.1 }, filter: ['in', ['get', 'district'], ['literal', []]] });
  map.addLayer({ id: 'district-line', type: 'line', source: 'districts', slot: 'middle',
    paint: { 'line-color': '#8b9199', 'line-opacity': 0.4, 'line-width': 1 } });
  map.addLayer({ id: 'district-line-sel', type: 'line', source: 'districts', slot: 'middle',
    paint: { 'line-color': AMBER, 'line-width': 2.2 }, filter: ['in', ['get', 'district'], ['literal', []]] });
  map.addLayer({ id: 'district-label', type: 'symbol', source: 'districts', slot: 'top', maxzoom: 12.5,
    layout: { 'text-field': ['to-string', ['get', 'district']], 'text-size': 13, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'] },
    paint: { 'text-color': '#8b9199', 'text-halo-color': 'rgba(0,0,0,0.65)', 'text-halo-width': 1 } });

  // линии транспорта (из нашей базы, данные OpenStreetMap)
  for (const mode of ['bus', 'tram', 'sbahn', 'subway']) {
    const st = T[mode];
    map.addSource('tx-' + mode, { type: 'geojson', data: fc([]) });
    if (mode === 'subway' || mode === 'sbahn') map.addLayer({ id: `tx-${mode}-casing`, type: 'line', source: 'tx-' + mode, slot: 'middle', minzoom: st.min,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#000', 'line-opacity': 0.4, 'line-width': ['interpolate', ['linear'], ['zoom'], st.w[0], st.w[1] + 2, st.w[2], st.w[3] + 3] } });
    map.addLayer({ id: `tx-${mode}`, type: 'line', source: 'tx-' + mode, slot: 'middle', minzoom: st.min,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': st.color, 'line-opacity': st.opacity || 0.95,
               'line-width': ['interpolate', ['linear'], ['zoom'], ...st.w], ...(st.dash ? { 'line-dasharray': st.dash } : {}) } });
    map.addLayer({ id: `tx-${mode}-label`, type: 'symbol', source: 'tx-' + mode, slot: 'top', minzoom: st.labelMin,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['get', 'ref'], 'text-size': 10.5,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-keep-upright': true },
      paint: { 'text-color': '#fff', 'text-halo-color': mode === 'bus' ? '#2b4a8a' : '#000', 'text-halo-width': 1.6 } });
  }

  // остановки и станции (Mapbox Streets)
  map.addSource('streets', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
  const stopLayer = (id, filter, extra) => map.addLayer({ id, source: 'streets', 'source-layer': 'transit_stop_label', slot: 'top', filter, ...extra });
  stopLayer('stop-bus', ['==', ['get', 'mode'], 'bus'], { type: 'circle', minzoom: 14.5,
    paint: { 'circle-radius': 2.6, 'circle-color': '#7aa2f7', 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } });
  stopLayer('stop-tram', ['==', ['get', 'mode'], 'tram'], { type: 'circle', minzoom: 13.5,
    paint: { 'circle-radius': 3.2, 'circle-color': '#e05a4f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  const nameLayout = { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
                       'text-optional': true, 'text-anchor': 'left' };
  stopLayer('stop-s', ['all', ['==', ['get', 'mode'], 'rail'], ['==', ['get', 'stop_type'], 'station']], { type: 'symbol', minzoom: 11,
    layout: { 'icon-image': 'badge-s', 'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.36, 15, 0.62], 'icon-allow-overlap': true,
              'icon-offset': [14, 0], ...nameLayout, 'text-offset': [1.6, 0], 'text-field': ['step', ['zoom'], '', 13.5, ['get', 'name']] },
    paint: { 'text-color': '#cfe4fb', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
  map.addSource('ustations', { type: 'geojson', data: ust });
  map.addLayer({ id: 'stop-u', type: 'symbol', source: 'ustations', slot: 'top', minzoom: 10,
    layout: { 'icon-image': 'badge-u', 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.36, 15, 0.62], 'icon-allow-overlap': true,
              'icon-offset': [-14, 0], ...nameLayout, 'text-anchor': 'right', 'text-offset': [-1.6, 0],
              'text-field': ['step', ['zoom'], '', 13, ['get', 'name']] },
    paint: { 'text-color': '#cfe4fb', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });

  // наши точки
  map.addSource('poi', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'poi-dot', type: 'circle', source: 'poi', slot: 'top',
    paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'poi-label', type: 'symbol', source: 'poi', slot: 'top',
    layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } });

  // НАШИ ДОМА — настоящий контур здания
  const col = ['case', ['get', 'pass'], AMBER, GREY];
  map.addSource('fp', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'fp-fill', type: 'fill', source: 'fp', slot: 'top',
    paint: { 'fill-color': col, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 0.9] } });
  map.addLayer({ id: 'fp-glow', type: 'line', source: 'fp', slot: 'top',
    paint: { 'line-color': col, 'line-blur': 4, 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 14] } });
  map.addLayer({ id: 'fp-3d', type: 'fill-extrusion', source: 'fp', slot: 'top', minzoom: 14,
    paint: { 'fill-extrusion-color': ['case', ['get', 'sel'], '#ffc940', col], 'fill-extrusion-height': ['+', ['get', 'h'], 0.6],
             'fill-extrusion-base': 0, 'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.6, 0.96],
             'fill-extrusion-emissive-strength': 0.75 } });
  map.addLayer({ id: 'fp-sel', type: 'line', source: 'fp', slot: 'top', filter: ['get', 'sel'],
    paint: { 'line-color': '#fff', 'line-width': 2 } });

  // издалека дом — пара пикселей: мягкое свечение в центре, чтобы его было видно
  map.addSource('ours', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'ours-halo', type: 'circle', source: 'ours', slot: 'top', maxzoom: 14,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 22], 'circle-color': col, 'circle-blur': 1,
             'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 13.5, 0.35, 14, 0] } });

  for (const id of ['fp-fill', 'fp-3d', 'ours-halo']) {
    map.on('click', id, e => { e.originalEvent.stopPropagation?.(); select(e.features[0].properties.id); });
    map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
  }

  map.on('idle', paintBasemap);
  pushMapData();
  pushTransit();
  syncLayerToggles();
});

/* дублируем янтарь на «родное» здание Mapbox, чтобы стены не мерцали серым сквозь наш слой */
let painted = [];
function paintBasemap() {
  if (!map.isStyleLoaded() || !map.getLayer('fp-3d')) return;
  for (const f of painted) { try { map.setFeatureState(f, { select: false }); } catch {} }
  painted = [];
  if (map.getZoom() < 14) return;
  const b = map.getBounds();
  for (const bd of S.buildings) {
    if (!bd.pass || !bd.parts) continue;
    for (const c of bd.parts) {
      if (!b.contains(c)) continue;
      const p = map.project(c);
      let fs = [];
      try { fs = map.queryRenderedFeatures([[p.x - 2, p.y - 2], [p.x + 2, p.y + 2]], { target: BUILDINGS_TARGET }); } catch {}
      for (const f of fs) { try { map.setFeatureState(f, { select: true }); painted.push(f); } catch {} }
    }
  }
}

function ringCentroid(r) { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; }
function geomParts(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }

function pushMapData() {
  if (!map.getSource('fp')) return;
  const show = S.buildings.filter(b => b.pass || !S.f.hideFail);
  map.getSource('fp').setData(fc(show.filter(b => b.footprint).map(b => ({ type: 'Feature',
    properties: { id: b.id, pass: !!b.pass, sel: S.selected === b.id, h: +b.height_m || 15 }, geometry: b.footprint }))));
  map.getSource('ours').setData(fc(show.map(b => ({ type: 'Feature',
    properties: { id: b.id, pass: !!b.pass }, geometry: { type: 'Point', coordinates: [b.lng, b.lat] } }))));
  const POI_COLORS = { p: '#3b82f6', a: '#ec4899', both: '#22c55e' };
  map.getSource('poi').setData(fc(S.poi.map(p => ({ type: 'Feature',
    properties: { label: p.label, color: POI_COLORS[p.owner] || '#22c55e' }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }))));
  const ds = [...S.f.districts];
  map.setFilter('district-fill', ['in', ['get', 'district'], ['literal', ds]]);
  map.setFilter('district-line-sel', ['in', ['get', 'district'], ['literal', ds]]);
  paintBasemap();
}
function pushTransit() {
  for (const mode of ['subway', 'sbahn', 'tram', 'bus']) {
    const src = map.getSource('tx-' + mode);
    if (src && S.transit[mode]) src.setData(S.transit[mode]);
  }
}

/* ---------- данные ---------- */
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);

async function load() {
  const [b, l, p, t] = await Promise.all([
    sb.from('buildings_map').select('*'),
    sb.from('listings').select('id,building_id,url,source,status,deal_type,area_m2,rooms,floor,outdoor,outdoor_m2,furnished,rent_net,betriebskosten,rent_gross,monthly_total,heating_est,utilities_est,internet_est,garage_cost,kaution_amount,setup_sunk,furnishing_est,furnishing_recovery_pct,befristet,befristet_years,pets_allowed,price_per_m2,published_at'),
    sb.from('poi_map').select('id,label,owner,address,lng,lat'),
    sb.from('transit_lines').select('mode,ref,colour,geom')
  ]);
  if (b.error) { toast('Ошибка базы: ' + b.error.message, 6000); return; }
  S.buildings = b.data.map(x => {
    const parts = geomParts(x.footprint).map(poly => ringCentroid(poly[0]));
    let lng = +x.lng, lat = +x.lat;
    return { ...x, lng, lat, parts };
  });
  S.listings = l.data || [];
  S.poi = (p.data || []).map(x => ({ ...x, lng: +x.lng, lat: +x.lat }));
  S.transit = {};
  for (const r of (t.data || [])) {
    (S.transit[r.mode] ||= fc([])).features.push({ type: 'Feature', properties: { ref: r.ref, colour: r.colour }, geometry: r.geom });
  }
  if (!S.buildings.length) {
    $('gateText').textContent = 'Вход выполнен, но доступа к базе нет. Напиши Claude — добавит твою почту в список.';
    showGate(true, true);
    return;
  }
  applyFilters();
  pushTransit();
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
function minPrice(b) {
  const ls = (b.fit && b.fit.length ? b.fit : b.ls) || [];
  if (!ls.length) return Infinity;
  return Math.min(...ls.map(l => S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total));
}
function renderList() {
  const arr = S.buildings.filter(b => b.pass || !S.f.hideFail).sort((a, b) => (b.pass - a.pass) || (minPrice(a) - minPrice(b)));
  $('cnt').textContent = S.buildings.filter(b => b.pass).length + '/' + S.buildings.length;
  $('list').innerHTML = arr.map(b => {
    const p = minPrice(b);
    return `<div class="bcard${b.pass ? '' : ' fail'}${S.selected === b.id ? ' sel' : ''}" data-id="${b.id}">
      <div class="bhead">
        <div>
          <div class="bname">${esc(b.name || b.street + ' ' + (b.house_no || ''))}<span class="status">${STATUS[b.our_status] || ''}</span></div>
          <div class="bmeta">${b.district}-й район${b.year_built ? ' · ' + b.year_built : ''}${b.height_m ? ' · ' + Math.round(b.height_m) + ' м' : ''}${b.ls.length ? ' · ' + b.ls.length + ' объявл.' : ''}</div>
        </div>
        <div class="bprice">${isFinite(p) ? 'от ' + eur(p) : '—'}<small>${S.f.basis === 'gross' ? 'грязная' : 'полная/мес'}</small></div>
      </div>
      ${b.pass ? '' : `<div class="why">${b.why.join(' · ')}</div>`}
    </div>`;
  }).join('') || '<p class="hint">Пусто. Ослабь фильтры.</p>';
  $('list').onclick = e => { const c = e.target.closest('.bcard'); if (c) select(c.dataset.id); };
}

/* ---------- выбор дома: подлёт в 3D, дом в центре свободной части экрана ---------- */
function select(id) {
  const b = S.buildings.find(x => x.id === id); if (!b) return;
  S.selected = id;
  stopOrbit();
  const h = +b.height_m || 20;
  const zoom = h > 120 ? 15.7 : h > 45 ? 16.3 : 16.9;
  renderDetail(id);
  $('detail').hidden = false;
  $('cam').hidden = false;
  document.body.classList.add('has-detail');
  if (!DESKTOP()) $('sheet').classList.add('min');
  map.flyTo({ center: [b.lng, b.lat], zoom, pitch: 60, bearing: -25, padding: detailPad(), duration: 2400, essential: true, curve: 1.4 });
  renderList();
  pushMapData();
}
function closeDetail() {
  S.selected = null; stopOrbit();
  $('detail').hidden = true; $('cam').hidden = true;
  document.body.classList.remove('has-detail');
  $('sheet').classList.remove('min');
  map.easeTo({ padding: basePad(), duration: 500 });
  renderList(); pushMapData();
}
$('detailClose').onclick = closeDetail;

function renderDetail(id) {
  const b = S.buildings.find(x => x.id === id); if (!b) return;
  const { months, furn, rec } = S.c;
  const am = AMEN.map(([k, t]) => `<span class="${b[k] ? '' : 'no'}">${t}</span>`).join('');
  const cards = b.ls.map(l => {
    const furnished = l.furnished === 'full';
    const setupF = furnished ? 0 : furn;
    const sunk = +l.setup_sunk || 0;
    const avg = +l.monthly_total + (sunk + setupF * (1 - rec / 100)) / months;
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
  }).join('') || '<p class="hint">Активных объявлений пока нет.</p>';

  $('detailBody').innerHTML = `
    <div class="dname">${esc(b.name || b.street)}</div>
    <div class="daddr">${esc([b.street, b.house_no].filter(Boolean).join(' '))}, ${esc(b.zip || '')} · ${b.district}-й район · ${STATUS[b.our_status] || ''}</div>
    <div class="facts">
      <div class="fact"><b>${b.year_built || '—'}</b><span>год</span></div>
      <div class="fact"><b>${b.height_m ? Math.round(b.height_m) + ' м' : (b.floors_total || '—')}</b><span>${b.height_m ? 'высота' : 'этажей'}</span></div>
      <div class="fact"><b>${b.hwb_class || (b.fgee ? 'fGEE ' + b.fgee : '—')}</b><span>энергия</span></div>
    </div>
    <div class="amen">${am}</div>
    ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}
    ${b.pass ? '' : `<div class="why">Не проходит: ${b.why.join(' · ')}</div>`}
    ${cards}`;
}

/* ---------- камера ---------- */
function orbitStep() { if (!S.orbiting) return; map.setBearing((map.getBearing() + 0.14) % 360); requestAnimationFrame(orbitStep); }
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
addEventListener('resize', () => map.setPadding(S.selected ? detailPad() : basePad()));

/* ---------- слои ---------- */
const LAYER_GROUPS = {
  lMetro:  ['tx-subway-casing', 'tx-subway', 'tx-subway-label', 'stop-u'],
  lSbahn:  ['tx-sbahn-casing', 'tx-sbahn', 'tx-sbahn-label', 'stop-s'],
  lTram:   ['tx-tram', 'tx-tram-label', 'stop-tram'],
  lBus:    ['tx-bus', 'tx-bus-label', 'stop-bus'],
  lDistricts: ['district-line', 'district-label'],
  lPoi:    ['poi-dot', 'poi-label']
};
function vis(ids, on) { ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')); }
function syncLayerToggles() {
  if (!map.getLayer('fp-fill')) return;
  for (const [cb, ids] of Object.entries(LAYER_GROUPS)) vis(ids, $(cb).checked);
  map.setConfigProperty('basemap', 'show3dObjects', $('l3d').checked);
  map.setConfigProperty('basemap', 'showPointOfInterestLabels', $('lPoiLabels').checked);
  map.setConfigProperty('basemap', 'colorGreenspace', $('lGreen').checked ? GREEN_ON : THEMES[S.theme].colorGreenspace);
  localSet('layers', JSON.stringify(Object.fromEntries([...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen'].map(k => [k, $(k).checked]))));
}
try { const saved = JSON.parse(localGet('layers', '{}')); for (const [k, v] of Object.entries(saved)) if ($(k)) $(k).checked = v; } catch {}
[...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen'].forEach(id => $(id).onchange = syncLayerToggles);
$('txAll').onclick = () => { const on = !['lMetro', 'lSbahn', 'lTram', 'lBus'].every(k => $(k).checked); ['lMetro', 'lSbahn', 'lTram', 'lBus'].forEach(k => $(k).checked = on); syncLayerToggles(); };

/* ---------- расчёт ---------- */
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
  $('gateEmail').hidden = signedIn;
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
