// The two native capabilities the web version cannot have, behind one guard each.
//
// Both are optional everywhere: on the web, on Android, on an iPhone where the user said no.
// Nothing here throws into the app — a missing capability returns a falsy result and the
// caller carries on with the in-app behaviour it already had. That is deliberate: the same
// bundle runs as a PWA, a sideloaded app and an App Store app, and only the last one has any
// of this.

import { MOBILE } from './mobile.js'

const plugin = name => {
  if (!MOBILE) return null
  const p = globalThis.Capacitor?.Plugins?.[name]
  return p || null
}

/* ------------------------------------------------------------------ Health -- */

export const healthPlugin = () => plugin('Health')

export async function healthAvailable() {
  const h = healthPlugin()
  if (!h) return false
  try { return !!(await h.isAvailable()).available } catch { return false }
}

export async function healthAuthorize() {
  const h = healthPlugin()
  if (!h) return false
  try { return !!(await h.requestAuthorization()).granted } catch { return false }
}

/**
 * Body-weight samples from Health, newest first, as the app's own shape.
 *
 * HealthKit never says whether READ access was granted — that would leak the existence of
 * data the user chose to withhold — so an empty list is a normal answer, not an error, and
 * callers must not report it as a failure.
 */
export async function healthReadWeights({ since } = {}) {
  const h = healthPlugin()
  if (!h) return []
  try {
    const { samples } = await h.readBodyWeight({ since, limit: 400 })
    return (samples || []).map(s => ({ d: s.date.slice(0, 10), kg: s.kg, t: Date.parse(s.date), source: s.source }))
  } catch { return [] }
}

export async function healthWriteWeight(kg, date) {
  const h = healthPlugin()
  if (!h || !(kg > 0)) return false
  try { return !!(await h.writeBodyWeight({ kg, date })).saved } catch { return false }
}

/* ------------------------------------------------------- rest Live Activity -- */

const restPlugin = () => plugin('RestTimer')

export async function restActivitySupported() {
  const r = restPlugin()
  if (!r) return false
  try { return !!(await r.isSupported()).supported } catch { return false }
}

/**
 * Hand the countdown to the system so it keeps ticking on the Lock Screen with the app
 * suspended. Only the END TIME is sent, never a per-second tick: Live Activities are rate
 * limited, and a timer pushed every second would be throttled into uselessness inside a
 * minute. See RestAttributes.swift.
 */
export function restActivityStart(seconds, info = {}) {
  const r = restPlugin()
  if (!r) return
  r.start({ seconds, ...info }).catch(() => {})
}

export function restActivityUpdate(seconds, info = {}) {
  const r = restPlugin()
  if (!r) return
  r.update({ seconds, ...info }).catch(() => {})
}

export function restActivityStop() {
  const r = restPlugin()
  if (!r) return
  r.stop().catch(() => {})
}
