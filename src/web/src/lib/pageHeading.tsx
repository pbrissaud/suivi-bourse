/**
 * Where a page says its name, now that the name is the **shell's** to draw
 * (#789, ADR-0022).
 *
 * Each page used to open with an `<h1>` of its own, under a header bar that
 * carried the collapse trigger and the three controls and said nothing about
 * where the reader was. Moving the title up is what makes the bar an object of
 * the product rather than a mount for a trigger — and it costs nothing in
 * accessibility, because the heading that moved is still a heading, still
 * level 1, and still names the page it is standing on.
 *
 * The subtitle rides with it and is **not** static: what the dashboard and the
 * shares page say under their name is the instant their figures are of, which
 * only a read can tell them. So the page declares both, the shell draws both,
 * and a page with nothing to add declares a title alone — which clears the
 * previous page's subtitle rather than inheriting it.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'

export interface PageHeading {
  title: string
  subtitle: string | null
}

/** Nothing declared: the bar draws no heading at all rather than a stale one. */
const NOTHING: PageHeading = { title: '', subtitle: null }

const HeadingContext = createContext<PageHeading>(NOTHING)
const DeclareContext = createContext<Dispatch<SetStateAction<PageHeading>> | null>(null)

export function PageHeadingProvider({ children }: { children: ReactNode }) {
  const [heading, setHeading] = useState<PageHeading>(NOTHING)
  return (
    <DeclareContext.Provider value={setHeading}>
      <HeadingContext.Provider value={heading}>{children}</HeadingContext.Provider>
    </DeclareContext.Provider>
  )
}

/**
 * A page declaring what the header says while it is mounted.
 *
 * Two details of the mechanism are decisions, and both are about the bar
 * telling the truth rather than about when it is convenient to write:
 *
 *  - **it declares in a layout effect**, so the name arrives in the same commit
 *    as the page it names. A passive effect runs after the paint, which is one
 *    frame of the bar naming the page the reader has just left — and dating it
 *    with that page's quote instant, which is worse than the name;
 *  - **it clears on unmount, but only its own declaration.** The doc this
 *    replaces refused a cleanup because it would race the next route's; a
 *    cleanup guarded on *is this still mine* cannot, and it is what keeps a
 *    slot that never declares — a route's `errorComponent`, say — from
 *    inheriting the last page's title and asserting it over a stack trace.
 */
export function usePageHeading(title: string, subtitle?: string | null) {
  const declare = useContext(DeclareContext)
  const next = useMemo(() => ({ title, subtitle: subtitle ?? null }), [title, subtitle])
  useLayoutEffect(() => {
    declare?.(next)
    return () => declare?.((current) => (current === next ? NOTHING : current))
  }, [declare, next])
}

export function usePageHeadingValue(): PageHeading {
  return useContext(HeadingContext)
}
