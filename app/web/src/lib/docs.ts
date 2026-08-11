/**
 * The one door this front has to the outside (ADR-0016, ADR-0025).
 *
 * Every convention bubble ends in a link, and the link carries **version and
 * locale**. Both halves are load-bearing:
 *
 *  - **the version**, frozen at the major, because `/docs` means *latest*: a
 *    link a v5 install emits would serve v6's page the day v6 ships — not a
 *    stale page, a *correct page about another product*, reached from an app
 *    that had just promised to explain its own numbers;
 *  - **the locale**, absent for English (the default locale sits at the bare
 *    root) and `fr/` otherwise, because a French reader sent to the English
 *    rule has been told the rule exists and not what it is.
 *
 * The anchors are a **contract with the website**, written by hand on every
 * heading of `website/docs/read-your-figures.mdx` and never derived from the
 * heading text — reword a title and a derived anchor moves with it, the front
 * sees nothing, the site still builds, and every bubble lands the reader at the
 * top of the page instead of at the rule they clicked for. That is the one
 * failure a broken-link check cannot catch, so the list lives here too.
 */
import type { Language } from '@/lib/i18n'

const DOCS_ORIGIN = 'https://pbrissaud.github.io/suivi-bourse'

/** Frozen at the **major**: a 5.1 install still reads `/docs/v5`. */
export const DOCS_VERSION = 'v5'

/**
 * **One page** — never one page per figure (ADR-0016). The count is descriptive
 * and the rule is not: a figure that earns a bubble earns a heading on that same
 * page, and the list grows with it. `net-contributed` is the first to arrive
 * that way — its bubble pointed at `deposit-fees`, where the *second* half of
 * its sentence lands and the first half has no home, so a reader asking what
 * *Net contributed* means arrived at a section titled *Fees taken from your
 * transfers*.
 */
export const DOCS_PAGE = 'read-your-figures'

export const DOCS_ANCHORS = [
  'avg-cost',
  'total-gain',
  'latent-gain',
  'realized-gain',
  'dividends',
  'net-contributed',
  'deposit-fees',
  'twr',
  'xirr',
  'carrying-price',
  'absence',
] as const

export type DocsAnchor = (typeof DOCS_ANCHORS)[number]

export function docsHref(language: Language, anchor: DocsAnchor): string {
  // English is the site's default locale and therefore has **no** segment.
  const locale = language === 'en' ? '' : `${language}/`
  return `${DOCS_ORIGIN}/${locale}docs/${DOCS_VERSION}/${DOCS_PAGE}#${anchor}`
}
