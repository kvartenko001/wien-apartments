import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// 1) Маршруты: прокси к открытому планировщику Wiener Linien / VOR (EFA).
// 2) Шум у дома: стратегические шумовые карты 2022 (laerminfo.at, OGC API Features).
// Только для участников (таблица members).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const EFA = 'https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2';
const FEAT = 'https://gis.lfrz.gv.at/api/geodata/i000804/ogc/features/v1/collections/i000804:';
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function isMember(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')!, anon = Deno.env.get('SUPABASE_ANON_KEY')!, svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: req.headers.get('Authorization') || '' } });
  if (!u.ok) return false;
  const email = String((await u.json())?.email || '').toLowerCase();
  if (!email) return false;
  const m = await fetch(`${url}/rest/v1/members?select=email&email=eq.${encodeURIComponent(email)}`, { headers: { apikey: svc, Authorization: `Bearer ${svc}` } });
  const rows = m.ok ? await m.json() : [];
  return Array.isArray(rows) && rows.length > 0;
}

function kind(m: any): string {
  const p = String(m?.product || '').toLowerCase(), n = String(m?.number || '');
  if (!m || m.type === '100' || m.type === '99' || m.type === '97' || p.includes('fuss')) return 'walk';
  if (p.includes('u-bahn') || /^U\d/.test(n)) return 'subway';
  if (p.includes('s-bahn') || /^S\d/.test(n)) return 'sbahn';
  if (p.includes('straßenbahn') || p.includes('strassenbahn') || p.includes('tram')) return 'tram';
  if (p.includes('badner') || n === 'WLB') return 'wlb';
  if (p.includes('bus')) return 'bus';
  return 'train';
}
const hm = (s: string) => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + m; };
function pathOf(leg: any): number[][] {
  const raw = typeof leg.path === 'string' ? leg.path : '';
  const pts = raw.trim().split(/\s+/).filter(Boolean).map((p: string) => p.split(',').map(Number)).filter((p: number[]) => p.length === 2 && !isNaN(p[0]));
  if (pts.length < 2) return (leg.points || []).map((p: any) => String(p?.ref?.coords || '').split(',').map(Number)).filter((p: number[]) => p.length === 2 && !isNaN(p[0]));
  const step = Math.max(1, Math.floor(pts.length / 120));
  const out = pts.filter((_: any, i: number) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out.map((p: number[]) => [+p[0].toFixed(5), +p[1].toFixed(5)]);
}

async function route(b: any) {
  const [flng, flat] = b.from, [tlng, tlat] = b.to;
  const p = new URLSearchParams({
    outputFormat: 'JSON', coordOutputFormat: 'WGS84[DD.ddddd]', locationServerActive: '1',
    type_origin: 'coord', name_origin: `${(+flng).toFixed(6)}:${(+flat).toFixed(6)}:WGS84[DD.ddddd]`,
    type_destination: 'coord', name_destination: `${(+tlng).toFixed(6)}:${(+tlat).toFixed(6)}:WGS84[DD.ddddd]`,
    itdTripDateTimeDepArr: b.arr ? 'arr' : 'dep', calcNumberOfTrips: String(Math.min(b.n || 4, 6)),
    useRealtime: '1', coordListOutputFormat: 'STRING',
    changeSpeed: ['slow', 'normal', 'fast'].includes(b.speed) ? b.speed : 'fast',
  });
  if (b.date) p.set('itdDate', String(b.date));
  if (b.time) p.set('itdTime', String(b.time));
  const r = await fetch(`${EFA}?${p}`, { headers: { 'User-Agent': 'wien-apartments (personal)' } });
  if (!r.ok) return j({ error: 'upstream ' + r.status }, 502);
  const d = await r.json();
  const trips = (d.trips || []).map((t: any) => t.trip || t).map((t: any) => {
    const legs = (t.legs || []).map((l: any) => {
      const k = kind(l.mode), a = l.points?.[0], z = l.points?.[1];
      return {
        kind: k, line: l.mode?.number || l.mode?.symbol || '', product: l.mode?.product || '',
        dest: (l.mode?.destination || '').replace(/^Wien /, ''),
        from: a?.nameWO || a?.name || '', to: z?.nameWO || z?.name || '',
        dep: a?.dateTime?.rtTime || a?.dateTime?.time || '', arr: z?.dateTime?.rtTime || z?.dateTime?.time || '',
        min: +l.timeMinute || 0, stops: Array.isArray(l.stopSeq) ? Math.max(0, l.stopSeq.length - 1) : null,
        path: pathOf(l),
      };
    }).filter((l: any) => !(l.kind === 'walk' && l.min === 0 && l.path.length < 2));
    const walk = legs.filter((l: any) => l.kind === 'walk').reduce((s: number, l: any) => s + l.min, 0);
    const maxWalk = Math.max(0, ...legs.filter((l: any) => l.kind === 'walk').map((l: any) => l.min));
    return { duration: hm(t.duration), interchanges: +t.interchange || 0, walk, maxWalk, dep: legs[0]?.dep || '', arr: legs[legs.length - 1]?.arr || '', legs };
  });
  // варианты с долгой прогулкой (15+ мин одним куском) убираем, если есть нормальный вариант не хуже чем на 5 мин
  const okTrips = trips.filter((t: any) => t.maxWalk < 15);
  const bestOk = okTrips.length ? Math.min(...okTrips.map((t: any) => t.duration)) : Infinity;
  const shown = trips.filter((t: any) => t.maxWalk < 15 || t.duration < bestOk - 5);
  return j({ from: d.origin?.points?.point?.name || null, to: d.destination?.points?.point?.name || null, trips: shown.length ? shown : trips });
}

// шум у дома: какие зоны касаются контура дома (bbox + ~8 м). Самый тихий и самый громкий фасад, по источникам.
const cat = (c: string) => { const m = c.match(/(\d{2})(\d{2})?$/) || c.match(/(\d{2})/); return m ? +m[1] : 0; };
async function noise(b: any) {
  const [w, s, e, n] = b.bbox as number[], px = 0.00011, py = 0.00007;
  const bbox = [w - px, s - py, e + px, n + py].map(v => (+v).toFixed(6)).join(',');
  const out: Record<string, any> = {};
  await Promise.all(['strasse', 'schiene', 'industrie', 'flug'].flatMap(src => ['lden', 'lnight'].map(async idx => {
    let res: any = null;
    try {
      const r = await fetch(`${FEAT}laerm_2022_${src}_${idx}/items?f=json&limit=200&bbox=${bbox}&properties=category`);
      const d = await r.json();
      const v = (d.features || []).map((f: any) => cat(String(f.properties?.category || ''))).filter(Boolean);
      if (v.length) res = { min: Math.min(...v), max: Math.max(...v) };
    } catch { res = undefined; }
    (out[src] ||= {})[idx] = res;
  })));
  return j({ noise: out });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!(await isMember(req))) return j({ error: 'not a member' }, 403);
    const b = await req.json();
    if (b.bbox) return await noise(b);
    return await route(b);
  } catch (e) {
    return j({ error: String(e) }, 500);
  }
});
