/*
  Fuel × WHOOP connector — a Cloudflare Worker (free plan is plenty).

  What it does
  - Signs in to WHOOP once with your own WHOOP developer app and keeps the tokens fresh.
  - Serves your recovery, sleep, strain and workouts as:
      • a remote MCP server at /mcp  → add it in Claude as a custom connector named WHOOP
      • a JSON endpoint at /api/history → used directly by the GitHub version of Fuel
  - Everything is locked behind your ACCESS_KEY (header "Authorization: Bearer <key>" or "?key=<key>").

  Setup (Fuel → Settings → WHOOP → Live Sync walks you through it with your exact links)
  1. Cloudflare: create a Worker from "Hello World", name it fuel-whoop, deploy. Note its https://… address.
  2. WHOOP: developer-dashboard.whoop.com → create an app. Redirect URL: <worker address>/callback.
     Scopes: read:recovery, read:cycles, read:sleep, read:workout (and offline if listed).
  3. Paste this file as the Worker's code and deploy.
  4. Worker Settings → Bindings → KV namespace, variable name WHOOP_KV (create a namespace if you have none).
     Worker Settings → Variables and Secrets → secrets WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, ACCESS_KEY.
  5. Open <worker address>/login?key=<ACCESS_KEY> and approve WHOOP.
  6. Claude → Customize → Connectors → Add custom connector. Name: WHOOP. URL: <worker address>/mcp?key=<ACCESS_KEY>. No sign in.

  Nothing here is stored except your WHOOP tokens (in your own KV). No third party sees your data.
*/

const WHOOP = 'https://api.prod.whoop.com';
const API = WHOOP + '/developer/v2';
const SCOPES = 'offline read:recovery read:cycles read:sleep read:workout';
const VERSION = '1.0.0';
const MAX_DAYS = 120;

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { return json({ error: 'Server error: ' + (e && e.message || e), code: 'server' }, 500); }
  }
};

async function route(req, env) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  const miss = ['WHOOP_KV', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'ACCESS_KEY'].filter(k => !env[k]);
  if (path === '/') return page(miss.length ? `Almost there. Still missing: ${miss.join(', ')}.` : (await getTokens(env)) ? 'Linked to WHOOP. Fuel and Claude can read your data.' : 'Set up. Next: open /login?key=YOUR_KEY to link WHOOP.');
  if (path.startsWith('/.well-known/')) return new Response('Not found', { status: 404 });
  if (miss.length) return json({ error: `The server isn't finished: add ${miss.join(', ')} in the Worker's settings.`, code: 'setup' }, 500);

  if (path === '/login') {
    if (!keyOk(req, url, env)) return page('That key doesn’t match ACCESS_KEY.', 401);
    const state = rand(24);
    await env.WHOOP_KV.put('state:' + state, '1', { expirationTtl: 600 });
    const q = new URLSearchParams({ response_type: 'code', client_id: env.WHOOP_CLIENT_ID, redirect_uri: url.origin + '/callback', scope: SCOPES, state });
    return Response.redirect(`${WHOOP}/oauth/oauth2/auth?${q}`, 302);
  }
  if (path === '/callback') {
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code');
    if (url.searchParams.get('error')) return page('WHOOP said: ' + url.searchParams.get('error') + '. Nothing was linked.', 400);
    if (!code || !(await env.WHOOP_KV.get('state:' + state))) return page('This link expired. Open /login?key=… again.', 400);
    await env.WHOOP_KV.delete('state:' + state);
    const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri: url.origin + '/callback' });
    if (!t.ok) return page('WHOOP didn’t accept the sign-in (' + t.status + '). Check the Client ID, Secret and redirect URL.', 400);
    return page('Linked to WHOOP. You can close this page and turn on live sync in Fuel.');
  }

  if (!keyOk(req, url, env)) return json({ error: 'Wrong or missing key.', code: 'key' }, 401);
  if (path === '/api/history' && req.method === 'GET') {
    const r = await history(env, num(url.searchParams.get('days'), 30));
    return json(r.error ? { error: r.error, code: r.code } : r, r.error ? (r.code === 'not_linked' ? 409 : 502) : 200);
  }
  if (path === '/mcp') {
    if (req.method === 'GET') return new Response('Use POST', { status: 405, headers: { Allow: 'POST', ...cors() } });
    if (req.method === 'DELETE') return new Response(null, { status: 204, headers: cors() });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let msg; try { msg = await req.json(); } catch (e) { return rpcErr(null, -32700, 'Parse error'); }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(m => rpc(m, env)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: cors() });
    }
    const out = await rpc(msg, env);
    return out ? json(out) : new Response(null, { status: 202, headers: cors() });
  }
  return json({ error: 'Not found' }, 404);
}

/* ---------- MCP (streamable HTTP, JSON responses, stateless) ---------- */
const TOOLS = [
  { name: 'whoop_today', title: 'WHOOP today',
    description: "The latest WHOOP day: recovery %, HRV, resting heart rate, last night's sleep (hours asleep, sleep need, performance), day strain and calories burned, plus today's workouts.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'whoop_history', title: 'WHOOP history',
    description: 'WHOOP data by day for the last N days (1 to 120): recovery %, HRV ms, resting HR, day strain, kcal burned, minutes asleep and in bed, sleep performance % and sleep need, plus every workout (sport, start, minutes, strain, kcal). Days are the local date you woke up.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'How many days back, including today. Default 30.' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true } }
];
async function rpc(m, env) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id != null ? err(m.id, -32600, 'Invalid request') : null;
  const id = m.id, isNote = id === undefined || id === null;
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion, ok = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];
      return ok_(id, { protocolVersion: ok.includes(want) ? want : ok[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fuel-whoop', title: 'WHOOP for Fuel', version: VERSION },
        instructions: 'Read-only WHOOP data: recovery, sleep, strain and workouts. Use whoop_today for this morning, whoop_history for trends.' });
    }
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return ok_(id, {});
    case 'tools/list': return ok_(id, { tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
      if (!TOOLS.some(t => t.name === name)) return err(id, -32602, 'Unknown tool: ' + name);
      const r = name === 'whoop_today' ? await today(env) : await history(env, num(args.days, 30));
      if (r.error) return ok_(id, { content: [{ type: 'text', text: r.error }], isError: true });
      return ok_(id, { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r });
    }
    default: return isNote ? null : err(id, -32601, 'Method not found: ' + m.method);
  }
}
const ok_ = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcErr = (id, code, message) => json(err(id, code, message), 400);

/* ---------- WHOOP data, shaped by day ---------- */
async function today(env) {
  const r = await history(env, 2); if (r.error) return r;
  const d = r.days[r.days.length - 1] || null;
  return { day: d, workouts: d ? r.workouts.filter(w => w.date === d.date) : [], updated: r.updated };
}
async function history(env, days) {
  days = Math.max(1, Math.min(MAX_DAYS, Math.round(days) || 30));
  const tok = await access(env); if (tok.error) return tok;
  const start = new Date(Date.now() - (days + 1) * 864e5).toISOString();
  let cycles, recs, sleeps, works;
  try {
    [cycles, recs, sleeps, works] = await Promise.all(['/cycle', '/recovery', '/activity/sleep', '/activity/workout'].map(p => list(tok.token, p, start)));
  } catch (e) {
    if (e.status === 401) { await env.WHOOP_KV.put('tokens', JSON.stringify({ ...(await getTokens(env)), exp: 0 })); return { error: 'WHOOP refused the token. Try again; if it keeps failing, open /login?key=… to link again.', code: 'not_linked' }; }
    if (e.status === 429) return { error: 'WHOOP is rate-limiting. Try again in a minute.', code: 'rate' };
    return { error: 'WHOOP didn’t answer (' + (e.status || e.message) + ').', code: 'upstream' };
  }
  const local = (iso, off) => { const t = Date.parse(iso); if (!isFinite(t)) return null; return new Date(t + offMin(off) * 6e4).toISOString(); };
  const out = {}, cycleDay = {}, sleepDay = {};
  const day = d => out[d] || (out[d] = { date: d });
  for (const s of sleeps) {
    if (s.nap || !s.end) continue; const w = local(s.end, s.timezone_offset); if (!w) continue; const d = w.slice(0, 10);
    sleepDay[s.id] = d; if (s.cycle_id != null) cycleDay[s.cycle_id] = d;
    const sc = s.score_state === 'SCORED' && s.score; if (!sc) continue; const st = sc.stage_summary || {}, nd = sc.sleep_needed || {}, x = day(d);
    const asleep = (st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0);
    x.sleep_min = r1(asleep / 6e4); x.in_bed_min = r1((st.total_in_bed_time_milli || 0) / 6e4);
    if (sc.sleep_performance_percentage != null) x.sleep_perf = r1(sc.sleep_performance_percentage);
    const need = (nd.baseline_milli || 0) + (nd.need_from_sleep_debt_milli || 0) + (nd.need_from_recent_strain_milli || 0) + (nd.need_from_recent_nap_milli || 0);
    if (need) x.sleep_need_min = r1(need / 6e4);
  }
  for (const c of cycles) {
    const d = cycleDay[c.id] || (local(c.start, c.timezone_offset) && new Date(Date.parse(local(c.start, c.timezone_offset)) + 8 * 36e5).toISOString().slice(0, 10));
    if (!d) continue; cycleDay[c.id] = d; const sc = c.score_state === 'SCORED' && c.score; if (!sc) continue;
    const x = day(d); if (sc.strain != null) x.strain = r1(sc.strain); if (sc.kilojoule != null) x.kcal = Math.round(sc.kilojoule / 4.184);
  }
  for (const r of recs) {
    const d = sleepDay[r.sleep_id] || cycleDay[r.cycle_id]; const sc = r.score_state === 'SCORED' && r.score; if (!d || !sc) continue;
    const x = day(d); if (sc.recovery_score != null) x.recovery = Math.round(sc.recovery_score);
    if (sc.hrv_rmssd_milli != null) x.hrv = r1(sc.hrv_rmssd_milli); if (sc.resting_heart_rate != null) x.rhr = Math.round(sc.resting_heart_rate);
  }
  const workouts = works.filter(w => w.start && w.end).map(w => {
    const l = local(w.start, w.timezone_offset), sc = w.score_state === 'SCORED' && w.score || {};
    return { id: w.id, date: l.slice(0, 10), start: l.slice(11, 16), sport: prettySport(w.sport_name), min: r1((Date.parse(w.end) - Date.parse(w.start)) / 6e4),
      strain: sc.strain != null ? r1(sc.strain) : null, kcal: sc.kilojoule != null ? Math.round(sc.kilojoule / 4.184) : null };
  }).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return { days: Object.values(out).filter(x => x.date >= from).sort((a, b) => a.date.localeCompare(b.date)), workouts: workouts.filter(w => w.date >= from), updated: new Date().toISOString() };
}
async function list(token, path, start) {
  const recs = []; let next = '';
  for (let page = 0; page < 12; page++) {
    const q = new URLSearchParams({ limit: '25', start }); if (next) q.set('nextToken', next);
    const res = await fetch(`${API}${path}?${q}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const j = await res.json(); recs.push(...(j.records || [])); next = j.next_token || j.nextToken || '';
    if (!next) break;
  }
  return recs;
}
const prettySport = s => String(s || 'Activity').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const offMin = o => { const m = String(o || '').match(/^([+-])(\d\d):?(\d\d)$/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; };
const r1 = x => Math.round(x * 10) / 10;
const num = (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : d; };

/* ---------- tokens: WHOOP access tokens last about an hour; refresh tokens rotate, so the new one is always saved ---------- */
async function getTokens(env) { try { const t = await env.WHOOP_KV.get('tokens'); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
async function access(env) {
  const t = await getTokens(env);
  if (!t || !t.refresh) return { error: "WHOOP isn't linked yet. Open your server's /login?key=… link and approve WHOOP.", code: 'not_linked' };
  if (t.access && t.exp > Date.now() + 120e3) return { token: t.access };
  const r = await token(env, { grant_type: 'refresh_token', refresh_token: t.refresh, scope: 'offline' });
  if (!r.ok) return { error: 'WHOOP sign-in expired. Open /login?key=… to link again.', code: 'not_linked' };
  return { token: r.access };
}
async function token(env, params) {
  const body = new URLSearchParams({ ...params, client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET });
  const res = await fetch(`${WHOOP}/oauth/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) return { ok: false, status: res.status };
  const j = await res.json(); const prev = (await getTokens(env)) || {};
  const t = { access: j.access_token, refresh: j.refresh_token || prev.refresh, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
  await env.WHOOP_KV.put('tokens', JSON.stringify(t));
  return { ok: true, access: t.access };
}

/* ---------- small helpers ---------- */
function keyOk(req, url, env) {
  const h = req.headers.get('Authorization') || '', k = h.startsWith('Bearer ') ? h.slice(7).trim() : (url.searchParams.get('key') || '');
  return k.length >= 16 && safeEq(k, env.ACCESS_KEY);
}
function safeEq(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
function rand(n) { const a = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => a[x % a.length]).join(''); }
const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version', 'Access-Control-Max-Age': '86400' });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors() } });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (msg, status = 200) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fuel × WHOOP</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0e;color:#f4f4f6;font:17px/1.5 -apple-system,system-ui,sans-serif">
<main style="max-width:420px;padding:32px"><p style="font:600 12px ui-monospace,monospace;letter-spacing:.1em;color:#8a8a96;margin:0 0 10px">FUEL × WHOOP</p><h1 style="font-size:26px;margin:0 0 10px;letter-spacing:-.02em">${esc(msg)}</h1><p style="color:#8a8a96;margin:0">Version ${VERSION}</p></main>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
