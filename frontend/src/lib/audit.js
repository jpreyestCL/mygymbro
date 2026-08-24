// Rendering for the admin activity log (GET /api/admin/audit).
//
// The server stores reason codes, not sentences — `{ ev: 'auth.login.fail', msg: 'unknown-credential' }`
// rather than "someone tried a passkey we don't know". Turning those into English
// belongs here and not in Admin.jsx: it is the only part of the feature that can be wrong in a way
// a person sees, and as a plain module it is testable without mounting the dashboard.
//
// Like the rest of the admin screen this is English-only — the operator surface deliberately
// stays out of the per-language string packs (see the header of views/Admin.jsx). Times still
// follow the UI language, the way numbers and dates already do.
import { dateLocale } from './i18n-core.js'

// The first segment of an event name is also the filter chip it belongs to.
export const auditCat = ev => String(ev || '').split('.')[0]

// Every auth event carries a .ok/.fail suffix in this fork — the server derives them from the
// status Better Auth answered with, so both halves of every pair exist and both need a label.
const LABELS = {
  'auth.login.ok': 'Signed in',
  'auth.login.fail': 'Sign-in failed',
  'auth.register.ok': 'Created a profile',
  'auth.register.fail': 'Profile creation failed',
  'auth.register.denied': 'Signup refused',
  'auth.logout.ok': 'Signed out',
  'auth.logout.fail': 'Sign-out failed',
  'auth.logout.all.ok': 'Signed out everywhere',
  'auth.logout.all.fail': 'Sign-out everywhere failed',
  // Passkeys are managed by Better Auth in this fork, so adding or dropping one is its own
  // event rather than part of registering.
  'auth.passkey.add.ok': 'Added a passkey',
  'auth.passkey.add.fail': 'Adding a passkey failed',
  'auth.passkey.remove.ok': 'Removed a passkey',
  'auth.passkey.remove.fail': 'Removing a passkey failed',
  // Account recovery: the way back in when every passkey is gone. Worth its own events, because
  // a recovery link being sent to an account is exactly what an attacker would try first.
  'auth.recovery.set': 'Set a recovery address',
  'auth.recovery.send.ok': 'Requested a recovery link',
  'auth.recovery.send.fail': 'Recovery link request failed',
  'auth.recovery.use.ok': 'Signed in with a recovery link',
  'auth.recovery.use.fail': 'Recovery link rejected',
  'auth.email.verify.ok': 'Confirmed a recovery address',
  'auth.email.verify.fail': 'Address confirmation failed',
  'admin.user.disable': 'Disabled an account',
  'admin.user.enable': 'Re-enabled an account',
  'admin.invite.create': 'Created an invite code',
  'admin.invite.revoke': 'Revoked an invite code',
  'admin.audit.clear': 'Cleared the activity log',
  'admin.denied': 'Blocked from the admin dashboard',
  'admin.coach.config': 'Changed Coach settings',
  'admin.coach.connect': 'Connected a Coach provider',
  'admin.coach.disconnect': 'Disconnected the Coach provider'
}
// An unknown event is shown raw rather than dropped or rendered as "undefined": a dashboard
// that is one version behind the server should still say *something* truthful.
export const auditLabel = ev => LABELS[ev] || String(ev || 'Unknown event')

const REASONS = {
  'challenge-expired': 'the sign-in took too long and expired',
  'unknown-credential': 'unknown passkey',
  'verify-error': 'the passkey could not be verified',
  'not-verified': 'the passkey was rejected',
  'user-missing': 'the passkey points at a profile that no longer exists',
  'account-disabled': 'the account is disabled',
  'credential-exists': 'that passkey already belongs to a profile',
  'invite-invalid': 'the invite code was used or revoked in the meantime',
  'invite-rejected': 'wrong or already-used invite code',
  // Better Auth answers with a status, not a reason code, and its message can quote the address
  // somebody typed — which does not belong in a log every admin can read. So the status is what
  // gets stored, and this turns the ones that mean something into English.
  'http-400': 'the request was rejected',
  'http-401': 'wrong credentials',
  'http-403': 'not allowed',
  'http-404': 'no such account',
  'http-409': 'already exists',
  'http-422': 'the request was incomplete',
  'http-429': 'too many attempts',
  'http-500': 'the server errored'
}
export const auditReason = msg => REASONS[msg] || (msg ? String(msg) : '')

// → { title, sub }. `sub` is the house "a · b · c" metadata line used by every list row.
export function auditLine(e) {
  if (!e) return { title: '', sub: '' }
  const parts = []
  if (e.name) parts.push(e.name)
  else if (e.uid) parts.push(e.uid)
  else if (!e.ok) parts.push('unknown caller')
  if (e.tname) parts.push('→ ' + e.tname)
  // The reason codes and the invite codes share the msg field; only failures read as a reason.
  if (e.msg) parts.push(e.ok ? e.msg : auditReason(e.msg))
  if (e.ip) parts.push(e.ip)
  return { title: auditLabel(e.ev), sub: parts.join(' · ') }
}

// The activity log is the one place in the app that needs a clock, and fmtDate() renders none —
// it is used by every other view and is not worth changing for this.
export function fmtWhen(ts, now = Date.now()) {
  if (!ts) return ''
  const d = new Date(ts)
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  const n = new Date(now)
  const sameDay = d.toDateString() === n.toDateString()
  if (sameDay) return 'today ' + time
  if (now - ts < 6 * 86400000 && ts <= now) return d.toLocaleDateString(dateLocale(), { weekday: 'short' }) + ' ' + time
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) + ' ' + time
}
