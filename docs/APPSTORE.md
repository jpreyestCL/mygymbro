# Workset — App Store submission

Everything that can be prepared without an Apple Developer account is done and in the repo.
What remains needs the account, a Mac signed into it, and the App Store Connect web UI.

Hand `PROMPT.md` (below, section "Prompt for an agent with the account") to whichever assistant
has access to those.

---

## Status

| Piece | State |
|---|---|
| Bundle id `cl.rlz.workset` | done |
| Display name **Workset** | done |
| App icon 1024×1024 + splash | generated from `frontend/resources/icon.svg` |
| Associated Domains entitlement | done — **needs the real Team ID** |
| `apple-app-site-association` | served at `https://mygym.rlz.cl/.well-known/apple-app-site-association` — **contains `TEAMID` placeholder** |
| HealthKit (body weight, read + write) | done, with usage strings |
| Live Activity rest timer + widget extension | done, builds and embeds |
| Privacy policy URL | https://mygym.rlz.cl/privacy |
| Deployment target | iOS 16.0 |
| Apple Developer account | **not created** |
| Signing / archive / upload | **pending** |
| App Store Connect record + metadata | **pending** |

## The one blocker

`webcredentials` is what allows passkeys in the app, and it only works if the AASA file names
`<TEAM_ID>.cl.rlz.workset`. Until the Team ID is filled in, sign-in fails on device with no
useful error.

```bash
ssh root@37.27.190.92 \
  "sed -i 's/TEAMID/YOUR_TEAM_ID/g' /home/dev/apps/opengym/well-known/apple-app-site-association"
curl https://mygym.rlz.cl/.well-known/apple-app-site-association   # verify
```

Apple's CDN caches this for up to 24 hours. For development builds add `?mode=developer` to the
entitlement so iOS fetches it from the domain directly.

## Store listing copy

**Name:** Workset
**Subtitle:** Lift, log, and see the pattern

**Promotional text (170 chars max):**
> Your training log, with the numbers already filled in. Rest timer on the Lock Screen, weight synced with Health, and six years of history if you have it.

**Keywords (100 chars, comma separated, no spaces):**
```
gym,workout,lifting,strength,tracker,log,training,sets,reps,progressive,overload,1rm,routine
```

**Description:**
> Workset remembers what you lifted so you don't have to.
>
> Open today's session and the weights are already there — the ones you used last time,
> adjusted by the progression rule you picked. Every target tells you why it's that number.
>
> **Made for the gym floor**
> The rest timer runs on your Lock Screen and in the Dynamic Island, so you don't unlock your
> phone between sets. The screen stays awake while you train. Supersets log back to back.
>
> **Progression that follows a rule**
> Linear, Greyskull LP, double progression, or none. Missed reps never advance the load,
> stalls trigger a deload, and bodyweight exercises grow in reps instead.
>
> **kg or lb, per exercise**
> Log the dumbbells in whatever the rack is labelled in. Your history converts on the fly, so
> a set recorded in pounds still reads in kilos when you want it to.
>
> **Your body weight, shared with Health**
> Weigh-ins go to Apple Health as you log them, and weights from your scale come back in.
> Body weight only — Workset never reads your workouts or heart rate.
>
> **Bring your history**
> Import from FitNotes, Strong or Hevy. Exercise names are matched against a library of 1,324
> movements, and anything unrecognised becomes your own exercise, so nothing is dropped.
>
> **Sign in without a password**
> Face ID or Touch ID, no password to forget or leak. Your log syncs across your devices.
>
> No ads. No tracking. No subscription.

**What's New (1.0):** First release.

## App Privacy answers (App Store Connect)

Declare these as **collected and linked to the user**, none used for tracking:

| Category | Types | Purpose |
|---|---|---|
| Contact Info | Email address (optional) | Account management |
| Health & Fitness | Health, Fitness | App functionality |
| User Content | Other (training log) | App functionality |
| Identifiers | User ID | App functionality |

Answer **No** to "used for tracking" everywhere, and do not link any data to third parties.

## Review notes (paste into App Review Information)

> Workset is a strength-training log. Sign-in uses passkeys, so there is no demo username or
> password to provide: tap **Create new profile**, enter any name, and confirm with the
> simulator's or device's biometric prompt. That creates a working account with no email
> required. Registration is open — no invite code is needed.
>
> The app is built on openGym, an AGPL-licensed open-source project
> (https://github.com/DuarteSantos8/openGym). The project's NOTICE file grants an additional
> permission under AGPL section 7 that expressly allows distribution through app stores,
> provided the source stays available under the AGPL, which it does at
> https://github.com/arvids-unavailable/openGym. This app is a modified fork published under
> its own name and bundle id, not a copy of a listing that already exists on the App Store.
>
> HealthKit is used only for body weight, read and written, to keep weigh-ins in step with the
> user's scale and other apps. No other Health type is requested and no Health data leaves the
> device except to the user's own account.

## Before submitting

1. Fill in the Team ID (above) and confirm passkey sign-in on a real device.
2. Decide whether registration stays open. It is open today, which App Review needs; if it is
   ever closed, they must be given an invite code in the review notes.
3. Screenshots: 6.9" and 6.5" iPhone are required. Home, an active workout with the rest
   timer, Stats, and the exercise library are the four that show the app best.
4. Take the app through one full workout on a real device — the simulator cannot verify Live
   Activities or Health.
