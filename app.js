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
const NOISE_WMS = 'https://inspire.lfrz.gv.at/000804/wms';
const NOISE_LAYER = { strasse: 'STRASSE', schiene: 'SCHIENE', industrie: 'IPPC', flug: 'FLUGHAEFEN' };
const NOISE_KEYS = Object.keys(NOISE_LAYER);

/* ---------- темы ---------- */
const THEMES = {
  a: { theme: 'default', lightPreset: 'dusk',
       colorLand: '#1c1f24', colorWater: '#121a24', colorRoads: '#2e333a', colorMotorways: '#3a4049',
       colorBuildings: '#3a3f46', colorPlaceLabels: '#8b9199', colorRoadLabels: '#5f666e', colorGreenspace: '#22262b' },
  b: { theme: 'default', lightPreset: 'night',
       colorLand: '#0d1628', colorWater: '#060d1a', colorRoads: '#1e2a40', colorMotorways: '#2a3a56',
       colorBuildings: '#22314d', colorPlaceLabels: '#7f8ca3', colorRoadLabels: '#4c576b', colorGreenspace: '#0f1b30' },
  c: { theme: 'monochrome', lightPreset: 'dusk',
       colorLand: '#1c1f24', colorWater: '#121a24', colorRoads: '#2e333a', colorMotorways: '#3a4049',
       colorBuildings: '#3a3f46', colorPlaceLabels: '#8b9199', colorRoadLabels: '#5f666e', colorGreenspace: '#22262b' }
};
const THEME_ORDER = ['a', 'b', 'c'];
const THEME_NAMES = { a: 'Графит · сумерки', b: 'Синяя ночь', c: 'Монохром' };
const GREEN_ON = '#2f6b3f';
const COMMON = {
    showPointOfInterestLabels: false, showTransitLabels: false, show3dObjects: true
};

/* ---------- состояние ---------- */
const S = {
  theme: (t => THEMES[t] ? t : 'a')(localGet('theme', 'a')),
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
  const [bez, ust, planned] = await Promise.all([
    fetch('data/wien_bezirke.json').then(r => r.json()),
    fetch('data/ubahn_stations.json').then(r => r.json()),
    fetch('data/planned.json').then(r => r.json()),
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

  // ШУМ — стратегические шумовые карты Австрии 2022 (WMS, Datenquelle: www.laerminfo.at)
  // Сервер на мелком масштабе (весь город) рисует не зоны, а просто линии дорог (а ж/д — чёрным, на тёмной карте не видно).
  // Поэтому каждую плитку 256 px просим в 1024 px: сервер считает масштаб в 4 раза крупнее и отдаёт настоящие зоны в дБ.
  for (const key of ['strasse', 'schiene', 'industrie', 'flug']) for (const period of ['24H', 'NACHT']) {
    const layer = `2022_${NOISE_LAYER[key]}_${period}_ZONEN_OE`;
    const id = `noise-${key}-${period === '24H' ? 'day' : 'night'}`;
    map.addSource(id, { type: 'raster', tileSize: 256, minzoom: 10, maxzoom: 17,
      attribution: '<a href="https://www.laerminfo.at" target="_blank">Datenquelle: www.laerminfo.at</a>',
      tiles: [`${NOISE_WMS}?service=WMS&version=1.3.0&request=GetMap&layers=${layer}&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=1024&height=1024&format=image/png&transparent=true`] });
    map.addLayer({ id, type: 'raster', source: id, slot: 'middle', minzoom: 10.5, layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.78, 'raster-fade-duration': 150, 'raster-emissive-strength': 1,
               'raster-brightness-min': 0.18, 'raster-saturation': 0.25, 'raster-resampling': 'linear' } });
  }

  // СТРОЯЩИЕСЯ ЛИНИИ: U5, новая U2 — тусклым пунктиром, со сроками
  map.addSource('planned-lines', { type: 'geojson', data: planned.lines });
  map.addSource('planned-stations', { type: 'geojson', data: planned.stations });
  map.addLayer({ id: 'pl-line', type: 'line', source: 'planned-lines', slot: 'middle',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': ['case', ['==', ['get', 'stage'], 1], 0.7, 0.45],
             'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 16, 6], 'line-dasharray': ['literal', [1.4, 1.2]] } });
  map.addLayer({ id: 'pl-line-label', type: 'symbol', source: 'planned-lines', slot: 'top', minzoom: 12,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 260, 'text-field': ['concat', ['get', 'line'], ' · ', ['get', 'open']], 'text-size': 11,
              'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.6 } });
  map.addLayer({ id: 'pl-stn', type: 'circle', source: 'planned-stations', slot: 'top', minzoom: 10.5,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 6.5], 'circle-color': '#15171a',
             'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.2 } });
  map.addLayer({ id: 'pl-stn-label', type: 'symbol', source: 'planned-stations', slot: 'top', minzoom: 12.5,
    layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true,
              'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.4 } });
  map.on('click', 'pl-stn', e => { const p = e.features[0].properties; toast(`${p.name}: ${p.line}, ${p.open} — ${p.note}`, 4500); });

  // остановки и станции (Mapbox Streets)
  map.addSource('streets', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
  const stopLayer = (id, filter, extra) => map.addLayer({ id, source: 'streets', 'source-layer': 'transit_stop_label', slot: 'top', filter, ...extra });
  stopLayer('stop-bus', ['==', ['get', 'mode'], 'bus'], { type: 'circle', minzoom: 14.5,
    paint: { 'circle-radius': 2.6, 'circle-color': '#7aa2f7', 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1 } });
  stopLayer('stop-tram', ['==', ['get', 'mode'], 'tram'], { type: 'circle', minzoom: 13.5,
    paint: { 'circle-radius': 3.2, 'circle-color': '#e05a4f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  // станции: значок / точка / название — три независимых слоя на вид транспорта
  const S_FILTER = ['all', ['==', ['get', 'mode'], 'rail'], ['==', ['get', 'stop_type'], 'station']];
  map.addSource('ustations', { type: 'geojson', data: ust });
  const STN = {
    u: { src: { source: 'ustations' }, min: 10, nameMin: 12.5, side: -1, color: '#cfe4fb' },
    s: { src: { source: 'streets', 'source-layer': 'transit_stop_label', filter: S_FILTER }, min: 11, nameMin: 13, side: 1, color: '#cfe4fb' }
  };
  for (const [k, c] of Object.entries(STN)) {
    map.addLayer({ id: `stn-${k}-dot`, type: 'circle', slot: 'top', minzoom: c.min, ...c.src,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 15, 5], 'circle-color': '#fff', 'circle-stroke-color': '#0b0d10', 'circle-stroke-width': 1.4 } });
    map.addLayer({ id: `stn-${k}-icon`, type: 'symbol', slot: 'top', minzoom: c.min, ...c.src,
      layout: { 'icon-image': `badge-${k}`, 'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.36, 15, 0.62], 'icon-allow-overlap': true,
                'icon-offset': [c.side * 14, 0] } });
    map.addLayer({ id: `stn-${k}-name`, type: 'symbol', slot: 'top', minzoom: c.nameMin, ...c.src,
      layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'], 'text-optional': true,
                'text-anchor': c.side < 0 ? 'right' : 'left', 'text-offset': [c.side * 1.6, 0] },
      paint: { 'text-color': c.color, 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
  }

  // маршрут из калькулятора дороги
  map.addSource('route', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', slot: 'top', filter: ['!=', ['get', 'kind'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 9, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', slot: 'top', filter: ['!=', ['get', 'kind'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5.5 } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', slot: 'top', filter: ['==', ['get', 'kind'], 'walk'],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e8eaed', 'line-width': 3, 'line-dasharray': [0.1, 1.8] } });
  map.addLayer({ id: 'route-stops', type: 'circle', source: 'route', slot: 'top', filter: ['==', ['get', 'kind'], 'stop'],
    paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 } });

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
    paint: { 'fill-color': col, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 0.9, 14.8, 0] } });
  map.addLayer({ id: 'fp-glow', type: 'line', source: 'fp', slot: 'top',
    paint: { 'line-color': col, 'line-blur': 4, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 14, 0.5, 14.8, 0], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 14.8, 12] } });
  map.addSource('fp3d', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'fp-3d', type: 'fill-extrusion', source: 'fp3d', slot: 'top', minzoom: 13.8,
    paint: { 'fill-extrusion-color': ['case', ['get', 'sel'], '#ffc940', col], 'fill-extrusion-height': ['+', ['get', 'h'], 1.5],
             'fill-extrusion-base': 0, 'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13.8, 0, 14.6, 1],
             'fill-extrusion-emissive-strength': 0.8, 'fill-extrusion-vertical-gradient': true } });
  map.addLayer({ id: 'fp-sel', type: 'line', source: 'fp', slot: 'top', filter: ['get', 'sel'], maxzoom: 14.8,
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

  pushMapData();
  pushTransit();
  syncLayerToggles();
});

function ringCentroid(r) { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; }
function geomParts(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
/* оболочка: контур, раздвинутый на ~1 м от центра, чтобы наши стены стояли перед стенами Mapbox */
const MX = 111320 * Math.cos(48.2 * Math.PI / 180), MY = 110574;
function shell(g, meters = 1.1) {
  const polys = geomParts(g).map(poly => {
    const c = ringCentroid(poly[0]);
    return poly.map(ring => ring.map(([x, y]) => {
      const dx = (x - c[0]) * MX, dy = (y - c[1]) * MY, d = Math.hypot(dx, dy) || 1;
      const k = (d + meters) / d;
      return [c[0] + dx * k / MX, c[1] + dy * k / MY];
    }));
  });
  return { type: 'MultiPolygon', coordinates: polys };
}

function pushMapData() {
  if (!map.getSource('fp')) return;
  const show = S.buildings.filter(b => b.pass || !S.f.hideFail);
  map.getSource('fp').setData(fc(show.filter(b => b.footprint).map(b => ({ type: 'Feature',
    properties: { id: b.id, pass: !!b.pass, sel: S.selected === b.id, h: +b.height_m || 15 }, geometry: b.footprint }))));
  map.getSource('fp3d').setData(fc(show.filter(b => b.footprint).map(b => ({ type: 'Feature',
    properties: { id: b.id, pass: !!b.pass, sel: S.selected === b.id, h: +b.height_m || 15 }, geometry: shell(b.footprint) }))));
  map.getSource('ours').setData(fc(show.map(b => ({ type: 'Feature',
    properties: { id: b.id, pass: !!b.pass }, geometry: { type: 'Point', coordinates: [b.lng, b.lat] } }))));
  const POI_COLORS = { p: '#3b82f6', a: '#ec4899', both: '#22c55e' };
  map.getSource('poi').setData(fc(S.poi.map(p => ({ type: 'Feature',
    properties: { label: p.label, color: POI_COLORS[p.owner] || '#22c55e' }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }))));
  const ds = [...S.f.districts];
  map.setFilter('district-fill', ['in', ['get', 'district'], ['literal', ds]]);
  map.setFilter('district-line-sel', ['in', ['get', 'district'], ['literal', ds]]);
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
    sb.from('transit_lines_v2').select('mode,ref,colour,geom')
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
  let rows = t.data || [];
  if (!rows.length) { // новая таблица ещё не заполнена — берём прежние линии
    const old = await sb.from('transit_lines').select('mode,ref,colour,geom');
    rows = old.data || [];
  }
  for (const r of rows) {
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
  S.selected = null; stopOrbit(); clearRoute();
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
    <div class="noisebox" id="noiseBox"><b>Шум у дома</b><span class="rmeta">считаю…</span></div>
    ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}
    ${b.pass ? '' : `<div class="why">Не проходит: ${b.why.join(' · ')}</div>`}
    ${cards}
    <div class="routes"><div class="rhead"><b>Дорога</b><span class="rwhen">${esc(routeWhenLabel())}</span></div>
      <div id="routeList"></div>
      <form class="rcustom" id="routeCustom"><input id="routeQ" placeholder="Свой адрес: хобби, друзья…" autocomplete="off"><button>→</button></form>
      <div class="src">Маршруты: Wiener Linien / VOR (открытые данные)</div></div>`;
  loadRoutes(b);
  loadNoise(b);
}

/* ---------- дорога: как WienMobil (маршрутизатор Wiener Linien через нашу функцию) ---------- */
const CENTER = { id: 'center', label: 'Центр · Stephansplatz', owner: 'both', lng: 16.37241, lat: 48.20849 };
const U_COL = { U1: '#e20613', U2: '#a862a4', U3: '#ef7c00', U4: '#009540', U5: '#3cc8c0', U6: '#9d6930' };
const K_COL = { sbahn: '#1a8ccc', tram: '#e05a4f', bus: '#3b6fd8', wlb: '#0f6e8c', train: '#8b5cf6', walk: '#9aa1aa' };
const legColor = l => l.kind === 'subway' ? (U_COL[l.line] || '#e20613') : (K_COL[l.kind] || '#888');
const KIND_ICON = { walk: '🚶', subway: '', sbahn: '', tram: '🚋', bus: '🚌', wlb: '🚈', train: '🚆' };
S.routes = {};      // кэш: `${building}|${dest}` → ответ
S.routeOpen = null; // какой пункт раскрыт

/* типичное утро: ближайший вторник, выезд в 8:00 */
function routeWhen() {
  const d = new Date(); d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7 || 7));
  const p = n => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, time: '0800' };
}
function routeWhenLabel() { return 'будний день, выезд 8:00'; }

function chip(l) {
  if (l.kind === 'walk') return `<span class="lchip walk">🚶${l.min}</span>`;
  if (l.kind === 'subway') return `<span class="lchip" style="background:${legColor(l)}">${esc(l.line)}</span>`;
  if (l.kind === 'sbahn') return `<span class="lchip" style="background:${K_COL.sbahn}">${esc(l.line || 'S')}</span>`;
  return `<span class="lchip" style="background:${legColor(l)}">${KIND_ICON[l.kind] || ''}${esc(l.line)}</span>`;
}
function tripChips(t) { return t.legs.filter(l => l.kind !== 'walk' || l.min >= 3).map(chip).join('<i class="arr">›</i>'); }
function best(r) { return r && r.trips && r.trips.length ? r.trips.reduce((a, b) => b.duration < a.duration ? b : a) : null; }

async function fetchRoute(b, dest) {
  const key = `${b.id}|${dest.id}`;
  if (S.routes[key]) return S.routes[key];
  try { const c = JSON.parse(sessionStorage.getItem('wa_r_' + key) || 'null'); if (c) return (S.routes[key] = c); } catch {}
  const w = routeWhen();
  const { data, error } = await sb.functions.invoke('route', { body: { from: [b.lng, b.lat], to: [dest.lng, dest.lat], date: w.date, time: w.time, n: 4 } });
  if (error || !data || data.error) throw new Error((data && data.error) || (error && error.message) || 'нет ответа');
  S.routes[key] = data;
  try { sessionStorage.setItem('wa_r_' + key, JSON.stringify(data)); } catch {}
  return data;
}

function routeDests() { return [...S.poi.map(p => ({ id: p.id, label: p.label, owner: p.owner, lng: p.lng, lat: p.lat })), CENTER, ...(S.customDests || [])]; }

async function loadRoutes(b) {
  const box = $('routeList'); if (!box) return;
  const dests = routeDests();
  box.innerHTML = dests.map(d => `<div class="rrow" data-dest="${esc(d.id)}"><div class="rtop"><span class="rlabel"><i class="dot o-${d.owner || 'both'}"></i>${esc(d.label)}</span><span class="rmin">…</span></div><div class="rchips"></div><div class="ralts" hidden></div></div>`).join('');
  box.onclick = e => {
    const alt = e.target.closest('.ralt'); const row = e.target.closest('.rrow'); if (!row) return;
    const d = dests.find(x => String(x.id) === row.dataset.dest) || (S.customDests || []).find(x => String(x.id) === row.dataset.dest);
    const r = S.routes[`${b.id}|${d.id}`]; if (!r) return;
    if (alt) { drawTrip(r.trips[+alt.dataset.i], b, d); row.querySelectorAll('.ralt').forEach(a => a.classList.toggle('on', a === alt)); return; }
    const open = S.routeOpen === row.dataset.dest ? null : row.dataset.dest;
    S.routeOpen = open;
    box.querySelectorAll('.rrow').forEach(x => { x.classList.toggle('open', x.dataset.dest === open); x.querySelector('.ralts').hidden = x.dataset.dest !== open; });
    if (open) { renderAlts(row, r); const t = best(r); drawTrip(t, b, d); } else clearRoute();
  };
  const form = $('routeCustom');
  form.onsubmit = async e => { e.preventDefault(); const q = $('routeQ').value.trim(); if (q) addCustomDest(b, q); };
  await Promise.all(dests.map(async d => {
    const row = box.querySelector(`.rrow[data-dest="${CSS.escape(String(d.id))}"]`);
    try {
      const r = await fetchRoute(b, d); const t = best(r);
      if (S.selected !== b.id) return;
      if (!t) { row.querySelector('.rmin').textContent = 'нет маршрута'; return; }
      row.querySelector('.rmin').innerHTML = `<b>${t.duration}</b> мин`;
      row.querySelector('.rchips').innerHTML = tripChips(t) +
        `<span class="rmeta">${t.interchanges ? t.interchanges + ' пересад.' : 'без пересадок'} · пешком ${t.walk} мин</span>`;
    } catch (err) {
      row.querySelector('.rmin').textContent = '—';
      row.querySelector('.rchips').innerHTML = `<span class="rmeta">не получилось: ${esc(err.message)}</span>`;
    }
  }));
}

function renderAlts(row, r) {
  const trips = [...r.trips].sort((a, b) => a.duration - b.duration);
  r.trips = trips;
  row.querySelector('.ralts').innerHTML = trips.map((t, i) => `
    <div class="ralt${i === 0 ? ' on' : ''}" data-i="${i}">
      <div class="atop"><b>${t.dep}–${t.arr}</b><span>${t.duration} мин · ${t.interchanges} пересад. · 🚶${t.walk}</span></div>
      <ol class="legs">${t.legs.map(l => l.kind === 'walk'
        ? `<li class="walk">🚶 пешком ${l.min} мин${l.to ? ' → ' + esc(l.to) : ''}</li>`
        : `<li>${chip(l)} <span>${esc(l.from)} → ${esc(l.to)}</span><em>${l.dep}–${l.arr}${l.stops ? ' · ' + l.stops + ' ост.' : ''}${l.dest ? ' · напр. ' + esc(l.dest) : ''}</em></li>`).join('')}</ol>
    </div>`).join('');
}

function drawTrip(t, b, d) {
  if (!t || !map.getSource('route')) return;
  const feats = [];
  for (const l of t.legs) {
    if (l.path && l.path.length > 1) feats.push({ type: 'Feature', properties: { kind: l.kind, color: legColor(l) }, geometry: { type: 'LineString', coordinates: l.path } });
    if (l.kind !== 'walk' && l.path && l.path.length) for (const p of [l.path[0], l.path[l.path.length - 1]])
      feats.push({ type: 'Feature', properties: { kind: 'stop', color: legColor(l) }, geometry: { type: 'Point', coordinates: p } });
  }
  map.getSource('route').setData(fc(feats));
  stopOrbit();
  const bb = new mapboxgl.LngLatBounds([b.lng, b.lat], [b.lng, b.lat]); bb.extend([d.lng, d.lat]);
  for (const f of feats) (f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(c => bb.extend(c));
  map.fitBounds(bb, { padding: Object.fromEntries(Object.entries(detailPad()).map(([k, v]) => [k, v + 40])), pitch: 35, bearing: 0, duration: 1400, maxZoom: 15 });
}
function clearRoute() { S.routeOpen = null; map.getSource('route')?.setData(fc([])); }

async function addCustomDest(b, q) {
  try {
    const u = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&proximity=16.3738,48.2082&bbox=16.18,48.11,16.58,48.33&language=de&limit=1&access_token=${CFG.MAPBOX_TOKEN}`;
    const r = await (await fetch(u)).json(); const f = r.features && r.features[0];
    if (!f) { toast('Адрес не нашёлся в Вене'); return; }
    const [lng, lat] = f.geometry.coordinates;
    const label = f.properties.name || q;
    S.customDests = [...(S.customDests || []).filter(x => x.label !== label), { id: 'c' + Date.now(), label, owner: 'both', lng, lat }].slice(-4);
    loadRoutes(b);
  } catch { toast('Поиск адреса не ответил'); }
}

/* ---------- шум у дома: зоны 2022 вокруг контура ---------- */
S.noise = {};
function fpBbox(b) {
  const pts = geomParts(b.footprint).flatMap(p => p[0]);
  if (!pts.length) return [b.lng - 0.0002, b.lat - 0.00013, b.lng + 0.0002, b.lat + 0.00013];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const NOISE_NAMES = { strasse: 'улица', schiene: 'ж/д и трамвай', industrie: 'завод', flug: 'самолёты' };
const dbClass = v => v >= 70 ? 'n-hi' : v >= 60 ? 'n-mid' : 'n-lo';
async function loadNoise(b) {
  const box = $('noiseBox'); if (!box) return;
  try {
    let r = S.noise[b.id];
    if (!r) {
      const { data, error } = await sb.functions.invoke('route', { body: { bbox: fpBbox(b) } });
      if (error || !data || data.error) throw new Error((data && data.error) || (error && error.message));
      r = S.noise[b.id] = data.noise;
    }
    if (S.selected !== b.id) return;
    const rows = Object.entries(NOISE_NAMES).map(([k, name]) => {
      const d = r[k]?.lden, n = r[k]?.lnight;
      if (!d && !n) return '';
      const f = x => x ? (x.max >= 75 ? '75+' : `${x.max}–${x.max + 4}`) : '<45';
      return `<div class="nrow"><span>${name}</span><span class="${dbClass(d?.max || 0)}">днём ${d ? f(d) : '<55'} дБ</span><span class="${dbClass((n?.max || 0) + 10)}">ночью ${f(n)} дБ</span></div>`;
    }).join('');
    box.innerHTML = `<b>Шум у дома</b><span class="rmeta">самый громкий фасад · карты 2022</span>${rows || '<div class="nrow"><span>Тихо: ни один источник не даёт у фасада 55 дБ днём</span></div>'}`;
  } catch (e) {
    box.innerHTML = `<b>Шум у дома</b><span class="rmeta">не получилось: ${esc(e.message)}</span>`;
  }
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
$('themeBtn').onclick = () => { const t = THEME_ORDER[(THEME_ORDER.indexOf(S.theme) + 1) % THEME_ORDER.length]; applyTheme(t); toast('Тема: ' + THEME_NAMES[t], 1400); };
$('modeSeg').onclick = e => {
  const m = e.target.dataset.mode; if (!m) return;
  S.mode = m; seg('modeSeg', m, 'mode');
  if (m === 'buy') toast('Режим покупки — этап 8. Пока показываются только дома, отмеченные для покупки.', 4000);
  applyFilters();
};
addEventListener('resize', () => map.setPadding(S.selected ? detailPad() : basePad()));

/* ---------- слои ---------- */
const LAYER_GROUPS = {
  lMetro:  ['tx-subway-casing', 'tx-subway', 'tx-subway-label'],
  lSbahn:  ['tx-sbahn-casing', 'tx-sbahn', 'tx-sbahn-label'],
  lTram:   ['tx-tram', 'tx-tram-label', 'stop-tram'],
  lBus:    ['tx-bus', 'tx-bus-label', 'stop-bus'],
  lDistricts: ['district-line', 'district-label'],
  lPoi:    ['poi-dot', 'poi-label'],
  lPlanned: ['pl-line', 'pl-line-label', 'pl-stn', 'pl-stn-label']
};
function vis(ids, on) { ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')); }
function syncLayerToggles() {
  if (!map.getLayer('fp-fill')) return;
  for (const [cb, ids] of Object.entries(LAYER_GROUPS)) vis(ids, $(cb).checked);
  // станции: значки или точки, названия отдельно
  const icons = $('lStnIcons').checked, names = $('lStnNames').checked;
  for (const [k, cb] of [['u', 'lMetro'], ['s', 'lSbahn']]) {
    const on = $(cb).checked, side = k === 'u' ? -1 : 1;
    vis([`stn-${k}-icon`], on && icons);
    vis([`stn-${k}-dot`], on && !icons);
    vis([`stn-${k}-name`], on && names);
    if (map.getLayer(`stn-${k}-name`)) map.setLayoutProperty(`stn-${k}-name`, 'text-offset', [side * (icons ? 1.6 : 0.7), 0]);
  }
  map.setConfigProperty('basemap', 'show3dObjects', $('l3d').checked);
  map.setConfigProperty('basemap', 'showPointOfInterestLabels', $('lPoiLabels').checked);
  map.setConfigProperty('basemap', 'colorGreenspace', $('lGreen').checked ? GREEN_ON : THEMES[S.theme].colorGreenspace);
  const per = $('noiseNight').checked ? 'night' : 'day';
  for (const k of NOISE_KEYS) for (const p of ['day', 'night'])
    vis([`noise-${k}-${p}`], $('n_' + k).checked && p === per);
  const any = NOISE_KEYS.find(k => $('n_' + k).checked);
  const lg = $('noiseLegend');
  if (any) {
    lg.src = `${NOISE_WMS}?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&sld_version=1.1.0&layer=2022_STRASSE_${per === 'day' ? '24H' : 'NACHT'}_ZONEN_OE`;
    lg.hidden = false;
  } else lg.hidden = true;
  localSet('layers', JSON.stringify(Object.fromEntries([...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen', 'n_strasse', 'n_schiene', 'n_industrie', 'n_flug', 'noiseNight', 'lStnIcons', 'lStnNames'].map(k => [k, $(k).checked]))));
}
try { const saved = JSON.parse(localGet('layers', '{}')); for (const [k, v] of Object.entries(saved)) if ($(k)) $(k).checked = v; } catch {}
[...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen', 'n_strasse', 'n_schiene', 'n_industrie', 'n_flug', 'noiseNight', 'lStnIcons', 'lStnNames'].forEach(id => $(id).onchange = syncLayerToggles);
$('noiseDay').onchange = syncLayerToggles;
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
