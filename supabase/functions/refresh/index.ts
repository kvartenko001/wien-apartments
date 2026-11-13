import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Кнопка «↻ Обновить» в ленте: запускает сборщик по выбранным районам в фоне. Только для участников (verify_jwt + members).
// Тело: { districts: number[] (≤ 8 из интерфейса), deal: 'rent' | 'buy' }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const KEY = '<COLLECTOR_KEY>';
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
async function isMember(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')!, anon = Deno.env.get('SUPABASE_ANON_KEY')!, svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: req.headers.get('Authorization') || '' } });
  if (!u.ok) return false;
  const email = String((await u.json())?.email || '').toLowerCase();
  const m = await fetch(`${url}/rest/v1/members?select=email&email=eq.${encodeURIComponent(email)}`, { headers: { apikey: svc, Authorization: `Bearer ${svc}` } });
  const rows = m.ok ? await m.json() : [];
  return Array.isArray(rows) && rows.length > 0;
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!(await isMember(req))) return j({ error: 'not a member' }, 403);
  const b = await req.json().catch(() => ({}));
  const deal = b.deal === 'buy' ? 'buy' : 'rent';
  let ds: number[] = (b.districts || []).map(Number).filter((d: number) => d >= 1 && d <= 23);
  if (!ds.length) ds = [2, 3, 4, 5, 10, 12, 22];
  ds = ds.slice(0, 23);
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/collect?key=${KEY}&deal=${deal}`;
  const work = (async () => {
    // по 3 запроса параллельно, чтобы не долбить сайты
    const jobs = ds.flatMap(d => ['willhaben', 'immoscout'].map(s => `${base}&source=${s}&district=${d}`));
    for (let i = 0; i < jobs.length; i += 3) await Promise.allSettled(jobs.slice(i, i + 3).map(u => fetch(u)));
  })();
  // @ts-ignore EdgeRuntime есть в Supabase
  EdgeRuntime.waitUntil(work);
  return j({ started: true, deal, districts: ds, eta_sec: Math.ceil(ds.length * 2 / 3) * (deal === 'buy' ? 60 : 25) });
});
