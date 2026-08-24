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
import { Pool } from 'pg'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080'
const RP_ID = process.env.RP_ID || 'localhost'
const RP_NAME = process.env.RP_NAME || 'Workset'

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
