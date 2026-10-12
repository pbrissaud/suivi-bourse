/**
 * **The hero value, recomposing from the old figure to the new one** (#1180,
 * DESIGN.md › Motion): the one authored movement, now with two triggers — a
 * merged proposal and a refreshed value.
 *
 * It takes a number and a currency, never a string: every frame is formatted
 * like the final figure, so the movement goes through real amounts. Nothing
 * moves on the first render, on a currency change, under
 * `prefers-reduced-motion`, or for a change under {@link RECOMPOSE_THRESHOLD} —
 * the hero shows cents, so a figure that moved whenever its string changed
 * would move almost every minute of a trading day.
 *
 * No sign colour while it moves: a value is not a direction. The frames are
 * `aria-hidden` and the final value is said once, in an `sr-only` span.
 */
import { useLayoutEffect, useRef, useState } from 'react'

import { useFormatters } from '@/lib/format'

/** The share of the old value a change has to reach to be animated: 0,1 %. */
export const RECOMPOSE_THRESHOLD = 0.001
const DURATION_MS = 250

export function shouldRecompose(from: number | null, to: number | null): boolean {
  if (from === null || to === null || from === to) return false
  return Math.abs(to - from) >= RECOMPOSE_THRESHOLD * Math.abs(from)
}

export function RecomposingFigure({
  value,
  currency,
}: {
  value: number | null
  currency: string | null
}) {
  const f = useFormatters()
  const [shown, setShown] = useState(value)
  // What is on screen, so a value that lands mid-movement starts from there.
  const drawn = useRef(value)
  const target = useRef({ value, currency })

  // A layout effect, so an instant change is never painted one frame late —
  // nor an old amount under a new currency's symbol.
  useLayoutEffect(() => {
    const previous = target.current
    target.current = { value, currency }
    const show = (figure: number | null) => {
      drawn.current = figure
      setShown(figure)
    }
    if (
      previous.currency !== currency ||
      !shouldRecompose(previous.value, value) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      show(value)
      return
    }
    const from = drawn.current ?? (previous.value as number)
    const to = value as number
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      // A frame's timestamp can precede `start`: never run backwards.
      const progress = Math.min(Math.max((now - start) / DURATION_MS, 0), 1)
      // ease-out (cubic), DESIGN.md's curve for what arrives.
      show(from + (to - from) * (1 - (1 - progress) ** 3))
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [value, currency])

  return (
    <>
      <span aria-hidden>{f.currency(shown, currency)}</span>
      <span className="sr-only">{f.currency(value, currency)}</span>
    </>
  )
}
