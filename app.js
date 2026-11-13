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
  c: { months: 36, furn: 10000, rec: 40, eq: +localGet('c_eq', 20), rate: +localGet('c_rate2', 3.75), years: +localGet('c_years', 30), income: +localGet('c_income', 0) },
  rates: [],
  stats: {},
  market: [], favs: new Set(), osm: [], listView: 'ours'
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

  // рядом с домом: магазины, аптеки, почта, боксы (OSM)
  map.addSource('osm', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'osm-dot', type: 'circle', source: 'osm', slot: 'top', minzoom: 11, layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6], 'circle-color': ['get', 'color'],
             'circle-stroke-color': '#0b0d10', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'osm-label', type: 'symbol', source: 'osm', slot: 'top', minzoom: 14.5, layout: { visibility: 'none',
      'text-field': ['get', 'label'], 'text-size': 10.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
  map.on('click', 'osm-dot', e => { const p = e.features[0].properties;
    new mapboxgl.Popup({ closeButton: false, className: 'mkpop' }).setLngLat(e.lngLat)
      .setHTML(`<b>${esc(p.label)}</b>${p.name && p.name !== p.label ? '<br>' + esc(p.name) : ''}${p.hours ? '<br><small>' + esc(p.hours) + '</small>' : ''}`).addTo(map); });

  // объявления из ленты
  map.addSource('mk', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'mk-dot', type: 'circle', source: 'mk', slot: 'top', layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['get', 'isNew'], 4, 3], 16, ['case', ['get', 'isNew'], 8, 6]],
             'circle-color': ['case', ['get', 'fav'], '#facc15', ['get', 'fit'], '#5eead4', '#6b7280'],
             'circle-stroke-color': ['case', ['get', 'isNew'], '#ffffff', '#0b0d10'], 'circle-stroke-width': ['case', ['get', 'isNew'], 2, 1] } });
  map.on('click', 'mk-dot', e => mkPopup(+e.features[0].properties.id, e.lngLat));
  for (const id of ['mk-dot', 'osm-dot']) { map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', id, () => map.getCanvas().style.cursor = ''); }

  // солнце
  map.addSource('sun', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'sun-ring', type: 'line', source: 'sun', slot: 'top', filter: ['==', ['get', 't'], 'ring'], layout: { visibility: 'none' },
    paint: { 'line-color': '#e8eaed', 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [1, 2] } });
  map.addLayer({ id: 'sun-line', type: 'line', source: 'sun', slot: 'top', filter: ['==', ['get', 't'], 'ray'], layout: { visibility: 'none', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'w'], 'line-dasharray': [2, 1.2] } });
  map.addLayer({ id: 'sun-label', type: 'symbol', source: 'sun', slot: 'top', filter: ['==', ['get', 't'], 'label'], layout: { visibility: 'none',
      'text-field': ['get', 'text'], 'text-size': ['get', 'size'], 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.4 } });

  // кандидат на добавление
  map.addSource('cand', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'cand-fill', type: 'fill', source: 'cand', slot: 'top', paint: { 'fill-color': '#ffb300', 'fill-opacity': 0.35 } });
  map.addLayer({ id: 'cand-line', type: 'line', source: 'cand', slot: 'top', paint: { 'line-color': '#ffb300', 'line-width': 3, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'cand-pt', type: 'circle', source: 'cand', slot: 'top', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 9, 'circle-color': '#ffb300', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });

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
  map.addLayer({ id: 'route-label', type: 'symbol', source: 'route', slot: 'top', filter: ['all', ['!=', ['get', 'kind'], 'walk'], ['!=', ['get', 'kind'], 'stop'], ['has', 'name']],
    layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'name'], 'text-size': 13, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true },
    paint: { 'text-color': '#fff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 3 } });
  map.addLayer({ id: 'route-stop-name', type: 'symbol', source: 'route', slot: 'top', filter: ['all', ['==', ['get', 'kind'], 'stop'], ['has', 'name']],
    layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true, 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
    paint: { 'text-color': '#e8eaed', 'text-halo-color': '#000', 'text-halo-width': 1.4 } });

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
  loadMarket(); loadOsm();
  sb.from('mortgage_rates').select('*').order('sort').then(r => { S.rates = r.data || []; });
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
  renderQueue();
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
  const ls = buildingListings(b);
  const fit = ls.filter(l => {
    const price = S.f.basis === 'gross' ? +l.rent_gross : +l.monthly_total;
    return (S.mode === 'buy' || price <= S.f.budget) && (+l.rooms || 0) >= S.f.rooms && (+l.area_m2 || 0) >= S.f.area;
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
  renderFeed(); pushMarket();
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
          <div class="bmeta">${b.district ? b.district + '-й район' : 'район ?'}${b.year_built ? ' · ' + b.year_built : ''}${b.height_m ? ' · ' + Math.round(b.height_m) + ' м' : ''}${b.ls.length ? ' · ' + b.ls.length + ' объявл.' : ''}</div>
        </div>
        <div class="bprice">${isFinite(p) ? 'от ' + eur(p) : '—'}<small>${S.mode === 'buy' ? 'цена' : S.f.basis === 'gross' ? 'грязная' : 'полная/мес'}</small></div>
      </div>
      ${b.research_status === 'queued' ? '<div class="queued">⏳ на разборе: Claude соберёт данные и объявления</div>' : ''}
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
  $('lview').hidden = true; $('feedPanel').hidden = true;
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
  if ($('lSun').checked) pushSun();
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
  const am = AMEN.map(([k, t]) => `<span class="${b[k] ? '' : 'no'}">${t}</span>`).join('');
  const ls = buildingListings(b).sort((x, y) => (+x.rent_gross || 9e9) - (+y.rent_gross || 9e9));
  const cards = ls.map(listingCard).join('');
  $('detailBody').innerHTML = `
    <div class="dname">${esc(b.name || b.street)}</div>
    <div class="daddr">${esc([b.street, b.house_no].filter(Boolean).join(' '))}, ${esc(b.zip || '')} · ${b.district ? b.district + '-й район' : ''} · ${STATUS[b.our_status] || ''}</div>
    <div class="facts">
      <div class="fact"><b>${b.year_built || '—'}</b><span>год</span></div>
      <div class="fact"><b>${b.height_m ? Math.round(b.height_m) + ' м' : (b.floors_total || '—')}</b><span>${b.height_m ? 'высота' : 'этажей'}</span></div>
      <div class="fact"><b>${b.hwb_class || (b.fgee ? 'fGEE ' + b.fgee : '—')}</b><span>энергия</span></div>
    </div>
    ${(b.photos || []).length ? `<div class="gal bgal">${b.photos.slice(0, 30).map(p => `<a href="${esc(p.page || p.url)}" target="_blank" rel="noopener" title="${esc(p.source || '')}"><img src="${esc(p.url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></a>`).join('')}</div>
      <div class="src">Фото: ${[...new Set(b.photos.map(p => p.source))].map(esc).join(', ')} · нажми на фото — откроется источник</div>` : ''}
    <div class="amen">${am}</div>
    ${b.notes ? `<div class="note">${esc(b.notes)}</div>` : ''}
    ${b.pass ? '' : `<div class="why">Не проходит: ${b.why.join(' · ')}</div>`}
    <div class="lhead2"><b>Объявления</b><span class="rmeta">${ls.length ? ls.length + ' · листай →' : 'сейчас нет'}</span></div>
    <div class="lscroll">${cards || '<p class="hint">Сейчас в этом доме ничего не сдаётся. Сборщик проверяет каждое утро.</p>'}</div>
    ${section('noise', 'Шум у дома', '<div id="noiseBox"><span class="rmeta">считаю…</span></div>', '<span id="noiseSum"></span>')}
    ${section('route', 'Дорога', `<div class="rwhen">${esc(routeWhenLabel())}</div>
      <div id="routeList"></div>
      <form class="rcustom" id="routeCustom"><input id="routeQ" placeholder="Свой адрес: хобби, друзья…" autocomplete="off"><button>→</button></form>
      <div class="src">Транспорт: Wiener Linien / VOR · машина: Mapbox</div>`, '<span id="routeSum"></span>')}`;
  $('detailBody').querySelectorAll('.sec-h').forEach(h => h.onclick = () => {
    const sec = h.parentElement, k = sec.dataset.k, open = !sec.classList.contains('open');
    sec.classList.toggle('open', open); localSet('sec_' + k, open ? '1' : '0');
  });
  $('detailBody').querySelector('.lscroll').onclick = e => { const st = e.target.closest('.star'); if (st) { e.preventDefault(); toggleFav(+st.dataset.id); return; }
    const a = e.target.closest('.mcard[data-mid]'); const g = a && (S.mkGroups || []).find(q => String(q.mid) === a.dataset.mid); if (g) { e.preventDefault(); openListing(g); } };
  loadRoutes(b);
  loadNoise(b);
}
function section(k, title, body, sum) {
  const open = localGet('sec_' + k, k === 'route' ? '0' : '1') === '1';
  return `<div class="sec${open ? ' open' : ''}" data-k="${k}"><div class="sec-h"><i class="chev">›</i><b>${title}</b>${sum}</div><div class="sec-b">${body}</div></div>`;
}
function listingCard(l) {
  const days = l.first_seen ? Math.max(0, Math.round((Date.now() - new Date(l.published_at || l.first_seen)) / 864e5)) : null;
  const ppm = l.rent_gross && l.area_m2 ? (l.rent_gross / l.area_m2).toFixed(1) : null;
  const drop = (l.price_history || []).filter(x => x.to < x.from).length;
  return `<a class="mcard${S.mode === 'rent' && l.rent_gross > S.f.budget ? ' over' : ''}" href="${esc(l.url || '#')}" target="_blank" rel="noopener"${l.mid ? ` data-mid="${l.mid}"` : ''}>
    <div class="mtop"><b>${eur(l.rent_gross)}</b>${l.mid ? `<span class="star${S.favs.has(l.mid) ? ' on' : ''}" data-id="${l.mid}">★</span>` : ''}</div>
    <div class="mmeta">${l.area_m2 ? Math.round(l.area_m2) + ' м²' : '? м²'} · ${l.rooms ? +l.rooms + ' комн.' : '—'}${ppm ? ' · ' + ppm + ' €/м²' : ''}</div>
    ${S.mode === 'buy' && l.market && l.rent_gross ? `<div class="mmort">≈ ${eur(buyCalc({ ...l, price: +l.rent_gross }).monthly)}/мес ипотека</div>` : ''}
    <div class="mtitle">${esc((l.title || '').slice(0, 70))}</div>
    <div class="msrc">${(l.srcs || [l.source || 'наша база']).map(x => `<span>${esc(x)}</span>`).join('')}${days != null ? `<em>${days ? days + ' дн.' : 'новое'}</em>` : ''}${drop ? '<em class="drop">цена ↓</em>' : ''}</div>
  </a>`;
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
function routeWhenLabel() { return 'будни, выезд 8:00, бодрым шагом'; }

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
  try { const c = JSON.parse(sessionStorage.getItem('wa_r2_' + key) || 'null'); if (c) return (S.routes[key] = c); } catch {}
  const w = routeWhen();
  const { data, error } = await sb.functions.invoke('route', { body: { from: [b.lng, b.lat], to: [dest.lng, dest.lat], date: w.date, time: w.time, n: 4 } });
  if (error || !data || data.error) throw new Error((data && data.error) || (error && error.message) || 'нет ответа');
  S.routes[key] = data;
  try { sessionStorage.setItem('wa_r2_' + key, JSON.stringify(data)); } catch {}
  return data;
}

function routeDests() { return [...S.poi.map(p => ({ id: p.id, label: p.label, owner: p.owner, lng: p.lng, lat: p.lat })), CENTER, ...(S.customDests || [])]; }

async function loadRoutes(b) {
  const box = $('routeList'); if (!box) return;
  S.rsum = {};
  const dests = routeDests();
  box.innerHTML = dests.map(d => `<div class="rrow" data-dest="${esc(d.id)}"><div class="rtop"><span class="rlabel"><i class="dot o-${d.owner || 'both'}"></i>${esc(d.label)}</span><span class="rmin">…</span></div><div class="rchips"></div><div class="ralts" hidden></div></div>`).join('');
  box.onclick = e => {
    const alt = e.target.closest('.ralt'); const row = e.target.closest('.rrow'); if (!row) return;
    const d = dests.find(x => String(x.id) === row.dataset.dest) || (S.customDests || []).find(x => String(x.id) === row.dataset.dest);
    const r = S.routes[`${b.id}|${d.id}`]; if (!r) return;
    if (alt && alt.dataset.car) { drawCar(S.car[`${b.id}|${d.id}`], b, d); row.querySelectorAll('.ralt').forEach(a => a.classList.toggle('on', a === alt)); return; }
    if (alt) { drawTrip(r.trips[+alt.dataset.i], b, d); row.querySelectorAll('.ralt').forEach(a => a.classList.toggle('on', a === alt)); return; }
    const open = S.routeOpen === row.dataset.dest ? null : row.dataset.dest;
    S.routeOpen = open;
    box.querySelectorAll('.rrow').forEach(x => { x.classList.toggle('open', x.dataset.dest === open); x.querySelector('.ralts').hidden = x.dataset.dest !== open; });
    if (open) { renderAlts(row, r, S.car[`${b.id}|${d.id}`]); const t = best(r); drawTrip(t, b, d); } else clearRoute();
  };
  const form = $('routeCustom');
  form.onsubmit = async e => { e.preventDefault(); const q = $('routeQ').value.trim(); if (q) addCustomDest(b, q); };
  dests.forEach(async d => {
    const row = box.querySelector(`.rrow[data-dest="${CSS.escape(String(d.id))}"]`);
    try {
      const c = await fetchCar(b, d);
      if (S.selected !== b.id || !c) return;
      let el = row.querySelector('.rcar'); if (!el) { el = document.createElement('div'); el.className = 'rcar'; row.querySelector('.rchips').after(el); }
      el.innerHTML = `🚗 на машине <b>${c.min}</b> мин · ${c.km} км <span class="rmeta">(с пробками в будни 8:00)</span>`;
    } catch {}
  });
  await Promise.all(dests.map(async d => {
    const row = box.querySelector(`.rrow[data-dest="${CSS.escape(String(d.id))}"]`);
    try {
      const r = await fetchRoute(b, d); const t = best(r);
      if (S.selected !== b.id) return;
      if (!t) { row.querySelector('.rmin').textContent = 'нет маршрута'; return; }
      row.querySelector('.rmin').innerHTML = `<b>${t.duration}</b> мин`;
      setRouteSum(d, t.duration);
      row.querySelector('.rchips').innerHTML = tripChips(t) +
        `<span class="rmeta">${t.interchanges ? t.interchanges + ' пересад.' : 'без пересадок'} · пешком ${t.walk} мин</span>`;
    } catch (err) {
      row.querySelector('.rmin').textContent = '—';
      row.querySelector('.rchips').innerHTML = `<span class="rmeta">не получилось: ${esc(err.message)}</span>`;
    }
  }));
}

function renderAlts(row, r, car) {
  const trips = [...r.trips].sort((a, b) => a.duration - b.duration);
  r.trips = trips;
  const carHtml = car ? `<div class="ralt" data-car="1"><div class="atop"><b>🚗 На машине</b><span>${car.min} мин · ${car.km} км · без пробок ${car.free} мин</span></div></div>` : '';
  row.querySelector('.ralts').innerHTML = carHtml + trips.map((t, i) => `
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
    const nm = l.kind === 'walk' ? undefined : (l.line || undefined);
    if (l.path && l.path.length > 1) feats.push({ type: 'Feature', properties: { kind: l.kind, color: legColor(l), ...(nm ? { name: nm } : {}) }, geometry: { type: 'LineString', coordinates: l.path } });
    if (l.kind !== 'walk' && l.path && l.path.length) [[l.path[0], l.from], [l.path[l.path.length - 1], l.to]].forEach(([p, n]) =>
      feats.push({ type: 'Feature', properties: { kind: 'stop', color: legColor(l), ...(n ? { name: String(n) } : {}) }, geometry: { type: 'Point', coordinates: p } }));
  }
  map.getSource('route').setData(fc(feats));
  focusRoute(true); stopOrbit();
  const bb = new mapboxgl.LngLatBounds([b.lng, b.lat], [b.lng, b.lat]); bb.extend([d.lng, d.lat]);
  for (const f of feats) (f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(c => bb.extend(c));
  map.fitBounds(bb, { padding: Object.fromEntries(Object.entries(detailPad()).map(([k, v]) => [k, v + 40])), pitch: 35, bearing: 0, duration: 1400, maxZoom: 15 });
}
/* машина: Mapbox Directions с типичными пробками на будний день 8:00 */
S.car = {};
async function fetchCar(b, d) {
  const key = `${b.id}|${d.id}`;
  if (S.car[key]) return S.car[key];
  const w = routeWhen(), dt = `${w.date.slice(0, 4)}-${w.date.slice(4, 6)}-${w.date.slice(6, 8)}T08:00`;
  const base = `https://api.mapbox.com/directions/v5/mapbox`, xy = `${b.lng},${b.lat};${d.lng},${d.lat}`;
  const q = `geometries=geojson&overview=simplified&access_token=${CFG.MAPBOX_TOKEN}`;
  const [t, f] = await Promise.all([
    fetch(`${base}/driving-traffic/${xy}?${q}&depart_at=${dt}`).then(r => r.json()),
    fetch(`${base}/driving/${xy}?${q}`).then(r => r.json())
  ]);
  const rt = t.routes && t.routes[0], rf = f.routes && f.routes[0];
  if (!rt && !rf) return null;
  const main = rt || rf;
  return (S.car[key] = { min: Math.round(main.duration / 60), free: Math.round((rf || main).duration / 60), km: (main.distance / 1000).toFixed(1), coords: main.geometry.coordinates });
}
function drawCar(c, b, d) {
  if (!c || !map.getSource('route')) return;
  const feats = [{ type: 'Feature', properties: { kind: 'car', color: '#e8eaed' }, geometry: { type: 'LineString', coordinates: c.coords } }];
  map.getSource('route').setData(fc(feats));
  focusRoute(true); stopOrbit();
  const bb = new mapboxgl.LngLatBounds([b.lng, b.lat], [b.lng, b.lat]); c.coords.forEach(x => bb.extend(x)); bb.extend([d.lng, d.lat]);
  map.fitBounds(bb, { padding: Object.fromEntries(Object.entries(detailPad()).map(([k, v]) => [k, v + 40])), pitch: 35, bearing: 0, duration: 1400, maxZoom: 15 });
}
function clearRoute() { S.routeOpen = null; map.getSource('route')?.setData(fc([])); focusRoute(false); }
/* режим маршрута: гасим все линии транспорта, станции, точки «рядом с домом» и объявления — виден только наш путь */
const FOCUS_RX = /^(tx-|stn-|pl-|osm-|mk-|sun-|dev-)/;
function focusRoute(on) {
  if (!map.getStyle()) return;
  if (on) {
    if (S.focusSaved) return;
    S.focusSaved = {};
    for (const l of map.getStyle().layers) if (FOCUS_RX.test(l.id)) {
      const v = map.getLayoutProperty(l.id, 'visibility') || 'visible'; S.focusSaved[l.id] = v;
      if (v !== 'none') map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    $('routeFocus').hidden = false;
  } else {
    if (!S.focusSaved) return;
    for (const [id, v] of Object.entries(S.focusSaved)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    S.focusSaved = null;
    $('routeFocus').hidden = true;
  }
}

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
    box.innerHTML = `<span class="rmeta">самый громкий фасад · карты 2022</span>${rows || '<div class="nrow"><span>Тихо: ни один источник не даёт у фасада 55 дБ днём</span></div>'}`;
    const mx = Math.max(0, ...Object.values(r).map(x => x?.lden?.max || 0));
    if ($('noiseSum')) $('noiseSum').innerHTML = mx ? `<span class="${dbClass(mx)}">до ${mx >= 75 ? '75+' : mx + 4} дБ днём</span>` : '<span class="n-lo">тихо</span>';
  } catch (e) {
    box.innerHTML = `<span class="rmeta">не получилось: ${esc(e.message)}</span>`;
  }
}

/* ---------- добавить дом: поиск по названию ЖК или адресу ---------- */
const ADD = { cand: null };
$('addBtn').onclick = () => { const bx = $('addBox'); bx.hidden = !bx.hidden; if (!bx.hidden) $('addQ').focus(); };
$('addForm').onsubmit = async e => {
  e.preventDefault();
  const q = $('addQ').value.trim(); if (!q) return;
  $('addRes').innerHTML = '<p class="hint">Ищу…</p>';
  try {
    const u = `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(q)}&proximity=16.3738,48.2082&bbox=16.18,48.11,16.58,48.33&language=de&limit=6&types=poi,address&access_token=${CFG.MAPBOX_TOKEN}`;
    const r = await (await fetch(u)).json();
    const list = (r.features || []).map(f => {
      const p = f.properties || {}, c = p.context || {};
      return { name: p.feature_type === 'poi' ? p.name : '', label: p.name, addr: p.full_address || p.place_formatted || '',
        street: c.address?.street_name || c.street?.name || '', house: c.address?.address_number || '', zip: c.postcode?.name || '',
        lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: p.feature_type };
    });
    ADD.list = list;
    $('addRes').innerHTML = list.length ? list.map((x, i) => `<div class="addhit" data-i="${i}"><b>${esc(x.label)}</b><span>${esc(x.addr)}</span></div>`).join('')
      : '<p class="hint">Ничего не нашлось в Вене. Попробуй адрес: «Arsenalstraße 8».</p>';
  } catch { $('addRes').innerHTML = '<p class="hint">Поиск не ответил, попробуй ещё раз.</p>'; }
};
$('addPick').onclick = () => {
  toast('Ткни на нужный дом на карте', 3000);
  if (!DESKTOP()) $('sheet').classList.add('min');
  map.getCanvas().style.cursor = 'crosshair';
  map.once('click', async e => {
    map.getCanvas().style.cursor = '';
    const { lng, lat } = e.lngLat;
    let c = { name: '', label: '', addr: '', street: '', house: '', zip: '', lng, lat };
    try {
      const r = await (await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&types=address&language=de&access_token=${CFG.MAPBOX_TOKEN}`)).json();
      const f = r.features && r.features[0];
      if (f) { const p = f.properties, cx = p.context || {}; c = { ...c, addr: p.full_address || p.name, street: cx.address?.street_name || cx.street?.name || '', house: cx.address?.address_number || '', zip: cx.postcode?.name || '' }; }
    } catch {}
    pickCandidate(c);
  });
};
$('addRes').onclick = e => { const h = e.target.closest('.addhit'); if (h) pickCandidate(ADD.list[+h.dataset.i]); };

function ringAreaM2(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * MX) * (r[i][1] * MY) - (r[i][0] * MX) * (r[j][1] * MY); return Math.abs(a / 2); }
function pickCandidate(c) {
  closeDetail();
  if (!DESKTOP()) $('sheet').classList.add('min');
  map.flyTo({ center: [c.lng, c.lat], zoom: 17, pitch: 45, bearing: -20, padding: basePad(), duration: 1800 });
  map.once('idle', () => {
    let fp = null, h = null;
    try {
      const pt = map.project([c.lng, c.lat]);
      const box = [[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]];
      const hits = map.queryRenderedFeatures(box, { target: BUILDINGS_TARGET });
      const f = hits.find(x => x.geometry && /Polygon/.test(x.geometry.type));
      if (f) { fp = f.geometry; h = +(f.properties.height || f.properties.render_height || 0) || null; }
    } catch {}
    const area = fp ? geomParts(fp).reduce((s, p) => s + ringAreaM2(p[0]), 0) : 0;
    ADD.cand = { ...c, fp: area > 0 && area < 20000 ? fp : null, h, area };
    map.getSource('cand').setData(fc([ADD.cand.fp ? { type: 'Feature', properties: {}, geometry: ADD.cand.fp } : { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } }]));
    $('acAddr').textContent = [c.street && (c.street + ' ' + c.house), c.zip].filter(Boolean).join(', ') || c.addr;
    $('acName').value = c.name || '';
    $('acNote').textContent = ADD.cand.fp ? `Контур найден: ~${Math.round(area)} м²${h ? ', высота ~' + Math.round(h) + ' м' : ''}. Если подсветился весь квартал — жми «Только точкой».`
      : (area >= 20000 ? 'Mapbox отдаёт целый квартал одним куском — добавлю точкой, контур поправлю при разборе.' : 'Контур здания не нашёлся — добавлю точкой, контур поправлю при разборе.');
    $('acPoint').hidden = !ADD.cand.fp;
    $('addConfirm').hidden = false;
  });
}
async function confirmAdd(usePoint) {
  const c = ADD.cand; if (!c) return;
  $('acOk').disabled = true;
  const { data, error } = await sb.rpc('add_building', {
    p_name: $('acName').value.trim(), p_street: c.street || null, p_house_no: c.house || null, p_zip: c.zip || null,
    p_lng: c.lng, p_lat: c.lat, p_footprint: usePoint ? null : c.fp, p_height: c.h, p_query: $('addQ').value.trim()
  });
  $('acOk').disabled = false;
  if (error) { toast('Не добавилось: ' + error.message, 5000); return; }
  cancelAdd(); $('addBox').hidden = true; $('addQ').value = ''; $('addRes').innerHTML = '';
  toast('Дом добавлен. Он в очереди на разбор — напиши Claude «разбери новые дома».', 5000);
  await load();
  if (data) select(data);
}
function cancelAdd() { ADD.cand = null; $('addConfirm').hidden = true; map.getSource('cand')?.setData(fc([])); }
$('acOk').onclick = () => confirmAdd(false);
$('acPoint').onclick = () => confirmAdd(true);
$('acCancel').onclick = cancelAdd;

function setRouteSum(d, min) {
  if (d.id === 'center' || String(d.id).startsWith('c')) return;
  S.rsum[d.id] = { min, label: d.owner === 'p' ? 'он' : d.owner === 'a' ? 'Ариша' : 'зал' };
  const el = $('routeSum'); if (!el) return;
  el.textContent = Object.values(S.rsum).sort((a, b) => a.label.localeCompare(b.label)).map(x => `${x.label} ${x.min}`).join(' · ') + ' мин';
}

/* ---------- рынок: объявления со всех сайтов (собираются каждое утро) ---------- */
const MK_COLS = 'id,source,url,title,street,house_no,zip,district,lng,lat,price,area_m2,rooms,is_private,published_at,first_seen,price_history,building_id,pid:raw->>project_id';
async function loadMarket() {
  const deal = S.mode, rows = [];
  const page = i => sb.from('market_listings').select(MK_COLS).is('removed_at', null).eq('deal_type', deal).order('id').range(i * 1000, i * 1000 + 999);
  const [f, st] = await Promise.all([sb.from('market_favorites').select('listing_id'), sb.from('district_stats').select('*')]);
  for (let i = 0; i < 60; i += 4) {
    const rs = await Promise.all([0, 1, 2, 3].map(k => page(i + k)));
    const err = rs.find(r => r.error); if (err) { console.warn(err.error); break; }
    rs.forEach(r => rows.push(...r.data));
    if (rs.some(r => r.data.length < 1000)) break;
  }
  if (deal !== S.mode) return; // режим успели переключить
  S.stats = Object.fromEntries((st.data || []).map(x => [x.district, x]));
  S.market = rows.map(x => ({ ...x, price: +x.price || null, area_m2: +x.area_m2 || null, rooms: +x.rooms || null }));
  S.favs = new Set((f.data || []).map(x => +x.listing_id));
  S.mkGroups = groupMarket(S.market);
  applyFilters();
  renderFeed();
}
// одна квартира на нескольких сайтах — одна карточка
function groupMarket(list) {
  const g = new Map();
  for (const x of list) {
    const k = [x.building_id || ((x.street || '') + (x.house_no || '') + (x.zip || '')), Math.round(x.price || 0), Math.round(x.area_m2 || 0)].join('|');
    const cur = g.get(k);
    if (!cur) g.set(k, { ...x, mid: x.id, ids: [x.id], srcs: [x.source], urls: [x.url] });
    else {
      cur.ids.push(x.id); if (!cur.srcs.includes(x.source)) cur.srcs.push(x.source); cur.urls.push(x.url);
      if (new Date(x.first_seen) < new Date(cur.first_seen)) cur.first_seen = x.first_seen;
      if (S.favs.has(x.id)) cur.mid = x.id;
    }
  }
  return [...g.values()].map(x => ({ ...x, rent_gross: x.price, monthly_total: x.price, status: 'active', deal_type: S.mode, market: true }));
}
const isFav = g => g.ids.some(i => S.favs.has(i));
function buildingListings(b) {
  const own = S.listings.filter(l => l.building_id === b.id && l.status === 'active' && l.deal_type === S.mode)
    .map(l => ({ ...l, srcs: [l.source || 'наша база'] }));
  const mk = (S.mkGroups || []).filter(x => x.building_id === b.id);
  // наши ручные записи, совпадающие с рыночными, не дублируем
  const rest = own.filter(l => !mk.some(x => Math.abs((x.price || 0) - (+l.rent_gross || 0)) < 2 && Math.abs((x.area_m2 || 0) - (+l.area_m2 || 0)) < 2));
  return [...rest, ...mk];
}
function fitsFilters(x) {
  if (!x.price || (S.mode === 'rent' && x.price > S.f.budget)) return false;
  if (x.rooms && x.rooms < S.f.rooms) return false;
  if (x.area_m2 && x.area_m2 < S.f.area) return false;
  if (S.f.districts.size && !S.f.districts.has(x.district)) return false;
  return true;
}
async function toggleFav(id) {
  const g = (S.mkGroups || []).find(x => x.ids.includes(id)); if (!g) return;
  const on = isFav(g);
  if (on) { await sb.from('market_favorites').delete().in('listing_id', g.ids); g.ids.forEach(i => S.favs.delete(i)); }
  else { await sb.from('market_favorites').insert({ listing_id: g.mid }); S.favs.add(g.mid); }
  toast(on ? 'Убрано из избранного' : 'В избранном ★', 1400);
  renderFeed(); pushMarket();
  if (S.selected) { const sc = $('detailBody').querySelector('.lscroll'); if (sc) { const b = S.buildings.find(x => x.id === S.selected); sc.innerHTML = buildingListings(b).sort((x, y) => (+x.rent_gross || 9e9) - (+y.rent_gross || 9e9)).map(listingCard).join(''); } }
  document.querySelectorAll(`.star[data-id]`).forEach(el => { const gg = (S.mkGroups || []).find(x => x.ids.includes(+el.dataset.id)); if (gg) el.classList.toggle('on', isFav(gg)); });
}
/* ---------- покупка: медианы районов, расходы, ипотека ---------- */
const ppmOf = x => x.price && x.area_m2 ? x.price / x.area_m2 : null;
function vsDistrict(x) { // % к медиане €/м² района (минус = дешевле)
  const st = S.stats[x.district], med = st && (S.mode === 'buy' ? st.buy_ppm : st.rent_ppm), p = ppmOf(x);
  return med && p ? (p / med - 1) * 100 : null;
}
function annuity(loan, ratePct, years) { const r = ratePct / 1200, n = years * 12; return r ? loan * r / (1 - Math.pow(1 + r, -n)) : loan / n; }
function buyCalc(x) {
  const p = x.price || 0, eqPct = S.c.eq / 100;
  const broker = x.is_private === true || x.pid ? 0 : 0.036;
  const parts = [['Налог на покупку', 'GrESt · 3,5 % цены', p * 0.035], ['Запись в Grundbuch', 'реестр собственников · 1,1 %', p * 0.011],
    ['Маклер', broker ? '3 % + НДС' : 'скорее нет: частник или застройщик', p * broker], ['Договор и нотариус', '~1,8 % + НДС', p * 0.0216]];
  const loan0 = p * (1 - eqPct);
  parts.push(['Запись залога банка', '1,2 % от 120 % кредита', loan0 * 1.2 * 0.012], ['Оценка квартиры банком', 'Schätzung, ~500 €', loan0 ? 500 : 0]);
  const fees = parts.reduce((a, q) => a + q[2], 0);
  const monthly = annuity(loan0, S.c.rate, S.c.years), interest = monthly * S.c.years * 12 - loan0;
  const st = S.stats[x.district], ppm = ppmOf(x);
  const yld = st && st.rent_ppm && ppm ? st.rent_ppm * 12 / ppm * 100 : null;
  return { p, parts, fees, loan: loan0, cash: p * eqPct + fees, monthly, interest, income: monthly / 0.4, yld, rentEq: st && st.rent_ppm && x.area_m2 ? st.rent_ppm * x.area_m2 : null };
}
const kEur = n => n >= 1e6 ? (n / 1e6).toFixed(2).replace('.', ',') + ' млн €' : Math.round(n / 1000) + ' тыс €';
function dBadge(x) { const v = vsDistrict(x); if (v == null) return ''; const c = v <= -10 ? 'good' : v >= 10 ? 'bad' : '';
  return `<em class="vs ${c}" title="€/м² против медианы ${x.district}-го района">${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))}% к району</em>`; }

function feedCard(x) {
  const b = x.building_id && S.buildings.find(y => y.id === x.building_id);
  const days = Math.max(0, Math.round((Date.now() - new Date(x.published_at || x.first_seen)) / 864e5));
  const isNew = Date.now() - new Date(x.first_seen) < 2 * 864e5;
  const drop = (x.price_history || []).filter(h => h.to < h.from).length;
  return `<div class="fcard${isNew ? ' new' : ''}" data-id="${x.mid}">
    <div class="ftop"><b>${eur(x.price)}</b><span class="fm">${x.area_m2 ? Math.round(x.area_m2) + ' м²' : '? м²'} · ${x.rooms ? x.rooms + ' к.' : '—'}${x.area_m2 ? ' · ' + (x.price / x.area_m2).toFixed(S.mode === 'buy' ? 0 : 1) + ' €/м²' : ''}</span>
      <span class="star${isFav(x) ? ' on' : ''}" data-id="${x.mid}">★</span></div>
    ${S.mode === 'buy' ? (() => { const c = buyCalc(x); return `<div class="fbuy">${dBadge(x)}${x.pid ? '<em class="nb">новостройка</em>' : ''}<span>≈ ${eur(c.monthly)}/мес кредит</span>${c.yld ? `<span>доходн. ${c.yld.toFixed(1)}%</span>` : ''}</div>`; })() : dBadge(x) ? `<div class="fbuy">${dBadge(x)}</div>` : ''}
    <div class="ft">${fitsFilters(x) ? '<span class="fit">подходит</span> ' : ''}${esc((x.title || '').slice(0, 90))}</div>
    <div class="fmeta">${b ? `<span class="ours">${esc(b.name)}</span>` : ''}${esc([x.street, x.house_no].filter(Boolean).join(' ') || '')} ${x.zip || ''}
      · ${x.srcs.map(s => `<a href="${esc(x.urls[x.srcs.indexOf(s)] || x.url)}" target="_blank" rel="noopener">${s}</a>`).join(' ')}
      · ${isNew ? '<em class="newb">новое</em>' : days + ' дн.'}${drop ? ' · <em class="drop">цена ↓</em>' : ''}</div>
  </div>`;
}
// фильтры ленты — свои, быстрые; требования (вкладка «Требования») только помечают «подходит»
const DEF_FF = () => ({ pmin: null, pmax: S.mode === 'buy' ? 500000 : S.f.budget, area: S.f.area, rooms: S.f.rooms, d: new Set(S.f.districts), src: new Set(), isNew: false, drop: false, priv: false, ours: false, lift: false, proj: false, below: false });
const ffKey = () => S.mode === 'buy' ? 'ffBuy' : 'ff';
function readFF() { try { const o = JSON.parse(localGet(ffKey(), 'null')); if (o) return { ...o, d: new Set(o.d), src: new Set(o.src) }; } catch {} return null; }
S.ff = readFF();
function saveFF() { localSet(ffKey(), JSON.stringify({ ...S.ff, d: [...S.ff.d], src: [...S.ff.src] })); }
const LIFT_RE = /\b(lift|aufzug|fahrstuhl|liftstock|personenaufzug)/i;
function passFF(x) {
  const f = S.ff;
  if (f.pmin && (x.price || 0) < f.pmin) return false;
  if (f.pmax && (!x.price || x.price > f.pmax)) return false;
  if (f.area && x.area_m2 && x.area_m2 < f.area) return false;
  if (f.rooms && x.rooms && x.rooms < f.rooms) return false;
  if (f.d.size && !f.d.has(x.district)) return false;
  if (f.src.size && !x.srcs.some(s => f.src.has(s))) return false;
  if (f.isNew && Date.now() - new Date(x.first_seen) > 2 * 864e5) return false;
  if (f.drop && !(x.price_history || []).some(h => h.to < h.from)) return false;
  if (f.priv && x.is_private !== true) return false;
  if (f.ours && !x.building_id) return false;
  if (S.mode === 'buy' && f.proj && !x.pid) return false;
  if (f.below) { const v = vsDistrict(x); if (v == null || v > -5) return false; }
  if (f.lift) { const b = x.building_id && S.buildings.find(y => y.id === x.building_id); if (!(b && b.has_lift) && !LIFT_RE.test(x.title || '')) return false; }
  return true;
}
function ffCount() {
  const f = S.ff, d = DEF_FF(); let n = 0;
  if (f.pmin) n++; if (f.pmax) n++; if (f.area) n++; if (f.rooms) n++; if (f.d.size) n++; if (f.src.size) n++;
  for (const k of ['isNew', 'drop', 'priv', 'ours', 'lift', 'below']) if (f[k]) n++;
  if (S.mode === 'buy' && f.proj) n++;
  return n;
}
function renderFeed() {
  if (!S.ff) S.ff = DEF_FF();
  const all = S.mkGroups || [];
  const favs = all.filter(isFav);
  const view = all.filter(passFF);
  $('feedCnt').textContent = view.length || '';
  $('favCnt').textContent = favs.length || '';
  $('feedFiltN').textContent = ffCount() || '';
  if ($('ffCount')) $('ffCount').textContent = `Показано ${view.length} из ${all.length} объявлений в базе (все 23 района, ${S.mode === 'buy' ? 'продажа до 1,5 млн €, от 30 м²' : 'аренда до 2200 €, от 38 м²'}).`;
  if (S.listView === 'ours') return;
  let arr = S.listView === 'fav' ? favs : view;
  const sort = $('feedSort').value;
  arr = [...arr].sort(sort === 'cheap' ? (a, b) => a.price - b.price : sort === 'm2' ? (a, b) => (a.price / (a.area_m2 || 99)) - (b.price / (b.area_m2 || 99))
    : sort === 'deal' ? (a, b) => (vsDistrict(a) ?? 99) - (vsDistrict(b) ?? 99)
    : (a, b) => new Date(b.first_seen) - new Date(a.first_seen));
  const lim = S.feedLim || 60;
  $('feedHint').textContent = S.listView === 'fav' ? (arr.length ? '' : 'Пока пусто — жми ★ на объявлениях в ленте или в карточке дома.') : S.mode === 'buy' ? `${view.length} квартир на продажу. «% к району» — цена за м² против медианы района; кредит и доходность — по допущениям во вкладке «Расчёт».` : `${view.length} объявлений. Зелёная полоска — новое, «подходит» — под ваши требования.`;
  $('feed').innerHTML = arr.slice(0, lim).map(feedCard).join('') + (arr.length > lim ? `<button class="more" id="feedMore">ещё ${Math.min(60, arr.length - lim)} из ${arr.length - lim}</button>` : '');
  const more = $('feedMore'); if (more) more.onclick = () => { S.feedLim = lim + 60; renderFeed(); };
}
/* панель фильтров ленты */
function renderFFPanel() {
  const f = S.ff;
  $('ffPmin').value = f.pmin || ''; $('ffPmax').value = f.pmax || ''; $('ffArea').value = f.area || ''; $('ffRooms').value = f.rooms || 0;
  $('ffDistricts').innerHTML = Array.from({ length: 23 }, (_, i) => i + 1).map(n => `<button class="chip${f.d.has(n) ? ' on' : ''}" data-d="${n}">${n}</button>`).join('');
  $('ffSources').innerHTML = ['willhaben', 'immoscout'].map(sname => `<button class="chip${f.src.has(sname) ? ' on' : ''}" data-s="${sname}">${sname}</button>`).join('');
  for (const [id, k] of FF_CB) $(id).checked = !!f[k];
  const buy = S.mode === 'buy';
  $('ffPTitle').textContent = buy ? 'Цена покупки, €' : 'Цена в месяц, €';
  $('ffPpre').innerHTML = (buy ? [[300000, '300k'], [400000, '400k'], [500000, '500k'], [700000, '700k']] : [[1000, 'до 1000'], [1300, 'до 1300'], [1500, 'до 1500'], [2000, 'до 2000']])
    .map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('');
  $('ffPmin').step = $('ffPmax').step = buy ? 10000 : 50;
  $('ffBuyOnly').hidden = !buy;
}
const FF_CB = [['ffNew', 'isNew'], ['ffDrop', 'drop'], ['ffPrivate', 'priv'], ['ffOurs', 'ours'], ['ffLift', 'lift'], ['ffProj', 'proj'], ['ffBelow', 'below']];
function ffChanged() { saveFF(); S.feedLim = 60; renderFeed(); pushMarket(); }
$('feedFiltBtn').onclick = () => { if (!S.ff) S.ff = DEF_FF(); renderFFPanel(); $('feedPanel').hidden = !$('feedPanel').hidden; $('lview').hidden = true; };
$('feedPanelClose').onclick = () => $('feedPanel').hidden = true;
for (const [id, k] of [['ffPmin', 'pmin'], ['ffPmax', 'pmax'], ['ffArea', 'area'], ['ffRooms', 'rooms']])
  $(id).oninput = () => { S.ff[k] = +$(id).value || null; ffChanged(); };
for (const [id, k] of FF_CB)
  $(id).onchange = () => { S.ff[k] = $(id).checked; ffChanged(); };
$('ffPpre').onclick = e => { const v = e.target.dataset.v; if (!v) return; S.ff.pmax = +v; $('ffPmax').value = v; ffChanged(); };
$('ffDistricts').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; const n = +c.dataset.d; S.ff.d.has(n) ? S.ff.d.delete(n) : S.ff.d.add(n); c.classList.toggle('on'); ffChanged(); };
$('ffSources').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; const n = c.dataset.s; S.ff.src.has(n) ? S.ff.src.delete(n) : S.ff.src.add(n); c.classList.toggle('on'); ffChanged(); };
$('ffReq').onclick = () => { S.ff = DEF_FF(); renderFFPanel(); ffChanged(); };
$('ffReset').onclick = () => { S.ff = { ...DEF_FF(), pmax: null, area: null, rooms: null, d: new Set() }; renderFFPanel(); ffChanged(); };

/* ---------- просмотр объявления внутри приложения ---------- */
S.lcache = {};
async function openListing(x) {
  S.lvX = x;
  $('feedPanel').hidden = true;
  $('detail').hidden = true;
  const box = $('lviewBody'), b = x.building_id && S.buildings.find(y => y.id === x.building_id);
  $('lview').hidden = false;
  const head = `<div class="dname">${eur(x.price)} <span class="star${isFav(x) ? ' on' : ''}" data-id="${x.mid}">★</span></div>
    <div class="daddr">${x.area_m2 ? Math.round(x.area_m2) + ' м²' : '? м²'} · ${x.rooms ? x.rooms + ' комн.' : '—'} · ${esc([x.street, x.house_no].filter(Boolean).join(' '))} ${x.zip || ''}${b ? ` · <span class="ours">${esc(b.name)}</span>` : ''}</div>
    <div class="lv-btns">
      ${x.srcs.map((sname, i) => `<a class="lvb" href="${esc(x.urls[i] || x.url)}" target="_blank" rel="noopener">${sname} ↗</a>`).join('')}
      ${x.lat ? '<button class="lvb" id="lvMap">На карте</button>' : ''}
      ${b ? '<button class="lvb primary" id="lvHouse">Открыть дом</button>' : (x.lat ? '<button class="lvb primary" id="lvTrack">＋ Отслеживать этот дом</button>' : '')}
    </div>`;
  box.innerHTML = head + '<p class="hint">Загружаю объявление…</p>';
  bindLv(x, b);
  let d = S.lcache[x.url];
  try {
    if (!d) { const r = await sb.functions.invoke('listing', { body: { url: x.url } }); if (r.error || r.data?.error) throw new Error(r.data?.error || r.error.message); d = S.lcache[x.url] = r.data; }
  } catch (e) { box.innerHTML = head + `<p class="hint">Не получилось загрузить: ${esc(e.message)}. Открой на сайте.</p>`; bindLv(x, b); return; }
  if (d.gone) { box.innerHTML = head + '<p class="why">Объявление уже снято с сайта.</p>'; bindLv(x, b); return; }
  const imgs = (d.images || []).map(u => `<img src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer">`).join('');
  box.innerHTML = head + `
    ${imgs ? `<div class="gal">${imgs}</div>` : ''}
    <div class="lv-title">${esc(d.title || x.title || '')}</div>
    ${d.lift === true ? '<div class="amen"><span>Лифт упомянут</span></div>' : ''}
    ${(d.facts || []).length ? `<dl class="rows lv-facts">${d.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join('')}</dl>` : ''}
    ${(d.equipment || []).length ? `<div class="amen">${d.equipment.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
    ${(x.deal_type || S.mode) === 'buy' ? buyBlock(x) : ''}
    ${d.description ? `<div class="lv-desc">${esc(d.description).replace(/\n/g, '<br>')}</div>` : ''}
    ${(d.extra || []).map(t => `<div class="lv-desc sub">${esc(t).replace(/\n/g, '<br>')}</div>`).join('')}
    ${d.contact ? `<div class="src">Контакт: ${esc(d.contact)}</div>` : ''}`;
  bindLv(x, b);
}
const BANKS = [
  ['Брокеры (бесплатно для покупателя, сравнивают десятки банков)', [['Infina', 'https://www.infina.at/'], ['Optifin', 'https://www.optifin.at/'], ['durchblicker', 'https://durchblicker.at/wohnfinanzierung']]],
  ['Банки', [['Erste / Sparkasse', 'https://www.sparkasse.at/erstebank/privatkunden/wohnen-finanzieren'], ['Bank Austria', 'https://www.bankaustria.at/privatkunden-finanzierungen-und-kredite-wohnkredit.jsp'],
    ['Raiffeisen NÖ-Wien', 'https://www.raiffeisen.at/noew/rlb/de/privatkunden.html'], ['BAWAG', 'https://www.bawag.at/'], ['HYPO NOE', 'https://www.hyponoe.at/'], ['Volksbank Wien', 'https://www.volksbankwien.at/'],
    ['bank99', 'https://www.bank99.at/'], ['Oberbank', 'https://www.oberbank.at/'], ['BKS Bank', 'https://www.bks.at/']]],
  ['Bausparkassen (часть суммы под фикс-ставку)', [['Wüstenrot', 'https://www.wuestenrot.at/'], ['s Bausparkasse', 'https://www.sbausparkasse.at/'], ['Raiffeisen Bausparkasse', 'https://www.bausparen.at/'], ['start:bausparkasse', 'https://www.startbausparkasse.at/']]],
];
function buyBlock(x) {
  const c = buyCalc(x), st = S.stats[x.district] || {}, v = vsDistrict(x);
  const inc = S.c.income, dsti = inc ? c.monthly / inc * 100 : null, r$ = String(S.c.rate).replace('.', ',');
  const rates = S.rates.length ? S.rates : [{ label: 'Ставка из «Расчёта»', rate: S.c.rate, kind: 'avg' }];
  const rows = rates.map(r => {
    const m = annuity(c.loan, +r.rate, S.c.years), tot = m * S.c.years * 12 - c.loan;
    return `<tr class="${r.kind}${+r.rate === S.c.rate ? ' cur' : ''}" data-rate="${r.rate}"><td>${esc(r.label)}</td>
      <td class="who"><a href="${esc(r.source_url || '#')}" target="_blank" rel="noopener">${esc(r.provider || r.source || '')}</a><small>${esc(r.provider_note || '')}${r.as_of ? ' · ' + r.as_of.slice(8, 10) + '.' + r.as_of.slice(5, 7) : ''}</small></td>
      <td class="num">${String(r.rate).replace('.', ',')} %</td><td class="num"><b>${eur(m)}</b></td><td class="num">${eur(tot)}</td><td class="num">${eur(m / 0.4)}</td></tr>`;
  }).join('');
  const stress = annuity(c.loan, S.c.rate + 1.5, S.c.years);
  const tile = (cls, label, val, sub) => `<div class="kpi ${cls}"><span>${label}</span><b>${val}</b><small>${sub}</small></div>`;
  const vsCls = v == null ? '' : v <= -10 ? 'good' : v >= 10 ? 'bad' : '';
  return `<div class="buybox">
    <div class="bbhead"><div class="ftitle">Ипотека для этой квартиры</div>
      <p class="bbwhat">Ипотека = жилищный кредит под залог квартиры (в Австрии: <i>Wohnkredit</i> или <i>Hypothekarkredit</i>, это одно и то же).</p></div>
    <div class="mctl">
      <label>Свои деньги <select id="mEq">${[10, 20, 25, 30, 40, 50].map(p => `<option value="${p}"${p === S.c.eq ? ' selected' : ''}>${p} % = ${kEur(c.p * p / 100)}</option>`).join('')}</select></label>
      <label>Срок <select id="mYears">${[15, 20, 25, 30, 35].map(y => `<option${y === S.c.years ? ' selected' : ''}>${y}</option>`).join('')}</select> лет</label>
      <label>Доход семьи «на руки» <input id="mInc" type="number" step="100" min="0" placeholder="€/мес" value="${inc || ''}"></label>
    </div>
    <div class="kpis">
      ${tile('amber', 'Нужно своих денег', eur(c.cash), `${S.c.eq} % взнос + расходы на сделку`)}
      ${tile('amber', 'Платёж в месяц', eur(c.monthly), `при ${r$} % · ${S.c.years} лет`)}
      ${dsti != null ? tile(dsti <= 40 ? 'good' : 'bad', 'Доля вашего дохода', dsti.toFixed(0) + ' %', dsti <= 40 ? '✓ банк одобрит (нужно ≤ 40 %)' : '✗ банк скорее откажет (нужно ≤ 40 %)')
        : tile('', 'Нужен доход', eur(c.income), 'на руки в месяц, правило ≤ 40 %')}
      ${tile(vsCls, 'Цена к району', v != null ? (v > 0 ? '+' : '−') + Math.abs(Math.round(v)) + ' %' : '—', st.buy_ppm ? `${eur(ppmOf(x) || 0)}/м² против ${eur(st.buy_ppm)}/м²` : 'нет данных по району')}
    </div>
    <div class="bsec"><div class="bsh"><span>Цена квартиры</span><b>${eur(c.p)}</b></div></div>
    <div class="bsec"><div class="bsh"><span>Расходы на сделку сверху</span><b>${eur(c.fees)} <em>${(c.fees / c.p * 100).toFixed(1)} %</em></b></div>
      ${c.parts.filter(q => q[2] > 0 || /Маклер/.test(q[0])).map(([k, h, val]) => `<div class="bl"><span>${k}<small>${h}</small></span><b>${val ? eur(val) : '0 €'}</b></div>`).join('')}</div>
    <div class="bsec"><div class="bsh"><span>Кредит</span><b>${eur(c.loan)}</b></div>
      <div class="bl"><span>Срок · ставка<small>ставку меняй кликом в таблице ниже</small></span><b>${S.c.years} лет · ${r$} %</b></div>
      <div class="bl"><span>Переплата банку за весь срок<small>сколько отдашь сверху суммы кредита</small></span><b>${eur(c.interest)}</b></div>
      <div class="bl warn"><span>Если плавающая ставка вырастет на 1,5 п.п.<small>стресс-тест банка</small></span><b>${eur(stress)}/мес <em>+${eur(stress - c.monthly)}</em></b></div></div>
    ${c.rentEq ? `<div class="bsec"><div class="bsh"><span>Если сдавать</span><b>≈ ${eur(c.rentEq)}/мес</b></div><div class="bl"><span>Валовая доходность<small>аренда за год / цена, без расходов</small></span><b>${c.yld.toFixed(1)} %</b></div></div>` : ''}
    <div class="ftitle sm">Сравнение ставок рынка · нажми строку — пересчитать</div>
    <div class="mtabw"><table class="mtab rates"><thead><tr><th>Вариант</th><th>Кто / источник</th><th>Ставка</th><th>В месяц</th><th>Переплата</th><th>Нужен доход</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="bnote"><b>Почему не названия банков?</b> Банки в Австрии не публикуют ставки — каждый даёт предложение лично, после проверки дохода. Поэтому здесь реальные ставки рынка от брокеров:
      <b>Infina</b> (индекс по 12 банкам) и <b>Optifin</b> (лучшее из 60–80 банков). Брокер бесплатно для тебя запросит банки и покажет, <i>какой именно банк</i> даёт ставку.</p>
    <div class="banks">${BANKS.map(([g, list]) => `<div class="bgrp"><span>${g}</span><div>${list.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n}</a>`).join('')}</div></div>`).join('')}</div>
    <p class="src">Правила FMA: от 20 % своих денег, платёж ≤ 40 % дохода, срок до 35 лет. Не учтены Betriebskosten и ремфонд собственника (~2,5–4 €/м² в месяц).</p></div>`;
}
function bindBuy(x) {
  const bb = $('lviewBody').querySelector('.buybox'); $('lview').classList.toggle('wide', !!bb || !!$('lviewBody').querySelector('.pgal')); if (!bb) return;
  const redo = () => { bb.outerHTML = buyBlock(x); bindBuy(x); if (S.mode === 'buy') renderFeed(); };
  const set = (k, v) => { S.c[k] = v; localSet(k === 'rate' ? 'c_rate2' : 'c_' + k, v); const el = { eq: 'cEq', rate: 'cRate', years: 'cYears' }[k], lb = { eq: 'vEq', rate: 'vRate', years: 'vYears' }[k];
    if (el && $(el)) $(el).value = v; if (lb && $(lb)) $(lb).textContent = k === 'eq' ? v + ' %' : k === 'rate' ? String(v).replace('.', ',') + ' %' : v + ' лет'; };
  bb.querySelector('#mEq').onchange = e => { set('eq', +e.target.value); redo(); };
  bb.querySelector('#mYears').onchange = e => { set('years', +e.target.value); redo(); };
  bb.querySelector('#mInc').onchange = e => { set('income', +e.target.value || 0); redo(); };
  bb.querySelectorAll('tr[data-rate]').forEach(tr => tr.onclick = () => { set('rate', +tr.dataset.rate); redo(); });
}
function bindLv(x, b) {
  bindBuy(x);
  const st = $('lviewBody').querySelector('.star'); if (st) st.onclick = () => toggleFav(x.mid);
  if ($('lvMap')) $('lvMap').onclick = () => { if (!$('lMarket').checked) { $('lMarket').checked = true; syncLayerToggles(); }
    map.flyTo({ center: [x.lng, x.lat], zoom: 16.5, pitch: 50, padding: detailPad(), duration: 1500 }); };
  if ($('lvHouse')) $('lvHouse').onclick = () => { $('lview').hidden = true; select(b.id); };
  if ($('lvTrack')) $('lvTrack').onclick = () => trackHouse(x);
}
$('lviewClose').onclick = () => { $('lview').hidden = true; };
$('routeFocus').onclick = () => focusRoute(false);
async function trackHouse(x) {
  $('lvTrack').disabled = true; $('lvTrack').textContent = 'Добавляю…';
  map.flyTo({ center: [x.lng, x.lat], zoom: 17, pitch: 45, padding: detailPad(), duration: 1200 });
  await new Promise(r => map.once('idle', r));
  let fp = null, h = null;
  try {
    const pt = map.project([x.lng, x.lat]);
    const f = map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { target: BUILDINGS_TARGET }).find(q => q.geometry && /Polygon/.test(q.geometry.type));
    if (f) { const area = geomParts(f.geometry).reduce((a, p) => a + ringAreaM2(p[0]), 0); if (area < 20000) { fp = f.geometry; h = +(f.properties.height || 0) || null; } }
  } catch {}
  const { data, error } = await sb.rpc('add_building', { p_name: '', p_street: x.street || null, p_house_no: x.house_no || null, p_zip: x.zip || null,
    p_lng: x.lng, p_lat: x.lat, p_footprint: fp, p_height: h, p_query: 'из объявления: ' + (x.title || '') });
  if (error) { toast('Не добавилось: ' + error.message, 5000); $('lvTrack').disabled = false; $('lvTrack').textContent = '＋ Отслеживать этот дом'; return; }
  await sb.rpc('market_rematch');
  toast('Дом добавлен в отслеживаемые. Все его объявления теперь будут в карточке дома.', 4500);
  $('lview').hidden = true;
  await load(); await loadMarket();
  if (data) select(data);
}

$('feed').onclick = e => {
  const st = e.target.closest('.star'); if (st) { toggleFav(+st.dataset.id); return; }
  if (e.target.closest('a')) return;
  const c = e.target.closest('.fcard'); if (!c) return;
  const x = (S.mkGroups || []).find(g => g.mid === +c.dataset.id); if (!x) return;
  if (!DESKTOP()) $('sheet').classList.add('min');
  openListing(x);
};
$('listSeg').onclick = e => {
  const v = e.target.closest('button')?.dataset.v; if (!v) return;
  S.listView = v; S.feedLim = 60;
  $('listSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('oursBox').hidden = v !== 'ours'; $('feedBox').hidden = v === 'ours';
  $('feedFiltBtn').hidden = v === 'fav';
  renderFeed();
};
$('feedSort').onchange = renderFeed;
function pushMarket() {
  if (!map.getSource('mk')) return;
  const now = Date.now();
  map.getSource('mk').setData(fc((S.mkGroups || []).filter(x => x.lat).map(x => ({ type: 'Feature',
    properties: { id: x.mid, fit: fitsFilters(x), fav: isFav(x), isNew: now - new Date(x.first_seen) < 2 * 864e5 },
    geometry: { type: 'Point', coordinates: [x.lng, x.lat] } }))));
}
function mkPopup(id, ll) {
  const x = (S.mkGroups || []).find(g => g.ids.includes(id)); if (!x) return;
  const pop = new mapboxgl.Popup({ closeButton: true, className: 'mkpop', maxWidth: '280px' }).setLngLat(ll).setHTML(feedCard(x)).addTo(map);
  pop.getElement().addEventListener('click', e => { const st = e.target.closest('.star'); if (st) { toggleFav(+st.dataset.id); return; } if (e.target.closest('a')) return; pop.remove(); openListing(x); });
}

/* ---------- рядом с домом: OSM ---------- */
const SHOP_BRANDS = ['Billa', 'Billa Plus', 'Spar', 'Eurospar', 'Interspar', 'Spar Gourmet', 'Hofer', 'Penny', 'Lidl', 'Другие'];
const SHOP_COL = { Billa: '#facc15', 'Billa Plus': '#eab308', Spar: '#22c55e', Eurospar: '#16a34a', Interspar: '#15803d', 'Spar Gourmet': '#86efac',
  Hofer: '#60a5fa', Penny: '#f87171', Lidl: '#3b82f6', 'Другие': '#9ca3af' };
const LOCK_BRANDS = ['Post', 'myflexbox', 'Amazon', 'Hermes PaketShop', 'DPD', 'Другие'];
const KIND_COL = { pharmacy: '#34d399', post: '#fbbf24', locker: '#c084fc', night: '#f43f5e' };
S.shopOn = new Set(JSON.parse(localGet('shopBrands', JSON.stringify(SHOP_BRANDS.filter(b => b !== 'Другие')))));
S.lockOn = new Set(JSON.parse(localGet('lockBrands', JSON.stringify(LOCK_BRANDS))));
function brandChips(id, list, set, key, col) {
  $(id).innerHTML = list.map(b => `<button class="chip${set.has(b) ? ' on' : ''}" data-b="${esc(b)}">${col ? `<i style="background:${col[b] || '#9ca3af'}"></i>` : ''}${esc(b)}</button>`).join('');
  $(id).onclick = e => { const c = e.target.closest('.chip'); if (!c) return; const b = c.dataset.b;
    set.has(b) ? set.delete(b) : set.add(b); c.classList.toggle('on'); localSet(key, JSON.stringify([...set])); pushOsm(); };
}
brandChips('shopBrands', SHOP_BRANDS, S.shopOn, 'shopBrands', SHOP_COL);
brandChips('lockerBrands', LOCK_BRANDS, S.lockOn, 'lockBrands');
async function loadOsm() {
  const all = []; let from = 0;
  while (true) { const r = await sb.from('osm_poi').select('osm_id,kind,brand,name,lng,lat,opening_hours').range(from, from + 999); if (r.error || !r.data.length) break; all.push(...r.data); if (r.data.length < 1000) break; from += 1000; }
  S.osm = all;
  const np = await sb.from('night_pharmacy').select('name,address,phone,lat,lng,duty,fetched_at');
  S.night = np.data || [];
  if ($('nightInfo') && S.night.length) $('nightInfo').textContent = `(${S.night.length}, обновлено ${new Date(S.night[0].fetched_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`;
  pushOsm();
}
function pushOsm() {
  if (!map.getSource('osm')) return;
  const on = { shop: $('lShops').checked, pharmacy: $('lPharm').checked, post: $('lPost').checked, locker: $('lLocker').checked, night: $('lNight').checked };
  const label = p => p.kind === 'shop' ? (p.brand === 'Другие' ? (p.name || 'Супермаркет') : p.brand) : p.kind === 'pharmacy' ? '✚ ' + (p.name || 'Apotheke')
    : p.kind === 'post' ? (p.brand === 'Post Partner' ? 'Post Partner' : 'Post') : '📦 ' + (p.brand === 'Другие' ? (p.name || 'Paketbox') : p.brand);
  map.getSource('osm').setData(fc(S.osm.filter(p => on[p.kind] && (p.kind !== 'shop' || S.shopOn.has(p.brand)) && (p.kind !== 'locker' || S.lockOn.has(p.brand)))
    .map(p => ({ type: 'Feature', properties: { kind: p.kind, label: label(p), name: p.name || '', hours: p.opening_hours || '',
      color: p.kind === 'shop' ? (SHOP_COL[p.brand] || '#9ca3af') : KIND_COL[p.kind] }, geometry: { type: 'Point', coordinates: [+p.lng, +p.lat] } }))
    .concat(on.night ? (S.night || []).map(p => ({ type: 'Feature', properties: { kind: 'night', label: '🌙 ' + p.name, name: p.address + (p.phone ? ' · ' + p.phone : ''), hours: 'Дежурство: ' + (p.duty || ''), color: KIND_COL.night },
      geometry: { type: 'Point', coordinates: [+p.lng, +p.lat] } })) : [])));
  const any = Object.values(on).some(Boolean);
  vis(['osm-dot', 'osm-label'], any);
}

/* ---------- солнце: стороны света, восход и закат у выбранного дома ---------- */
function sunTimes(date, lat, lng) {
  const rad = Math.PI / 180, N = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5);
  const g = 2 * Math.PI / 365 * (N - 1);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const phi = lat * rad, z = 90.833 * rad;
  const ha = Math.acos(Math.cos(z) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl));
  const noonUTC = 720 - 4 * lng - eot; // минуты
  const rise = noonUTC - 4 * ha / rad, set = noonUTC + 4 * ha / rad;
  const az = Math.acos(Math.sin(decl) / Math.cos(phi)) / rad; // азимут восхода от севера (без рефракции)
  const tz = (d => { const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset(), jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset(); return 60 + (d.getTimezoneOffset() < Math.max(jan, jul) ? 60 : 0); })(date);
  const fmt = m => { m = ((m + tz) % 1440 + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0'); };
  return { riseAz: az, setAz: 360 - az, rise: fmt(rise), set: fmt(set) };
}
function destPt(lng, lat, az, m) { const r = az * Math.PI / 180; return [lng + Math.sin(r) * m / MX, lat + Math.cos(r) * m / MY]; }
function pushSun() {
  if (!map.getSource('sun')) return;
  const b = S.selected && S.buildings.find(x => x.id === S.selected);
  const c = b ? [b.lng, b.lat] : map.getCenter().toArray();
  const y = new Date().getFullYear(), R = 260, feats = [];
  const ring = []; for (let a = 0; a <= 360; a += 6) ring.push(destPt(c[0], c[1], a, R));
  feats.push({ type: 'Feature', properties: { t: 'ring' }, geometry: { type: 'LineString', coordinates: ring } });
  for (const [a, t] of [[0, 'С'], [90, 'В'], [180, 'Ю'], [270, 'З']])
    feats.push({ type: 'Feature', properties: { t: 'label', text: t, size: 15, color: '#e8eaed' }, geometry: { type: 'Point', coordinates: destPt(c[0], c[1], a, R + 35) } });
  const days = [[new Date(y, 5, 21), 'лето', '#fbbf24', 2], [new Date(), 'сегодня', '#fb923c', 3.5], [new Date(y, 11, 21), 'зима', '#93c5fd', 2]];
  for (const [d, name, color, w] of days) {
    const st = sunTimes(d, c[1], c[0]);
    for (const [az, kind, time] of [[st.riseAz, '☀↑', st.rise], [st.setAz, '☀↓', st.set]]) {
      feats.push({ type: 'Feature', properties: { t: 'ray', color, w }, geometry: { type: 'LineString', coordinates: [c, destPt(c[0], c[1], az, R)] } });
      feats.push({ type: 'Feature', properties: { t: 'label', text: `${kind} ${name} ${time}`, size: 11, color }, geometry: { type: 'Point', coordinates: destPt(c[0], c[1], az, R + (name === 'сегодня' ? 75 : 120)) } });
    }
  }
  map.getSource('sun').setData(fc(feats));
}

/* ---------- кнопки: обновить ленту сейчас / очередь разбора ---------- */
$('feedRefresh').onclick = async () => {
  const btn = $('feedRefresh');
  let ds = [...(S.ff?.d || [])];
  if (ds.length > 8) { toast('За раз можно обновить до 8 районов — выбери поменьше в фильтрах ленты', 4000); return; }
  btn.disabled = true; btn.textContent = '↻ Собираю…';
  const { data, error } = await sb.functions.invoke('refresh', { body: { districts: ds, deal: S.mode } });
  if (error || data?.error) { toast('Не запустилось: ' + (data?.error || error.message), 5000); btn.disabled = false; btn.textContent = '↻ Обновить'; return; }
  toast(`Собираю свежие объявления: районы ${data.districts.join(', ')}. Около ${Math.round(data.eta_sec / 60) || 1} мин — лента обновится сама.`, 6000);
  const before = (S.market || []).length;
  const end = Date.now() + (data.eta_sec + 60) * 1000;
  const tick = async () => {
    await loadMarket();
    if (Date.now() < end) setTimeout(tick, 30000);
    else { btn.disabled = false; btn.textContent = '↻ Обновить'; toast(`Готово. В базе ${S.market.length} объявлений (было ${before}).`, 4000); }
  };
  setTimeout(tick, 30000);
};
function renderQueue() {
  const q = S.buildings.filter(b => b.research_status === 'queued');
  const bar = $('queueBar'); if (!bar) return;
  bar.hidden = !q.length;
  if (!q.length) return;
  const slots = [8, 11, 14, 17, 20].map(h => { const d = new Date(); d.setHours(h, 13, 0, 0); return d; });
  const next = slots.find(d => d > new Date()) || (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 13, 0, 0); return d; })();
  bar.innerHTML = `⏳ <b>${q.length}</b> ${q.length === 1 ? 'дом ждёт' : 'дома ждут'} разбора. Claude разберёт автоматически в ${next.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${next.getDate() !== new Date().getDate() ? ' завтра' : ''} (проверяет очередь в 8, 11, 14, 17 и 20 часов).`;
}

/* ---------- камера ---------- */
function orbitStep() { if (!S.orbiting) return; map.setBearing((map.getBearing() + 0.14) % 360); requestAnimationFrame(orbitStep); }
function startOrbit() { S.orbiting = true; $('orbitBtn').classList.add('on'); if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 600 }); requestAnimationFrame(orbitStep); }
function stopOrbit() { S.orbiting = false; $('orbitBtn').classList.remove('on'); }
$('orbitBtn').onclick = () => S.orbiting ? stopOrbit() : startOrbit();
$('flatBtn').onclick = () => { stopOrbit(); map.easeTo({ pitch: 0, bearing: 0, duration: 900 }); };
$('tiltBtn').onclick = () => map.easeTo({ pitch: 62, duration: 900 });
['mousedown', 'touchstart', 'wheel'].forEach(ev => map.getCanvasContainer().addEventListener(ev, stopOrbit, { passive: true }));


/* ---------- радар новостроек: проекты на карте, застройщики ---------- */
const RY = [ // год сдачи → цвет
  { k: 'done', t: 'уже сдан', c: '#22c55e', f: y => y && y <= 2025 },
  { k: '2026', t: '2026', c: '#facc15', f: y => y === 2026 },
  { k: '2027', t: '2027', c: '#f97316', f: y => y === 2027 },
  { k: 'later', t: '2028+', c: '#c084fc', f: y => y && y >= 2028 },
  { k: 'na', t: 'без даты', c: '#64748b', f: y => !y },
];
const ryOf = y => RY.find(r => r.f(y));
const PT = [ // тип проекта: что именно строится
  { k: 'neubau', t: 'Новостройка', d: 'дом с нуля (на пустом участке или на месте снесённого)' },
  { k: 'dachausbau', t: 'Мансарды / надстройка', d: 'новые квартиры на крыше старого дома (Dachgeschossausbau, Aufstockung)' },
  { k: 'umbau', t: 'Перестройка', d: 'бывший офис/склад/отель переделан в жильё (Umnutzung)' },
  { k: 'altbau', t: 'Санированный альтбау', d: 'старый дом (до ~1950) отремонтирован целиком (Sanierung)' },
];
const ptOf = k => PT.find(p => p.k === (k || 'neubau')) || PT[0];
S.rad = { on: new Set(JSON.parse(localGet('radYears', '["done","2026","2027","later","na"]'))), types: new Set(JSON.parse(localGet('radTypes', '["neubau"]'))), sale: false, mine: false, q: '', dev: null, list: [], devs: [], reg: [] };
const DEV_LEGAL = /\s*(\(FN[^)]*\)|gesellschaft m\.?b\.?h\.?|ges\.?m\.?b\.?h\.?|gmbh(\s*&\s*co\.?\s*kg)?|\bag\b|\bkg\b|\beg\b|e\.u\.|m\.b\.h\.?)\s*/gi;
const PERSON = /(^|\s)(mag\.|mag\(fh\)|di |dipl\.|dr\.|ing\.|herr |frau )|\b(msc|mba|mrics|bsc|verkauf|vertrieb|beratung)\b/i;
const BROKER = /makler|vermittlung|immocontract|\behl\b|örag|swiss life|remax|re\/max|sotheby|engel ?&|otto immobilien|doppelmakler|brokers?\b/i;
const COMPANY = /gmbh|\bag\b|\bkg\b|immobilien|bau|wohn|real|develop|grupp|group|gesellschaft|genossenschaft|holding|invest|living|projekt|estate|partner|siedlung|heim|management|entwicklung|buwog|3si|winegg|riwog|glorit|haring|soravia|s\+b|arwag|gesiba|sozialbau|öv?sw/i;
function cleanDevs(arr) {
  const out = [];
  for (const raw of arr || []) for (let part of String(raw).replace(/\s*&\s*Co\.?\s*KG/gi, ' KG').replace(/\([^)]*\)/g, ' ').split(/\s+[—–]\s+|;|,|\s\/\s|\s&\s(?=[A-ZÄÖÜ])/)) {
    part = part.replace(/\s+/g, ' ').trim();
    if (!part || part.length > 60 || !/^[A-ZÄÖÜ0-9]/.test(part) || /^\S+-\s/.test(part) || PERSON.test(part) || BROKER.test(part)) continue;
    if (!COMPANY.test(part) && !regMatch(devKey(part))) continue;
    out.push(devKey(part));
  }
  return [...new Set(out)].filter(n => n.length > 1);
}
function devKey(n) { return n.replace(DEV_LEGAL, ' ').replace(/[–-]\s*(verkauf|vertrieb).*$/i, '').replace(/\s+/g, ' ').trim(); }
function regMatch(name) {
  const n = name.toLowerCase();
  return S.rad.reg.find(r => [r.name, ...(r.aliases || [])].some(a => { const x = devKey(a).toLowerCase(); return x.length > 2 && (n === x || n.startsWith(x + ' ') || x.startsWith(n + ' ') || n.includes(x) && x.length > 4); }));
}
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
function logoHtml(d) {
  const dom = d.website ? domainOf(d.website) : d.domain;
  return dom ? `<img class="dlogo" src="https://www.google.com/s2/favicons?domain=${esc(dom)}&sz=64" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="dlogo ini">${esc(d.name.replace(/[^A-Za-zÄÖÜäöü0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase())}</span>`;
}
async function loadRadar() {
  const [p, r] = await Promise.all([
    sb.from('dev_projects').select('id,name,address,zip,district,lat,lng,developer_names,completion_year,units_total,units_available,units_reserved,area_min,area_max,rooms_min,rooms_max,price_min,price_max,ppm_min,ppm_max,ppm_median,energy_class,amenities,url,official_url,first_seen,building_id,project_type,built_year,renovated_year,photos').is('removed_at', null).limit(2000),
    sb.from('developers').select('*')
  ]);
  if (p.error) { console.warn(p.error); return; }
  S.rad.reg = r.data || [];
  const devs = new Map();
  S.rad.list = (p.data || []).filter(x => x.lat && x.lng).map(x => {
    const names = cleanDevs(x.developer_names);
    const keys = [];
    for (const n of names) {
      const reg = regMatch(n), key = reg ? reg.name : n;
      if (keys.includes(key)) continue; keys.push(key);
      const d = devs.get(key) || { name: key, reg, website: reg?.website, kind: reg?.kind, tier: reg?.tier, projects: [], domains: {} };
      d.projects.push(x.id); const dm = domainOf(x.official_url); if (dm) d.domains[dm] = (d.domains[dm] || 0) + 1;
      devs.set(key, d);
    }
    return { ...x, devs: keys, y: ryOf(x.completion_year), pt: ptOf(x.project_type) };
  });
  S.rad.devs = [...devs.values()].map(d => ({ ...d, domain: Object.entries(d.domains).sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name));
  renderRadar(); pushRadar();
}
function radFiltered() {
  const R = S.rad, q = R.q.toLowerCase();
  return R.list.filter(x => R.on.has(x.y.k) && R.types.has(x.pt.k) && (!R.sale || x.units_available > 0) && (!R.mine || !S.f.districts.length || S.f.districts.includes(x.district))
    && (!R.dev || x.devs.includes(R.dev)) && (!q || [x.name, x.address, ...(x.devs || [])].join(' ').toLowerCase().includes(q)));
}
function renderRadar() {
  const R = S.rad, list = radFiltered();
  $('radCnt').textContent = R.list.length; $('devCnt').textContent = R.devs.length;
  $('radTypes').innerHTML = PT.map(p => { const n = R.list.filter(x => x.pt.k === p.k).length;
    return `<button class="ychip pt${R.types.has(p.k) ? ' on' : ''}" data-k="${p.k}" title="${esc(p.d)}"><i class="pt-${p.k}"></i>${p.t} <b>${n}</b></button>`; }).join('');
  $('radYears').innerHTML = RY.map(r => { const n = R.list.filter(x => x.y.k === r.k && R.types.has(x.pt.k)).length;
    return `<button class="ychip${R.on.has(r.k) ? ' on' : ''}" data-k="${r.k}"><i style="background:${r.c}"></i>${r.t} <b>${n}</b></button>`; }).join('');
  $('radDevF').innerHTML = R.dev ? `Застройщик: <b>${esc(R.dev)}</b> <button class="linkbtn" id="radDevX">показать всех</button>` : '';
  const sorted = list.slice().sort((a, b) => (a.completion_year || 9999) - (b.completion_year || 9999) || (b.units_available || 0) - (a.units_available || 0));
  $('radList').innerHTML = sorted.slice(0, 300).map(x => {
    const st = S.stats[x.district] || {}, prem = st.buy_ppm && x.ppm_median ? Math.round((x.ppm_median / st.buy_ppm - 1) * 100) : null;
    return `<div class="rcard" data-id="${x.id}"><i class="rdot" style="background:${x.y.c}"></i>
      <div class="rbody"><div class="rname">${esc(x.name || '—')}</div>
        <div class="rmeta">${x.pt.k !== 'neubau' ? `<span class="ptb pt-${x.pt.k}">${x.pt.t}${x.built_year ? ' · дом ' + x.built_year : ''}</span> ` : ''}${x.district ? x.district + '-й · ' : ''}${esc(x.address || '')}</div>
        <div class="rmeta">${x.y.k === 'done' ? 'сдан ' + x.completion_year : x.completion_year ? 'сдача ' + x.completion_year : 'срок не указан'}
          ${(x.photos || []).length ? ` · 📷 ${x.photos.length}` : ''}${x.units_total ? ` · ${x.units_total} кв.` : ''}${x.units_available ? ` · <b>${x.units_available} в продаже</b>` : ''}
          ${x.ppm_median ? ` · ${eur(x.ppm_median)}/м²` : ''}${prem != null ? ` <em class="vs ${prem <= -10 ? 'good' : prem >= 10 ? 'bad' : ''}">${prem > 0 ? '+' : '−'}${Math.abs(prem)}% к району</em>` : ''}</div>
        ${x.devs.length ? `<div class="rdev">${x.devs.map(d => `<span data-dev="${esc(d)}">${esc(d)}</span>`).join('')}</div>` : ''}</div></div>`;
  }).join('') || '<p class="hint">Ничего не найдено. Проверь фильтры по году.</p>';
  if (sorted.length > 300) $('radList').insertAdjacentHTML('beforeend', `<p class="hint">Показаны первые 300 из ${sorted.length}, уточни фильтры.</p>`);
  const dq = ($('devQ').value || '').toLowerCase();
  $('devList').innerHTML = R.devs.filter(d => !dq || d.name.toLowerCase().includes(dq)).map(d => {
    const ps = R.list.filter(x => d.projects.includes(x.id)), cnt = k => ps.filter(x => x.y.k === k).length;
    return `<div class="dcard${R.dev === d.name ? ' on' : ''}" data-dev="${esc(d.name)}">${logoHtml(d)}
      <div class="rbody"><div class="rname">${esc(d.name)}${d.kind === 'nonprofit' ? ' <small>gemeinnützig</small>' : ''}</div>
        <div class="rmeta">${ps.length} ${ps.length === 1 ? 'проект' : 'проектов'}: ${RY.map(r => cnt(r.k) ? `<i class="mini" style="background:${r.c}"></i>${cnt(r.k)}` : '').join(' ')}</div>
        ${d.website ? `<a class="rlink" href="${esc(d.website)}" target="_blank" rel="noopener">${esc(domainOf(d.website))} ↗</a>` : ''}</div></div>`;
  }).join('');
}
function pushRadar() {
  if (!map.getSource('dev')) {
    map.addSource('dev', { type: 'geojson', data: fc([]) });
    map.addLayer({ id: 'dev-halo', type: 'circle', source: 'dev', slot: 'top', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 15, 16], 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-blur': 0.6 } });
    map.addLayer({ id: 'dev-dot', type: 'circle', source: 'dev', slot: 'top', layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['+', 3, ['min', ['/', ['get', 'u'], 60], 4]], 15, ['+', 7, ['min', ['/', ['get', 'u'], 30], 7]]],
               'circle-color': ['case', ['==', ['get', 'old'], 1], '#0b0d10', ['get', 'color']],
               'circle-stroke-color': ['case', ['==', ['get', 'old'], 1], ['get', 'color'], '#0b0d10'], 'circle-stroke-width': ['case', ['==', ['get', 'old'], 1], 2.5, 1.5] } });
    map.addLayer({ id: 'dev-label', type: 'symbol', source: 'dev', slot: 'top', minzoom: 13.5, layout: { visibility: 'none',
        'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true, 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.3 } });
    map.on('click', 'dev-dot', e => openProject(e.features[0].properties.id));
    map.on('mouseenter', 'dev-dot', () => map.getCanvas().style.cursor = 'pointer'); map.on('mouseleave', 'dev-dot', () => map.getCanvas().style.cursor = '');
  }
  const feats = radFiltered().map(x => ({ type: 'Feature', properties: { id: x.id, name: x.name || '', color: x.y.c, u: x.units_total || 10, old: x.pt.k === 'neubau' ? 0 : 1 }, geometry: { type: 'Point', coordinates: [x.lng, x.lat] } }));
  map.getSource('dev').setData(fc(feats));
  if (!S.focusSaved) vis(['dev-halo', 'dev-dot', 'dev-label'], S.radarActive);
}
async function openProject(id) {
  const x = S.rad.list.find(p => p.id === id); if (!x) return;
  $('feedPanel').hidden = true; $('detail').hidden = true; $('lview').hidden = false;
  const st = S.stats[x.district] || {}, prem = st.buy_ppm && x.ppm_median ? (x.ppm_median / st.buy_ppm - 1) * 100 : null;
  const head = `<div class="dname"><i class="rdot big" style="background:${x.y.c}"></i>${esc(x.name || '—')}</div>
    <div class="daddr">${esc(x.address || '')}${x.zip ? ', ' + x.zip : ''} · ${x.district}-й район · ${x.y.k === 'done' ? (x.pt.k === 'altbau' ? 'санирован в ' : 'сдан в ') + x.completion_year : x.completion_year ? 'сдача ' + x.completion_year : 'срок сдачи не указан'}</div>
    <div class="ptline"><span class="ptb pt-${x.pt.k}">${x.pt.t}</span> ${esc(x.pt.d)}${x.built_year ? ` · дом построен в ${x.built_year}` : ''}${x.renovated_year ? `, санирован в ${x.renovated_year}` : ''}</div>
    ${prjGallery(x)}
    <div class="lv-btns">
      <a class="lvb" href="${esc(x.url)}" target="_blank" rel="noopener">wiew.at ↗</a>
      ${x.official_url ? `<a class="lvb" href="${esc(x.official_url)}" target="_blank" rel="noopener">сайт проекта ↗</a>` : ''}
      ${x.building_id ? '<button class="lvb primary" id="prjHouse">Открыть дом</button>' : '<button class="lvb primary" id="lvTrack">＋ Отслеживать как дом</button>'}
    </div>
    ${x.devs.length ? `<div class="rdev big">${x.devs.map(d => { const dd = S.rad.devs.find(q => q.name === d) || { name: d }; return `<span data-dev="${esc(d)}">${logoHtml(dd)}${esc(d)}</span>`; }).join('')}</div>` : ''}
    <dl class="rows">
      ${x.units_total ? `<dt>Квартир в проекте</dt><dd>${x.units_total}</dd>` : ''}
      <dt>Сейчас в продаже</dt><dd><b>${x.units_available || 0}</b>${x.units_reserved ? ` · ${x.units_reserved} зарезервировано` : ''}</dd>
      ${x.area_min ? `<dt>Площади</dt><dd>${Math.round(x.area_min)}–${Math.round(x.area_max)} м²${x.rooms_min ? ` · ${+x.rooms_min}–${+x.rooms_max} комн.` : ''}</dd>` : ''}
      ${x.price_min ? `<dt>Цены</dt><dd>${eur(x.price_min)} – ${eur(x.price_max)}</dd>` : ''}
      ${x.ppm_median ? `<dt>€/м²</dt><dd>${eur(x.ppm_min)} – ${eur(x.ppm_max)} · медиана <b>${eur(x.ppm_median)}</b>${prem != null ? ` · ${prem > 0 ? '+' : '−'}${Math.abs(Math.round(prem))}% к перепродаже в районе (${eur(st.buy_ppm)})` : ''}</dd>` : ''}
      ${x.energy_class ? `<dt>Энергокласс</dt><dd>${esc(x.energy_class)}</dd>` : ''}
      <dt>Скорость продаж</dt><dd>считается с 13.11.2026 — по изменениям списка квартир каждую ночь</dd>
    </dl>
    ${(x.amenities || []).length ? `<div class="amen">${x.amenities.map(a => `<span>${esc(a)}</span>`).join('')}</div>` : ''}`;
  $('lviewBody').innerHTML = head + '<p class="hint">Загружаю квартиры…</p>';
  bindProject(x);
  map.flyTo({ center: [x.lng, x.lat], zoom: Math.max(map.getZoom(), 15.5), pitch: 50, padding: detailPad(), duration: 1300 });
  const { data } = await sb.from('dev_units').select('unit_ref,floor,rooms,area_m2,price,ppm,status,price_history,plan_url').eq('project_id', id).is('gone_at', null).order('price').limit(400);
  const us = data || [];
  const rows = us.map(u => `<tr class="${u.status}"><td>${esc(u.unit_ref)}</td><td>${esc(u.floor || '')}</td><td>${u.rooms ? +u.rooms : ''}</td><td>${u.area_m2 ? (+u.area_m2).toFixed(1) : ''}</td><td>${eur(u.price)}${(u.price_history || []).length ? ' <em class="drop">↓</em>' : ''}</td><td>${u.ppm ? eur(u.ppm) : ''}</td><td>${u.status === 'reserved' ? 'резерв' : u.status === 'sold' ? 'продана' : ''}</td><td>${u.plan_url ? `<button class="plan" data-plan="${esc(u.plan_url)}" title="планировка">⌗</button>` : ''}</td></tr>`).join('');
  $('lviewBody').innerHTML = head + (us.length ? `<div class="ftitle sm">Квартиры (${us.length})</div>
    <table class="mtab units"><thead><tr><th>Top</th><th>Этаж</th><th>Комн.</th><th>м²</th><th>Цена</th><th>€/м²</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="src">Нажми строку — откроется расчёт ипотеки для этой квартиры.</p>` : '<p class="hint">Поквартирного списка у этого проекта на портале нет.</p>');
  bindProject(x, us);
}
// галерея проекта: визуализации снаружи / внутри / фото стройки по месяцам
const PK = { outside: 'Снаружи', inside: 'Внутри', build: 'Стройка' };
function prjGallery(x) {
  const ph = x.photos || [];
  if (!ph.length) return `<p class="hint">Фото проекта ещё собираются (официальный сайт + wiew.at, обновление раз в неделю).</p>`;
  const kinds = Object.keys(PK).filter(k => ph.some(p => p.kind === k));
  const k0 = S.prjKind && kinds.includes(S.prjKind) ? S.prjKind : kinds[0];
  const mon = d => { if (!d) return ''; const [y, m] = d.split('-'); return ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][+m - 1] + ' ' + y; };
  return `<div class="pgal"><div class="pgtabs">${kinds.map(k => `<button data-k="${k}" class="${k === k0 ? 'on' : ''}">${PK[k]} <b>${ph.filter(p => p.kind === k).length}</b></button>`).join('')}</div>
    <div class="gal pg">${ph.map((p, i) => `<a data-i="${i}" data-k="${p.kind}"${p.kind !== k0 ? ' hidden' : ''}><img src="${esc(p.url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()">${p.kind === 'build' && p.date ? `<span class="pdate">${mon(p.date)}</span>` : ''}</a>`).join('')}</div>
    <p class="src">Источник: ${[...new Set(ph.map(p => p.src === 'wiew' ? 'wiew.at' : p.src === 'both' ? 'сайт застройщика + wiew.at' : 'сайт застройщика'))].join(', ')}${ph.some(p => p.kind === 'build') ? '' : ' · фото стройки застройщик пока не публикует'}</p></div>`;
}
function lightbox(list, i) {
  let lb = $('lbox');
  if (!lb) { document.body.insertAdjacentHTML('beforeend', '<div id="lbox" hidden><img><div class="lbcap"></div><button class="lbx">✕</button><button class="lbp">‹</button><button class="lbn">›</button></div>'); lb = $('lbox'); }
  const show = () => { const p = list[i]; lb.querySelector('img').src = p.url; lb.querySelector('.lbcap').textContent = [p.cap, p.date, `${i + 1}/${list.length}`].filter(Boolean).join(' · '); };
  lb.querySelector('.lbx').onclick = () => lb.hidden = true;
  lb.querySelector('.lbp').onclick = e => { e.stopPropagation(); i = (i - 1 + list.length) % list.length; show(); };
  lb.querySelector('.lbn').onclick = e => { e.stopPropagation(); i = (i + 1) % list.length; show(); };
  lb.onclick = e => { if (e.target === lb) lb.hidden = true; };
  document.onkeydown = e => { if (lb.hidden) return; if (e.key === 'Escape') lb.hidden = true; if (e.key === 'ArrowRight') lb.querySelector('.lbn').click(); if (e.key === 'ArrowLeft') lb.querySelector('.lbp').click(); };
  show(); lb.hidden = false;
}
function bindProject(x, us) {
  $('lview').classList.add('wide');
  const g = $('lviewBody').querySelector('.pgal');
  if (g) {
    g.querySelector('.pgtabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.prjKind = b.dataset.k;
      g.querySelectorAll('.pgtabs button').forEach(z => z.classList.toggle('on', z === b)); g.querySelectorAll('.pg a').forEach(a => a.hidden = a.dataset.k !== b.dataset.k); };
    g.querySelector('.pg').onclick = e => { const a = e.target.closest('a'); if (!a) return; const k = a.dataset.k, list = (x.photos || []).filter(p => p.kind === k);
      lightbox(list, list.indexOf(x.photos[+a.dataset.i])); };
  }
  if ($('prjHouse')) $('prjHouse').onclick = () => { $('lview').hidden = true; select(x.building_id); };
  if ($('lvTrack')) $('lvTrack').onclick = () => trackHouse({ lat: x.lat, lng: x.lng, street: (x.address || '').replace(/\s+\d.*$/, ''), house_no: (x.address || '').match(/\d+[a-z]?/i)?.[0] || null, zip: x.zip, title: x.name });
  $('lviewBody').querySelectorAll('.rdev [data-dev]').forEach(el => el.onclick = () => radSetDev(el.dataset.dev));
  if (us) $('lviewBody').querySelectorAll('.units tbody tr').forEach((tr, i) => tr.onclick = e => {
    const pl = e.target.closest('[data-plan]'); if (pl) { lightbox([{ url: pl.dataset.plan, cap: `${x.name} · ${us[i].unit_ref} · планировка` }], 0); return; }
    const u = us[i]; const fake = { price: +u.price, area_m2: +u.area_m2, rooms: u.rooms, district: x.district, pid: 'wiew', is_private: false, deal_type: 'buy', title: `${x.name} · ${u.unit_ref}` };
    const old = $('lviewBody').querySelector('.buybox'); if (old) old.remove();
    tr.closest('table').insertAdjacentHTML('beforebegin', buyBlock(fake)); S.lvX = fake; bindBuy(fake);
    $('lviewBody').querySelector('.buybox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function radSetDev(name) {
  S.rad.dev = name; $('radQ').value = ''; S.rad.q = '';
  document.querySelectorAll('#radSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === 'projects'));
  $('radProjects').hidden = false; $('radDevs').hidden = true;
  renderRadar(); pushRadar(); radFit();
}
function radFit() {
  const l = radFiltered(); if (!l.length) return;
  const bb = new mapboxgl.LngLatBounds([l[0].lng, l[0].lat], [l[0].lng, l[0].lat]); l.forEach(x => bb.extend([x.lng, x.lat]));
  map.fitBounds(bb, { padding: Object.fromEntries(Object.entries(detailPad()).map(([k, v]) => [k, v + 50])), maxZoom: 15, duration: 1200 });
}
$('radYears').onclick = e => { const b = e.target.closest('.ychip'); if (!b) return; const R = S.rad; R.on.has(b.dataset.k) ? R.on.delete(b.dataset.k) : R.on.add(b.dataset.k);
  localSet('radYears', JSON.stringify([...R.on])); renderRadar(); pushRadar(); };
$('radTypes').onclick = e => { const b = e.target.closest('.ychip'); if (!b) return; const R = S.rad; R.types.has(b.dataset.k) ? R.types.delete(b.dataset.k) : R.types.add(b.dataset.k);
  localSet('radTypes', JSON.stringify([...R.types])); renderRadar(); pushRadar(); };
$('radSale').onchange = e => { S.rad.sale = e.target.checked; renderRadar(); pushRadar(); };
$('radMine').onchange = e => { S.rad.mine = e.target.checked; renderRadar(); pushRadar(); };
$('radQ').oninput = e => { S.rad.q = e.target.value.trim(); renderRadar(); pushRadar(); };
$('devQ').oninput = () => renderRadar();
$('radSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#radSeg button').forEach(x => x.classList.toggle('on', x === b));
  $('radProjects').hidden = b.dataset.v !== 'projects'; $('radDevs').hidden = b.dataset.v !== 'devs'; };
$('radList').onclick = e => { const d = e.target.closest('[data-dev]'); if (d) { radSetDev(d.dataset.dev); return; } const c = e.target.closest('.rcard'); if (c) openProject(c.dataset.id); };
$('devList').onclick = e => { if (e.target.closest('a')) return; const c = e.target.closest('.dcard'); if (c) radSetDev(c.dataset.dev); };
$('radDevF').onclick = e => { if (e.target.id === 'radDevX') { S.rad.dev = null; renderRadar(); pushRadar(); } };

/* ---------- шторка, вкладки, тема, режим ---------- */
$('tabs').onclick = e => {
  const t = e.target.closest('button'); if (!t) return;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t.dataset.tab));
  $('sheet').classList.remove('min');
  S.radarActive = t.dataset.tab === 'radar';
  if (S.radarActive && !S.rad.list.length) loadRadar(); else if (S.rad.list.length && !map.getSource('dev')) pushRadar(); else if (map.getSource('dev') && !S.focusSaved) vis(['dev-halo', 'dev-dot', 'dev-label'], S.radarActive);
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
  if (m === S.mode) return;
  S.mode = m; seg('modeSeg', m, 'mode');
  S.ff = readFF() || DEF_FF(); S.feedLim = 60; $('lview').hidden = true;
  if (!$('feedPanel').hidden) renderFFPanel();
  document.body.classList.toggle('buy', m === 'buy');
  toast(m === 'buy' ? 'Покупка: загружаю квартиры на продажу…' : 'Аренда', 1800);
  S.market = []; S.mkGroups = []; applyFilters();
  loadMarket().then(() => m === 'buy' && toast(`Продажа: ${S.market.length} объявлений. Допущения ипотеки — во вкладке «Расчёт».`, 3500));
};
addEventListener('resize', () => map.setPadding(S.selected ? detailPad() : basePad()));
map.on('moveend', () => { if ($('lSun').checked && !S.selected) pushSun(); });

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
  vis(['mk-dot'], $('lMarket').checked); if ($('lMarket').checked) pushMarket();
  pushOsm();
  vis(['sun-ring', 'sun-line', 'sun-label'], $('lSun').checked); if ($('lSun').checked) pushSun();
  const per = $('noiseNight').checked ? 'night' : 'day';
  for (const k of NOISE_KEYS) for (const p of ['day', 'night'])
    vis([`noise-${k}-${p}`], $('n_' + k).checked && p === per);
  const any = NOISE_KEYS.find(k => $('n_' + k).checked);
  const lg = $('noiseLegend');
  if (any) {
    lg.src = `${NOISE_WMS}?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&sld_version=1.1.0&layer=2022_STRASSE_${per === 'day' ? '24H' : 'NACHT'}_ZONEN_OE`;
    lg.hidden = false;
  } else lg.hidden = true;
  localSet('layers', JSON.stringify(Object.fromEntries([...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen', 'n_strasse', 'n_schiene', 'n_industrie', 'n_flug', 'noiseNight', 'lStnIcons', 'lStnNames', 'lMarket', 'lShops', 'lPharm', 'lNight', 'lPost', 'lLocker', 'lSun'].map(k => [k, $(k).checked]))));
}
try { const saved = JSON.parse(localGet('layers', '{}')); for (const [k, v] of Object.entries(saved)) if ($(k)) $(k).checked = v; } catch {}
[...Object.keys(LAYER_GROUPS), 'l3d', 'lPoiLabels', 'lGreen', 'n_strasse', 'n_schiene', 'n_industrie', 'n_flug', 'noiseNight', 'lStnIcons', 'lStnNames', 'lMarket', 'lShops', 'lPharm', 'lNight', 'lPost', 'lLocker', 'lSun'].forEach(id => $(id).onchange = syncLayerToggles);
$('noiseDay').onchange = syncLayerToggles;
$('txAll').onclick = () => { const on = !['lMetro', 'lSbahn', 'lTram', 'lBus'].every(k => $(k).checked); ['lMetro', 'lSbahn', 'lTram', 'lBus'].forEach(k => $(k).checked = on); syncLayerToggles(); };

/* ---------- расчёт ---------- */
function bindCalc(id, key, out, fmt) {
  const el = $(id); el.value = S.c[key];
  const upd = () => {
    S.c[key] = +el.value; $(out).textContent = fmt(S.c[key]);
    document.querySelectorAll(`.presets[data-target="${id}"] button`).forEach(b => b.classList.toggle('on', +b.dataset.v === S.c[key]));
    if (['eq', 'rate', 'years'].includes(key)) { localSet(key === 'rate' ? 'c_rate2' : 'c_' + key, S.c[key]); if (S.mode === 'buy') { renderFeed(); const x = S.lvX; if (x && !$('lview').hidden) { const bb = $('lviewBody').querySelector('.buybox'); if (bb) { bb.outerHTML = buyBlock(x); bindBuy(x); } } } }
    if (S.selected) renderDetail(S.selected);
  };
  el.oninput = upd; upd();
}
bindCalc('cMonths', 'months', 'vMonths', v => v + ' мес');
bindCalc('cFurn', 'furn', 'vFurn', eur);
bindCalc('cRec', 'rec', 'vRec', v => v + ' %');
bindCalc('cEq', 'eq', 'vEq', v => v + ' %');
bindCalc('cRate', 'rate', 'vRate', v => String(v).replace('.', ',') + ' %');
bindCalc('cYears', 'years', 'vYears', v => v + ' лет');
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
