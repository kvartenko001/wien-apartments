const KEY = '<COLLECTOR_KEY>';
const URL_ = Deno.env.get('SUPABASE_URL')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PTS = [[48.2082, 16.3738], [48.245, 16.43], [48.17, 16.37], [48.215, 16.31], [48.25, 16.36], [48.145, 16.30], [48.22, 16.48], [48.16, 16.43], [48.28, 16.42], [48.19, 16.27]];
const strip = (s: string) => s.replace(/<br\s*\/?>/g, ', ').replace(/<[^>]+>/g, '').replace(/&ndash;/g, '–').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function search(lat: number, lng: number) {
  const body = new URLSearchParams({
    'tx_theme_pharmacysearch[search][geolocation]': '1', 'tx_theme_pharmacysearch[search][lat]': String(lat), 'tx_theme_pharmacysearch[search][lng]': String(lng),
    'tx_theme_pharmacysearch[search][city]': 'Wien', 'tx_theme_pharmacysearch[search][nightShift]': '1', 'tx_theme_pharmacysearch[search][placeType]': 'locality',
  });
  const r = await fetch('https://www.apothekerkammer.at/apothekensuche?tx_theme_pharmacysearch%5Baction%5D=perform&tx_theme_pharmacysearch%5Bcontroller%5D=PharmacySearch&cHash=00471e8b07ebf8dcf0721d08bcc1b305',
    { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const html = await r.text();
  const out: any[] = [];
  for (const part of html.split('class="pharmacy-item"').slice(1)) {
    const lat = part.match(/data-lat="([\d.]+)"/), lng = part.match(/data-lng="([\d.]+)"/);
    const name = part.match(/pharmacy-item-title">([^<]+)</);
    const addr = part.match(/<p class="mb-0">\s*([^<]+<br>[^<]+)<\/p>/);
    const tel = part.match(/href="tel:([^"]+)"/);
    const duty = part.match(/<span class="d-block">(Bereitschaft[\s\S]*?)<\/span>/);
        if (!lat || !lng || !name) continue;
    out.push({ name: strip(name[1]), address: addr ? strip(addr[1]) : '', phone: tel ? tel[1] : null, lat: +lat[1], lng: +lng[1],
      duty: duty ? strip(duty[1]).replace(/^Bereitschaft von\s*,?\s*/, '').replace(/\s*Uhr/g, '') : null });
  }
  return out;
}

Deno.serve(async (req) => {
  if (new URL(req.url).searchParams.get('key') !== KEY) return new Response('forbidden', { status: 403 });
  const res = await Promise.allSettled(PTS.map(([a, b]) => search(a, b)));
  const map = new Map<string, any>();
  for (const r of res) if (r.status === 'fulfilled') for (const p of r.value) map.set(p.name + '|' + p.address, p);
  const rows = [...map.values()].filter(p => p.lat > 48.1 && p.lat < 48.35 && p.duty);
  const h = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
  if (rows.length) {
    await fetch(`${URL_}/rest/v1/night_pharmacy?name=not.is.null`, { method: 'DELETE', headers: h });
    await fetch(`${URL_}/rest/v1/night_pharmacy`, { method: 'POST', headers: { ...h, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.map(r => ({ ...r, fetched_at: new Date().toISOString() }))) });
  }
  return new Response(JSON.stringify({ found: map.size, on_duty: rows.length }), { headers: { 'Content-Type': 'application/json' } });
});
