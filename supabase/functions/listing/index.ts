import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Подробности объявления для просмотра прямо в приложении: фото, описание, параметры. Только для участников.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const text = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<li>/gi, '• ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

async function isMember(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')!, anon = Deno.env.get('SUPABASE_ANON_KEY')!, svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: req.headers.get('Authorization') || '' } });
  if (!u.ok) return false;
  const email = String((await u.json())?.email || '').toLowerCase();
  const m = await fetch(`${url}/rest/v1/members?select=email&email=eq.${encodeURIComponent(email)}`, { headers: { apikey: svc, Authorization: `Bearer ${svc}` } });
  const rows = m.ok ? await m.json() : [];
  return Array.isArray(rows) && rows.length > 0;
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

function willhaben(html: string) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const ad = JSON.parse(m[1])?.props?.pageProps?.advertDetails;
  if (!ad) return null;
  const a: Record<string, string> = {};
  for (const x of ad.attributes?.attribute || []) a[x.name] = x.values?.[0];
  const imgs = (ad.advertImageList?.advertImage || []).map((i: any) => i.mainImageUrl || i.referenceImageUrl).filter(Boolean).slice(0, 20);
  const equip = (ad.equipmentList?.equipment || ad.equipmentList || []).flatMap?.((e: any) => e?.values || e?.name || []) || [];
  const extra = ['GENERAL_TEXT_ADVERT/Ausstattung', 'GENERAL_TEXT_ADVERT/Lage', 'GENERAL_TEXT_ADVERT/Sonstiges'].map(k => a[k] ? text(a[k]) : '').filter(Boolean);
  const facts: [string, string | undefined][] = [
    ['Аренда всего', a['RENTAL_PRICE/PER_MONTH_FOR_DISPLAY']], ['Брутто без отопления', a['RENTAL_PRICE/GROSS'] && '€ ' + a['RENTAL_PRICE/GROSS']],
    ['Betriebskosten', a['RENTAL_PRICE/ADDITIONAL_COST_GROSS'] && '€ ' + a['RENTAL_PRICE/ADDITIONAL_COST_GROSS']],
    ['Отопление', a['RENTAL_PRICE/HEATINGCOSTSGROSS'] && '€ ' + a['RENTAL_PRICE/HEATINGCOSTSGROSS']],
    ['Залог', a['ADDITIONAL_COST/DEPOSIT'] && '€ ' + a['ADDITIONAL_COST/DEPOSIT']], ['Провизия', a['ADDITIONAL_COST/PROVISION'] || a['ADDITIONAL_COST/FEE']],
    ['Площадь', a['ESTATE_SIZE/LIVING_AREA'] && a['ESTATE_SIZE/LIVING_AREA'] + ' м²'], ['Комнат', a['NO_OF_ROOMS']], ['Этаж', a['FLOOR']],
    ['Наружная площадь', a['FREE_AREA/FREE_AREA_TYPE_AND_AREA']], ['Срок', [a['DURATION/HASTERMLIMIT'], a['DURATION/TERMLIMITTEXT']].filter(Boolean).join(', ')],
    ['Свободна', a['AVAILABLE_NOW'] || a['AVAILABLE_DATE']], ['Состояние', a['BUILDING_CONDITION']], ['Тип дома', a['BUILDING_TYPE']],
    ['Отопление (тип)', a['HEATING']], ['HWB', a['ENERGY_HWB'] && `${a['ENERGY_HWB']} (${a['ENERGY_HWB_CLASS'] || '?'})`],
    ['Пол', a['FLOOR_SURFACE']], ['Частник', a['ISPRIVATE'] === '1' ? 'да' : a['ISPRIVATE'] === '0' ? 'нет, маклер' : undefined],
  ];
  return {
    title: a.HEADING || ad.description, images: imgs, description: text(a.DESCRIPTION || ''), extra,
    facts: facts.filter(f => f[1]).map(([k, v]) => ({ k, v })), equipment: [...new Set(equip.map(String))].slice(0, 30),
    address: [a['LOCATION/ADDRESS_1'], a['POSTCODE'] || '', a['LOCATION/ADDRESS_2']].filter(Boolean).join(', '),
    lift: equip.some((e: any) => /lift|fahrstuhl|aufzug/i.test(String(e))) || /\b(lift|aufzug|fahrstuhl)\b/i.test(a.DESCRIPTION || '') || null,
    contact: ad.organisationDetails?.orgName || ad.advertContactDetails?.contactName || null,
  };
}

function generic(html: string) {
  const meta = (p: string) => (html.match(new RegExp(`<meta[^>]+(?:property|name)="${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1];
  let st: any = null;
  const i = html.indexOf('window.__INITIAL_STATE__=');
  if (i >= 0) { try { st = JSON.parse(jsonAt(html, i + 25).replace(/:undefined([,}])/g, ':null$1')); } catch { /* */ } }
  const imgs = new Set<string>();
  const s = st ? JSON.stringify(st) : html;
  for (const m of s.matchAll(/https:\\?\/\\?\/[^"\\\s]+?\.(?:jpe?g|webp)(?:\?[^"\\\s]*)?/gi)) { const u = m[0].replace(/\\\//g, '/'); if (!/logo|icon|avatar/i.test(u)) imgs.add(u); if (imgs.size > 20) break; }
  const desc = st ? (JSON.stringify(st).match(/"(?:description|descriptionNote|objectDescription)":"((?:[^"\\]|\\.){40,4000})"/) || [])[1] : null;
  const facts: { k: string; v: string }[] = [];
  if (st) for (const m of JSON.stringify(st).matchAll(/"label":"([^"]{2,40})","value":"([^"]{1,60})"/g)) { facts.push({ k: m[1], v: m[2] }); if (facts.length > 25) break; }
  const lift = /\b(lift|aufzug|fahrstuhl|personenaufzug)\b/i.test(s) || null;
  return { title: meta('og:title'), images: [...imgs], description: text((desc ? JSON.parse(`"${desc}"`) : null) || meta('og:description') || meta('description') || ''),
    extra: [], facts, equipment: [], address: null, lift, contact: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!(await isMember(req))) return j({ error: 'not a member' }, 403);
    const { url } = await req.json();
    if (!/^https:\/\/(www\.)?(willhaben\.at|immobilienscout24\.at)\//.test(url || '')) return j({ error: 'unsupported url' }, 400);
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-AT,de;q=0.9' } });
    if (r.status === 404 || r.status === 410) return j({ gone: true });
    const html = await r.text();
    const data = (url.includes('willhaben') ? willhaben(html) : null) || generic(html);
    return j(data);
  } catch (e) { return j({ error: String(e) }, 500); }
});
