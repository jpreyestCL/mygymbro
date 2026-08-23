# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

openGym — a self-hosted gym & body-weight tracker. React 19 + Vite frontend, a dependency-light
Node backend with passkey (WebAuthn) auth, JSON files for storage. Fork of `DuarteSantos8/openGym`
(origin here is `arvids-unavailable/openGym`).

## Commands

```bash
# Frontend (all commands from frontend/)
npm install
npm run dev                 # Vite dev server; proxies /api → :3000 and /img,/gif → :8888
npm test                    # vitest run — the pure training-logic tests
npm run test:watch
npx vitest run src/lib/progression.test.js     # a single test file
npx vitest run -t "deload"                     # a single test by name
npm run build               # static build → frontend/dist
npm run build:mobile        # VITE_MOBILE=1 build + `cap sync` into android/ and ios/
node scripts/check-locales.mjs                 # all src/locales/*.js must share one key set

# Backend (from api/)
npm install && npm start    # node server.js, needs DATA_DIR + RP_ID + ORIGIN

# Whole stack
docker compose up -d        # media (one-time ~140 MB download) + api + web on :8080

# Regenerate the exercise instruction packs from upstream (repo root)
node scripts/build-instructions.mjs [path-to-exercises.json]
```

There is no lint step and no CI in this fork. `npm test` covers only `frontend/src/lib/*.test.js`;
everything else is verified by clicking through the app.

## Architecture

### One codebase, three deployment flavors

Build-time flags select the flavor; Vite replaces them, so the unused paths fold away entirely.

| Flavor | Flag | Backend | Auth | Storage |
|---|---|---|---|---|
| Self-hosted web (default) | — | Node api | passkeys, per-profile sync | `./data/*.json` on the server + localStorage |
| Demo (GitHub Pages) | `VITE_DEMO=1` | none | guest only | localStorage, seeded by `lib/demoSeed.js` |
| Mobile (Capacitor) | `VITE_MOBILE=1` | none | guest only | localStorage **plus** a JSON file mirror in the app data dir |

`lib/demo.js` and `lib/mobile.js` own these branches; `store/useStore.js` `boot()` is where the
three paths diverge. Anything imported only by the demo (the seed generator) is dynamically
imported so it never ships in a self-hosted bundle.

**Passkeys require a single origin.** nginx serves the built app and proxies `/api` to the
`api` container, so the browser only ever sees one host. Anything that splits app and API onto
different origins breaks login.

### State: one object `S`, synced whole

All user data is a single serializable object `S` (shape and defaults in `DEF`,
`frontend/src/store/useStore.js`): `routines`, `week` (weekday → routine id), `dayPlan` (ISO date
→ override), `workouts`, `bodyweight`, `exWeights`, `customEx`, `active` (in-progress workout),
plus settings. Never mutate it directly — go through `update(mut)`, which clones, applies, writes
localStorage, and debounce-pushes to `PUT /api/data`.

Sync is last-writer-wins on `S._ts`, with a `gym_dirty` localStorage flag so an offline edit is
not clobbered by a stale server pull. `visibilitychange` flushes pending debounces, because a
setting changed just before backgrounding must not be lost.

Backwards compatibility is a hard rule: absent fields must read as their old behaviour so no
stored workout, plan file or backup ever needs migrating (see the comments on `mode`, `bodyweight`,
`side`, `effort`). Follow that pattern when adding fields.

### Weights carry their unit

`frontend/src/lib/units.js` is the single place kg/lb conversion lives, and the split it
enforces is the thing to get right:

- `wIn(S, set, unit)` — what to **show**. The number in the unit the screen is speaking.
- `wBase(S, set)` — what to **compare**. Every set in the profile's unit, so volume, PRs,
  1RM estimates and progression never add lb to kg.

A set stores `u` only when it differs from `S.unit`; absent `u` reads as the profile's unit,
which is what every set written before this existed meant, so nothing needed migrating.
`S.exUnit[exId]` is the unit an exercise is logged in (the kg/lb switch on the workout
screen), defaulting to the profile's.

Consequences worth knowing before touching this:

- `nextPrescription` computes **in the exercise's unit** — `plan.weight` goes straight into
  the set rows, so a jump named "2.5 kg" beside a column headed lb is a wrong number, not a
  wording bug. Steps are per-unit too (2.5 kg vs 5 lb), not a converted 2.5.
- `bestWeightFor`, `workoutVolume(w, S)`, `bestSetOf(entry, formula, S)` and
  `readSession(entry, fallback, S)` all take the profile so they can normalise. The `S`
  argument is optional purely so pre-units call sites keep their old behaviour — pass it.
- The toggle calls `reexpress`, which converts **and** snaps to a loadable step (0.25 kg /
  0.5 lb). The snap is what makes toggling round-trip exactly; plain conversion drifts a
  tenth per trip and a user tapping back and forth watches their working weight creep.
- Changing the profile's unit in Settings stamps `u` on every existing set first. Without
  that, every set ever logged silently becomes a different weight.

Covered by `units.test.js` and `mixed-units.test.js` — the latter checks a history logged
partly in each unit, which is where the failure mode is silent.

### Training logic lives in pure functions

`frontend/src/lib/` holds everything that decides what you lift next or reads a session back,
as pure functions of `S`, with tests beside them:

- `progression.js` — named policies (`linear`, `greyskull`, `double`, `time`) → `nextPrescription()`.
  Nothing is written back into a finished workout; the next target is *derived* every time, so
  fixing a mistyped set immediately corrects the suggestion. A set is a "hit" only if checked off
  with at least its target reps.
- `history.js` — the reading layer over `S`: `modeOf` (reps/time/cardio), `isBw`, `isPerSide`,
  `buildSets` (pre-fills from last time), `effectiveRoutine*`, volume/streak helpers.
- `onerm.js`, `effort.js`, `muscles.js`, `import-csv.js` (FitNotes/Strong/Hevy), `plan-share.js`.

Per CONTRIBUTING.md: anything in this category **gets a unit test** — these rules are nearly
impossible to verify by clicking, and the progression engine grew two real bugs that only tests
pinned down.

### UI

`App.jsx` is a `HashRouter` shell (hash routing because the mobile/native shell serves from
`file://`) wrapping the views in `src/views/`. Modal flows — start-workout, exercise picker,
settings sub-screens, plan import/export — are **not** routes: they are bottom sheets pushed onto
a stack in `store/useUI.js` and rendered from `sheets.jsx`, which is one large file by design and
holds most of the interaction logic. `components/ui.jsx` is bound to the UI store via `bindUI()`
so shared controls can open sheets without importing the store at module scope.

`useUI` also owns the rest timer and the work timer (timed sets), and mirrors the rest timer to
the server (`/api/push/rest-timer`) so a suspended tab still gets the alert via Web Push.

### i18n

`lib/i18n.js` is a hand-rolled `t()` where **English source strings are the keys**. Locale packs
(`src/locales/*.js`) and exercise-instruction packs (`src/instr/*.js`, generated by
`scripts/build-instructions.mjs`) are lazy-loaded via `import.meta.glob`, so the initial bundle is
English-only. There is no `en.js` — English is the fallback, which is why
`frontend/scripts/check-locales.mjs` exists: a key present in only some locales otherwise falls
back silently mid-sentence.

### Backend (`api/server.js`, ~550 lines, no framework)

A hand-written `routes` table keyed `'METHOD /path'`. Two runtime dependencies
(`@simplewebauthn/server`, `web-push`) — keep it near that. Persistence is atomic writes of
plain JSON under `DATA_DIR`: `db.json` (users, public credentials, invites), `state-<uid>.json`
(one per profile), `secret` (HMAC key for session cookies), `vapid.json` (generated on first run).

Sessions are an HMAC-signed cookie `<uid>:<expiry>:<sv>`; bumping the user's `sv` is how
"sign out everywhere" works. Admin (`ADMIN_UIDS`) and invite-only signup (`INVITE_ONLY`) are both
off by default. Live-workout presence is in-memory only, never persisted.

`effectiveRoutineId` is deliberately duplicated between `api/server.js` and
`frontend/src/lib/history.js` — a tiny helper not worth sharing across two runtimes. If you change
the day-override semantics, change both.

## Conventions

- **Dependency-light is the point.** Frontend: React + Router + Zustand and nothing else. New
  dependencies on either side need a real justification.
- Comments explain *why*, not *what* — the existing code is heavily commented in that style;
  match it rather than adding narration.
- State in `src/store`, pure helpers in `src/lib`, screens in `src/views`, sheets in `sheets.jsx`.
- Exercise media (`media/`) is fetched from `hasaneyldrm/exercises-dataset`; `img/` and `gif/` are
  served next to the app, overridable with `VITE_IMG_BASE` / `VITE_GIF_BASE` (the demo build points
  them at a CDN).

## Fork-specific state (differs from upstream)

- **`web/Dockerfile` no longer exists.** It was moved to the repo root (with `web/nginx.conf` →
  `nginx.conf`) for a Render deploy (`render.yaml`), and `web/nginx.conf` was later restored as a
  copy. `docker-compose.yml` still points `web.build.dockerfile` at `web/Dockerfile`, so
  `docker compose build web` / `up --build` fails; `docker compose pull` (prebuilt ghcr images)
  works. The root `Dockerfile` builds the frontend + nginx only — it has no `api` service behind
  the `/api` proxy.
- **`media/` (2,648 files) and `data/` are committed** — they were tracked before a `.gitignore`
  existed, and the current `.gitignore` only covers `graphify-out/`. `data/` includes
  `data/secret` (the live session-signing key) and `data/vapid.json`: treat those as compromised,
  rotate rather than reuse, and don't add more to `data/`.
- `.env` / `.env.example` are absent despite the README referring to them; env vars documented in
  README.md and `docs/SELF_HOSTING.md` still apply (`RP_ID`, `ORIGIN`, `WEB_PORT`, `RP_NAME`,
  `ADMIN_UIDS`, `INVITE_ONLY`, `SESSION_DAYS`).
- `website/` is the marketing site (hand-written HTML/CSS/JS, no build step).

## Deployment — mygym.rlz.cl

Live at **https://mygym.rlz.cl** on `root@37.27.190.92` (Ubuntu 26.04), running as user `dev`,
**without Docker** — it reuses what the box already runs: system Node 22, nginx + certbot, and
PM2 (`pm2-dev.service`, enabled at boot).

| Piece | Where |
|---|---|
| Checkout | `/home/dev/apps/opengym` (clone of `origin/main`, media included) |
| Frontend | `frontend/dist`, built on the server, served directly by nginx |
| API | PM2 process `opengym-api` on `127.0.0.1:3030` |
| PM2 config | `/home/dev/apps/opengym.pm2.config.cjs` (outside the checkout) |
| User data | `/home/dev/apps/opengym-data` (mode 700, **outside the checkout**) |
| vhost | `/etc/nginx/sites-available/mygym.rlz.cl` |
| Redeploy | `/home/dev/apps/opengym-deploy.sh` |

Things that will bite if forgotten:

- **The repo's `data/` is not used, deliberately.** It carries a committed `secret` (session
  signing key) and a real profile with passkeys, both public on GitHub. `DATA_DIR` points
  outside the checkout so the server generated its own key on first boot.
- **Passkeys need `RP_ID`/`ORIGIN` to match the address bar exactly** — set to `mygym.rlz.cl`
  and `https://mygym.rlz.cl` in the PM2 config. Change the domain and login breaks with no
  useful error. This is also why nginx proxies `/api` on the same origin instead of a separate
  API subdomain.
- **nginx reads the app out of `/home/dev`, which is mode 750.** `www-data` gets traverse via an
  ACL (`setfacl -m u:www-data:x /home/dev`), not by loosening the home directory. A restored
  home or a rebuilt box needs that ACL again.
- `client_max_body_size 6m` in the vhost matches `MAX_BODY` in `api/server.js`; nginx's 1 MB
  default would 413 a large history import.
- The domain sits behind Cloudflare; Let's Encrypt runs at the origin (Full/Strict).

## graphify — knowledge graph (read this before exploring the codebase)

`graphify-out/` holds a persistent graph of this repo — ~650 symbols and ~1,900 edges across 25
named communities, built from tree-sitter ASTs (exact counts at the top of `GRAPH_REPORT.md`).
It is the cheap way to orient: `graphify query` returns a scoped subgraph with `file:line` for
every symbol, instead of grepping and reading whole files.

Ask the graph first:

```bash
graphify query "how does progression decide the next weight?"   # BFS subgraph, --budget N to cap
graphify explain "nextPrescription()"                            # one node + its neighbours
graphify path "ActiveWorkout()" "useStore"                       # shortest path between two symbols
graphify god-nodes --top 10                                      # the hubs everything routes through
graphify affected "modeOf()"                                     # what breaks if you change it
```

- `graphify-out/wiki/index.md` — one Wikipedia-style article per community and per god node, for
  broad navigation without reading source.
- `graphify-out/GRAPH_REPORT.md` — god nodes, community map, import cycles, surprising edges.
  Read it for architecture review; prefer `query` for a specific question.
- `graphify-out/graph.html` — interactive graph, open in a browser.

**Staleness:** the graph rebuilds itself. The `post-commit` and `post-checkout` git hooks run an
AST-only rebuild (~6s, no API cost, detached so the commit returns immediately) and then refresh
`wiki/`. `graphify watch .` does the same ~5s after any code file is saved, if someone left it
running. Mid-session you can force it with `graphify update .`. `GRAPH_REPORT.md` records the
commit it was built from — compare with `git rev-parse HEAD`.

On this machine two LaunchAgents keep it live without any terminal open:
`com.graphify.watch.opengym` (code → graph, ~5s) and `com.graphify.wiki.opengym`
(`WatchPaths` on `graph.json` → wiki). Both in `~/Library/LaunchAgents/`, logging to
`~/.cache/graphify-watch.log`; `launchctl kickstart -k gui/$UID/com.graphify.watch.opengym`
restarts one. The git hooks cover machines without them, and `scripts/graphify-wiki.py` takes a
lock so the two paths never rewrite `wiki/` at once.

Community *names* are the one thing nothing refreshes automatically: they come from an LLM pass.
After a refactor that reshapes the module structure, run `graphify label . --backend claude-cli`.

**Scope:** `.graphifyignore` keeps `media/`, `assets/`, the Capacitor `android/`+`ios/` shells,
`frontend/src/locales`, `frontend/src/instr`, `exercises-data.js` and `data/` out of the graph —
2,648 binaries and generated string maps that carry no structure. Extend that file rather than
letting them back in.

**Regenerating everything** (graph + report + html + wiki):

```bash
graphify extract . --code-only && graphify cluster-only . && ./scripts/graphify-wiki.py
```

The `--code-only` flag keeps it free: full `/graphify .` also sends docs and images through an
LLM, which costs tokens and is only worth it when you want the prose in `docs/` and `README.md`
represented as nodes too.

Use the `graphify` CLI, not `python3 -c "import graphify"` — `python3` here resolves to a
Homebrew 3.14 with a broken `pip` and a stale graphify 0.4.13. The working install is
`~/.local/bin/graphify` (uv tool, 0.9.48).
