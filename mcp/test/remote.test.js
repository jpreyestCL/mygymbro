// Remote mode: reading the deployed instance over HTTP instead of the local ./data directory.
//
// The point of these tests is that remote mode adds no server surface. It authenticates with a
// Better Auth bearer token against GET /api/data — the very endpoint the web client already
// syncs against — so there is no new route to secure and no second copy of the session logic.
// What can still go wrong is client-side: a wrong base URL, an expired token, a burst of tool
// calls each paying for its own round trip. Those are what is pinned here.
//
// state.js reads its configuration at module scope, so every case re-imports it under a fresh
// environment rather than mutating a live module.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const URL_BASE = 'https://mygym.example'
const TOKEN = 'test-token'

const STATE = {
  unit: 'kg',
  workouts: [{ id: 'w1', d: '2026-07-24', start: 1, entries: [] }],
  routines: [{ id: 'r1', name: 'Push', ex: [] }],
}

let calls

// Stand in for the api. `overrides` replaces the response for one path.
function mockFetch(overrides = {}) {
  calls = []
  return vi.fn(async (url, init) => {
    const path = String(url).slice(URL_BASE.length)
    calls.push({ path, auth: init?.headers?.Authorization })
    if (overrides[path]) return overrides[path]
    if (path === '/api/me') return jsonRes({ user: { id: 'u-123', name: 'Ana' } })
    if (path === '/api/data') return jsonRes({ state: STATE })
    return jsonRes({ error: 'not found' }, 404)
  })
}

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

// Fresh module graph with the given env, so REMOTE and the URL constants are re-evaluated.
async function loadState(env) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return import('../src/state.js')
}

const REMOTE_ENV = { OPENGYM_URL: URL_BASE, OPENGYM_TOKEN: TOKEN, OPENGYM_TTL_MS: '15000' }
const CLEAR = { OPENGYM_URL: undefined, OPENGYM_TOKEN: undefined, OPENGYM_TTL_MS: undefined, OPENGYM_UID: undefined }

beforeEach(() => { vi.stubGlobal('fetch', mockFetch()) })
afterEach(() => { vi.unstubAllGlobals(); for (const k of Object.keys(CLEAR)) delete process.env[k] })

describe('mode selection', () => {
  test('OPENGYM_URL switches the server to remote', async () => {
    const s = await loadState(REMOTE_ENV)
    expect(s.REMOTE).toBe(true)
    expect(s.source()).toBe(URL_BASE)
  })

  test('without OPENGYM_URL it stays on the local data directory', async () => {
    const s = await loadState({ ...CLEAR, OPENGYM_DATA: '/tmp/nope' })
    expect(s.REMOTE).toBe(false)
    expect(s.source()).toBe('/tmp/nope')
  })

  test('a URL with no token is refused up front, not on the first tool call', async () => {
    const s = await loadState({ ...REMOTE_ENV, OPENGYM_TOKEN: '' })
    await expect(s.init()).rejects.toThrow(/OPENGYM_TOKEN/)
  })

  test('a trailing slash on the URL does not produce a double slash', async () => {
    const s = await loadState({ ...REMOTE_ENV, OPENGYM_URL: URL_BASE + '/' })
    await s.init()
    expect(calls.map(c => c.path)).toEqual(['/api/me', '/api/data'])
  })
})

describe('reading the profile', () => {
  test('init resolves the user from /api/me and primes the state', async () => {
    const s = await loadState(REMOTE_ENV)
    await s.init()

    expect(s.getUser()).toMatchObject({ id: 'u-123', name: 'Ana' })
    expect(s.getState().routines[0].name).toBe('Push')
    expect(calls.map(c => c.path)).toEqual(['/api/me', '/api/data'])
  })

  test('every request carries the bearer token', async () => {
    const s = await loadState(REMOTE_ENV)
    await s.init()
    expect(calls.every(c => c.auth === 'Bearer ' + TOKEN)).toBe(true)
  })

  test('missing fields are filled from the defaults, as on the web client', async () => {
    const s = await loadState(REMOTE_ENV)
    await s.init()
    const S = s.getState()
    expect(S.week).toEqual({})
    expect(S.bodyweight).toEqual([])
    expect(S.unit).toBe('kg')      // from the payload, not clobbered by the default
  })

  test('a profile that has never synced reads as no state, not as an error', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/data': jsonRes({ state: null }) }))
    const s = await loadState(REMOTE_ENV)
    await s.init()
    expect(s.getState()).toBeNull()
  })

  test('getState stays synchronous, so the eight handlers need no await', async () => {
    const s = await loadState(REMOTE_ENV)
    await s.init()
    expect(s.getState()).not.toBeInstanceOf(Promise)
  })
})

describe('refresh', () => {
  test('a second call inside the TTL is served from cache', async () => {
    const s = await loadState(REMOTE_ENV)
    await s.init()
    const before = calls.length
    await s.refresh()
    await s.refresh()
    expect(calls.length).toBe(before)
  })

  test('a call past the TTL re-fetches', async () => {
    const s = await loadState({ ...REMOTE_ENV, OPENGYM_TTL_MS: '0' })
    await s.init()
    const before = calls.length
    await s.refresh()
    expect(calls.length).toBe(before + 1)
  })

  test('concurrent refreshes share one round trip', async () => {
    const s = await loadState({ ...REMOTE_ENV, OPENGYM_TTL_MS: '0' })
    await s.init()
    const before = calls.length
    await Promise.all([s.refresh(), s.refresh(), s.refresh()])
    expect(calls.length).toBe(before + 1)
  })

  test('refresh is a no-op in local mode', async () => {
    const s = await loadState({ ...CLEAR, OPENGYM_DATA: '/tmp/nope' })
    await s.refresh()
    expect(calls.length).toBe(0)
  })
})

describe('failures say what to fix', () => {
  test('401 names the token and where to get one', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/me': jsonRes({ error: 'not signed in' }, 401) }))
    const s = await loadState(REMOTE_ENV)
    await expect(s.init()).rejects.toThrow(/rejected the token \(401\)[\s\S]*OPENGYM_TOKEN/)
  })

  test('an unreachable host names the host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    const s = await loadState(REMOTE_ENV)
    await expect(s.init()).rejects.toThrow(new RegExp(`cannot reach ${URL_BASE}/api/me`))
  })

  test('a non-JSON body suggests the URL is not the app origin', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/me': { ok: true, status: 200, json: async () => { throw new Error('Unexpected token <') } },
    }))
    const s = await loadState(REMOTE_ENV)
    await expect(s.init()).rejects.toThrow(/did not return JSON/)
  })

  test('a token not bound to a profile is reported as such', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/me': jsonRes({ user: null }) }))
    const s = await loadState(REMOTE_ENV)
    await expect(s.init()).rejects.toThrow(/no user/)
  })

  test('remote mode never issues a write', async () => {
    const s = await loadState({ ...REMOTE_ENV, OPENGYM_TTL_MS: '0' })
    await s.init()
    await s.refresh()
    const methods = fetch.mock.calls.map(([, init]) => (init?.method || 'GET').toUpperCase())
    expect(new Set(methods)).toEqual(new Set(['GET']))
  })
})
