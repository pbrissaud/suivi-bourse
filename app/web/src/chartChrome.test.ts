/**
 * **A chart's chrome comes from the tokens, and it is measured** (#841,
 * ADR-0023).
 *
 * Recharts has a theme of its own and it is not ours: a `CartesianGrid` with no
 * `stroke` is painted `#ccc`, an axis with no `stroke` is painted `#666`, and
 * those two greys are the same on both grounds. That is the failure this file
 * exists for, and it is not a light-ground defect — it is a chart that has no
 * ground at all. `PriceChart` had it: the grid stood at 11,6:1 against its
 * surface on midnight, ten times the dashboard's 1,2:1, so a scale drawn as
 * chrome read as data over the one curve it serves; the gradations stood at
 * 3,24:1, under the floor.
 *
 * Three claims, and each is asked of a **measurement** or of the **source**,
 * never of a name:
 *
 *  - **Nothing is left implicit.** Every grid and every axis the front mounts
 *    either says its colour or is hidden — the guard that makes *one chart was
 *    fixed* into *no chart escapes*, which is what #841 asked for after #837
 *    found this one by hand and could not have found a second.
 *  - **The gradations are text**, so they clear WCAG's 4,5:1 against the
 *    surface they are drawn on, on both grounds. The token is read off the
 *    component and its value off `index.css`: nothing here is a copy of either.
 *  - **The grid is chrome wherever it hangs.** One token for both charts, and
 *    both of them under the 3:1 that a mark *carrying meaning* would have to
 *    reach — a grid carries none, and the whole defect was it claiming to.
 *
 * The stylesheet is read through `test/stylesheet.ts` for the same reason
 * `themeCut.test.ts` reads it: `index.css` is the only source of a token's
 * value, and a test that pinned a copy would pass while the theme moved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Ground } from '@/lib/alloc'
import { contrast, luminance } from '@/test/oklch'
import { blocks, declarations, oklch, WEB_ROOT } from '@/test/stylesheet'

const SOURCE = path.join(WEB_ROOT, 'src')
const GROUNDS: readonly Ground[] = ['light', 'dark']

/** The two surfaces a block of this product is ever drawn on. */
const SURFACES = ['--background', '--card'] as const

const PRICE_CHART = path.join(SOURCE, 'components', 'shares', 'PriceChart.tsx')
const PORTFOLIO_CHART = path.join(SOURCE, 'components', 'dashboard', 'PortfolioChart.tsx')

/**
 * Every `.tsx` the product writes by hand.
 *
 * `ui/` is out, and for `gridColumns.test.ts`'s reason rather than a new one:
 * it is generated from the registry (ADR-0023) and a rule enforced there would
 * be undone by the next `add`. Nothing under it mounts a chart today.
 */
function sources(directory: string = SOURCE): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'ui' || entry.name === 'test' ? [] : sources(full)
    if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) return []
    return [full]
  })
}

/**
 * The file with its comments taken out.
 *
 * The prose in this repository is long, it is full of `<`, and every rule below
 * scans for a tag: read raw, a paragraph explaining `<XAxis>` would be scanned
 * as one. Only whole-line `//` comments go, because `https://` is not one.
 */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}

/** From `{` at `from`, the span it closes — quotes and nesting respected. */
function balanced(text: string, from: number): string {
  let depth = 0
  let quote: string | null = null
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, at + 1)
    }
  }
  return text.slice(from)
}

/**
 * Every opening tag of one element, whole.
 *
 * Whole is the difficult half: `tickFormatter={(value: number) => …}` holds a
 * `>` that does not end the tag, so the scan counts braces rather than stopping
 * at the first angle bracket. A shallow reader that got this wrong would read
 * half a tag and report a colour missing that is written two lines down.
 */
function openingTags(source: string, element: string): string[] {
  const found: string[] = []
  for (const start of source.matchAll(new RegExp(`<${element}(?=[\\s/>])`, 'g'))) {
    const from = start.index ?? 0
    let depth = 0
    let quote: string | null = null
    for (let at = from; at < source.length; at += 1) {
      const char = source[at]
      if (quote) {
        if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) {
        found.push(source.slice(from, at + 1))
        break
      }
    }
  }
  return found
}

/** One prop as written — `''` for a bare flag, `null` where it is not there. */
function prop(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  if (quoted) return quoted[1]
  const braced = new RegExp(`\\s${name}=\\{`).exec(tag)
  if (braced) return balanced(tag, braced.index + braced[0].length - 1)
  return new RegExp(`\\s${name}(?=[\\s/>])`).test(tag) ? '' : null
}

/**
 * The custom property a fragment paints from, or `null`.
 *
 * `--color-x` is the `@theme inline` bridge's name for `--x` and carries its
 * value verbatim, so the two spellings resolve to one token: the front writes
 * both (`var(--border)` on the dashboard's grid, `var(--color-price)` on its
 * curve) and neither is more correct than the other.
 */
function token(fragment: string | null): string | null {
  const found = fragment == null ? null : /var\((--[\w-]+)\)/.exec(fragment)
  if (!found) return null
  return found[1].startsWith('--color-') ? `--${found[1].slice('--color-'.length)}` : found[1]
}

/** A token's `oklch()` on one ground, whichever block of `index.css` says it. */
function painted(name: string, ground: Ground): number {
  for (const block of blocks()) {
    const value = declarations(block, ground).get(name)
    if (value) {
      const { lightness, chroma, hue } = oklch(value)
      return luminance(lightness, chroma, hue)
    }
  }
  throw new Error(`no ${name} declared for the ${ground} theme`)
}

/** What one mark is worth against one surface, on one ground. */
function ratio(mark: string, surface: string, ground: Ground): number {
  return contrast(painted(mark, ground), painted(surface, ground))
}

/** The token a chart draws its grid from, read off the chart itself. */
function gridToken(file: string): string | null {
  const [tag] = openingTags(code(file), 'CartesianGrid')
  return tag ? token(prop(tag, 'stroke')) : null
}

/** The token a chart writes its gradations in, read off the chart itself. */
function tickToken(file: string): string | null {
  const source = code(file)
  const tags = [...openingTags(source, 'XAxis'), ...openingTags(source, 'YAxis')]
  const drawn = tags.filter((tag) => prop(tag, 'hide') === null)
  const tokens = new Set(drawn.map((tag) => token(prop(tag, 'tick'))))
  return tokens.size === 1 ? [...tokens][0] : null
}

/** The surface a `ui/` primitive draws, taken from the class it carries. */
function surfaceOf(primitive: string): string | null {
  const source = fs.readFileSync(path.join(SOURCE, 'components', 'ui', primitive), 'utf8')
  const found = /(?<![\w-])bg-(background|card)\b/.exec(source)
  return found ? `--${found[1]}` : null
}

describe('nothing is left to Recharts’ own greys', () => {
  /**
   * A grid says its stroke; an axis says its stroke **and** the fill of its
   * gradations, or is hidden and paints nothing at all. The two are separate
   * props on purpose: Recharts fills a tick label with the axis' own `stroke`,
   * so one token for both would either shout the grid or hide the figures —
   * which is why *take the dashboard's line and paste it* was the wrong repair.
   */
  const offenders: string[] = []
  let scanned = 0

  for (const file of sources()) {
    const source = code(file)
    const relative = path.relative(WEB_ROOT, file)
    for (const tag of openingTags(source, 'CartesianGrid')) {
      scanned += 1
      if (!token(prop(tag, 'stroke'))) offenders.push(`${relative} — a grid with no stroke`)
    }
    for (const element of ['XAxis', 'YAxis']) {
      for (const tag of openingTags(source, element)) {
        scanned += 1
        if (prop(tag, 'hide') !== null) continue
        if (!token(prop(tag, 'stroke'))) offenders.push(`${relative} — ${element} with no stroke`)
        // `tick={false}` draws no label, so there is nothing to colour.
        const tick = prop(tag, 'tick')
        if (tick !== '{false}' && !token(tick)) {
          offenders.push(`${relative} — ${element} with no tick colour`)
        }
      }
    }
    for (const tag of openingTags(source, 'Tooltip')) {
      scanned += 1
      // The cursor is the band Recharts drags under the pointer, and its
      // default paints over the very marks it is helping read.
      if (!token(prop(tag, 'cursor'))) offenders.push(`${relative} — a tooltip with no cursor`)
    }
  }

  it('mounts no grid, axis or cursor without a token of its own', () => {
    expect(offenders).toEqual([])
  })

  it('is reading the tags it is supposed to be reading', () => {
    // The coverage half, in `gridColumns.test.ts`'s taste: a scan that stopped
    // matching would pass on a front that had lost the rule entirely.
    expect(scanned).toBeGreaterThan(5)
  })
})

describe('the gradations are text, and text has a floor', () => {
  it('clears 4,5:1 against both surfaces, on both grounds', () => {
    const tick = tickToken(PRICE_CHART)
    expect(tick, 'the sheet’s chart states one colour for its gradations').not.toBeNull()

    // Against **both** surfaces rather than against the one the sheet happens
    // to use today: the chart is a block, a block is moved onto a card sooner
    // or later, and a floor that held only where it was first mounted would be
    // a measurement with a shelf life. `--muted-foreground` clears it on all
    // four, which is what makes that the token to take rather than a value to
    // invent.
    for (const ground of GROUNDS) {
      for (const surface of SURFACES) {
        expect(
          ratio(tick!, surface, ground),
          `the ${ground} gradations are under the floor on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('a grid is not more legible for being elsewhere', () => {
  it('draws the sheet’s chart and the dashboard’s from one token', () => {
    const sheet = gridToken(PRICE_CHART)
    expect(sheet).not.toBeNull()
    expect(sheet).toBe(gridToken(PORTFOLIO_CHART))
  })

  it('keeps both under the 3:1 a mark that carried meaning would have to reach', () => {
    // 3:1 is WCAG's floor for a **non-text mark that carries information**, and
    // a grid carries none: it is a ground for the eye to rest a level on. So
    // the figure is used as a ceiling rather than as a target — the defect was
    // exactly a grid reaching well past what a real mark must reach, at 11,6:1
    // on midnight, and reading as data because of it.
    const grid = gridToken(PRICE_CHART)!
    for (const ground of GROUNDS) {
      for (const surface of SURFACES) {
        expect(ratio(grid, surface, ground), `the ${ground} grid on ${surface}`).toBeLessThan(3)
      }
    }
  })

  it('reads each chart’s own surface off the primitive that draws it', () => {
    // Not an assumption: the sheet is `bg-background` and the card is `bg-card`
    // in the two primitives, and this is what the comparison below stands on.
    expect(surfaceOf('sheet.tsx')).toBe('--background')
    expect(surfaceOf('card.tsx')).toBe('--card')
  })

  it('leaves the two within a step of each other against their own surfaces', () => {
    // One token cannot make two ratios identical — the sheet is the page's
    // ground and the dashboard's chart is on a card, and the two are one step
    // apart by construction. What the criterion asks is that the step be that
    // and nothing more, so a reader cannot tell a grid's *place* from how loud
    // it is: measured, 1,257 against 1,197 on midnight and 1,274 against 1,354
    // on white.
    const grid = gridToken(PRICE_CHART)!
    for (const ground of GROUNDS) {
      const sheet = ratio(grid, surfaceOf('sheet.tsx')!, ground)
      const card = ratio(grid, surfaceOf('card.tsx')!, ground)
      expect(Math.abs(sheet - card), `the two grids part company on the ${ground} ground`).toBeLessThan(0.25)
    }
  })
})
