/**
 * The hero's recomposition (#1180): the one authored movement, driven frame by
 * frame with faked animation frames.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RECOMPOSE_THRESHOLD,
  RecomposingFigure,
  shouldRecompose,
} from '@/components/RecomposingFigure'
import { formatCurrency } from '@/lib/format'
import { I18nProvider } from '@/lib/i18n'

const eur = (value: number) => formatCurrency('en-US', value, 'EUR')

function mount(value: number | null, currency: string | null = 'EUR') {
  const ui = (v: number | null, c: string | null) => (
    <I18nProvider>
      <RecomposingFigure value={v} currency={c} />
    </I18nProvider>
  )
  const { container, rerender } = render(ui(value, currency))
  const [shown, said] = container.querySelectorAll('span')
  return {
    shown: () => shown.textContent,
    said: () => said.textContent,
    update: (v: number | null, c: string | null = currency) => rerender(ui(v, c)),
  }
}

const frames = (count: number) => act(() => vi.advanceTimersByTime(16 * count))

beforeEach(() => {
  Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['en-US'] })
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})
afterEach(() => vi.useRealTimers())

describe('the hero recomposes a refreshed value', () => {
  it('does not move on the first render', () => {
    const figure = mount(2800)
    expect(figure.shown()).toBe(eur(2800))
    expect(figure.said()).toBe(eur(2800))
  })

  it('goes through the amounts between the two, then lands on the new one', () => {
    const figure = mount(2800)
    figure.update(3000)
    // The reader is told the final value at once; only the drawing moves.
    expect(figure.said()).toBe(eur(3000))
    frames(4)
    const midway = Number(figure.shown()?.replace(/[^\d.]/g, ''))
    expect(midway).toBeGreaterThan(2800)
    expect(midway).toBeLessThan(3000)
    frames(20)
    expect(figure.shown()).toBe(eur(3000))
  })

  it('changes at once under the threshold, so the cents do not twitch', () => {
    const figure = mount(2800)
    figure.update(2801) // 0,036 %
    expect(figure.shown()).toBe(eur(2801))
  })

  it('changes at once on a currency change, under reduced motion, and to a dash', () => {
    const figure = mount(2800)
    figure.update(3000, 'USD')
    expect(figure.shown()).toMatch(/\$3,000\.00/)

    const matchMedia = window.matchMedia
    window.matchMedia = (query: string) =>
      ({ ...matchMedia(query), matches: query.includes('reduced-motion') }) as MediaQueryList
    try {
      figure.update(4000, 'USD')
      expect(figure.shown()).toMatch(/\$4,000\.00/)
    } finally {
      window.matchMedia = matchMedia
    }

    figure.update(null, 'USD')
    expect(figure.shown()).toBe('—')
    expect(figure.said()).toBe('—')
  })

  it('draws the line at 0,1 % of the old value', () => {
    expect(RECOMPOSE_THRESHOLD).toBe(0.001)
    expect(shouldRecompose(2800, 2802.8)).toBe(true)
    expect(shouldRecompose(2800, 2802.79)).toBe(false)
    expect(shouldRecompose(2800, 2797.2)).toBe(true)
    expect(shouldRecompose(null, 2800)).toBe(false)
    expect(shouldRecompose(2800, null)).toBe(false)
  })
})
