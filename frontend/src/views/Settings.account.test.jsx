import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Settings is the only route that can render for somebody who is NOT signed in, which makes its
// account section the one place a guest can be stranded: in the native app passkeys cannot work,
// so without a sign-out row there is no account to leave and no entrance to reach — the screen
// becomes a dead end. It shipped that way once, and then shipped again crashing outright, because
// nothing rendered this component in a test. These are smoke tests in the literal sense: they
// assert the screen comes up at all, in each of the states a person can actually be in.

const mocks = vi.hoisted(() => ({
  user: null,
  guest: false,
  mobile: false,
  providers: [],
  config: { social: [] },
}))

vi.mock('../store/useStore.js', () => {
  const state = {
    S: { unit: 'kg', lang: 'en', accent: 'blue', effort: 'rir', rest: 90, tz: 'UTC' },
    get user() { return mocks.user },
    update: () => {}, replaceState: () => {}, setUser: () => {},
    pullState: async () => {}, pushState: async () => {},
    signOut: () => {}, signOutAll: async () => {}, resetDemo: () => {},
    setGuest: () => {},
    isGuest: () => mocks.guest,
    get config() { return mocks.config },
    loadConfig: async () => mocks.config,
  }
  return {
    useStore: Object.assign(
      selector => (selector ? selector(state) : state),
      { getState: () => state },
    ),
    DEF: {}, hasData: () => false,
  }
})
vi.mock('../store/useUI.js', () => {
  const ui = { toast: () => {}, openSheet: () => {} }
  return { useUI: Object.assign(sel => (sel ? sel(ui) : ui), { getState: () => ui }) }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: async () => ({}), webauthnOK: () => true,
  passkeyLogin: async () => ({}), passkeyRegister: async () => ({}), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({
  pushSupported: () => false, enablePush: async () => {}, disablePush: async () => {}, sendTestPush: async () => {},
}))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/native.js', () => ({ healthAvailable: async () => false }))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.test' }))
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.mobile },
  shareExport: async () => {}, syncReminder: async () => {},
}))
vi.mock('../lib/social.js', () => ({
  socialLogin: async () => ({}),
  socialProviders: () => mocks.providers,
}))
vi.mock('../sheets.jsx', () => ({
  loadStarterPlan: () => {}, confirmSheet: () => {}, importFromApp: () => {},
  recoveryEmailSheet: () => {}, healthSheet: () => {},
}))
vi.mock('../components/Icon.jsx', () => ({ default: props => React.createElement('span', props) }))

const { default: Settings } = await import('./Settings.jsx')

let dom, root, container

beforeEach(() => {
  dom = new Window()
  global.window = dom
  global.document = dom.document
  container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  mocks.user = null
  mocks.guest = false
  mocks.mobile = false
  mocks.providers = []
  mocks.config = { social: [] }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

const render = () => {
  root = createRoot(container)
  act(() => root.render(React.createElement(Settings)))
  return container.textContent
}

describe('the Settings account section', () => {
  // The regression that shipped: a useEffect whose dependency array named a `const` declared
  // further down threw on render, so the whole screen came up as "Something went wrong".
  it('renders for a signed-out visitor on the web', () => {
    expect(() => render()).not.toThrow()
  })

  it('renders for a guest in the native app', () => {
    mocks.mobile = true
    mocks.guest = true
    mocks.providers = ['apple', 'google']
    expect(() => render()).not.toThrow()
  })

  it('renders for a signed-in user', () => {
    mocks.user = { id: 'u1', name: 'Ada', email: 'ada@example.test', needsRecovery: false }
    expect(() => render()).not.toThrow()
  })

  // The dead end itself: a guest with no way back to the sign-in screen.
  it('offers a guest a way to sign out', () => {
    mocks.guest = true
    expect(render()).toContain('Sign out')
  })

  it('offers the providers the platform can serve', () => {
    mocks.guest = true
    mocks.mobile = true
    mocks.providers = ['apple', 'google']
    const text = render()
    expect(text).toContain('Continue with Apple')
    expect(text).toContain('Continue with Google')
  })

  // Passkeys cannot work inside the WebView, so offering them there sends people at a door that
  // never opens — the whole reason sign-in moved to Apple and Google in the app.
  it('hides the passkey rows in the native app', () => {
    mocks.guest = true
    mocks.mobile = true
    mocks.providers = ['apple']
    expect(render()).not.toContain('Sign in with passkey')
  })

  it('keeps the passkey rows on the web', () => {
    expect(render()).toContain('Sign in with passkey')
  })

  // A signed-in person is not a guest, so the guest exit must not appear beside the real one.
  it('does not offer the guest exit to a signed-in user', () => {
    mocks.user = { id: 'u1', name: 'Ada', needsRecovery: false }
    mocks.guest = true
    expect(render()).not.toContain('Guest mode')
  })
})
