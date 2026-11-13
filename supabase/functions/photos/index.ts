// Фото домов: ссылки на фото с официальной страницы ЖК/архитектора и из объявлений по этому дому.
// Храним только ссылки и источник. Вручную добавленные (не Willhaben) фото сохраняются и идут первыми.
// Запуск: cron photos-daily (06:17 UTC) → GET /functions/v1/photos?key=<COLLECTOR_KEY>[&id=<building uuid>]
const KEY = '<COLLECTOR_KEY>';
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };

async function whImages(url: string) {
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return [];
  const ad = JSON.parse(m[1])?.props?.pageProps?.advertDetails;
  return (ad?.advertImageList?.advertImage || []).map((i: any) => ({ url: i.mainImageUrl || i.referenceImageUrl, desc: i.description || '' })).filter((i: any) => i.url);
}
// крупные изображения с официальной страницы: og:image + файлы, у которых в пути видно большой размер
async function pageImages(url: string) {
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const out: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+(?:property="og:image(?::url)?"[^>]+content="([^"]+)"|content="([^"]+)"[^>]+property="og:image(?::url)?")/gi)) out.push(m[1] || m[2]);
  for (const m of html.matchAll(/https?:\/\/[^"'\s()]+?\.(?:jpe?g|webp)/gi)) if (/1200|1600|1920|2000|large|full|cdn\.sanity/i.test(m[0]) && !/logo|icon|favicon|avatar/i.test(m[0])) out.push(m[0]);
  const base = new URL(url);
  return [...new Set(out.map(u => new URL(u, base).href))].slice(0, 10);
}
const OUT = /au(ss|ß)en|fassade|geb(ä|ae)ude|haus|visual|ansicht|exterior|building|tower|projekt/i;

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('key') !== KEY) return new Response('forbidden', { status: 403 });
  const only = q.get('id');
  const bs = await (await fetch(`${URL_}/rest/v1/buildings?select=id,name,official_url,photos${only ? '&id=eq.' + only : ''}`, { headers: H })).json();
  const report: any[] = [];
  for (const b of bs) {
    const keep = (b.photos || []).filter((p: any) => p.source !== 'Willhaben');
    const photos: any[] = [...keep];
    const seen = new Set<string>(keep.map((p: any) => p.url));
    const add = (url: string, source: string, page: string, desc = '') => { if (!url || seen.has(url) || photos.length >= 30) return; seen.add(url); photos.push({ url, source, page, desc }); };
    if (!keep.length && b.official_url) { try { for (const u of await pageImages(b.official_url)) add(u, 'официальный сайт', b.official_url); } catch { /* */ } }
    const ls = await (await fetch(`${URL_}/rest/v1/market_listings?select=url&building_id=eq.${b.id}&source=eq.willhaben&removed_at=is.null&order=first_seen.desc&limit=6`, { headers: H })).json();
    const imgs: any[] = [];
    for (const l of ls) { try { (await whImages(l.url)).forEach((x: any, i: number) => imgs.push({ ...x, page: l.url, rank: (OUT.test(x.desc) ? 0 : 10) + i })); } catch { /* */ } }
    imgs.sort((a, b) => a.rank - b.rank).forEach(x => add(x.url, 'Willhaben', x.page, x.desc));
    if (photos.length) await fetch(`${URL_}/rest/v1/buildings?id=eq.${b.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ photos }) });
    report.push({ name: b.name, photos: photos.length });
  }
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
});
