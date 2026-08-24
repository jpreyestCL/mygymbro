# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — from your own
self-hosted instance.

It is read-only and runs as a stdio process spawned by the LLM client. There are two ways to
point it at a profile:

- **local** — reads `state-<uid>.json` straight off the disk. For an LLM client running on the
  same box as the api. No authentication, because the filesystem is the boundary.
- **remote** — `GET /api/data` against the deployed instance with a bearer token. For a laptop
  talking to `https://mygym.rlz.cl`. This adds **no new server route**: `/api/data` is the
  endpoint the web client already syncs against, and Better Auth's `bearer()` plugin already
  accepts `Authorization: Bearer …` on it.

The LLM never sees passkeys, VAPID keys, or session secrets in either mode — only the training
state the app itself reads.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Read-only today. Write tools are planned but not shipped — see **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

### Local mode

The MCP server reads the same `DATA_DIR` the api writes to. Pick the profile to answer for.

> **This fork:** identity moved to Better Auth on Postgres, so `db.json` no longer lists users
> — it holds invites and push subscriptions. Training data did *not* move: it is still
> `state-<uid>.json`, which is why local mode works unchanged. With one profile the uid is
> auto-detected from the state file; with several, look it up with
> `select id, name from "user";` and set `OPENGYM_UID`.

```bash
# single-profile instance — the uid is auto-detected from the one state-*.json file:
OPENGYM_DATA=/path/to/data node src/index.js

# several profiles, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/data node src/index.js
```

Point `OPENGYM_DATA` at the real data directory. On the deployed box that is
`/home/dev/apps/opengym-data`, **not** the repo's committed `./data` — see the deployment notes
in the root `CLAUDE.md`.

### Remote mode

Set `OPENGYM_URL` and the server switches to HTTP; `OPENGYM_DATA` is then ignored.

```bash
OPENGYM_URL=https://mygym.rlz.cl OPENGYM_TOKEN=<bearer-token> node src/index.js
```

`OPENGYM_TOKEN` is a Better Auth bearer token for the profile — the value of the
`set-auth-token` response header returned by a sign-in. The server calls `/api/me` once at
startup to resolve who the token belongs to, then `/api/data` per tool call, cached for
`OPENGYM_TTL_MS` (default 15000) so a burst of tool calls in one LLM turn costs one round trip.
Only GETs are ever issued.

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        // local mode
        "OPENGYM_DATA": "/absolute/path/to/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected with one profile

        // …or remote mode instead (OPENGYM_URL wins; OPENGYM_DATA is then ignored)
        // "OPENGYM_URL": "https://mygym.rlz.cl",
        // "OPENGYM_TOKEN": "<bearer-token>"
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Tools

Eight read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight per exercise) |
| `get_week_plan` | What's on my plan this week, including today with any date-specific override? |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

`scripts/check-node-loadable.mjs` guards that split. It runs under bare `node`, not vitest,
because being outside Vite *is* the check — a Vite-only import can land in a shared lib module,
leave every test green, and still kill this server at startup.

### Units

This fork stores the unit each set was logged in (`u`, absent meaning the profile's), so a raw
`s.w` is a number with no scale attached. Everything that leaves this server is therefore
normalised to the profile's unit first — via `wBase`/`setLabelIn`, the same helpers the UI uses
— and every payload names that unit. This matters more here than on screen: an LLM cannot see a
missing `u` and will happily average 100 kg with 225 lb into "162.5", with no error anywhere.
`test/units.test.js` pins it. Warm-up rows are reported as `warmup: true` and excluded from 1RM
estimates, matching the Stats screen.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth, and no new route.** Local mode makes the filesystem the boundary. Remote mode
  reuses `/api/data` and Better Auth's existing bearer plugin, so there is no second copy of the
  session logic to keep in step. No passkey material, VAPID keys, or session secrets ever cross
  either boundary.
- **Read-only.** Nothing here writes; remote mode issues GETs only, and there is a test that
  says so.
- **No telemetry.** Local mode makes no network calls at all; remote mode talks only to the
  `OPENGYM_URL` you set.

## Tests

```bash
cd mcp && npm test
```

64 cases across three files:

- `tools.test.js` (36) — JSON shape and the user-facing edge cases, seeded from
  `frontend/src/lib/demoSeed.js`: rest-day override, missing routine, zero-workout history, no
  synced state, superset links, three 1RM formulas. "Today" is pinned with
  `vi.useFakeTimers({ now: ..., toFake: ['Date'] })`.
- `units.test.js` (10) — mixed kg/lb histories, per-set `u` stamps, warm-up exclusion.
- `remote.test.js` (18) — mode selection, bearer auth, TTL caching, concurrent-refresh
  deduplication, and the error messages for a bad URL, a rejected token and a non-JSON body.

The pure lib functions have their own tests in `frontend/src/lib/*.test.js`.

```bash
cd mcp && npm run check:node-loadable   # the import graph still loads under bare node
```

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (this fork):** remote mode over `/api/data` with a bearer token; per-set unit
  normalisation; warm-up-aware 1RM.
- **Phase 1.5:** a `progression_next` tool (what does the policy prescribe next?). No new
  deps; small surface area.
- **Phase 2:** read+write. Remote mode makes this cheaper than upstream planned — `PUT
  /api/data` already exists and already takes the same bearer token, so the remaining problem is
  the read-modify-write race against the web UI rather than a new auth path. Tools:
  `log_workout`, `add_bodyweight`, `edit_routine`, `assign_weekday`, `override_day`.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
