/**
 * Where the reader's three preferences live — the theme and the language from
 * ADR-0024, the density since #789 — and the two ways a browser can refuse to
 * keep them.
 *
 * Web Storage is not guaranteed: a privacy mode can make `localStorage` throw on
 * access or on write, and an embedding without it simply has none. Neither is
 * worth a white screen over a theme, so both degrade to *not remembered*: the
 * reader still chooses, the choice still applies, it just does not survive the
 * tab. The readers already treat absence as `auto`, so nothing else has to know.
 */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export function rememberPreference(key: string, value: string) {
  try {
    browserStorage()?.setItem(key, value)
  } catch {
    // A full or refused quota is not a reason to stop applying the choice.
  }
}
