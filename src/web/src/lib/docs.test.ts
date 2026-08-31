/**
 * The link contract (ADR-0016, ADR-0025). It is one string, and both of its
 * moving parts are the kind that fails silently.
 */
import { describe, expect, it } from 'vitest'

import { DOCS_ANCHORS, docsHref } from '@/lib/docs'

describe('the documentation link', () => {
  it('carries the version, frozen at the major', () => {
    // Without the version segment `/docs` means *latest*, so this link would
    // serve v6's page the day v6 ships — not a stale page, a correct page about
    // another product, reached from an app that promised to explain itself.
    expect(docsHref('en', 'total-gain')).toBe(
      'https://pbrissaud.github.io/suivi-bourse/docs/v5/read-your-figures#total-gain',
    )
  })

  it('carries the locale, and English has none because it is the default', () => {
    expect(docsHref('fr', 'total-gain')).toBe(
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('names one page whatever the count of anchors, never one page per figure', () => {
    // The rule is **one page**, and the count is descriptive: a figure that
    // earns a bubble earns a heading there, and the list grows with it. What
    // must not drift is the page, so that is what is asserted.
    for (const anchor of DOCS_ANCHORS) {
      expect(docsHref('fr', anchor)).toContain('/docs/v5/read-your-figures#')
    }
    expect(new Set(DOCS_ANCHORS).size).toBe(DOCS_ANCHORS.length)
  })
})
