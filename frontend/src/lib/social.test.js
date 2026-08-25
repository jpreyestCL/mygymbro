import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// What is being pinned here is not a preference — it is the difference between a button that
// shows an error and one that kills the app. The native SDKs raise uncaught ObjC exceptions when
// asked for a provider the shell was not built for ("No active configuration", "missing support
// for the following URL schemes"), so the app terminates on the tap rather than failing softly.
// A button that cannot work must therefore never be drawn, and no amount of clicking through the
// app proves that for platforms and configurations you do not happen to be holding.
//
// MOBILE is a build-time constant, so the two flavours are separate modules-under-test: the mock
// has to be in place before social.js is imported, which is why each block imports it fresh.

const load = async ({ mobile, platform }) => {
  vi.resetModules()
  vi.doMock('./mobile.js', () => ({ MOBILE: mobile }))
  // api.js reaches for import.meta.env and navigator at module scope; social.js only needs its
  // types here, never a request.
  vi.doMock('./api.js', () => ({ api: vi.fn(), API_BASE: '' }))
  globalThis.Capacitor = platform ? { getPlatform: () => platform } : undefined
  return (await import('./social.js')).socialProviders
}

const CONFIG = { social: ['google', 'apple'], googleIosClientId: 'ios-client-id' }

afterEach(() => { delete globalThis.Capacitor; vi.resetModules() })

describe('socialProviders on the web', () => {
  let socialProviders
  beforeEach(async () => { socialProviders = await load({ mobile: false, platform: null }) })

  it('offers whatever the server has configured', async () => {
    expect(socialProviders(CONFIG)).toEqual(['google', 'apple'])
  })

  // The web flow is a redirect the server drives end to end, so it needs no native client id.
  it('offers Google without a native client id', async () => {
    expect(socialProviders({ social: ['google'] })).toEqual(['google'])
  })

  it('offers nothing when the server has no providers', async () => {
    expect(socialProviders({ social: [] })).toEqual([])
    expect(socialProviders(null)).toEqual([])
  })

  // /api/config is a public payload; an unknown provider must not become a button that calls an
  // endpoint nothing implements.
  it('ignores providers it does not implement', async () => {
    expect(socialProviders({ social: ['google', 'facebook', 'twitter'] })).toEqual(['google'])
  })
})

describe('socialProviders in the native app', () => {
  it('offers both on iOS when the Google client id is present', async () => {
    const socialProviders = await load({ mobile: true, platform: 'ios' })
    expect(socialProviders(CONFIG)).toEqual(['google', 'apple'])
  })

  // The crash this whole module exists to avoid: the server has Google credentials, so it lists
  // the provider, but GOOGLE_CLIENT_ID_IOS was never set, so the SDK has nothing to configure
  // itself with and raises rather than returning an error.
  it('drops Google on iOS when the native client id is missing', async () => {
    const socialProviders = await load({ mobile: true, platform: 'ios' })
    expect(socialProviders({ social: ['google', 'apple'] })).toEqual(['apple'])
  })

  // Apple needs no client id natively — iOS identifies the app by its bundle id.
  it('keeps Apple on iOS with no extra configuration', async () => {
    const socialProviders = await load({ mobile: true, platform: 'ios' })
    expect(socialProviders({ social: ['apple'] })).toEqual(['apple'])
  })

  // Android's plugin validates Apple first and rejects on the missing redirect url, which fails
  // initialise() before Google is ever read — so BOTH buttons would fail on every tap. Nothing
  // here configures either, so nothing is offered.
  it('offers nothing on Android, where neither provider is configured', async () => {
    const socialProviders = await load({ mobile: true, platform: 'android' })
    expect(socialProviders(CONFIG)).toEqual([])
  })

  // A native build whose Capacitor bridge has not attached yet must not guess it is on iOS.
  it('offers nothing when the platform cannot be determined', async () => {
    const socialProviders = await load({ mobile: true, platform: null })
    expect(socialProviders(CONFIG)).toEqual([])
  })
})
