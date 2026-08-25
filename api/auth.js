// Identity: Better Auth over Postgres.
//
// The self-hosted flavour of this app signed people in with a hand-rolled passkey flow and
// an HMAC cookie, storing users in db.json. That is fine for a box you run for yourself and
// wrong for an App Store listing, for two reasons:
//
//   1. No account recovery. A passkey that never made it into iCloud is a lost account, and
//      "your six years of training are gone" is not an answer you can give a stranger.
//   2. A cookie cannot travel from a native app. Inside Capacitor the web view's origin is
//      capacitor://localhost, so a SameSite=Lax cookie for mygym.rlz.cl is simply not sent.
//
// So identity moves to Better Auth: passkeys (still SimpleWebAuthn underneath, so the keys
// already registered against this domain keep working), plus a bearer token for the native
// app. Training data does NOT move — it stays in state-<uid>.json exactly as before. This
// module owns *who you are*, nothing else.
import { betterAuth } from 'better-auth'
import { passkey } from '@better-auth/passkey'
import { bearer } from 'better-auth/plugins/bearer'
import { magicLink } from 'better-auth/plugins/magic-link'
import { send, recoveryEmail, mailEnabled } from './email.js'
import { Pool } from 'pg'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080'
const RP_ID = process.env.RP_ID || 'localhost'
const RP_NAME = process.env.RP_NAME || 'MyGymBro'

const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '')
const DATA = process.env.DATA_DIR || '/data'

// Invite codes stayed in db.json when identity moved to Postgres: they are a property of the
// instance, not of a user, and nothing else needs them. Read at the moment of use rather than
// cached, because the admin dashboard writes the same file from the same process.
function burnInvite(code) {
  const file = path.join(DATA, 'db.json')
  let db
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return false }
  const inv = (db.invites || []).find(i => i.code === code && !i.usedBy && !i.revoked)
  if (!inv) return false
  // Marked used here, at the point of no return: the passkey is already verified by the time
  // resolveUser runs, so a code burned now cannot be spent on a ceremony that then fails.
  inv.usedBy = 'pending'
  inv.usedAt = new Date().toISOString()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, file)
  return true
}

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (!process.env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required')

// Where a request is allowed to come from. The web app is same-origin, so it only needs
// ORIGIN; the rest are the native shells, whose "origin" is a scheme with no host.
// WebAuthn is NOT verified against this list — see `origin` on the passkey plugin below.
const TRUSTED = [
  ORIGIN,
  'capacitor://localhost',   // iOS
  'http://localhost',        // Android
  ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
]

/* ---------- social sign-in ---------- */
//
// Passkeys are the front door on the web and stay that way. They cannot be the front door in
// the native app: inside Capacitor the page is capacitor://localhost, and `navigator.credentials`
// signs the assertion with *that* origin, not with the domain in the Associated Domains
// entitlement — the entitlement only governs the native ASAuthorization API, which a WebView
// does not use. So an assertion made in the app can never satisfy an rpID of mygym.rlz.cl.
// Rather than widen the accepted origins (every Capacitor app on earth presents
// capacitor://localhost, so that trades away the phishing resistance passkeys exist for),
// the app signs in with Apple or Google, and the web keeps passkeys as well.
//
// Both are optional: with no credentials configured the providers simply do not appear, and
// /api/config tells the client which buttons to draw. That keeps a self-hosted instance
// working out of the box without anyone registering an OAuth app.

// Apple does not issue a client secret. It wants a short-lived ES256 JWT signed with a private
// key from the developer account, valid for at most 6 months — so it is generated here rather
// than pasted into the environment, where it would silently expire half a year later.
function appleClientSecret({ teamId, keyId, key, servicesId }) {
  const b64url = b => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: keyId }
  // Just under Apple's 6-month ceiling. A process living longer than that would need a restart;
  // deploys are far more frequent than that, and a wrong `exp` is rejected outright.
  const payload = { iss: teamId, iat: now, exp: now + 150 * 24 * 3600, aud: 'https://appleid.apple.com', sub: servicesId }
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload))
  // ieee-p1363 is raw r||s, the encoding JWS defines for ES256. Node's default DER is a valid
  // ECDSA signature that Apple rejects with an opaque invalid_client.
  const sig = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return input + '.' + b64url(sig)
}

const socialProviders = {}

// clientId is a LIST on purpose. The web flow gets an id token addressed to the browser client,
// the native SDK one addressed to the iOS client; both are this same app, and a single string
// would reject whichever half it was not.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_ID_IOS].filter(Boolean),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  }
}

// Apple's web flow identifies the app by a Services ID, the native one by the bundle id, and the
// id token's audience differs accordingly — appBundleIdentifier is what lets the same provider
// accept both.
const appleKey = process.env.APPLE_PRIVATE_KEY
  ? process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.APPLE_KEY_PATH ? fs.readFileSync(process.env.APPLE_KEY_PATH, 'utf8') : null
if (appleKey && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_SERVICES_ID) {
  socialProviders.apple = {
    clientId: [process.env.APPLE_SERVICES_ID, process.env.APPLE_BUNDLE_ID].filter(Boolean),
    clientSecret: appleClientSecret({
      teamId: process.env.APPLE_TEAM_ID,
      keyId: process.env.APPLE_KEY_ID,
      key: appleKey,
      servicesId: process.env.APPLE_SERVICES_ID,
    }),
    ...(process.env.APPLE_BUNDLE_ID ? { appBundleIdentifier: process.env.APPLE_BUNDLE_ID } : {}),
  }
}

/** Which social buttons the client should draw. Read by /api/config. */
export const socialEnabled = () => Object.keys(socialProviders)

// The native Google SDK has to be initialised with the iOS OAuth client, which is a different
// client id from the web one. It is not a secret (it ships inside every copy of the app), and
// serving it here keeps the app from hard-coding a value that belongs to the deployment.
export const googleIosClientId = () => process.env.GOOGLE_CLIENT_ID_IOS || null

// Exported so the admin views can read the user table directly. Better Auth owns writes to
// identity; these are read-mostly views the app already had.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const auth = betterAuth({
  database: pool,
  baseURL: ORIGIN,
  basePath: '/api/auth',
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: TRUSTED,
  // Email/password is deliberately off: the whole point of this app's sign-in is that there
  // is no password to phish or reuse. Email exists only as a recovery channel, added later.
  emailAndPassword: { enabled: false },
  socialProviders,
  account: {
    accountLinking: {
      // Someone who signed up with a passkey and later taps "Sign in with Apple" on their phone
      // is the same person and must land in the same profile — a second account would strand
      // their training history behind a login they no longer use. Apple and Google both verify
      // the address before asserting it, which is what makes linking on email safe here.
      enabled: true,
      trustedProviders: ['apple', 'google'],
    },
  },
  emailVerification: {
    sendOnSignUp: false,
    sendVerificationEmail: async ({ user, url }) => {
      await send({
        to: user.email,
        subject: 'Confirm your recovery email',
        text: `Hi ${user.name || 'there'},\n\nConfirm this address so it can get you back into `
          + `your account if you ever lose your passkey:\n${url}\n\n`
          + `If you didn't ask for this, ignore it — the address will not be used.`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;line-height:1.55;color:#111">`
          + `<p>Hi ${user.name || 'there'},</p>`
          + `<p>Confirm this address so it can get you back into your account if you ever lose your passkey:</p>`
          + `<p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Confirm email</a></p>`
          + `<p style="color:#666;font-size:14px">If you didn't ask for this, ignore it — the address will not be used.</p></div>`,
      })
    },
  },
  user: {
    additionalFields: {
      // Mirrors the old db.json `admin` flag. ADMIN_UIDS still works as an env-level
      // override so a fresh instance can promote its first user without SQL.
      admin: { type: 'boolean', required: false, defaultValue: false, input: false },
      // Locks an account out everywhere without deleting it or its training data. `input:
      // false` so it can never be set through the sign-up payload.
      banned: { type: 'boolean', required: false, defaultValue: false, input: false },
    },
  },
  session: {
    // 90 days, matching what the hand-rolled cookie did: someone training a few times a
    // week stays signed in, a stolen token does not stay good for a year.
    expiresIn: 60 * 60 * 24 * 90,
    updateAge: 60 * 60 * 24,
  },
  plugins: [
    passkey({
      rpID: RP_ID,
      rpName: RP_NAME,
      // The ONE value the native app hinges on. iOS signs the assertion with the domain
      // from the app's Associated Domains entitlement (https://mygym.rlz.cl), while the web
      // build signs with its page origin. Both must be accepted or one of the two clients
      // can never sign in. This is a list for exactly that reason.
      origin: [ORIGIN, `https://${RP_ID}`],
      authenticatorSelection: {
        residentKey: 'required',      // discoverable, so sign-in needs no username first
        userVerification: 'preferred',
      },
      registration: {
        // Sign-up IS the passkey ceremony — there is no account to log into first. This is
        // what the old POST /api/register/options did, and it is why the flow feels like
        // "tap once and you're in" rather than a form.
        requireSession: false,
        resolveUser: async ({ ctx }) => {
          // generate-register-options is a GET, so the display name arrives as a query
          // parameter; body is read too so a future POST-shaped caller still works.
          const name = String(ctx.query?.name ?? ctx.body?.name ?? '').trim().slice(0, 40)
          if (!name) throw ctx.error('BAD_REQUEST', { message: 'name required' })
          if (INVITE_ONLY) {
            const code = String(ctx.query?.code ?? ctx.body?.code ?? '').trim().toUpperCase()
            if (!burnInvite(code)) throw ctx.error('FORBIDDEN', { message: 'a valid invite code is required' })
          }
          return { id: crypto.randomUUID(), name, displayName: name }
        },
      },
    }),
    // Recovery. A passkey that never reached iCloud is otherwise a dead account, and for a
    // public app that is a support burden measured in lost training histories. A signed link
    // to a verified address gets you back in, where you register a fresh passkey.
    //
    // NOT a second way to log in day to day: passkeys stay the front door. This is the
    // fire escape, which is why it is short-lived and single-use.
    magicLink({
      expiresIn: 600,                 // 10 minutes
      // Nobody signs up by email — an account only ever begins with a passkey ceremony, so a
      // link to an unknown address must not quietly mint an account.
      disableSignUp: true,
      sendMagicLink: async ({ email, url, token }, request) => {
        // Migrated accounts carry a reserved @passkey.invalid address. Sending there would
        // bounce; worse, it would tell the caller a mail is on its way when it never can be.
        if (email.endsWith('@passkey.invalid')) {
          console.warn('[auth] recovery requested for an account with no real email')
          return
        }
        // Only a PROVEN address opens the fire escape. Without this check, setting your
        // recovery address to someone else's mailbox would hand them your account — and
        // pointing it at a stranger's would hand yours to them.
        const row = (await pool.query('select name, "emailVerified" from "user" where email = $1', [email])).rows[0]
        if (!row?.emailVerified) {
          console.warn('[auth] recovery requested for an unverified address — not sending')
          return
        }
        const name = row.name
        await send({ to: email, ...recoveryEmail(url, name) })
      },
    }),
    // Native apps get a token in a `set-auth-token` response header and send it back as
    // `Authorization: Bearer …`, because cookies do not survive the origin change.
    bearer(),
  ],
})

export const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean)
export const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id))
export { TRUSTED as TRUSTED_ORIGINS }

/* ---------- read-only views for the admin dashboard ---------- */
export const listUsers = async () => (await pool.query(
  `select u.id, u.name, u.email, u."createdAt", u.admin, u.banned,
          (select count(*) from passkey p where p."userId" = u.id)::int as passkeys
     from "user" u order by u."createdAt"`)).rows

export const findUser = async id =>
  (await pool.query('select id, name, email, "createdAt", admin, banned from "user" where id = $1', [id])).rows[0] || null

export const setBanned = async (id, banned) => {
  await pool.query('update "user" set banned = $2, "updatedAt" = now() where id = $1', [id, banned])
  // A banned account keeps its data but loses every live session, on every device.
  if (banned) await pool.query('delete from session where "userId" = $1', [id])
}

export const countUsers = async () => Number((await pool.query('select count(*)::int as n from "user"')).rows[0].n)

/** Set (or replace) the recovery address. Unverified until the owner clicks the link. */
export async function setRecoveryEmail(userId, email) {
  const clean = String(email || '').trim().toLowerCase()
  // Deliberately loose: the confirmation mail is the real validator. A regex that rejects a
  // deliverable address is worse than one that lets an undeliverable one through.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(clean)) return { ok: false, error: 'that does not look like an email address' }
  if (clean.endsWith('@passkey.invalid')) return { ok: false, error: 'reserved domain' }
  const taken = await pool.query('select id from "user" where lower(email) = $1 and id <> $2', [clean, userId])
  if (taken.rowCount) return { ok: false, error: 'that address is already on another account' }
  await pool.query('update "user" set email = $2, "emailVerified" = false, "updatedAt" = now() where id = $1', [userId, clean])
  return { ok: true, email: clean }
}
