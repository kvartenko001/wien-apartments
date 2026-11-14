import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ÖV-качество у дома по официальной методике ÖROK «ÖV-Güteklassen» (Австрия, 2017/2022)
// + разнообразие линий в 500 м + время до центра (Stephansplatz) в будний день.
// Расписание и пешие расстояния — открытый планировщик Wiener Linien / VOR (EFA), плановые данные (не онлайн).
// Вызов: POST {lng, lat} (участник, JWT) или GET ?key=<COLLECTOR_KEY>&mode=ref&n=4 (эталон для процентиля).
const KEY = '<COLLECTOR_KEY>';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const EFA = 'https://www.wienerlinien.at/ogd_routing/';
const UA = { 'User-Agent': 'wien-apartments (personal, low volume)' };
const CENTER = [16.37251, 48.20849]; // Stephansplatz
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function isMember(req: Request) {
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: req.headers.get('Authorization') || '' } });
  if (!u.ok) return false;
  const email = String((await u.json())?.email || '').toLowerCase(); if (!email) return false;
  const m = await fetch(`${URL_}/rest/v1/members?select=email&email=eq.${encodeURIComponent(email)}`, { headers: H });
  const rows = m.ok ? await m.json() : []; return Array.isArray(rows) && rows.length > 0;
}

// обычный рабочий вторник: ≥ 3 дней вперёд, вне праздников и рождественской недели
function refDate() {
  const d = new Date(Date.now() + 3 * 864e5);
  while (true) {
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const bad = md >= 1222 || md <= 107 || [501, 815, 1026, 1101, 1208].includes(md);
    if (d.getUTCDay() === 2 && !bad) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ÖROK: категория остановки по виду транспорта и интервалу (все линии, оба направления × 0,5)
const CAT: Record<string, (string | null)[]> = { // интервалы: <5, 5–10, 10–20, 20–40, 40–60, 60–120, 120–210
  fern: ['I', 'I', 'II', 'III', 'IV', 'V', 'VII'], bahn: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VIII'],
  tram: ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'], bus: ['III', 'III', 'IV', 'V', 'VI', 'VII', null] };
const KL: Record<string, (string | null)[]> = { // ≤300, 301–500, 501–750, 751–1000, 1001–1250 м
  I: ['A', 'A', 'B', 'C', 'D'], II: ['A', 'B', 'C', 'D', 'E'], III: ['B', 'C', 'D', 'E', 'F'], IV: ['C', 'D', 'E', 'F', 'G'],
  V: ['D', 'E', 'F', 'G', 'G'], VI: ['E', 'F', 'G', null, null], VII: ['F', 'G', 'G', null, null], VIII: ['G', 'G', null, null, null] };
const RANK = 'ABCDEFG';
const ivRow = (iv: number) => iv < 5 ? 0 : iv <= 10 ? 1 : iv < 20 ? 2 : iv <= 40 ? 3 : iv <= 60 ? 4 : iv <= 120 ? 5 : iv <= 210 ? 6 : -1;
const band = (m: number) => m <= 300 ? 0 : m <= 500 ? 1 : m <= 750 ? 2 : m <= 1000 ? 3 : m <= 1250 ? 4 : -1;
function modeOf(mot: number, num: string) {
  if (/^(RJX?|ICE?|EC|EN|NJ|REX|D)\b/i.test(num)) return 'fern';
  if (mot === 0 || mot === 1 || mot === 2 || mot === 3) return 'bahn';   // Zug, S-Bahn, U-Bahn, Stadtbahn/WLB
  if (mot === 4) return 'tram';
  return 'bus';
}
const MODE_RANK = ['fern', 'bahn', 'tram', 'bus'];
const kindOf = (mot: number, num: string) => /^U\d/.test(num) ? 'U' : /^S\d/.test(num) || mot === 1 ? 'S' : mot === 0 ? 'R' : mot === 4 ? 'T' : mot === 3 ? 'B' : 'Bus';

async function dm(lng: number, lat: number, date: string, time: string) {
  const p = new URLSearchParams({ outputFormat: 'JSON', coordOutputFormat: 'WGS84[DD.ddddd]', locationServerActive: '1', type_dm: 'coord',
    name_dm: `${lng.toFixed(6)}:${lat.toFixed(6)}:WGS84[DD.ddddd]`, itdDate: date, itdTime: time, mode: 'direct', useRealtime: '0',
    limit: '1500', itdDateTimeDepArr: 'dep', useAllStops: '1' });
  const r = await fetch(`${EFA}XML_DM_REQUEST?${p}`, { headers: UA });
  if (!r.ok) throw new Error('dm ' + r.status);
  return await r.json();
}

// окна: утренний пик 7–9 и день 12–14 (ÖROK берёт 6–20 ч; две выборки по 2 ч — приближение)
const WINDOWS: [string, number][] = [['0700', 420], ['1200', 720]];
async function stopsAround(lng: number, lat: number, date: string) {
  const stops = new Map<string, any>();
  for (const [t, start] of WINDOWS) {
    const d = await dm(lng, lat, date, t);
    for (const s of (d.dm?.itdOdvAssignedStops || [])) {
      const id = String(s.stopID);
      if (!stops.has(id)) stops.set(id, { id, name: s.name, dist: +s.distance || 0, walk: +s.distanceTime || 0, x: +s.x, y: +s.y, lines: new Map(), cnt: [0, 0], cover: [0, 0] });
    }
    const deps = d.departureList || [];
    const wi = start === 420 ? 0 : 1;
    let last = start;
    for (const x of deps) {
      const dt = x.dateTime || {}; const m = (+dt.hour) * 60 + (+dt.minute);
      if (+dt.day && m < start) continue;
      if (m >= start + 120) continue;
      last = Math.max(last, m);
      const st = stops.get(String(x.stopID)); if (!st) continue;
      const num = String(x.servingLine?.number || x.servingLine?.symbol || ''), mot = +x.servingLine?.motType;
      if (/^N\d/.test(num)) continue;                           // ночные линии
      st.cnt[wi]++;
      const ln = st.lines.get(num) || { num, mot, mode: modeOf(mot, num), kind: kindOf(mot, num), n: [0, 0] };
      ln.n[wi]++; st.lines.set(num, ln);
    }
    const truncated = deps.length >= 1500;
    for (const st of stops.values()) st.cover[wi] = truncated ? Math.max(30, last - start) : 120;
    await sleep(400);
  }
  return [...stops.values()];
}

async function centerTime(lng: number, lat: number, date: string) {
  const p = new URLSearchParams({ outputFormat: 'JSON', coordOutputFormat: 'WGS84[DD.ddddd]', locationServerActive: '1',
    type_origin: 'coord', name_origin: `${lng.toFixed(6)}:${lat.toFixed(6)}:WGS84[DD.ddddd]`,
    type_destination: 'coord', name_destination: `${CENTER[0]}:${CENTER[1]}:WGS84[DD.ddddd]`,
    itdDate: date, itdTime: '0830', itdTripDateTimeDepArr: 'arr', calcNumberOfTrips: '4', useRealtime: '0', changeSpeed: 'normal' });
  const r = await fetch(`${EFA}XML_TRIP_REQUEST2?${p}`, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  const ts = (d.trips || []).map((t: any) => t.trip || t).map((t: any) => { const [h, m] = String(t.duration || '').split(':').map(Number); return h * 60 + m; }).filter((x: number) => x > 0);
  return ts.length ? Math.min(...ts) : null;
}

async function compute(lng: number, lat: number) {
  const date = refDate();
  const stops = await stopsAround(lng, lat, date);
  let best: any = null;
  const rows = stops.map(st => {
    const perWin = [0, 1].map(i => st.cover[i] ? st.cnt[i] * 120 / st.cover[i] : 0);    // отправлений за 2 ч
    const depH = (perWin[0] + perWin[1]) / 4;                                          // в час, оба направления
    const iv = depH > 0 ? 60 / (depH * 0.5) : Infinity;                                // интервал в одном направлении
    const lines = [...st.lines.values()];
    const mode = MODE_RANK.find(m => lines.some(l => l.mode === m)) || 'bus';
    const row = ivRow(iv), cat = row >= 0 ? CAT[mode][row] : null;
    const b = band(st.dist), kl = cat && b >= 0 ? KL[cat][b] : null;
    const r = { name: st.name, dist: st.dist, walk: st.walk, depH: Math.round(depH), iv: isFinite(iv) ? Math.round(iv * 10) / 10 : null, mode, cat, kl,
      lines: lines.map(l => ({ num: l.num, kind: l.kind, perH: Math.round((l.n[0] + l.n[1]) / 4 * 10) / 10 })).sort((a, b) => b.perH - a.perH) };
    if (kl && (!best || RANK.indexOf(kl) < RANK.indexOf(best.kl))) best = r;
    return r;
  }).sort((a, b) => a.dist - b.dist);
  // разнообразие: разные линии в 500 м пешком, вес по виду
  const near = new Map<string, string>();
  for (const r of rows) if (r.dist <= 500) for (const l of r.lines) if (l.perH >= 1) near.set(l.num, l.kind);
  const W: Record<string, number> = { U: 3, T: 1.5, S: 1.5, R: 1.5, B: 1.5, Bus: 1 };   // v2: S-Bahn = трамвай (в Вене S-Bahn чаще раз в 15 мин, частота уже учтена в классе ÖROK)
  const variety = [...near.values()].reduce((a, k) => a + (W[k] || 1), 0);
  const kinds = [...new Set(near.values())];
  const dC = Math.hypot((lng - CENTER[0]) * 74400, (lat - CENTER[1]) * 111200);              // м до Stephansplatz
  const center = dC < 900 ? Math.max(1, Math.round(dC * 1.25 / 80)) : await centerTime(lng, lat, date); // рядом с центром — пешком
  const klScore: Record<string, number> = { A: 100, B: 85, C: 70, D: 55, E: 40, F: 25, G: 12 };
  const s1 = best ? klScore[best.kl] : 0;
  const s2 = Math.min(100, variety / 8 * 100);
  const s3 = center == null ? null : Math.max(0, Math.min(100, (50 - center) / (50 - 15) * 100));
  const score = s3 == null ? (s1 * 0.5 + s2 * 0.15) / 0.65 : s1 * 0.5 / 0.9 + s2 * 0.15 / 0.9 + s3 * 0.25 / 0.9; // ÖV-часть без велосипеда (10 %)
  return { v: 2, date, klasse: best?.kl || null, best, stops: rows.slice(0, 14), lines500: [...near.entries()].map(([num, kind]) => ({ num, kind })), kinds,
    variety: Math.round(variety * 10) / 10, center, parts: { klasse: s1, variety: Math.round(s2), center: s3 == null ? null : Math.round(s3) }, score: Math.round(score * 10) / 10 };
}

const key4 = (lng: number, lat: number) => `${lng.toFixed(4)},${lat.toFixed(4)}`;
async function cached(lng: number, lat: number, maxAgeDays = 35) {
  const k = key4(lng, lat);
  const r = await fetch(`${URL_}/rest/v1/loc_oev?select=data,computed_at&k=eq.${encodeURIComponent(k)}`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  if (rows[0] && rows[0].data?.v === 2 && Date.now() - new Date(rows[0].computed_at).getTime() < maxAgeDays * 864e5) return rows[0].data;
  const data = await compute(lng, lat);
  await fetch(`${URL_}/rest/v1/loc_oev?on_conflict=k`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ k, lng: +lng.toFixed(4), lat: +lat.toFixed(4), data, score: data.score, computed_at: new Date().toISOString() }) });
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const q = new URL(req.url).searchParams;
    if (q.get('key') === KEY && q.get('mode') === 'ref') {
      // эталон: случайные адреса рынка из loc_ref, у которых ещё нет ÖV-расчёта
      const n = Math.min(+(q.get('n') || 4), 10);
      const r = await fetch(`${URL_}/rest/v1/rpc/oev_ref_todo`, { method: 'POST', headers: H, body: JSON.stringify({ n }) });
      const todo = r.ok ? await r.json() : [];
      const done: any[] = [];
      for (const p of todo) { try { const d = await cached(+p.lng, +p.lat); done.push({ k: key4(+p.lng, +p.lat), s: d.score, kl: d.klasse }); } catch (e) { done.push({ err: String(e).slice(0, 80) }); } await sleep(800); }
      return j({ done });
    }
    if (q.get('key') === KEY && q.get('lng')) return j(await compute(+q.get('lng')!, +q.get('lat')!));   // тест без кэша
    if (!(await isMember(req))) return j({ error: 'not a member' }, 403);
    const b = await req.json();
    const lng = +b.lng, lat = +b.lat;
    if (!(lng > 16 && lng < 16.8 && lat > 47.9 && lat < 48.5)) return j({ error: 'bad coords' }, 400);
    return j(await cached(lng, lat));
  } catch (e) {
    return j({ error: String(e) }, 500);
  }
});
