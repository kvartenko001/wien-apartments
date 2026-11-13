const KEY = '<COLLECTOR_KEY>';
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const NAMES: Record<number, string> = {1: 'innere-stadt', 2: 'leopoldstadt', 3: 'landstrasse', 4: 'wieden', 5: 'margareten', 6: 'mariahilf', 7: 'neubau', 8: 'josefstadt', 9: 'alsergrund', 10: 'favoriten', 11: 'simmering', 12: 'meidling', 13: 'hietzing', 14: 'penzing', 15: 'rudolfsheim-fuenfhaus', 16: 'ottakring', 17: 'hernals', 18: 'waehring', 19: 'doebling', 20: 'brigittenau', 21: 'floridsdorf', 22: 'donaustadt', 23: 'liesing'};
const D: Record<number, { wh: string; is: string }> = Object.fromEntries(Object.entries(NAMES).map(([n, s]) => [n, { wh: `wien-1${String(n).padStart(2, '0')}0-${s}`, is: `${n}-bezirk-${s}` }]));
const MAX_PRICE = 2200, MIN_AREA = 38, BUY_MAX = 1500000, BUY_MIN_AREA = 30;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function splitAddr(a?: string | null) {
  if (!a) return { street: null, house_no: null };
  const s = a.split(',')[0].trim();
  const m = s.match(/^(.*?\D)\s*(\d+[a-zA-Z]?)(?:[\/\-\s].*)?$/);
  return m ? { street: m[1].trim(), house_no: m[2] } : { street: s, house_no: null };
}
const numPlain = (v: any) => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return isFinite(n) && n > 0 ? n : null; };

async function get(u: string) {
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-AT,de;q=0.9', Accept: 'text/html' } });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return await r.text();
}

async function willhaben(d: number, buy: boolean) {
  const out: any[] = [];
  for (let page = 1; page <= (buy ? 30 : 8); page++) {
    const html = await get(buy
      ? `https://www.willhaben.at/iad/immobilien/eigentumswohnung/wien/${D[d].wh}?rows=90&page=${page}&PRICE_TO=${BUY_MAX}&ESTATE_SIZE/LIVING_AREA_FROM=${BUY_MIN_AREA}`
      : `https://www.willhaben.at/iad/immobilien/mietwohnungen/wien/${D[d].wh}?rows=90&page=${page}&PRICE_TO=${MAX_PRICE}&ESTATE_SIZE/LIVING_AREA_FROM=${MIN_AREA}`);
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) break;
    const sr = JSON.parse(m[1])?.props?.pageProps?.searchResult;
    const ads = sr?.advertSummaryList?.advertSummary || [];
    for (const a of ads) {
      const at: Record<string, string> = {};
      for (const x of a.attributes?.attribute || []) at[x.name] = x.values?.[0];
      const [lat, lng] = String(at.COORDINATES || '').split(',').map(Number);
      const ad = splitAddr(at.ADDRESS);
      out.push({
        source: 'willhaben', ext_id: String(a.id),
        url: at.SEO_URL ? `https://www.willhaben.at/iad/${at.SEO_URL}` : `https://www.willhaben.at/iad/object?adId=${a.id}`,
        title: at.HEADING || a.description || null, ...ad, zip: at.POSTCODE || null, district: d,
        lat: isFinite(lat) && lat > 0 ? lat : null, lng: isFinite(lng) && lng > 0 ? lng : null,
        price: numPlain(at.PRICE), area_m2: numPlain(at['ESTATE_SIZE/LIVING_AREA']), rooms: numPlain(at.NUMBER_OF_ROOMS),
        is_private: at.ISPRIVATE === '1' ? true : at.ISPRIVATE === '0' ? false : null,
        published_at: at.PUBLISHED_String || null,
        deal_type: buy ? 'buy' : 'rent',
        raw: { address: at.ADDRESS || null, image: at.MMO || null, floor: at.FLOOR || null, project_id: at.PROJECT_ID || null, org: at.ORGNAME || null, free_area: at.FREE_AREA_TYPE_NAME || null },
      });
    }
    const total = +sr?.rowsFound || 0;
    if (ads.length < 90 || page * 90 >= total) break;
    await sleep(buy ? 350 : 700);
  }
  return out;
}

function jsonAt(t: string, p: number) {
  while (t[p] !== '{' && p < t.length) p++;
  let depth = 0, inStr = false, esc = false;
  for (let k = p; k < t.length; k++) {
    const ch = t[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return t.slice(p, k + 1); }
  }
  return '{}';
}

async function immoscout(d: number, buy: boolean) {
  const out: any[] = [];
  for (let page = 1; page <= (buy ? 30 : 20); page++) {
    const html = await get(`https://www.immobilienscout24.at/regional/wien/wien/${D[d].is}/${buy ? 'wohnung-kaufen' : 'wohnung-mieten'}${page > 1 ? '/seite-' + page : ''}`);
    const i = html.indexOf('window.__INITIAL_STATE__=');
    if (i < 0) break;
    const raw = jsonAt(html, i + 'window.__INITIAL_STATE__='.length).replace(/:undefined([,}])/g, ':null$1');
    let st: any; try { st = JSON.parse(raw); } catch { break; }
    const hits: any[] = [];
    const walk = (o: any, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 8) return;
      if (Array.isArray(o)) { if (o.length && o[0] && o[0].exposeId) { hits.push(...o); return; } for (const x of o) walk(x, depth + 1); return; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    };
    walk(st);
    if (!hits.length) break;
    for (const h of hits) {
      if (h.meta?.hasChildren || h.appearanceSettings?.hasChildren) continue;
      const zipM = String(h.addressString || '').match(/\b(1\d{3})\b/);
      const first = String(h.addressString || '').split(',')[0];
      const ad = splitAddr(first);
      const price = h.primaryPrice ?? null, area = h.primaryArea ?? null;
      if (buy ? ((price && price > BUY_MAX) || (area && area < BUY_MIN_AREA)) : ((price && price > MAX_PRICE) || (area && area < MIN_AREA))) continue;
      out.push({
        source: 'immoscout', ext_id: String(h.exposeId),
        url: h.links?.absoluteURL || `https://www.immobilienscout24.at/expose/${h.exposeId}`,
        title: h.headline || h.title || null,
        street: /^\s*\d{4}\b/.test(first) ? null : ad.street,
        house_no: /^\s*\d{4}\b/.test(first) ? null : ad.house_no, zip: zipM ? zipM[1] : null, district: d,
        lat: h.location?.lat ?? null, lng: h.location?.lon ?? null,
        price, area_m2: area, rooms: h.numberOfRooms ?? null,
        is_private: typeof h.isPrivate === 'boolean' ? h.isPrivate : null,
        published_at: h.dateCreated || null,
        deal_type: buy ? 'buy' : 'rent',
        raw: { address: h.addressString || null, badges: (h.typedBadges || []).map((b: any) => b?.details?.value).filter(Boolean) },
      });
    }
    const pg = JSON.stringify(st).match(/"totalPages":(\d+)/);
    if (pg && page >= +pg[1]) break;
    await sleep(buy ? 350 : 700);
  }
  return out;
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('key') !== KEY) return json({ error: 'forbidden' }, 403);
  const source = q.get('source') || 'willhaben', d = +(q.get('district') || 0), buy = q.get('deal') === 'buy', deal = buy ? 'buy' : 'rent';
  if (!D[d]) return json({ error: 'unknown district' }, 400);
  const started = new Date().toISOString();
  try {
    const items = source === 'immoscout' ? await immoscout(d, buy) : await willhaben(d, buy);
    const seen = new Map(items.map(x => [x.ext_id, x]));
    const rows = [...seen.values()].map(x => ({ ...x, last_seen: started, removed_at: null }));
    for (let i = 0; i < rows.length; i += 200)
      await rest('market_listings?on_conflict=source,ext_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200)) });
    if (rows.length > 5)
      await rest(`market_listings?source=eq.${source}&district=eq.${d}&deal_type=eq.${deal}&removed_at=is.null&last_seen=lt.${encodeURIComponent(started)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ removed_at: started }) });
    await rest('rpc/market_match', { method: 'POST', body: '{}' });
    await rest('market_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: source + (buy ? ':buy' : ''), district: d, started_at: started, finished_at: new Date().toISOString(), found: rows.length }) });
    return json({ source, deal, district: d, found: rows.length });
  } catch (e) {
    await rest('market_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source, district: d, started_at: started, finished_at: new Date().toISOString(), error: String(e).slice(0, 500) }) }).catch(() => {});
    return json({ error: String(e) }, 500);
  }
});
