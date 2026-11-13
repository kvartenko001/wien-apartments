// Фото домов (v3, 13.11.2026). Порядок в галерее:
//   1) официальные: сайт ЖК/застройщика/архитектора (buildings.official_url + buildings.photo_pages) — сначала снаружи, потом внутри/общие зоны;
//   2) фото квартир из актуальных объявлений по дому (Willhaben, ImmoScout24).
// Храним только ссылки и источник (фото чужие). Вручную добавленные фото (source не Willhaben/ImmoScout) сохраняются.
// Запуск: GET /functions/v1/photos?key=<COLLECTOR_KEY>[&id=<building uuid>][&missing=1]
//   cron photos-daily — все дома раз в день; cron photos-new — каждые 15 мин дома без фото (сразу после разбора).
const KEY = '<COLLECTOR_KEY>';
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const MAX = 40;
const OUTSIDE = /au(ss|ß)enansicht|fassade|geb(ä|ae)ude|exterior|facade|tower\b|turm|hochhaus|visuali[sz]|rendering|luftbild|aerial|skyline|bauteil|phase/i;
const INSIDE = /lobby|lounge|foyer|eingang|entrance|fitness|gym|pool|sauna|ruheraum|spa\b|dachterrasse|rooftop|co-?working|kino|cinema|gemeinschaft|common|innenhof|garten|spielplatz/i;
const APT = /apartment|wohnung|staging|wohn(bereich|raum|zimmer)|schlafzimmer|zimmer|k(ü|ue)che|bad(ezimmer)?\b|studio|loggia|balkon/i;
const JUNK = /logo|icon|favicon|avatar|sprite|placeholder|\bmap\b|karte|grundriss|floorplan|portrait|team|person|metawien|1200x630|topping|handover|spatenstich|dachgleiche|ceremony|richtfest|\/s\d{3}x\d{3}\/|\/small\/|\/medium/i;
const kind = (s: string) => OUTSIDE.test(s) ? 'снаружи' : INSIDE.test(s) ? 'общие зоны' : APT.test(s) ? 'квартира' : 'проект';

async function html(url: string) { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8' } }); if (!r.ok) throw new Error(`${r.status}`); return await r.text(); }

// официальная страница: og:image + <img src/srcset alt> + крупные jpg/webp в коде страницы
async function pageImages(url: string) {
  const h = await html(url), base = new URL(url), out: { url: string; desc: string }[] = [];
  const push = (u: string, d = '') => { try { const abs = new URL(u.replace(/&amp;/g, '&'), base).href; if (!JUNK.test(abs + ' ' + d) && /\.(jpe?g|webp|png)(\?|$)/i.test(abs)) out.push({ url: abs, desc: d }); } catch { /* */ } };
  for (const m of h.matchAll(/<meta[^>]+(?:property|name)="(?:og:image|twitter:image)(?::url)?"[^>]+content="([^"]+)"/gi)) push(m[1], 'og');
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0], alt = tag.match(/\balt="([^"]*)"/i)?.[1] || '', title = tag.match(/\btitle="([^"]*)"/i)?.[1] || '';
    const set = tag.match(/\b(?:data-)?srcset="([^"]+)"/i)?.[1];
    const src = set ? set.split(',').map(s => s.trim().split(/\s+/)).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0][0]
      : tag.match(/\b(?:data-src|data-lazy-src|src)="([^"]+)"/i)?.[1];
    const w = parseInt(tag.match(/\bwidth="(\d+)"/i)?.[1] || '0');
    if (src && (w === 0 || w >= 500)) push(src, (alt + ' ' + title).trim());
  }
  for (const m of h.matchAll(/https?:\/\/[^"'\s()<>]+?\.(?:jpe?g|webp)/gi)) if (/1200|1400|1600|1920|2000|2400|large|full|xl|original|cdn\.sanity/i.test(m[0])) push(m[0], '');
  const seen = new Set<string>();
  return out.filter(x => { const k = x.url.replace(/[?#].*$/, '').replace(/-\d{2,4}x\d{2,4}(?=\.)/, '').split('/').pop()!; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
}
async function whImages(url: string) {
  const h = await html(url);
  const m = h.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  const ad = JSON.parse(m[1])?.props?.pageProps?.advertDetails;
  return (ad?.advertImageList?.advertImage || []).map((i: any) => ({ url: i.mainImageUrl || i.referenceImageUrl, desc: i.description || '' })).filter((i: any) => i.url);
}
async function isImages(url: string) {   // ImmoScout24: картинки объявления с pictureserver
  const h = await html(url), out: { url: string; desc: string }[] = [], seen = new Set<string>();
  for (const m of h.matchAll(/https:\/\/pictures\.immobilienscout24\.de\/[^"'\s\\]+?loadPicture\?[^"'\s\\]*?id=([\w.\-]+)/g)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    out.push({ url: `https://pictures.immobilienscout24.de/prod.www.immobilienscout24.at/pictureserver/loadPicture?q=80&id=${m[1]}`, desc: '' });
  }
  return out.slice(0, 15);
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('key') !== KEY) return new Response('forbidden', { status: 403 });
  const only = q.get('id'), missing = q.get('missing') === '1';
  let filter = only ? '&id=eq.' + only : '';
  if (missing) filter += '&research_status=eq.done&photos_checked_at=is.null';   // новые дома, ещё ни разу не обработанные
  const bs = await (await fetch(`${URL_}/rest/v1/buildings?select=id,name,official_url,photo_pages,photos${filter}`, { headers: H })).json();
  const report: any[] = [];
  for (const b of bs) {
    const keep = (b.photos || []).filter((p: any) => !['Willhaben', 'ImmoScout24'].includes(p.source) && !p.auto);
    const photos: any[] = [...keep], seen = new Set<string>(keep.map((p: any) => p.url));
    const add = (url: string, source: string, page: string, desc = '', k = 'квартира', auto = true) => {
      if (!url || seen.has(url) || photos.length >= MAX) return; seen.add(url); photos.push({ url, source, page, desc, kind: k, auto });
    };
    // 1) официальные страницы: снаружи → общие зоны → прочее
    const pages = [...new Set([b.official_url, ...(b.photo_pages || [])].filter(Boolean))] as string[];
    const off: any[] = [];
    for (const p of pages) { try { (await pageImages(p)).forEach((x, i) => off.push({ ...x, page: p, k: kind(x.desc + ' ' + x.url), i })); } catch { /* */ } }
    const ord: Record<string, number> = { 'снаружи': 0, 'общие зоны': 1, 'квартира': 2, 'проект': 3 };
    off.sort((a, b) => ord[a.k] - ord[b.k] || a.i - b.i).forEach(x => add(x.url, new URL(x.page).hostname.replace(/^www\./, ''), x.page, x.desc, x.k));
    // 2) фото квартир из объявлений по этому дому
    const ls = await (await fetch(`${URL_}/rest/v1/market_listings?select=url,source&building_id=eq.${b.id}&removed_at=is.null&order=first_seen.desc&limit=8`, { headers: H })).json();
    const imgs: any[] = [];
    for (const l of ls) {
      try {
        const list = l.source === 'willhaben' ? await whImages(l.url) : l.source === 'immoscout' ? await isImages(l.url) : [];
        list.forEach((x: any, i: number) => imgs.push({ ...x, page: l.url, src: l.source === 'willhaben' ? 'Willhaben' : 'ImmoScout24', rank: (OUTSIDE.test(x.desc) ? 0 : 10) + i }));
      } catch { /* */ }
    }
    imgs.sort((a, b) => a.rank - b.rank).forEach(x => add(x.url, x.src, x.page, x.desc, OUTSIDE.test(x.desc) ? 'снаружи' : 'квартира'));
    await fetch(`${URL_}/rest/v1/buildings?id=eq.${b.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ photos, photos_checked_at: new Date().toISOString() }) });
    report.push({ name: b.name, photos: photos.length, official: photos.filter(p => !['Willhaben', 'ImmoScout24'].includes(p.source)).length });
  }
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
});
