/**
 * The table density, as the reader's **third** preference (#789).
 *
 * ADR-0024 decided two and says two, which is not a defect to repair: a record
 * is dated, and the count is carried by `app/web/CLAUDE.md` rather than by an
 * amendment rewriting what was decided about the language and the theme.
 *
 * The same mechanism as those two, and deliberately so: one
 * `localStorage` key of the same shape, absence meaning the default, and **no
 * dial in the store** — a density is a property of the reader, and the store
 * stays purely about the engine (ADR-0014).
 *
 * It is the one of the three with **two** states rather than three: `auto`
 * exists for the theme because the system answers `prefers-color-scheme`, and
 * for the language because the browser sends `Accept-Language`. Nothing
 * anywhere answers *how tight do you like a table*, so there is nothing for an
 * automatic state to read, and a third state that resolved to a constant would
 * be a control lying about having consulted something.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { browserStorage, rememberPreference } from '@/lib/storage'

export type DensityChoice = 'comfortable' | 'compact'

/** Same shape as the theme and language keys, deliberately. */
export const DENSITY_STORAGE_KEY = 'sb.density'

const CHOICES: DensityChoice[] = ['comfortable', 'compact']

/** Absence — and anything unrecognised — means the roomier of the two. */
export function readDensityChoice(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): DensityChoice {
  const stored = storage?.getItem(DENSITY_STORAGE_KEY)
  return CHOICES.find((choice) => choice === stored) ?? 'comfortable'
}

interface DensityContextValue {
  choice: DensityChoice
  setChoice: (choice: DensityChoice) => void
}

const DensityContext = createContext<DensityContextValue | null>(null)

export function DensityProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<DensityChoice>(() => readDensityChoice(browserStorage()))

  const setChoice = useCallback((next: DensityChoice) => {
    setChoiceState(next)
    rememberPreference(DENSITY_STORAGE_KEY, next)
  }, [])

  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice])
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
}

/**
 * The choice in force. It answers `comfortable` with no provider above it,
 * because the only consumer is a table primitive: a table rendered outside the
 * app is a table at its default spacing, not a crash.
 */
export function useDensity(): DensityChoice {
  return useContext(DensityContext)?.choice ?? 'comfortable'
}

export function useDensityControl(): DensityContextValue {
  const value = useContext(DensityContext)
  if (!value) throw new Error('useDensityControl outside DensityProvider')
  return value
}
