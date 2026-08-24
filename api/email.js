// Transactional email through Resend.
//
// A plain fetch rather than the SDK: one POST with a bearer token is the whole API, and this
// server's whole point is that it stays readable without a dependency tree behind it.
//
// Unset RESEND_API_KEY disables sending rather than crashing. A self-hosted instance run for
// one household has nobody to email and should not be forced to sign up for a mail provider
// to boot — but it also must not silently pretend a recovery mail went out, so send() reports
// what happened and callers surface it.

const KEY = process.env.RESEND_API_KEY || ''
const FROM = process.env.MAIL_FROM || 'Workset <noreply@rlz.cl>'

export const mailEnabled = () => !!KEY

export async function send({ to, subject, html, text }) {
  if (!KEY) {
    console.warn('[mail] RESEND_API_KEY not set — not sending:', subject, '->', to)
    return { ok: false, reason: 'mail-disabled' }
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error('[mail] resend rejected', r.status, body.slice(0, 300))
      return { ok: false, reason: `http-${r.status}` }
    }
    return { ok: true }
  } catch (e) {
    console.error('[mail] send failed', e.message)
    return { ok: false, reason: 'network' }
  }
}

/**
 * The recovery mail. Deliberately plain: one link, one sentence about why it arrived, and an
 * explicit "ignore this" for the case that matters most — someone else typing your address.
 */
export const recoveryEmail = (url, name) => ({
  subject: 'Sign in to Workset',
  text: `Hi ${name || 'there'},\n\nUse this link to sign in and set up a new passkey:\n${url}\n\n`
    + `It expires in 10 minutes and works once.\n\n`
    + `If you didn't ask for this, you can ignore it — nothing has changed on your account.`,
  html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;line-height:1.55;color:#111">
  <p>Hi ${name || 'there'},</p>
  <p>Use this link to sign in and set up a new passkey:</p>
  <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to Workset</a></p>
  <p style="color:#666;font-size:14px">It expires in 10 minutes and works once.</p>
  <p style="color:#666;font-size:14px">If you didn't ask for this, you can ignore it — nothing has changed on your account.</p>
</div>`,
})
