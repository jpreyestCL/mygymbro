// Backend + WebAuthn helpers (ported from the vanilla app).
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
export const webauthnOK = () => !!(window.PublicKeyCredential && navigator.credentials)

// Where the API lives. Empty for the web build, which is served from the same origin as the
// API — that sameness is what lets passkeys and a cookie work at all. The native build sets
// VITE_API_BASE to the absolute server URL, because inside Capacitor the page is
// capacitor://localhost and a relative /api/... would resolve to the app bundle.
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

// A cookie cannot cross that origin change, so the native build authenticates with a bearer
// token instead. The server hands it over in a `set-auth-token` header on sign-in; from then
// on it rides on every request. Web builds never see one and keep using the cookie.
const TOKEN_KEY = 'gym_auth_token'
export const authToken = () => { try { return localStorage.getItem(TOKEN_KEY) } catch { return null } }
const setAuthToken = t => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY) } catch { /* */ } }
export const clearAuthToken = () => setAuthToken(null)

// The passkey challenge cookie can't cross the capacitor://localhost → server origin gap either,
// so the server relays it in an x-passkey-challenge header instead. We hold it between the
// options and verify calls of one ceremony and echo it back. In memory, not localStorage: it
// lives for seconds and means nothing once the challenge is spent. Web builds keep their real
// cookie, so the server ignores the echoed header there.
let passkeyChallenge = null

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  const tok = authToken()
  if (tok) headers.Authorization = 'Bearer ' + tok
  if (passkeyChallenge) headers['x-passkey-challenge'] = passkeyChallenge
  const r = await fetch(API_BASE + path, {
    ...opts,
    headers,
    // Sends the session cookie on the web, and is harmless for the native build, which has
    // no cookie to send. Requires the server to name this origin explicitly in CORS — it
    // does; `*` would make this combination illegal.
    credentials: 'include',
  })
  // Any response can mint a token (sign-in does, session refresh can). Store it whenever it
  // shows up rather than only on the paths we expect to produce one.
  const fresh = r.headers.get('set-auth-token')
  if (fresh) setAuthToken(fresh)
  // generate-options carries the relayed challenge; grab it so the matching verify can echo it.
  const ch = r.headers.get('x-passkey-challenge')
  if (ch) passkeyChallenge = ch
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    // Better Auth reports failures as { message }, this server's own routes as { error }.
    const e = new Error(data.error || data.message || ('HTTP ' + r.status))
    e.status = r.status
    throw e
  }
  return data
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}
// Both ceremonies are two calls: ask the server for options, let the authenticator sign
// them, hand the result back. Better Auth generates the options on GET and verifies on POST,
// and holds the challenge itself — there is no `cid` to carry between the two any more.
export async function passkeyRegister(name, code) {
  const q = new URLSearchParams({ name })
  if (code) q.set('code', code)
  try {
    const options = await api('/api/auth/passkey/generate-register-options?' + q)
    const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
    // createSession: registering IS signing up here, so the ceremony that creates the passkey
    // is also the one that signs you in. Without it you would be registered and logged out.
    const res = await api('/api/auth/passkey/verify-registration', {
      method: 'POST',
      body: JSON.stringify({ response: credToJSON(cred), name, createSession: true }),
    })
    return res.user || (await api('/api/me')).user
  } finally { passkeyChallenge = null }   // spent, or abandoned — never echo it again
}

export async function passkeyLogin() {
  try {
    const options = await api('/api/auth/passkey/generate-authenticate-options')
    const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
    const res = await api('/api/auth/passkey/verify-authentication', {
      method: 'POST',
      body: JSON.stringify({ response: credToJSON(cred) }),
    })
    return res.user || (await api('/api/me')).user
  } finally { passkeyChallenge = null }
}
