// One-shot: move the profiles in data/db.json into Better Auth's Postgres tables.
//
// Run once per instance, before switching server.js over. Idempotent: re-running skips
// users and passkeys that are already there, so a half-finished run is safe to repeat.
//
//   DATABASE_URL=... node migrate-identity.js [--dry-run]
//
// The user id is PRESERVED. Training data lives in state-<uid>.json and is keyed by it, so
// a fresh id would orphan every workout the user has ever logged.
//
// The one conversion that matters: db.json stores the credential public key as base64url
// (`Buffer.toString('base64url')`), Better Auth stores it as standard base64. They differ
// only in two characters and the padding, so a straight copy imports without error and then
// fails to verify at sign-in — locking the user out of their own account with nothing in
// the logs. Hence toStandardB64 below, and the round-trip assertion in the verify step.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Pool } from 'pg'

const DATA = process.env.DATA_DIR || '/data'
const DRY = process.argv.includes('--dry-run')

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1) }

const toStandardB64 = b64url => Buffer.from(String(b64url), 'base64url').toString('base64')

const dbFile = path.join(DATA, 'db.json')
if (!fs.existsSync(dbFile)) { console.error(`no db.json at ${dbFile} — nothing to migrate`); process.exit(1) }
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'))

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const q = (sql, params) => pool.query(sql, params)

let users = 0, keys = 0, skipped = 0
try {
  for (const u of db.users || []) {
    const existing = await q('select id from "user" where id = $1', [u.id])
    if (existing.rowCount) { skipped++; console.log(`  = ${u.name} (${u.id}) already present`) }
    else {
      // No email was ever collected. .invalid is reserved by RFC 2606 precisely so it can
      // never resolve, which keeps this from ever being mistaken for a reachable address —
      // and gives the app a reliable test for "this account has no recovery yet".
      const email = `${u.id}@passkey.invalid`
      const created = u.created ? new Date(u.created) : new Date()
      if (!DRY) {
        await q(
          `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", admin)
           values ($1, $2, $3, false, $4, $4, $5)`,
          [u.id, u.name, email, created, u.admin === true],
        )
      }
      users++
      console.log(`  + user ${u.name} (${u.id})`)
    }

    for (const c of (db.creds || []).filter(c => c.userId === u.id)) {
      const have = await q('select id from passkey where "credentialID" = $1', [c.id])
      if (have.rowCount) { skipped++; console.log(`    = passkey ${c.id.slice(0, 12)}… already present`); continue }
      const pub = toStandardB64(c.publicKey)
      // Prove the conversion is lossless before writing it: a key that decodes to different
      // bytes than the original is the lockout this whole comment is about.
      if (!Buffer.from(pub, 'base64').equals(Buffer.from(c.publicKey, 'base64url'))) {
        throw new Error(`public key for ${c.id} does not round-trip — refusing to write it`)
      }
      if (!DRY) {
        await q(
          `insert into passkey (id, name, "publicKey", "userId", "credentialID", counter,
                                "deviceType", "backedUp", transports, "createdAt")
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [
            crypto.randomUUID(), 'Imported passkey', pub, u.id, c.id, c.counter || 0,
            // Neither flag was recorded before; both are informational (SimpleWebAuthn does
            // not read them when verifying), so the conservative value is the honest one.
            'singleDevice', false, (c.transports || []).join(','),
          ],
        )
      }
      keys++
      console.log(`    + passkey ${c.id.slice(0, 12)}…`)
    }
  }
  console.log(`\n${DRY ? '[dry run] ' : ''}${users} user(s), ${keys} passkey(s) migrated, ${skipped} already present`)
} finally {
  await pool.end()
}
