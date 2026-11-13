// Радар новостроек: собирает проекты Вены с wiew.at (агрегатор новостроек: ~524 проекта, ~255 застройщиков)
// и инвентарь квартир каждого проекта (Top, этаж, комнаты, м², цена, резерв) — для «скорости продаж».
// Данные проекта — из JSON-LD страницы (schema.org ApartmentComplex/Apartment/Offer), проверено на живой странице 13.11.2026.
// Запуск: GET /functions/v1/radar?key=<COLLECTOR_KEY>&mode=list|detail[&from=0&n=40]
//   mode=list   — обходит /de/neubauprojekte/wien?page=N, создаёт/обновляет dev_projects (slug 'wiew:<district>/<slug>')
//   mode=detail — открывает n проектов (самые давно обновлённые), пишет факты и dev_units
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
    return { unit_ref: ref, floor: a.floorLevel || null, rooms: qv(a.numberOfRooms), area_m2: area, price,
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
  return {
    name: cx?.name || null, official_url: site, address: cx?.address?.streetAddress || null, zip: cx?.address?.postalCode || null,
    lat: cx?.geo?.latitude ?? null, lng: cx?.geo?.longitude ?? null,
    developer_names: [...new Set(devs)], units_total: cx?.numberOfAccommodationUnits ?? null,
    completion_year: fin && /\d{4}/.test(fin) ? +fin.match(/\d{4}/)![0] : (cx?.yearBuilt ? +cx.yearBuilt : null),
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
    // detail: n проектов, давно не обновлявшихся
    const n = Math.min(+(q.get('n') || 30), 60);
    const ps = await (await rest(`dev_projects?select=id,slug,url&source=eq.wiew&removed_at=is.null&order=updated_at.asc.nullsfirst&limit=${n}`)).json();
    let units = 0; const report: any[] = [];
    for (const p of ps) {
      try {
        const d = parseProject(await get(p.url));
        const { units: us, _status_label, _fin_label, ...facts } = d;
        await rest(`dev_projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))),
            updated_at: new Date().toISOString(), raw: { status_label: _status_label, completion_label: _fin_label, parsed_at: started } }) });
        if (us.length) {
          await rest('dev_units?on_conflict=project_id,unit_ref', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(us.map((u: any) => ({ ...u, project_id: p.id, last_seen: started, gone_at: null }))) });
          // квартиры, исчезнувшие из списка проекта → gone_at (вероятно, проданы)
          await rest(`dev_units?project_id=eq.${p.id}&gone_at=is.null&last_seen=lt.${encodeURIComponent(started)}`,
            { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ gone_at: started, status: 'gone' }) });
          units += us.length;
        }
        report.push({ slug: p.slug, name: d.name, units: us.length, dev: d.developer_names });
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
