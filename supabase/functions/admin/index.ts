import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Админка: выдать доступ, продлить, отключить, сбросить пароль. Вызывать может только участник с role = 'admin'.
// Тело: { action: 'grant' | 'update' | 'reset_password', email, name?, ws?, paid_until?, max_devices?, note?, active? }
// grant: создаёт/обновляет участника и, если логина ещё нет, создаёт вход с паролем (возвращает пароль — один раз).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const URL_ = Deno.env.get('SUPABASE_URL')!, ANON = Deno.env.get('SUPABASE_ANON_KEY')!, SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };

async function callerEmail(req: Request) {
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: req.headers.get('Authorization') || '' } });
  return u.ok ? String((await u.json())?.email || '').toLowerCase() : '';
}
async function isAdmin(email: string) {
  if (!email) return false;
  const r = await fetch(`${URL_}/rest/v1/members?select=role,active&email=eq.${encodeURIComponent(email)}`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  return rows[0]?.role === 'admin' && rows[0]?.active === true;
}
function genPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => a[x % a.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}
async function findUser(email: string) {
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${URL_}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (!r.ok) throw new Error('auth list ' + r.status);
    const d = await r.json(); const users = d.users || [];
    const u = users.find((x: any) => String(x.email || '').toLowerCase() === email);
    if (u) return u;
    if (users.length < 200) return null;
  }
  return null;
}
async function setPassword(email: string) {
  const password = genPassword();
  const u = await findUser(email);
  const r = u
    ? await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ password, email_confirm: true }) })
    : await fetch(`${URL_}/auth/v1/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password, email_confirm: true }) });
  if (!r.ok) throw new Error('auth ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return password;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const me = await callerEmail(req);
    if (!(await isAdmin(me))) return j({ error: 'forbidden' }, 403);
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j({ error: 'bad email' }, 400);
    if (email === me && b.action !== 'reset_password') return j({ error: 'свой доступ здесь не меняется' }, 400);

    if (b.action === 'grant' || b.action === 'update') {
      const row: Record<string, unknown> = { email };
      if (b.action === 'grant') { row.ws = String(b.ws || '').trim() || email; row.role = 'user'; }
      for (const k of ['paid_until', 'max_devices', 'note', 'active']) if (k in b) row[k] = b[k] === '' ? null : b[k];
      if ('name' in b) row.display_name = b.name || null;
      const r = await fetch(`${URL_}/rest/v1/members?on_conflict=email`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
      if (!r.ok) return j({ error: 'members ' + r.status + ' ' + (await r.text()).slice(0, 200) }, 500);
      let password: string | null = null;
      if (b.action === 'grant' && !(await findUser(email))) password = await setPassword(email);
      return j({ ok: true, member: (await r.json())[0], password });
    }
    if (b.action === 'reset_password') return j({ ok: true, password: await setPassword(email) });
    return j({ error: 'unknown action' }, 400);
  } catch (e) { return j({ error: String((e as Error).message || e) }, 500); }
});
