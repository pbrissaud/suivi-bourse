/**
 * `matchMedia`, which jsdom does not implement — and which two things the shell
 * depends on read: the theme's `prefers-color-scheme` and shadcn's mobile
 * breakpoint. A stub that always answered `false` would make `auto` untestable,
 * so this one is **controllable**: `setPrefersDark(true)` flips the answer *and*
 * notifies the listeners, which is what a reader's system does at dusk.
 */
type Listener = (event: MediaQueryListEvent) => void

const listeners = new Map<string, Set<Listener>>()
let prefersDark = false

export function installMatchMedia() {
  prefersDark = false
  listeners.clear()
  window.matchMedia = (query: string): MediaQueryList => {
    const set = listeners.get(query) ?? new Set<Listener>()
    listeners.set(query, set)
    const list: MediaQueryList = {
      media: query,
      get matches() {
        return query.includes('prefers-color-scheme: dark') ? prefersDark : false
      },
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => set.add(listener),
      removeEventListener: (_type: string, listener: Listener) => set.delete(listener),
      addListener: (listener: Listener) => set.add(listener),
      removeListener: (listener: Listener) => set.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList
    return list
  }
}

/** Flip the system preference, listeners included. */
export function setPrefersDark(value: boolean) {
  prefersDark = value
  for (const [query, set] of listeners) {
    if (!query.includes('prefers-color-scheme: dark')) continue
    for (const listener of set) {
      listener({ matches: value, media: query } as MediaQueryListEvent)
    }
  }
}
