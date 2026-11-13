// Радар новостроек: собирает проекты Вены с wiew.at (агрегатор новостроек: ~524 проекта, ~255 застройщиков)
// и инвентарь квартир каждого проекта (Top, этаж, комнаты, м², цена, резерв) — для «скорости продаж».
// Данные проекта — из JSON-LD страницы (schema.org ApartmentComplex/Apartment/Offer), проверено на живой странице 13.11.2026.
// Запуск: GET /functions/v1/radar?key=<COLLECTOR_KEY>&mode=list|detail[&from=0&n=40]
//   mode=list   — обходит /de/neubauprojekte/wien?page=N, создаёт/обновляет dev_projects (slug 'wiew:<district>/<slug>')
//   mode=detail — открывает n проектов (самые давно обновлённые или ids=…), пишет факты, тип проекта и dev_units
//   mode=photos — фото проекта: wiew + официальный сайт (+ страницы Baufortschritt/Galerie), фото стройки с датой
const KEY = '<COLLECTOR_KEY>';
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BASE = 'https://wiew.at';
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const DSLUG: Record<string, number> = { 'innere-stadt': 1, leopoldstadt: 2, landstrasse: 3, wieden: 4, margareten: 5, mariahilf: 6, neubau: 7, josefstadt: 8,
  alsergrund: 9, favoriten: 10, simmering: 11, meidling: 12, hietzing: 13, penzing: 14, 'rudolfsheim-fuenfhaus': 15, ottakring: 16, hernals: 17,
  waehring: 18, doebling: 19, brigittenau: 20, floridsdorf: 21, donaustadt: 22, liesing: 23 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
async function get(u: string) { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-AT,de;q=0.9' } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return await r.text(); }
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
const txt = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\n\s*\n+/g, '\n').trim();
const num = (s?: string | null) => { if (!s) return null; const t = s.replace(/[€\s]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'); const m = t.match(/[\d.]+/); if (!m) return null;
  let v = parseFloat(m[0]); if (/M/i.test(s) && v < 100) v *= 1e6; return isFinite(v) ? v : null; };

// ---------- список проектов ----------
async function listAll() {
  const seen = new Map<string, any>();
  for (let page = 1; page <= 40; page++) {
    const html = await get(`${BASE}/de/neubauprojekte/wien${page > 1 ? '?page=' + page : ''}`);
    const before = seen.size;
    for (const m of html.matchAll(/href="\/de\/neubauprojekte\/wien\/([a-z-]+)\/([a-z0-9-]+)"/g)) {
      const [_, d, slug] = m; if (!DSLUG[d]) continue;
      const key = `wiew:${d}/${slug}`;
      if (!seen.has(key)) seen.set(key, { slug: key, source: 'wiew', url: `${BASE}/de/neubauprojekte/wien/${d}/${slug}`, district: DSLUG[d], name: slug.replace(/-/g, ' ') });
    }
    if (seen.size === before) break;           // новых ссылок нет — страницы кончились
    await sleep(600);
  }
  return [...seen.values()];
}

// ---------- карточка проекта: JSON-LD (schema.org ApartmentComplex + Apartment/Offer) + подписи из HTML ----------
function ldBlocks(html: string) {
  const out: any[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { out.push(JSON.parse(m[1])); } catch { /* */ } }
  return out;
}
function walk(o: any, f: (x: any) => void, d = 0) {
  if (!o || typeof o !== 'object' || d > 12) return;
  if (Array.isArray(o)) { for (const x of o) walk(x, f, d + 1); return; }
  f(o); for (const k of Object.keys(o)) walk(o[k], f, d + 1);
}
const qv = (v: any) => v == null ? null : typeof v === 'object' ? (v.value ?? null) : v;
const label = (html: string, name: string) => {
  const m = html.match(new RegExp('>' + name + '</div><div[^>]*>([^<]{1,120})</div>', 'i'));
  return m ? m[1].trim() : null;
};
function parseProject(html: string) {
  let cx: any = null; const apts: any[] = [];
  for (const b of ldBlocks(html)) walk(b, (o) => {
    const t = o['@type'];
    if (t === 'ApartmentComplex' && !cx) cx = o;
    if (t === 'Apartment' && o.offers) apts.push(o);
  });
  const seen = new Set<string>();
  const units = apts.map(a => {
    const ref = String(a.name || '').split(' — ')[0].trim() || String(a.url || '').split('/').pop();
    const area = qv(a.floorSize), price = a.offers?.price ?? null;
    const av = String(a.offers?.availability || '');
    const img = Array.isArray(a.image) ? a.image[0] : a.image;
    return { unit_ref: ref, plan_url: (typeof img === 'string' ? img : img?.url) || null, floor: a.floorLevel || null, rooms: qv(a.numberOfRooms), area_m2: area, price,
      ppm: a.offers?.priceSpecification?.price ?? (price && area ? Math.round(price / area) : null),
      status: /Reserved/i.test(av) ? 'reserved' : /SoldOut|Sold/i.test(av) ? 'sold' : 'available' };
  }).filter(u => u.unit_ref && !seen.has(u.unit_ref) && seen.add(u.unit_ref));
  const sale = units.filter(u => u.status !== 'sold');
  const ppms = sale.map(u => u.ppm).filter(Boolean).sort((a: number, b: number) => a - b);
  const prices = sale.map(u => u.price).filter(Boolean), areas = sale.map(u => u.area_m2).filter(Boolean), rooms = sale.map(u => u.rooms).filter(Boolean);
  const devs: string[] = [];
  for (const k of ['developer', 'seller', 'brand']) { const v = cx?.[k]; for (const x of (Array.isArray(v) ? v : v ? [v] : [])) if (x?.name) devs.push(String(x.name)); }
  for (const pv of (cx?.additionalProperty || [])) if (/^(developer|legalEntity)$/i.test(pv?.name) && pv.value) devs.push(String(pv.value));
  if (cx?.offers?.seller?.name) devs.push(String(cx.offers.seller.name).replace(/\s*[–-]\s*(Verkauf|Vertrieb).*$/i, ''));
  const amen = (cx?.amenityFeature || []).map((a: any) => a?.name).filter(Boolean);
  const site = (Array.isArray(cx?.sameAs) ? cx.sameAs : cx?.sameAs ? [cx.sameAs] : []).find((u: string) => !/wiew\.at/.test(u)) || null;
  const fin = label(html, 'Fertigstellung'), energy = label(html, 'Energieklasse') || label(html, 'Energieeffizienzklasse'), hwb = label(html, 'HWB');
  const stat = label(html, 'Status') || label(html, 'Projektstatus') || '';
  // тип проекта: новостройка с нуля / мансарды-надстройка на старом доме / санированный альтбау / перестройка (офис → жильё)
  const bullets = [...html.matchAll(/<li\b[^>]*leading-snug[^>]*>([^<]{5,200})<\/li>/g)].map(m => m[1]).join(' · ');
  const sub = (html.match(/<h1[\s\S]{0,1500}?<p[^>]*>([^<]{10,300})<\/p>/) || [])[1] || '';
  const tx = `${cx?.name || ''} · ${cx?.description || ''} · ${sub} · ${bullets}`;
  const finY = fin && /\d{4}/.test(fin) ? +fin.match(/\d{4}/)![0] : null;
  const renM = (fin || '').match(/(?:renoviert|renovated|saniert|sanierung)\D{0,6}(\d{4})/i) || tx.match(/(?:sanierung|saniert|renoviert|revitalisier\w*)\s*(?:im\s*jahr\s*|bis\s*|)(20\d{2})/i);
  const renY = renM ? +renM[1] : null;
  const bM = tx.match(/(?:baujahr|erbaut|errichtet|aus dem jahre?|anno|altbau\w*\s*(?:von|aus))\s*(1[6-9]\d{2})/i);
  const builtY = finY && finY < 1990 ? finY : bM ? +bM[1] : null;
  const isOld = !!builtY || /altbau|zinshaus|gründerzeit|biedermeier|jahrhundertwende|stilaltbau|denkmal/i.test(tx);
  const isDG = /dachgeschoss|dg-?ausbau|dachausbau|aufstockung|dachwohnung|penthouse im altbau/i.test(tx);
  const isConv = /umnutzung|umbau (?:eines|einer|des|der) (?:büro|gewerbe|hotel|fabrik|schule)|ehemalige[nrs]? (?:büro|bank|post|fabrik|schule|kaserne|hotel)|konversion/i.test(tx);
  const isNew = /neubau|erstbezug im neubau|neu errichtet|neu gebaut/i.test(tx);
  const project_type = isOld && isDG && !/sanierte altbauwohnungen/i.test(tx) ? 'dachausbau'
    : isOld || (renY && !isNew) ? 'altbau' : isConv ? 'umbau' : 'neubau';
  const imgs = (Array.isArray(cx?.image) ? cx.image : cx?.image ? [cx.image] : []).map((i: any) => typeof i === 'string' ? { url: i } : i)
    .filter((i: any) => i?.url && !/floorplan/i.test(i.url)).map((i: any) => ({ url: i.url, w: i.width || null, h: i.height || null, cap: i.caption || i.name || null }));
  return {
    _imgs: imgs,
    name: cx?.name || null, official_url: site, address: cx?.address?.streetAddress || null, zip: cx?.address?.postalCode || null,
    lat: cx?.geo?.latitude ?? null, lng: cx?.geo?.longitude ?? null,
    developer_names: [...new Set(devs)], units_total: cx?.numberOfAccommodationUnits ?? null,
    project_type, built_year: builtY, renovated_year: renY,
    completion_year: finY && finY < 1990 ? renY : finY ?? (cx?.yearBuilt && +cx.yearBuilt >= 1990 ? +cx.yearBuilt : null),
    energy_class: energy, hwb: hwb ? parseFloat(hwb.replace(',', '.')) || null : null, amenities: amen,
    units, units_available: units.filter(u => u.status === 'available').length, units_reserved: units.filter(u => u.status === 'reserved').length,
    price_min: prices.length ? Math.min(...prices) : (cx?.offers?.lowPrice ?? null), price_max: prices.length ? Math.max(...prices) : (cx?.offers?.highPrice ?? null),
    area_min: areas.length ? Math.min(...areas) : null, area_max: areas.length ? Math.max(...areas) : null,
    rooms_min: rooms.length ? Math.min(...rooms) : null, rooms_max: rooms.length ? Math.max(...rooms) : null,
    ppm_min: ppms[0] ?? null, ppm_max: ppms[ppms.length - 1] ?? null, ppm_median: ppms.length ? ppms[Math.floor(ppms.length / 2)] : null,
    status: /bau/i.test(stat) ? 'under_construction' : /fertig|bezug/i.test(stat) ? 'completed' : /plan/i.test(stat) ? 'planning' : null,
    _status_label: stat || null, _fin_label: fin,
  };
}

// ---------- фото проекта: визуализации (wiew + официальный сайт) и фото стройки по датам ----------
const MON: Record<string, number> = { jan: 1, jän: 1, jaen: 1, feb: 2, mär: 3, maer: 3, mar: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
function findDate(t: string): string | null {
  if (!t) return null;
  let m = t.match(/\b(\d{1,2})\.(\d{1,2})\.(20[12]\d)\b/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}`;
  m = t.match(/\b(jän(?:ner)?|jaen|jan(?:uar)?|feb(?:ruar)?|mär(?:z)?|maerz|mar(?:ch)?|apr(?:il)?|mai|may|jun[ie]?|jul[iy]?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dez(?:ember)?|dec(?:ember)?)\.?\s*(20[12]\d)\b/i);
  if (m) { const k = m[1].toLowerCase().slice(0, 3); const mo = MON[k] || MON[m[1].toLowerCase().slice(0, 4)]; if (mo) return `${m[2]}-${String(mo).padStart(2, '0')}`; }
  m = t.match(/\b(20[12]\d)[-_.](0[1-9]|1[0-2])(?:[-_.]\d{2})?\b/); if (m) return `${m[1]}-${m[2]}`;
  return null;
}
const BAD_IMG = /logo|favicon|icon|sprite|avatar|portrait|team|kontakt|contact|ansprechpartner|badge|siegel|zertifik|award|\/partners?\/|partner-?logo|sponsor|klimaaktiv-|placeholder|blank|pixel|loader|arrow|social|facebook|instagram|linkedin|youtube|map-?marker|googlemap|cookie|qr-?code|newsletter|signature|unterschrift|banner-ad/i;
const BAD_ALT = /logo|portrait|porträt|ansprechpartner|kontakt|team|geschäftsführ|mitarbeiter|unterschrift|icon/i;
function kindOf(t: string) {
  if (/zeitleiste|timeline|grafik|graphisch|zeichnung|infografik|diagramm/i.test(t)) return 'plan';
  if (/baustell|baufortschritt|bautagebuch|baudoku|rohbau|spatenstich|gleichenfeier|kran|aushub|baugrube|bauarbeit|webcam|construction|progress/i.test(t)) return 'build';
  if (/grundriss|lageplan|floor ?plan|schnitt|geschoss(?:plan)?|plan_/i.test(t)) return 'plan';
  if (/innen|interior|wohnzimmer|wohn-|küche|kueche|bad(?:ezimmer)?|schlafzimmer|essbereich|couch|loggia-innen|wohnraum/i.test(t)) return 'inside';
  return 'outside';
}
function absU(u: string, base: string) { try { return new URL(u.replace(/&amp;/g, '&'), base).href; } catch { return null; } }
// <img>/<source>/data-*/srcset/background-image + подписи (alt/title/figcaption рядом)
function pageImages(html: string, base: string) {
  const out: any[] = [];
  const push = (u: string | null, w: number | null, cap: string, ctx: string) => {
    if (!u || !/^https?:/.test(u) || !/\.(jpe?g|webp|png)(\?|$|\/)|\/(image|img|media|uploads|files)\//i.test(u) || /\.svg|\.gif/i.test(u)) return;
    if (BAD_IMG.test(u) || BAD_ALT.test(cap)) return;
    if (/weitere projekte|ähnliche projekte|andere projekte|könnte sie auch|referenzprojekte|unsere projekte/i.test(ctx)) return;
    out.push({ url: u, w, cap: cap.replace(/\s+/g, ' ').trim().slice(0, 140) || null, ctx });
  };
  for (const m of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = m[0], at = (n: string) => (tag.match(new RegExp('\\s' + n + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1] || '';
    const cap = at('alt') || at('title') || at('data-caption') || '';
    const ctx = html.slice(Math.max(0, m.index! - 300), m.index! + tag.length + 300).replace(/<[^>]+>/g, ' ');
    const set = at('srcset') || at('data-srcset');
    let best: string | null = null, bw = 0;
    for (const part of set.split(',')) { const [u, d] = part.trim().split(/\s+/); const w = parseInt(d) || 0; if (u && w >= bw) { best = u; bw = w; } }
    const cand = best || at('data-src') || at('data-lazy-src') || at('data-original') || at('src');
    const w = bw || parseInt(at('width')) || null;
    if (w && w < 300) continue;
    push(absU(cand, base), w, cap, ctx);
  }
  for (const m of html.matchAll(/background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/gi)) push(absU(m[2], base), null, '', html.slice(Math.max(0, m.index! - 200), m.index! + 200).replace(/<[^>]+>/g, ' '));
  for (const m of html.matchAll(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi)) push(absU(m[1], base), null, 'og', '');
  return out;
}
// «один и тот же снимок в разных размерах» → один ключ
const imgKey = (u: string) => u.split('?')[0].split('/').pop()!.toLowerCase().replace(/[-_](\d{2,4}x\d{2,4}|scaled|large|medium|small|thumb\w*|\d{3,4}w)(?=\.)/g, '').replace(/__\d+\./, '.');
const sizeOf = (u: string) => { const m = u.match(/\/(\d{3,4})x(\d{3,4})\//) || u.match(/[-_](\d{3,4})x(\d{3,4})\./); return m ? +m[1] : 0; };
function buildLinks(html: string, base: string) {
  const out = new Set<string>(); const host = new URL(base).host;
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const txt = (m[2].replace(/<[^>]+>/g, ' ') + ' ' + m[1]).toLowerCase();
    if (!/baufortschritt|baustell|bautagebuch|baudoku|webcam|galerie|gallery|bilder|impressionen/.test(txt)) continue;
    const u = absU(m[1], base); if (u && new URL(u).host === host && !/\.(pdf|jpe?g|png|zip)$/i.test(u)) out.add(u.split('#')[0]);
  }
  return [...out].sort((a, b) => (/baufort|baustell|bautage|baudoku|webcam/i.test(b) ? 1 : 0) - (/baufort|baustell|bautage|baudoku|webcam/i.test(a) ? 1 : 0)).slice(0, 3);
}
async function projectPhotos(p: any) {
  const all: any[] = []; const pages: string[] = [];
  // 1) wiew.at — JSON-LD image[] проекта
  try { const d = parseProject(await get(p.url)); for (const i of d._imgs) all.push({ url: i.url, w: i.w, cap: i.cap, src: 'wiew', kind: kindOf(i.cap || '') }); } catch { /* */ }
  // 2) официальный сайт проекта (+ до 3 страниц «Baufortschritt / Galerie»)
  if (p.official_url) {
    const queue = [p.official_url]; const seen = new Set<string>();
    while (queue.length && seen.size < 4) {
      const u = queue.shift()!; if (seen.has(u)) continue; seen.add(u);
      try {
        const html = await get(u); pages.push(u);
        const isBuildPage = /baufort|baustell|bautage|baudoku|webcam/i.test(u);
        for (const i of pageImages(html, u)) {
          const t = `${i.cap || ''} ${i.url}`;
          let kind = isBuildPage ? 'build' : kindOf(t);
          if (kind !== 'build' && kind !== 'plan' && /baufort|baustell|bautage/i.test(i.ctx)) kind = kindOf(t + ' ' + i.ctx);
          all.push({ url: i.url, w: i.w || sizeOf(i.url) || null, cap: i.cap === 'og' ? null : i.cap, src: 'official', kind,
            date: kind === 'build' ? (findDate(i.cap || '') || findDate(i.url) || findDate(i.ctx)) : null });
        }
        if (u === p.official_url) for (const l of buildLinks(html, u)) queue.push(l);
      } catch { /* */ }
      await sleep(400);
    }
  }
  // дедуп: один снимок — самый крупный вариант; официальные первыми
  const by = new Map<string, any>();
  for (const x of all) { const k = imgKey(x.url); const o = by.get(k); if (!o || (x.w || 0) > (o.w || 0)) by.set(k, { ...x, src: o && o.src !== x.src ? 'both' : x.src, cap: x.cap || o?.cap || null, date: x.date || o?.date || null }); }
  const ord: Record<string, number> = { outside: 0, inside: 1, build: 2, plan: 3 };
  const photos = [...by.values()].filter(x => x.kind !== 'plan')
    .sort((a, b) => ord[a.kind] - ord[b.kind] || (a.kind === 'build' ? String(b.date || '').localeCompare(String(a.date || '')) : 0) || (a.src === 'wiew' ? 1 : 0) - (b.src === 'wiew' ? 1 : 0))
    .slice(0, 40).map(({ url, cap, src, kind, date }) => ({ url, cap, src, kind, date }));
  return { photos, pages };
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('key') !== KEY) return json({ error: 'forbidden' }, 403);
  const mode = q.get('mode') || 'list', started = new Date().toISOString();
  try {
    if (mode === 'list') {
      const rows = (await listAll()).map(r => ({ ...r, last_seen: started, removed_at: null }));
      // уже известные проекты: только отметка «видели сегодня» (название не перетираем — его пишет detail)
      const known = new Set<string>(((await (await rest('dev_projects?select=slug&source=eq.wiew&limit=5000')).json()) as any[]).map(x => x.slug));
      const fresh = rows.filter(r => !known.has(r.slug)), old = rows.filter(r => known.has(r.slug)).map(r => r.slug);
      for (let i = 0; i < fresh.length; i += 200)
        await rest('dev_projects?on_conflict=slug', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(fresh.slice(i, i + 200)) });
      for (let i = 0; i < old.length; i += 80)
        await rest(`dev_projects?slug=in.(${old.slice(i, i + 80).map(x => '"' + x + '"').join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ last_seen: started, removed_at: null }) });
      // проекты, пропавшие из каталога → removed_at (только если каталог прочитан целиком)
      if (rows.length > 100) await rest(`dev_projects?source=eq.wiew&removed_at=is.null&last_seen=lt.${encodeURIComponent(started)}`,
        { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ removed_at: started }) });
      await rest('radar_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: 'wiew:list', started_at: started, finished_at: new Date().toISOString(), projects: rows.length }) });
      return json({ mode, projects: rows.length, new: fresh.length });
    }
    if (mode === 'photos') {
      const n = Math.min(+(q.get('n') || 15), 40), id = q.get('id');
      const ps = await (await rest(id ? `dev_projects?select=id,slug,url,official_url&id=eq.${id}`
        : `dev_projects?select=id,slug,url,official_url&source=eq.wiew&removed_at=is.null&order=photos_checked_at.asc.nullsfirst&limit=${n}`)).json();
      const report: any[] = [];
      for (const p of ps) {
        const r = await projectPhotos(p);
        await rest(`dev_projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ photos: r.photos, photo_pages: r.pages, photos_checked_at: new Date().toISOString() }) });
        report.push({ slug: p.slug, n: r.photos.length, build: r.photos.filter((x: any) => x.kind === 'build').length, pages: r.pages.length });
      }
      await rest('radar_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: 'wiew:photos', started_at: started, finished_at: new Date().toISOString(), projects: ps.length }) });
      return json({ mode, report });
    }
    // detail: n проектов, давно не обновлявшихся
    const n = Math.min(+(q.get('n') || 30), 60);
    const ids = q.get('ids');
    const ps = await (await rest(ids ? `dev_projects?select=id,slug,url&id=in.(${ids})`
      : `dev_projects?select=id,slug,url&source=eq.wiew&removed_at=is.null&order=updated_at.asc.nullsfirst&limit=${n}`)).json();
    let units = 0; const report: any[] = [];
    for (const p of ps) {
      try {
        const d = parseProject(await get(p.url));
        const { units: us, _status_label, _fin_label, _imgs, ...facts } = d;
        await rest(`dev_projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ ...Object.fromEntries(Object.entries(facts).filter(([k, v]) => (v != null || k === 'completion_year') && !(Array.isArray(v) && !v.length))),
            updated_at: new Date().toISOString(), raw: { status_label: _status_label, completion_label: _fin_label, parsed_at: started } }) });
        if (us.length) {
          await rest('dev_units?on_conflict=project_id,unit_ref', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(us.map((u: any) => ({ ...u, project_id: p.id, last_seen: started, gone_at: null }))) });
          // квартиры, исчезнувшие из списка проекта → gone_at (вероятно, проданы)
          await rest(`dev_units?project_id=eq.${p.id}&gone_at=is.null&last_seen=lt.${encodeURIComponent(started)}`,
            { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ gone_at: started, status: 'gone' }) });
          units += us.length;
        }
        report.push({ slug: p.slug, name: d.name, units: us.length, type: d.project_type, built: d.built_year, ren: d.renovated_year, fin: d.completion_year });
      } catch (e) { report.push({ slug: p.slug, error: String(e).slice(0, 120) }); }
      await sleep(700);
    }
    await rest('radar_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: 'wiew:detail', started_at: started, finished_at: new Date().toISOString(), projects: ps.length, units }) });
    return json({ mode, projects: ps.length, units, report });
  } catch (e) {
    await rest('radar_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: 'wiew:' + mode, started_at: started, finished_at: new Date().toISOString(), error: String(e).slice(0, 500) }) }).catch(() => {});
    return json({ error: String(e) }, 500);
  }
});
