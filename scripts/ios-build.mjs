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
//   node scripts/ios-build.mjs --distribute    # hand the newest successful build to the testers
//   node scripts/ios-build.mjs --no-distribute # build, but leave it out of TestFlight
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG = path.join(os.homedir(), '.appstoreconnect', 'config.json')
const PRODUCT_NAME = 'MyGymBro'
const WORKFLOW_NAME = 'Default'
const GROUP_NAME = 'Team (Expo)'

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

/* ---------- TestFlight ---------- */

// Xcode Cloud's own "TestFlight Internal Testing" post-action is a console-only setting: the
// API's workflow object carries no field for it, and a group with "automatic distribution" on
// still did not pick builds up by itself. So distribution happens here — every successful build
// this script watches is handed to the group, and `--distribute` does the same for a build a
// push to main started. Without it a build sits at READY_FOR_BETA_TESTING, valid and invisible.
async function betaGroup() {
  const app = await api(`/v1/ciProducts/${product.id}/app`)
  const groups = await api(`/v1/apps/${app.data.id}/betaGroups?limit=200`)
  const group = groups.data.find(g => g.attributes.name === GROUP_NAME)
  if (!group) throw new Error(`no beta group named "${GROUP_NAME}" — found: `
    + groups.data.map(g => g.attributes.name).join(', '))
  return group
}

// The build is not there the moment the run succeeds: Apple takes minutes to ingest and process
// it, and a build that is still PROCESSING cannot be handed to a group. Waiting it out is the
// whole job — failing here would leave a good build undelivered.
async function buildOfRun(runId, { tries = 40, waitMs = 30_000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const linked = await api(`/v1/ciBuildRuns/${runId}/builds?limit=1`).catch(() => ({ data: [] }))
    const id = linked.data[0]?.id
    if (id) {
      const build = await api(`/v1/builds/${id}`)
      if (build.data.attributes.processingState === 'VALID') return build.data
      if (build.data.attributes.processingState === 'FAILED') {
        throw new Error(`build ${build.data.attributes.version} failed processing at Apple`)
      }
    }
    if (i === 0) console.log('  waiting for TestFlight to finish processing the build…')
    await new Promise(r => setTimeout(r, waitMs))
  }
  return null
}

async function distribute(runId) {
  const group = await betaGroup()
  const build = await buildOfRun(runId)
  if (!build) {
    console.log(`  still processing — hand it to "${GROUP_NAME}" later with --distribute.`)
    return
  }
  await api(`/v1/betaGroups/${group.id}/relationships/builds`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }),
  })
  console.log(`  build ${build.attributes.version} → ${GROUP_NAME}`)
}

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

// For a build nobody watched: the push-triggered run that already finished.
if (flag('distribute')) {
  const runs = await api(`/v1/ciWorkflows/${workflow.id}/buildRuns?limit=8&sort=-number`)
  const done = runs.data.find(r => r.attributes.completionStatus === 'SUCCEEDED')
  if (!done) throw new Error('no successful build run to distribute')
  console.log('distributing ' + line(done))
  await distribute(done.id)
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
// started.data, not started: printing the envelope used to throw after the POST had already
// gone through, so a rerun "after the crash" queued the same commit twice.
console.log('started ' + line(started.data))

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
    if (ok && !flag('no-distribute')) await distribute(id)
    console.log(ok
      ? `\ndone — build #${a.number} succeeded. It should appear in TestFlight shortly.`
      : `\nbuild #${a.number} finished ${a.completionStatus}. Open Xcode → Report navigator, or App Store Connect, for the logs.`)
    process.exit(ok ? 0 : 1)
  }
}
