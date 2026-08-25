/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

import { auth, isAdmin as isAdminUser, TRUSTED_ORIGINS, listUsers, findUser, setBanned, countUsers, setRecoveryEmail, socialEnabled, googleIosClientId } from './auth.js';
import { mailEnabled } from './email.js';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'MyGymBro';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// Whether the login screen may offer "Continue without account". Default ON, and the test is
// inverted from INVITE_ONLY's on purpose: an unset variable must mean "allowed", so an existing
// install does not silently lock its guests out on the next deploy.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });

/* The secrets are locked down file by file rather than by sealing the whole directory.
 *
 * Coach credentials are encrypted with a key derived from $DATA_DIR/secret. Sessions no
 * longer use this file (Better Auth has BETTER_AUTH_SECRET); we still mint one so an
 * instance that never had the old cookie secret can store a provider token.
 *
 * Best-effort throughout: a bind-mounted host filesystem may refuse chmod, and that is not a
 * reason to refuse to boot. The privilege drop in adapters/spawn.js is the control that does
 * fail closed. */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const lock = f => { try { fs.chmodSync(path.join(DATA, f), 0o600); } catch { /* not present yet, or host says no */ } };
['secret', 'db.json', 'coach.json'].forEach(lock);

/* ---------- secret + db ---------- */
const dbFile = path.join(DATA, 'db.json');
// db.json is no longer the user store — that is Postgres. What is left here is device-local
// bookkeeping: push subscriptions, invite codes, and the last date each user was reminded.
let db = { subs: [], invites: [], reminded: {} };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
db.reminded = db.reminded || {};
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}

// Cadence only needs a uid. Identity lives in Postgres now, but Coach consent lives in the
// state file, so listing those files keeps the tick off the database (same reason the
// reminder ticker is driven by push subscriptions rather than the user table).
function coachUsers() {
  try {
    return fs.readdirSync(DATA)
      .filter(f => /^state-[A-Za-z0-9_-]+\.json$/.test(f))
      .map(f => ({ id: f.slice('state-'.length, -'.json'.length) }));
  } catch { return []; }
}
// Driven by who has a push subscription rather than by the user table: identity lives in
// Postgres now, but a reminder only needs a device to send to and a plan to read, both of
// which are still here on disk. Keeps the ticker off the database entirely.
setInterval(() => {
  for (const uid of [...new Set(db.subs.map(s => s.userId))]) {
    const user = (db.reminded ||= {});
    const S = readState(uid);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user[uid] === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', uid, rid);
    user[uid] = now.date;
    saveDb();
    sendPush(uid, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (Better Auth) ---------- */
// Identity moved to Better Auth (see auth.js): passkeys and sessions live in Postgres, and
// a native app authenticates with a bearer token because its origin is capacitor://localhost
// and no cookie for this domain would ever be sent. Both arrive as ordinary headers, so this
// is the single place that has to know the difference: it doesn't.
//
// Async now, where the cookie version was synchronous — every caller awaits it.
async function readSession(req) {
  try {
    const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!s?.user) return null;
    if (s.user.banned) return null;      // disabled accounts are locked out everywhere
    return s.user;
  } catch (e) { return null; }
}
const isAdmin = isAdminUser;

// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  // A signed-in non-admin reaching an admin route is worth a line; an anonymous 401 is not,
  // since every logged-out page load would produce one.
  if (!isAdmin(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}

// Everything the app needs to know about who is signed in. `needsRecovery` is the honest
// signal that this account has no way back if the passkey is lost: profiles migrated from
// the file-based version carry a reserved .invalid address rather than a real one.
const publicUser = u => ({
  id: u.id, name: u.name, admin: isAdmin(u),
  email: String(u.email || '').endsWith('@passkey.invalid') ? null : u.email,
  needsRecovery: String(u.email || '').endsWith('@passkey.invalid'),
});

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- audit log ---------- */
// Who signed in, who tried and failed, and what an admin changed. One JSON object per line in
// $DATA_DIR/audit.log, appended and never rewritten in place. It deliberately does not live in
// db.json: that file is rewritten whole on every save, and the sign-in handshake is
// unauthenticated by design, so an audit trail in there would turn one bogus request into a full
// db.json rewrite. A line torn by a crash costs one event and is dropped on read.
//
// It is a flat file rather than a Postgres table even though this fork has a database, for the
// same reason: an append is one syscall on a path that must never block or fail a sign-in, and a
// log nobody can read without psql is a log nobody reads. `jq` works on it directly.
//
// On by default. It records strictly less than the instance already holds — every account is in
// Postgres and every workout is in state-<uid>.json, both readable by any admin — and a security
// feature that ships switched off protects nobody. IP addresses are the exception: off unless you
// ask for them, because they are the one field here that says where somebody physically is.
const AUDIT_ON = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
const AUDIT_MAX = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);     // 0 = no count cap
const AUDIT_DAYS = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);     // 0 = no age cap
const AUDIT_IP = /^full$/i.test(process.env.AUDIT_IP || '') ? 'full'
  : /^(1|true|yes|on|net)$/i.test(process.env.AUDIT_IP || '') ? 'net' : 'off';
const auditFile = path.join(DATA, 'audit.log');
let auditSeq = 0;      // never reset, not even by a clear — a wiped log leaves a visible id gap
let auditCount = 0;

// Which header holds the caller depends on what is in front of the API. CF-Connecting-IP comes
// first because a Cloudflare tunnel does NOT forward the client in X-Forwarded-For — that header
// then only carries the tunnel's own container, which looks like a valid answer and isn't. This
// instance sits behind Cloudflare (see CLAUDE.md), so that ordering is the one that matters here.
// After that, the first entry of X-Forwarded-For is the client and everything behind it is our
// own hops. All three are only as trustworthy as the proxy in front: it has to overwrite them
// rather than pass a client-supplied one through. In 'net' mode only the network survives —
// enough to tell one source from another, not enough to point at a person.
function clientIp(req) {
  if (AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;    // never store a header verbatim
  if (AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

function auditLines() {
  let text;
  try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* torn line */ }
  }
  return rows;
}
// Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what's left.
function auditKeep(rows) {
  let out = rows;
  if (AUDIT_DAYS) { const cut = Date.now() - AUDIT_DAYS * 86400000; out = out.filter(r => r.ts >= cut); }
  if (AUDIT_MAX && out.length > AUDIT_MAX) out = out.slice(out.length - AUDIT_MAX);
  return out;
}
function compactAudit() {
  const rows = auditLines();
  for (const r of rows) if (+r.id > auditSeq) auditSeq = +r.id;
  const keep = auditKeep(rows);
  auditCount = keep.length;
  if (keep.length === rows.length) return;
  try { atomicWrite(auditFile, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '')); }
  catch (e) { console.error('audit compact failed', e.message); }
}

// Never throws: a log that can't be written must not break signing in.
function audit(req, ev, f = {}) {
  if (!AUDIT_ON) return;
  const rec = { id: ++auditSeq, ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  const ip = clientIp(req);
  if (ip) rec.ip = ip;
  try { fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n'); }
  catch (e) { return console.error('audit write failed', e.message); }
  // Amortized: a 5000-event cap rewrites the file once per ~1250 events.
  if (AUDIT_MAX && ++auditCount > AUDIT_MAX * 1.25) compactAudit();
}
if (AUDIT_ON) {
  compactAudit();                                // prune on boot, seed auditSeq/auditCount
  setInterval(compactAudit, 3600000).unref();    // honour AUDIT_DAYS on an idle instance too
}

// What a Better Auth path under /api/auth/ means in the log. Better Auth owns sign-in, sign-up
// and sign-out in this fork, so the events are derived from the route it handled and the status
// it answered with, rather than being emitted by hand-written handlers as upstream does.
// Anything unlisted is not logged: the session-read endpoints fire on every page load and would
// bury the events that matter.
const AUTH_EVENTS = [
  [/^passkey\/(verify-authentication|authenticate)/, 'auth.login'],
  [/^sign-in\//, 'auth.login'],
  [/^sign-up\//, 'auth.register'],
  [/^passkey\/(verify-registration|register)/, 'auth.passkey.add'],
  [/^passkey\/delete-passkey/, 'auth.passkey.remove'],
  [/^sign-out/, 'auth.logout'],
  [/^revoke-sessions/, 'auth.logout.all'],
  [/^magic-link\/verify/, 'auth.recovery.use'],
  [/^sign-in\/magic-link/, 'auth.recovery.send'],
  [/^verify-email/, 'auth.email.verify'],
];
const authEventFor = rest => (AUTH_EVENTS.find(([re]) => re.test(rest)) || [])[1] || null;

// Log the outcome of a Better Auth call. The user is taken from the response body, which is
// where it is on a successful sign-in — the session cookie is on the way OUT, so re-reading the
// request would find nobody. Body capture is capped and wrapped: this must never be the reason
// an authentication fails.
function auditAuthCall(req, res, rest) {
  const ev = authEventFor(rest);
  if (!AUDIT_ON || !ev) return;
  const write = res.write.bind(res), end = res.end.bind(res);
  let body = '', over = false;
  const grab = chunk => {
    if (over || !chunk) return;
    try {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (body.length > 4096) { over = true; body = body.slice(0, 4096); }
    } catch { over = true; }
  };
  res.write = (chunk, ...a) => { grab(chunk); return write(chunk, ...a); };
  res.end = (chunk, ...a) => {
    grab(chunk);
    try {
      const ok = res.statusCode < 400;
      let u = null;
      try { const b = JSON.parse(body); u = b?.user || b?.data?.user || null; } catch { /* not JSON */ }
      const f = { ok };
      if (u && u.id) f.user = u;
      // A failure says only what the status was. Better Auth's message can carry the address
      // someone typed, and an audit log is the wrong place for a stranger's guesses.
      if (!ok) f.msg = 'http-' + res.statusCode;
      // Uniform `.ok`/`.fail` suffix on every auth event. Upstream suffixes login and register
      // but writes logout flat; one rule is easier to filter on and to label, and this fork's
      // log starts empty, so there is no history to stay compatible with.
      audit(req, ev + (ok ? '.ok' : '.fail'), f);
    } catch (e) { console.error('audit auth failed', e.message); }
    return end(chunk, ...a);
  };
}


/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: await countUsers() }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => {
    const coach = coachConfig.publicConfig();
    json(res, 200, { invite_only: INVITE_ONLY, recovery: mailEnabled(), allow_guest: ALLOW_GUEST, social: socialEnabled(),
      ...(googleIosClientId() ? { googleIosClientId: googleIosClientId() } : {}), ...(coach ? { coach } : {}) });
  },

  'GET /api/me': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

              'GET /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  // Recovery address. Stored unverified and confirmed by mail: an address nobody has proven
  // they own must never be able to open the account, in either direction.
  'PUT /api/recovery-email': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (!mailEnabled()) return json(res, 503, { error: 'this instance cannot send email' });
    const body = await readBody(req);
    const r = await setRecoveryEmail(user.id, body.email);
    if (!r.ok) return json(res, 400, { error: r.error });
    try {
      await auth.api.sendVerificationEmail({ body: { email: r.email }, headers: fromNodeHeaders(req.headers) });
    } catch (e) {
      console.error('verification mail', e.message);
      return json(res, 502, { error: 'saved, but the confirmation email could not be sent' });
    }
    // The address is not logged — it is the one field here that is personal data belonging to
    // someone other than the account holder's own name, and the event alone is the useful part.
    audit(req, 'auth.recovery.set', { user });
    json(res, 200, { ok: true, email: r.email });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const users = (await listUsers()).map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.createdAt || null,
        disabled: !!u.banned, admin: isAdmin(u), passkeys: u.passkeys,
        // Reserved .invalid address = migrated from the file-based version and still has no
        // way back into the account if the passkey is lost. Worth seeing at a glance.
        needsRecovery: String(u.email || '').endsWith('@passkey.invalid'),
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = await findUser(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.createdAt || null, disabled: !!u.banned, admin: isAdmin(u) },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = await findUser(body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    const disabled = !!body.disabled;
    await setBanned(u.id, disabled);
    if (disabled) presence.delete(u.id);   // drop them off "training now" at once
    audit(req, disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    // resolve usedBy uid → name for display
    const byId = Object.fromEntries((await listUsers()).map(u => [u.id, u.name]));
    const invites = db.invites.map(i => ({ ...i, usedByName: i.usedBy ? byId[i.usedBy] || null : null }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    // The code itself is not logged: it is a bearer secret until it is used, and the log is
    // readable by every admin. The note is what identifies it to a person.
    audit(req, 'admin.invite.create', { user: admin, msg: invite.note || code.slice(0, 4) + '…' });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    audit(req, 'admin.invite.revoke', { user: admin, msg: inv.note || inv.code.slice(0, 4) + '…' });
    json(res, 200, { ok: true });
  },

  /* ---------- activity log ---------- */
  'GET /api/admin/audit': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const cat = q.get('cat') || '';
    let rows = auditKeep(auditLines()).reverse();
    if (cat === 'fail') rows = rows.filter(r => !r.ok);
    else if (cat) rows = rows.filter(r => String(r.ev).startsWith(cat + '.'));
    const page = rows.filter(r => r.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: AUDIT_ON, ip_mode: AUDIT_IP,
      retention: { max: AUDIT_MAX, days: AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and auditSeq is not reset — so a clear always leaves a
  // visible gap in the ids and can't be used to quietly erase a trace. There is no export route:
  // audit.log already is the export, in a format jq reads directly.
  'POST /api/admin/audit/clear': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    try { fs.unlinkSync(auditFile); } catch { /* nothing logged yet */ }
    auditCount = 0;
    audit(req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them. Sessions are async (Better Auth), so every handler in that module awaits
  // readSession/requireAdmin. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin, audit })
};

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
// A job that was running when the process died is not coming back; say so rather than leaving
// a spinner that never resolves.
coachJobs.recoverOnBoot();
// A ready proposal is the one Coach event worth a notification. Failures and "nothing to
// change" stay silent on purpose (FR-38/E4).
coachJobs.setProposalHook((uid, pending) => {
  if (pending?.bundle) {
    sendPush(uid, {
      title: 'Your Coach has a plan',
      body: pending.summary || 'A new plan is ready to review',
      tag: 'coach-proposal', url: '#/coach/proposal'
    });
    return;
  }
  const n = (pending?.changes || []).length;
  if (!n) return;
  sendPush(uid, {
    title: 'Your Coach has been reading',
    body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
    tag: 'coach-proposal', url: '#/coach'
  });
});
startCadence({ users: coachUsers, userNow });

// Better Auth serves everything under /api/auth (sign-up, sign-in, sessions, passkeys).
const authHandler = toNodeHandler(auth);

// Passkey challenge relay, for the native app only.
//
// Better Auth keeps the WebAuthn challenge in Postgres, keyed by a token it hands out in a
// signed, SameSite=Lax cookie (`better-auth-passkey`) on generate-options and reads back on
// verify. Same-origin web builds round-trip that cookie and never notice it. The native shell
// is cross-origin — capacitor://localhost → https://mygym.rlz.cl — so the cookie is never sent
// back on the verify POST and it fails with "Challenge not found": the very cookie-can't-cross-
// origins problem the session already routes around with a bearer token, one call earlier in the
// same ceremony. So relay the *opaque, already-signed* cookie through a channel the WebView can
// use — a readable response header out, the header the client echoes back folded into Cookie in.
// No secret is touched: this only carries a value the browser itself would have carried.
const PASSKEY_CH_HEADER = 'x-passkey-challenge';

// The challenge Set-Cookie as `name=value`, or null for anything else — its own deletion
// included, which carries an empty value.
function passkeyCookiePair(setCookie) {
  for (const c of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
    const pair = String(c).split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0 && /passkey/i.test(pair.slice(0, eq)) && pair.slice(eq + 1)) return pair;
  }
  return null;
}

// On the way out: whenever Better Auth sets the challenge cookie, copy it into a header the
// native client can read. setResponse writes cookies with res.setHeader before writeHead, so
// intercepting setHeader lands the extra header in the same flush.
function relayChallengeOut(res) {
  const set = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'set-cookie') {
      const pair = passkeyCookiePair(value);
      if (pair) set(PASSKEY_CH_HEADER, pair);
    }
    return set(name, value);
  };
}

// On the way in: if the client echoed the challenge back in the header and no real cookie is
// present (the native case), fold it into Cookie so the plugin finds it exactly where it looks.
function relayChallengeIn(req) {
  const hdr = req.headers[PASSKEY_CH_HEADER];
  if (!hdr || /passkey/i.test(req.headers.cookie || '')) return;
  req.headers.cookie = req.headers.cookie ? req.headers.cookie + '; ' + hdr : String(hdr);
}

// The web app is same-origin and needs none of this. The native shells are not: inside
// Capacitor the page is capacitor://localhost, so every call here is cross-origin and the
// browser will not send it at all without these headers. Reflecting only known origins
// (rather than *) is what makes `credentials: include` legal — and with `*` it isn't.
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // same-origin or a non-browser client
  if (!TRUSTED_ORIGINS.includes(origin)) return true;   // unknown: answer without CORS headers
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ' + PASSKEY_CH_HEADER);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Custom headers a cross-origin caller cannot read unless exposed by name: the bearer token
  // it gets on sign-in, and the relayed passkey challenge it must echo back to verify. Without
  // these the native app signs in and never sees its token, or never completes the ceremony.
  res.setHeader('Access-Control-Expose-Headers', 'set-auth-token, ' + PASSKEY_CH_HEADER);
  return true;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname.startsWith('/api/auth/')) {
    relayChallengeIn(req);
    relayChallengeOut(res);
    auditAuthCall(req, res, url.pathname.slice('/api/auth/'.length));
    try { return await authHandler(req, res); }
    catch (e) {
      console.error('auth', url.pathname, e);
      if (!res.headersSent) json(res, 500, { error: 'auth error' });
      return;
    }
  }

  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`workset-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
