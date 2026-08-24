# Prompt: finish the App Store submission

Copy everything below the line into an assistant that is running on the Mac signed into the
Apple Developer account. It cannot be done from a machine without that account.

---

You are finishing the App Store submission for an iOS app called **Workset**. The codebase,
native features and server are done and verified; what remains is the Apple side.

## Context you need

- **Repo:** `~/work/opengym` (branch `feat/per-exercise-units`). The iOS project is at
  `frontend/ios/App/App.xcworkspace` — always open the **workspace**, not the project, because
  it uses CocoaPods.
- **Bundle id:** `cl.rlz.workset`. Widget extension: `cl.rlz.workset.RestActivity`.
- **Deployment target:** iOS 16.0.
- **Server:** `https://mygym.rlz.cl` (Hetzner, `root@37.27.190.92`, app runs as user `dev`
  under PM2 as `opengym-api`). Postgres holds identity, JSON files hold training data.
- **Read `docs/APPSTORE.md` first** — it has the full status table, the store listing copy, the
  App Privacy answers and the review notes, already written. Do not rewrite them; use them.

## The build command that works

```bash
cd ~/work/opengym/frontend
npm run build:mobile          # web build with VITE_API_BASE + cap sync
cd ios/App && pod install
open App.xcworkspace
```

`npm run build:mobile` overwrites `frontend/dist` with the mobile bundle. Run a plain
`npm run build` afterwards if you also deploy the web app from that folder.

## Tasks, in order

### 1. Team ID — do this first, everything else depends on it

Passkeys will not work on a real device until the domain vouches for the app. Get the Team ID
from developer.apple.com (Membership), then:

```bash
ssh root@37.27.190.92 \
  "sed -i 's/TEAMID/<TEAM_ID>/g' /home/dev/apps/opengym/well-known/apple-app-site-association"
curl https://mygym.rlz.cl/.well-known/apple-app-site-association
```

It must return `application/json`, HTTP 200, **no redirect**. Apple follows neither redirects
nor a wrong content type, and reports neither — it just behaves as if there were no
association at all.

Then verify on a real device: install, tap **Create new profile**, and confirm with Face ID. If
the sheet never appears, the AASA is the cause 90% of the time. Apple's CDN caches it for up to
24 h; add `?mode=developer` to the `webcredentials` entry in
`frontend/ios/App/App/App.entitlements` while testing so iOS fetches from the domain directly.

### 2. Signing

In Xcode, target **App** → Signing & Capabilities: set the team, let it manage signing. Do the
same for the **RestActivityExtension** target. Confirm these capabilities are present (they are
already in the entitlements file, but the portal must know about them too):

- Associated Domains — `webcredentials:mygym.rlz.cl`, `applinks:mygym.rlz.cl`
- HealthKit
- Push Notifications (the server sends rest-timer and workout reminders via Web Push on the
  web build; only add this if you enable native push, otherwise skip it)

### 3. Verify on a real device before doing anything else

The simulator cannot test either native feature. On a physical iPhone, check all four:

1. Passkey sign-in creates an account and the app lands on Home.
2. Sign out, sign back in with the same passkey.
3. Start a workout, complete a set → the rest countdown appears on the Lock Screen and in the
   Dynamic Island, and disappears when the next set starts.
4. Settings → Health → import body weight; then log a weigh-in and confirm it appears in the
   Health app.

If (3) does nothing, check Settings → Face ID & Passcode → Live Activities is on, and that
`NSSupportsLiveActivities` is `true` in `Info.plist`.

### 4. App Store Connect

Create the app record: name **Workset**, primary language English, bundle id `cl.rlz.workset`,
SKU `workset-ios`. Then fill in, copying from `docs/APPSTORE.md`:

- Subtitle, promotional text, description, keywords — written there, use verbatim.
- **Privacy Policy URL:** `https://mygym.rlz.cl/privacy` (already live).
- **App Privacy:** the table in that file. Answer *No* to tracking everywhere.
- **App Review Information → Notes:** the block in that file. It explains that sign-in is by
  passkey so there is no demo login, and it explains the AGPL app-store exception that makes
  publishing this fork legitimate. **Do not omit the licensing paragraph** — the app is a fork
  of an open-source project and a reviewer who discovers that independently is a rejection.
- Age rating: 4+. Category: Health & Fitness.

### 5. Screenshots

Required: 6.9" and 6.5" iPhone. Take them on a real device with real data — an empty app
photographs badly. The four that show it best: Home with the week strip, an active workout with
the rest timer running, Stats, and the exercise library.

### 6. Archive and upload

Xcode → Product → Destination: Any iOS Device → Product → Archive → Distribute App → App Store
Connect. Then submit for review.

## Things that will bite you

- **HealthKit apps get extra scrutiny.** The usage strings must describe the user benefit, not
  the API. They are already written that way in `Info.plist`; do not shorten them.
- **Guideline 4.2** ("minimum functionality") is the real risk for this app, because it shares
  a codebase with a web app. HealthKit and the Live Activity are the defence. If review pushes
  back, the answer is the rest timer on the Lock Screen and two-way Health sync — both
  impossible on the web.
- **Do not rename the app to openGym.** That is the upstream project's name; using it invites
  a 4.1 copycat rejection.
- Registration must stay open for review, or the reviewer cannot get in.

## What to report back

The App Store Connect app id, the build number uploaded, and any review feedback verbatim. If
review rejects, paste the full message rather than summarising — the resolution usually depends
on the exact guideline number they cite.
