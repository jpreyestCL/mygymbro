// Test setup: guarantee a usable `localStorage`.
//
// Node 26 ships its own `localStorage` global that is *unavailable* unless the process was
// started with `--localstorage-file`. Reading it throws rather than returning undefined, and
// because it is defined on globalThis, the DOM environment (happy-dom) does not replace it. The
// result is that any test importing store/useStore.js — which reads localStorage at module
// scope — dies before the first assertion, with an error that says nothing about Node's flag.
//
// So: if the runtime cannot give us a working one, install an in-memory stand-in. Tests want
// isolation from the developer's real browser storage anyway, which is exactly what this is.
const usable = () => {
  try {
    const probe = '__probe__'
    globalThis.localStorage.setItem(probe, '1')
    globalThis.localStorage.removeItem(probe)
    return true
  } catch { return false }
}

if (!usable()) {
  const memory = new Map()
  const store = {
    getItem: k => (memory.has(String(k)) ? memory.get(String(k)) : null),
    setItem: (k, v) => { memory.set(String(k), String(v)) },
    removeItem: k => { memory.delete(String(k)) },
    clear: () => { memory.clear() },
    key: i => [...memory.keys()][i] ?? null,
    get length() { return memory.size },
  }
  // configurable so a later environment (or another setup file) can still replace it.
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: store, configurable: true, writable: true })
  }
}
