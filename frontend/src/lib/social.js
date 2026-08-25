// Sign in with Apple / Google.
//
// Passkeys remain the front door on the web. They cannot be one in the native app: inside
// Capacitor the page is capacitor://localhost, and `navigator.credentials` signs the assertion
// with that origin rather than the domain in the Associated Domains entitlement — the
// entitlement governs the native ASAuthorization API, which a WebView does not use. So the app
// signs in with Apple or Google instead, and the two flavours reach the same Better Auth
// endpoint by different routes:
//
//   web     redirect to the provider, come back to /api/auth/callback/<provider>, session cookie
//   native  the OS sheet returns an id token, POST it, get a bearer token back
//
// The native path is the reason this file exists at all: an OAuth redirect out of a WebView and
// back has no good landing spot, while the id token is already signed by the provider and can
// be handed straight to the server.
import { api, API_BASE } from './api.js'
import { MOBILE } from './mobile.js'

/**
 * Providers this build can actually complete — not merely the ones the server has credentials
 * for. The distinction matters because the native SDKs do not fail politely: tapping a provider
 * the shell was never configured for raises an uncaught ObjC exception and takes the app down
 * with it, so a button that cannot work must not be drawn in the first place.
 */
export const socialProviders = config => {
  const list = (config?.social || []).filter(p => p === 'apple' || p === 'google')
  if (!MOBILE) return list                      // the web flow is a redirect; nothing to configure
  return list.filter(p => nativeReady(p, config))
}

// What each native platform needs before its sheet can open. Apple is free on iOS (the OS
// identifies the app by its bundle id) and needs a web redirect on Android, which nothing here
// configures yet — so Android offers neither, rather than offering both and crashing.
function nativeReady(provider, config) {
  if (platform() !== 'ios') return false
  // Google's iOS SDK throws "No active configuration" without its own client id, and
  // "missing support for the following URL schemes" if Info.plist does not carry the reversed
  // form of that id. Both are hard crashes, so treat a missing id as "cannot offer".
  if (provider === 'google') return !!config?.googleIosClientId
  return true
}

// Read through Capacitor rather than the user agent: the WebView reports a Safari UA on iOS and
// a Chrome one on Android, neither of which says which shell is hosting it.
function platform() {
  try { return globalThis.Capacitor?.getPlatform?.() || 'web' } catch { return 'web' }
}

// Loaded only in the native build, and only when someone actually taps a button. A static import
// would pull the plugin into the web bundle, where it is dead weight that cannot work anyway.
let pluginPromise = null
const plugin = () => (pluginPromise ||= import('@capgo/capacitor-social-login').then(m => m.SocialLogin))

let initialised = false
async function initNative(config) {
  if (initialised) return
  const SocialLogin = await plugin()
  // Only ever reached on iOS with a google client id in hand — socialProviders() refuses to draw
  // a button otherwise, and initialising a provider the shell cannot serve is what crashes.
  await SocialLogin.initialize({
    // Apple needs no client id natively: the OS identifies the app by its bundle id, which is
    // what the server validates through appBundleIdentifier.
    apple: {},
    // Google native, by contrast, does want the iOS OAuth client. The server accepts both this
    // and the web client id, because the same person may arrive by either route.
    google: { iOSClientId: config.googleIosClientId },
  })
  initialised = true
}

/**
 * Start a social sign-in.
 *
 * Native resolves to the signed-in user. Web never resolves — it navigates away to the provider
 * and the page is replaced — so callers must not put anything meaningful after the await.
 *
 * @param {'apple'|'google'} provider
 * @param {object|null} config parsed /api/config, for the native client ids
 */
export async function socialLogin(provider, config) {
  if (MOBILE) return nativeLogin(provider, config)
  return webLogin(provider)
}

async function webLogin(provider) {
  // Better Auth answers with the provider URL rather than a 302, so that a fetch caller decides
  // when to leave the page instead of the browser following a redirect it cannot see.
  const r = await api('/api/auth/sign-in/social', {
    method: 'POST',
    body: JSON.stringify({ provider, callbackURL: window.location.origin + '/' }),
  })
  if (!r?.url) throw new Error('the server did not return a sign-in URL')
  window.location.href = r.url
  // Deliberately never resolves: the page is on its way out, and resolving would let a caller
  // flash a "signed in" toast over a screen that is about to be replaced.
  return new Promise(() => {})
}

async function nativeLogin(provider, config) {
  await initNative(config)
  const SocialLogin = await plugin()
  const res = await SocialLogin.login({
    provider,
    options: provider === 'apple'
      ? { scopes: ['email', 'name'] }
      : { scopes: ['email', 'profile'] },
  })
  const idToken = res?.result?.idToken?.token || res?.result?.idToken
  if (!idToken) throw new Error('no identity token came back from ' + provider)

  // Apple returns the id token bound to a nonce it generated; Better Auth has to be told which
  // one, or the audience check passes and the replay check does not.
  const nonce = res?.result?.idToken?.nonce || res?.result?.nonce
  const body = { provider, idToken: { token: idToken, ...(nonce ? { nonce } : {}) } }

  // Apple sends the name ONCE, on the very first authorisation, and never again. If it is not
  // captured here the profile is permanently nameless, so it rides along on that first sign-in.
  const given = res?.result?.profile?.givenName || res?.result?.givenName
  const family = res?.result?.profile?.familyName || res?.result?.familyName
  const name = [given, family].filter(Boolean).join(' ').trim()
  if (name) body.name = name

  const out = await api('/api/auth/sign-in/social', { method: 'POST', body: JSON.stringify(body) })
  return out.user || (await api('/api/me')).user
}

export { API_BASE }
