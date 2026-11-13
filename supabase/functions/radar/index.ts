// Радар новостроек: собирает проекты Вены с wiew.at (агрегатор новостроек: ~524 проекта, ~255 застройщиков)
// и инвентарь квартир каждого проекта (Top, этаж, комнаты, м², цена, резерв) — для «скорости продаж».
// ЧЕРНОВИК 13.11.2026: парсер написан без доступа к сырому HTML (Supabase был недоступен) — проверить и доточить на живой странице.
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

// ---------- карточка проекта ----------
function parseProject(html: string) {
  const t = txt(html);
  const title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, '').trim() || null;
  const og = (p: string) => html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]+)"`, 'i'))?.[1] || null;
  const after = (label: RegExp) => { const m = t.match(new RegExp(label.source + '\\s*:?\\s*\\n?\\s*([^\\n]{1,120})', 'i')); return m ? m[1].trim() : null; };
  const addr = t.match(/([A-ZÄÖÜ][\wäöüß.\- ]+?(?:straße|strasse|gasse|weg|platz|allee|promenade|ring|zeile|lände|steig)\s*[\d+\/\-a-z ]*),?\s*(1\d{2}0)\s*Wien/i);
  const dev = after(/Bauträger/) || after(/Projektentwickler/);
  const site = (html.match(/href="(https?:\/\/(?!wiew\.at)[^"]+)"[^>]*>\s*(?:Projektwebsite|Zur Projektwebsite|Website|Webseite)/i) || [])[1] || null;
  const completion = t.match(/Fertigstellung[^\n\d]{0,30}(\d{4})/i)?.[1] || t.match(/Bezug[^\n\d]{0,30}(\d{4})/i)?.[1] || null;
  const energy = t.match(/Energie(?:effizienz)?klasse\s*:?\s*\n?\s*(A\+\+|A\+|[A-G])\b/i)?.[1] || null;
  const hwb = num(t.match(/HWB[^\n\d]{0,20}([\d.,]+)/i)?.[1]);
  const units = num(t.match(/(\d{1,4})\s+(?:frei finanzierte |freifinanzierte |geförderte )?(?:Eigentums|Miet|Vorsorge)?wohnungen/i)?.[1]);
  // квартиры: строки вида «Top 17.59 … 1 Zimmer … 30,6 m² … € 212.000 … reserviert»
  const unitsOut: any[] = [];
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(Top\s*[\w.\/\-]+)/i); if (!m) continue;
    const blk = lines.slice(i, i + 14).join(' | ');
    const area = num(blk.match(/([\d.,]+)\s*m²/)?.[1]);
    const price = num(blk.match(/€\s*([\d.,]+(?:\s*M)?)/)?.[1]);
    unitsOut.push({ unit_ref: m[1].replace(/\s+/g, ' ').trim(),
      floor: blk.match(/(\d+\.\s*OG|EG|DG|UG|\d+\.\s*Stock)/i)?.[1] || null,
      orientation: blk.match(/\b(Nord|Süd|Ost|West)(?:[\-\/ ](?:Nord|Süd|Ost|West))?\b/)?.[0] || null,
      rooms: num(blk.match(/([\d,]+)\s*Zi/)?.[1]), area_m2: area, price, ppm: price && area ? Math.round(price / area) : null,
      status: /reserviert/i.test(blk) ? 'reserved' : /verkauft/i.test(blk) ? 'sold' : 'available' });
  }
  const ppms = unitsOut.map(u => u.ppm).filter(Boolean).sort((a: number, b: number) => a - b);
  const prices = unitsOut.map(u => u.price).filter(Boolean);
  const areas = unitsOut.map(u => u.area_m2).filter(Boolean);
  const amen = ['Tiefgarage', 'Lift', 'Aufzug', 'Fitness', 'Pool', 'Sauna', 'Gemeinschaftsraum', 'Dachterrasse', 'Spielplatz', 'Fahrradraum', 'Concierge', 'Wärmepumpe', 'Photovoltaik', 'Paketbox', 'Klimaanlage', 'Bauteilaktivierung']
    .filter(a => new RegExp(a, 'i').test(t));
  return {
    name: title, official_url: site, image: og('image'), address: addr ? addr[1].trim() : null, zip: addr ? addr[2] : null,
    developer_names: dev ? dev.split(/,|\s+und\s+|\s*&\s*(?=[A-Z])/).map(s => s.trim()).filter(s => s.length > 2) : [],
    completion_year: completion ? +completion : null, energy_class: energy, hwb, units_total: units,
    units: unitsOut, units_available: unitsOut.filter(u => u.status === 'available').length || null, units_reserved: unitsOut.filter(u => u.status === 'reserved').length || null,
    price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null,
    area_min: areas.length ? Math.min(...areas) : null, area_max: areas.length ? Math.max(...areas) : null,
    ppm_min: ppms[0] || null, ppm_max: ppms[ppms.length - 1] || null, ppm_median: ppms.length ? ppms[Math.floor(ppms.length / 2)] : null,
    amenities: amen, status: /in Bau|im Bau|Baustart erfolgt/i.test(t) ? 'under_construction' : /fertiggestellt|bezugsfertig|sofort bezugsfertig/i.test(t) ? 'completed' : /in Planung|geplant/i.test(t) ? 'planning' : null,
  };
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('key') !== KEY) return json({ error: 'forbidden' }, 403);
  const mode = q.get('mode') || 'list', started = new Date().toISOString();
  try {
    if (mode === 'list') {
      const rows = (await listAll()).map(r => ({ ...r, last_seen: started, removed_at: null }));
      for (let i = 0; i < rows.length; i += 200)
        await rest('dev_projects?on_conflict=slug', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 200).map(({ name, ...r }) => r)) });   // имя не перетираем — его пишет detail
      // проекты, пропавшие из каталога → removed_at (только если каталог прочитан целиком)
      if (rows.length > 100) await rest(`dev_projects?source=eq.wiew&removed_at=is.null&last_seen=lt.${encodeURIComponent(started)}`,
        { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ removed_at: started }) });
      await rest('radar_runs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ source: 'wiew:list', started_at: started, finished_at: new Date().toISOString(), projects: rows.length }) });
      return json({ mode, projects: rows.length });
    }
    // detail: n проектов, давно не обновлявшихся
    const n = Math.min(+(q.get('n') || 30), 60);
    const ps = await (await rest(`dev_projects?select=id,slug,url&source=eq.wiew&removed_at=is.null&order=updated_at.asc.nullsfirst&limit=${n}`)).json();
    let units = 0; const report: any[] = [];
    for (const p of ps) {
      try {
        const d = parseProject(await get(p.url));
        const { units: us, image, address, ...facts } = d;
        await rest(`dev_projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))),
            address, updated_at: new Date().toISOString(), raw: { image, parsed_at: started } }) });
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
