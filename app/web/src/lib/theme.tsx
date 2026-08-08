/**
 * The theme, as one of the reader's **two** preferences (ADR-0024).
 *
 * Three states — `light | dark | auto`, absence meaning `auto` — stored in the
 * browser and never in the store. The language wears the same shape in
 * `lib/i18n.tsx`, and that is the point: two reader preferences, one mechanism.
 * The store stays purely about the engine (ADR-0014) and the app still asks
 * exactly **one** question at first run (ADR-0021).
 *
 * `.dark` was declared in the prototype's stylesheet and **nothing ever set
 * it** — no toggle, no `localStorage`, no `prefers-color-scheme`. This module is
 * the missing half.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { allocationRamp, allocationTokenNames, type Ground } from '@/lib/alloc'
import { browserStorage, rememberPreference } from '@/lib/storage'

export type ThemeChoice = 'light' | 'dark' | 'auto'

/** Same shape as the language key, deliberately. */
export const THEME_STORAGE_KEY = 'sb.theme'

const CHOICES: ThemeChoice[] = ['light', 'dark', 'auto']

/** Absence — and anything unrecognised — means `auto`. */
export function readThemeChoice(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeChoice {
  const stored = storage?.getItem(THEME_STORAGE_KEY)
  return CHOICES.find((choice) => choice === stored) ?? 'auto'
}

/** Pure: what the reader chose, plus what the system says, gives the ground. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Ground {
  if (choice === 'auto') return prefersDark ? 'dark' : 'light'
  return choice
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  choice: ThemeChoice
  ground: Ground
  setChoice: (choice: ThemeChoice) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice(browserStorage()))
  const [prefersDark, setPrefersDark] = useState<boolean>(
    () => window.matchMedia?.(DARK_QUERY).matches ?? false,
  )

  // `auto` is a subscription, not a read: a reader who never touched the
  // control must follow the system when it flips at dusk.
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY)
    if (!media) return
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const ground = resolveTheme(choice, prefersDark)

  useEffect(() => {
    applyGround(document.documentElement, ground)
  }, [ground])

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    rememberPreference(THEME_STORAGE_KEY, next)
  }, [])

  const value = useMemo(() => ({ choice, ground, setChoice }), [choice, ground, setChoice])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Put the ground on the element: the class the stylesheet keys on, the
 * `color-scheme` native widgets read, and the twelve allocation stops — which
 * are generated rather than declared precisely because their *direction*
 * depends on the ground (ADR-0023).
 */
export function applyGround(element: HTMLElement, ground: Ground) {
  element.classList.toggle('dark', ground === 'dark')
  element.style.colorScheme = ground
  const ramp = allocationRamp(ground)
  allocationTokenNames().forEach((name, index) => {
    element.style.setProperty(name, ramp[index])
  })
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme outside ThemeProvider')
  return value
}
