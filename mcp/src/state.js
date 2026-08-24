/* opengym-mcp state — the profile snapshot the eight tools read.
 *
 * Two sources, picked by environment:
 *
 *   local (default)  reads ./data/state-<uid>.json off the disk, for an LLM client running on
 *                    the same box as the api. Cached with an fs.watch + mtime fallback so a
 *                    session the api server just wrote is visible on the next tool call.
 *   remote           GET {OPENGYM_URL}/api/data with a bearer token, for a laptop talking to
 *                    the deployed instance. No new server surface: /api/data is the endpoint
 *                    the web client already syncs against, and Better Auth's bearer plugin
 *                    already accepts `Authorization: Bearer …` on it.
 *
 * Identity note for this fork: users live in Postgres now, not in db.json (see api/auth.js).
 * Training data did NOT move — it is still state-<uid>.json — so local mode works unchanged,
 * but the uid can no longer be looked up in db.json. Local mode therefore resolves it from
 * the state files themselves, and says so when it cannot.
 *
 * Read-only in both modes: nothing here writes, and remote mode only ever issues GETs.
 */
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')
const URL_BASE = (process.env.OPENGYM_URL || '').trim().replace(/\/+$/, '')
const TOKEN = (process.env.OPENGYM_TOKEN || '').trim()
// A remote read costs a round trip, so a burst of tool calls in one LLM turn should not
// re-fetch per call. Short enough that "I just finished a set" is answered correctly.
const REMOTE_TTL_MS = Number(process.env.OPENGYM_TTL_MS || 15000)

export const REMOTE = !!URL_BASE

// null = no state (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _user = null
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions
let _fetchedAt = 0      // remote only: when the cache was last filled
let _inFlight = null    // remote only: dedupes concurrent refreshes

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// Merge stored state over the defaults, the same shape the frontend builds on pullState, so a
// field the app added since the snapshot was written reads undefined-safe rather than throwing.
const withDefaults = raw => Object.assign({}, defaultsShape(), raw)

/* ---------- local mode ---------- */

// Pick the uid: OPENGYM_UID env, else the only state-* file. There is deliberately no db.json
// fallback: this fork keeps users in Postgres, so db.json holds invites and push subscriptions
// and nothing that names a profile. The sanitiser on stateFile() keeps a sneaky '..' harmless.
function resolveUid() {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error(`OPENGYM_UID contains characters that aren't safe in a filename: ${JSON.stringify(envUid)}`)
    return envUid
  }
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    throw new Error(
      `no openGym profile state found in ${DATA_DIR} — sign in and sync at least once on a device, ` +
      `or set OPENGYM_URL + OPENGYM_TOKEN to read the deployed instance instead`
    )
  }
  throw new Error(
    `multiple openGym profiles found — set OPENGYM_UID to one of: ${files.join(', ')}\n` +
    `  (identity lives in Postgres in this fork: select id, name from "user";)`
  )
}

function initLocal() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`OPENGYM_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    const raw = readJsonOrNull(file)
    if (raw) _state = withDefaults(raw)
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it. The stdio transport is what keeps the loop alive while a client
    // is actually attached; watching is unaffected.
    _watcher.unref()
  } catch { /* fs.watch unsupported here; getState re-reads on mtime change instead */ }
}

function readLocal() {
  const file = stateFile(_uid)
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      _state = withDefaults(fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never synced
    }
  }
  return _state
}

/* ---------- remote mode ---------- */

async function get(pathname) {
  let res
  try {
    res = await fetch(URL_BASE + pathname, {
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
      redirect: 'manual',
    })
  } catch (e) {
    throw new Error(`cannot reach ${URL_BASE}${pathname}: ${e.message}`)
  }
  if (res.status === 401) {
    throw new Error(
      `${URL_BASE}${pathname} rejected the token (401). OPENGYM_TOKEN must be a Better Auth ` +
      `bearer token for the profile — the value of the set-auth-token response header from a sign-in.`
    )
  }
  if (!res.ok) throw new Error(`${URL_BASE}${pathname} returned HTTP ${res.status}`)
  try { return await res.json() } catch { throw new Error(`${URL_BASE}${pathname} did not return JSON — is OPENGYM_URL the app origin?`) }
}

async function refreshRemote(force) {
  if (!force && _state !== undefined && Date.now() - _fetchedAt < REMOTE_TTL_MS) return
  // One fetch even if several tool calls land together.
  if (_inFlight) return _inFlight
  _inFlight = (async () => {
    const body = await get('/api/data')
    _state = body && body.state ? withDefaults(body.state) : null
    _fetchedAt = Date.now()
  })()
  try { await _inFlight } finally { _inFlight = null }
}

async function initRemote() {
  if (!TOKEN) throw new Error('OPENGYM_URL is set but OPENGYM_TOKEN is empty — remote mode needs a bearer token')
  const me = await get('/api/me')
  const u = me && me.user
  if (!u || !u.id) throw new Error(`${URL_BASE}/api/me returned no user — the token is not bound to a profile`)
  _uid = u.id
  _user = { id: u.id, name: u.name || 'Profile', created: u.created || u.createdAt || null }
  await refreshRemote(true)
}

/* ---------- public surface ---------- */

// Idempotent. Resolves the profile and primes the cache. Async because remote mode has to ask
// the server who the token belongs to; local mode does no I/O beyond the disk read.
export async function init() {
  if (_uid !== null) return
  if (REMOTE) await initRemote()
  else initLocal()
}

// Called by index.js before each tool call. Local mode re-reads on mtime change inside
// getState(), so only remote mode has anything to do here — this is what keeps getState()
// synchronous, and therefore keeps all eight handlers synchronous.
export async function refresh() {
  if (!REMOTE) return
  await init()
  await refreshRemote(false)
}

// Returns the state object, or null for a profile that has never synced.
export function getState() {
  if (REMOTE) return _state === undefined ? null : _state
  if (_uid === null) initLocal()
  return readLocal()
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export function getUser() {
  if (REMOTE) return _user || { id: _uid, name: 'Profile', created: null }
  if (_uid === null) initLocal()
  const u = (_db?.users || []).find(x => x.id === _uid)
  // db.json has no users in this fork (Postgres owns identity), so the fallback is the norm
  // rather than the exception. The uid is the only thing the tools actually need.
  return u ? { id: u.id, name: u.name, created: u.created || null } : { id: _uid, name: 'Profile', created: null }
}

export const dataDir = () => DATA_DIR
export const source = () => (REMOTE ? URL_BASE : DATA_DIR)

// Test-only: work against a passed-in state, not the disk or the network.
export function _seedStateForTests(state) {
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _user = null
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  _fetchedAt = Number.MAX_SAFE_INTEGER
  if (_watcher) { _watcher.close(); _watcher = null }
}

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, exUnit: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
