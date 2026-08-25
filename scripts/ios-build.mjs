#!/usr/bin/env node
// Start (and watch) an Xcode Cloud build from the terminal.
//
// "Start Build" is a menu item in Xcode, which means a build normally needs someone sitting at
// an unlocked Mac. The App Store Connect API can do the same thing over HTTPS, so this works
// headless, over SSH, and with the screen locked — which is the whole reason it exists.
//
// A push to `main` already triggers the Default workflow on its own. Reach for this when you
// want a build WITHOUT a commit: re-running after a failure that was not the code's fault (a
// timed-out runner, an expired certificate), or building a branch the workflow does not watch.
//
// Credentials live in ~/.appstoreconnect, never in the repo:
//   config.json                     {keyId, issuerId, keyPath}
//   private_keys/AuthKey_XXX.p8     the private key, chmod 600
// The .p8 is downloadable exactly once from App Store Connect. Losing it means revoking the
// key and issuing a new one, so it is deliberately kept outside the checkout where no `git add`
// can ever reach it.
//
// Usage:
//   node scripts/ios-build.mjs                 # build main, then watch until it finishes
//   node scripts/ios-build.mjs --branch dev    # build another branch
//   node scripts/ios-build.mjs --no-watch      # start it and return
//   node scripts/ios-build.mjs --status        # just show the latest runs
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG = path.join(os.homedir(), '.appstoreconnect', 'config.json')
const PRODUCT_NAME = 'MyGymBro'
const WORKFLOW_NAME = 'Default'

const args = process.argv.slice(2)
const flag = name => args.includes('--' + name)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

/* ---------- auth ---------- */

let cfg
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
} catch {
  console.error(`no App Store Connect config at ${CONFIG}\n`
    + `Create it with {"keyId","issuerId","keyPath"} — see the comment at the top of this file.`)
  process.exit(1)
}
const keyPath = cfg.keyPath.replace(/^~/, os.homedir())
const privateKey = fs.readFileSync(keyPath, 'utf8')

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

// Signed fresh per call rather than once per run: a long --watch outlives a single token, and
// Apple rejects anything older than 20 minutes.
function token() {
  const header = { alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { iss: cfg.issuerId, iat: now, exp: now + 19 * 60, aud: 'appstoreconnect-v1' }
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload))
  // ieee-p1363 is raw r||s, the format JWS defines for ES256. Node's default DER encoding is
  // a valid ECDSA signature that Apple rejects with a bare 401, so this flag is load-bearing.
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return input + '.' + b64url(sig)
}

async function api(endpoint, init = {}) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + endpoint, {
    ...init,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  if (!r.ok) {
    // Apple's errors are far more useful than the status alone — surface the detail, not "HTTP 409".
    const detail = data?.errors?.map(e => `${e.title}: ${e.detail}`).join('\n  ') || text
    throw new Error(`HTTP ${r.status} on ${endpoint}\n  ${detail}`)
  }
  return data
}

/* ---------- the build ---------- */

const line = b => `#${b.attributes.number}  ${b.attributes.executionProgress}`
  + `/${b.attributes.completionStatus || '—'}`
  + `  ${(b.attributes.sourceCommit?.commitSha || '').slice(0, 8)}`
  + `  "${(b.attributes.sourceCommit?.message || '').split('\n')[0].slice(0, 60)}"`

const products = await api('/v1/ciProducts?limit=200')
const product = products.data.find(p => p.attributes.name === PRODUCT_NAME)
if (!product) throw new Error(`no Xcode Cloud product named "${PRODUCT_NAME}" — found: `
  + products.data.map(p => p.attributes.name).join(', '))

const workflows = await api(`/v1/ciProducts/${product.id}/workflows?limit=200`)
const workflow = workflows.data.find(w => w.attributes.name === WORKFLOW_NAME)
if (!workflow) throw new Error(`no workflow named "${WORKFLOW_NAME}" — found: `
  + workflows.data.map(w => w.attributes.name).join(', '))

if (flag('status')) {
  const runs = await api(`/v1/ciWorkflows/${workflow.id}/buildRuns?limit=8&sort=-number`)
  runs.data.forEach(b => console.log(line(b)))
  process.exit(0)
}

// A build run is started against a git reference, not a branch name, so the branch has to be
// resolved to the ref Xcode Cloud already knows about.
const branch = opt('branch', 'main')
const repos = await api(`/v1/ciProducts/${product.id}/primaryRepositories?limit=200`)
if (!repos.data.length) throw new Error('the product has no primary repository')
const refs = await api(`/v1/scmRepositories/${repos.data[0].id}/gitReferences?limit=200`)
const ref = refs.data.find(r => r.attributes.name === branch && r.attributes.kind === 'BRANCH')
if (!ref) throw new Error(`no branch "${branch}" — found: `
  + refs.data.filter(r => r.attributes.kind === 'BRANCH').map(r => r.attributes.name).join(', '))

console.log(`starting ${PRODUCT_NAME} / ${WORKFLOW_NAME} on ${branch}…`)
const started = await api('/v1/ciBuildRuns', {
  method: 'POST',
  body: JSON.stringify({
    data: {
      type: 'ciBuildRuns',
      relationships: {
        workflow: { data: { type: 'ciWorkflows', id: workflow.id } },
        sourceBranchOrTag: { data: { type: 'scmGitReferences', id: ref.id } },
      },
    },
  }),
})
console.log('started ' + line(started))

if (flag('no-watch')) {
  console.log('not watching (--no-watch). Check later with --status.')
  process.exit(0)
}

// Poll until it lands. A cold Xcode Cloud build takes ~10-20 min here, so 30s is frequent
// enough to feel live without hammering the API.
const id = started.data.id
let last = ''
for (;;) {
  await new Promise(r => setTimeout(r, 30_000))
  let run
  try {
    run = await api(`/v1/ciBuildRuns/${id}`)
  } catch (e) {
    // A transient API blip should not kill a 20-minute watch.
    console.log('  (poll failed, retrying: ' + e.message.split('\n')[0] + ')')
    continue
  }
  const a = run.data.attributes
  const now = `${a.executionProgress}/${a.completionStatus || '—'}`
  if (now !== last) { console.log('  ' + new Date().toTimeString().slice(0, 8) + '  ' + now); last = now }
  if (a.executionProgress === 'COMPLETE') {
    const ok = a.completionStatus === 'SUCCEEDED'
    console.log(ok
      ? `\ndone — build #${a.number} succeeded. It should appear in TestFlight shortly.`
      : `\nbuild #${a.number} finished ${a.completionStatus}. Open Xcode → Report navigator, or App Store Connect, for the logs.`)
    process.exit(ok ? 0 : 1)
  }
}
