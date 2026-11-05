import { act } from '@testing-library/react'

/**
 * jsdom has no `IntersectionObserver`, and the ledger reveals its rows when the
 * last one scrolls into view. This stand-in records what is watched so a test
 * can say *the reader scrolled to the end* with `reachTheEnd()`.
 */
export class StubIntersectionObserver {
  static live = new Set<StubIntersectionObserver>()
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds = []
  private targets = new Set<Element>()
  private callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.targets.add(target)
    StubIntersectionObserver.live.add(this)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    StubIntersectionObserver.live.delete(this)
  }
  takeRecords() {
    return []
  }

  enter() {
    const entries = [...this.targets].map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    )
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

/** Every watched element comes into view at once — one scroll to the bottom. */
export function reachTheEnd() {
  act(() => {
    for (const observer of [...StubIntersectionObserver.live]) observer.enter()
  })
}
