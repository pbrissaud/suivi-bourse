/**
 * **Every plot is reachable, named, and says its shape** (#1003) — held on the
 * source, because the part that matters most cannot be seen from the outside.
 *
 * Two things make a rendering test insufficient here, and both were measured
 * rather than assumed:
 *
 *  - **Recharts draws nothing under jsdom.** `ResponsiveContainer` measures its
 *    box, finds 0×0 and renders no `<svg>` at all — so the `aria-label` this
 *    contract puts on the chart element never reaches a test's DOM. It is worth
 *    knowing what that cost before: `benchmark.test.tsx` asserted the plot was
 *    hidden with
 *    `expect(document.querySelector('.recharts-wrapper')?.closest('[aria-hidden]')).not.toBeNull()`,
 *    and `.recharts-wrapper` does not exist, so `?.closest()` returned
 *    `undefined` and the assertion passed on nothing for as long as it existed.
 *  - **One chart was fixed** has to become **no chart escapes**, which is
 *    `chartChrome.test.ts`'s own doctrine and the reason this file walks every
 *    source rather than naming four.
 *
 * The contract, in one sentence: *a drawing that only repeats a figure written
 * beside it is `aria-hidden`; a plot that carries its own navigation is named
 * and kept, and its shape is written beside it.* Recharts turns its own
 * `accessibilityLayer` on by default, so every plot here is focusable and its
 * arrow keys walk the series — which is why hiding one leaves a stop in the tab
 * order that announces nothing, and why the exception below has to earn itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = path.join(path.resolve(import.meta.dirname), '.')

/**
 * The one surface whose plot is hidden on purpose, and the reason.
 *
 * The allocation ring mounts **no tooltip at all**, so Recharts' arrow keys have
 * no index to move and a focusable ring answers no key. Its legend beside it
 * already names every slice with its exact percentage, which makes the arcs a
 * repeat of the text — exactly the case `ShareBar`'s rule was written for. An
 * entry here is a claim that both halves hold, and adding one should be as hard
 * as writing its sentence.
 */
const HIDDEN_ON_PURPOSE: Record<string, string> = {
  'components/shares/Allocation.tsx':
    'no tooltip is mounted, so nothing navigates, and the legend is already the whole reading',
  'components/dashboard/HeroChart.tsx':
    'the hero’s sparkline, and the value it draws is written beside it in text — the full chart, reading included, is behind the link under it',
}

/** Every `.tsx` the product writes by hand — `ui/` is the registry's, not ours. */
function sources(directory: string = SOURCE): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'ui' || entry.name === 'test' ? [] : sources(full)
    }
    if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) return []
    return [full]
  })
}

/**
 * The file with its comments taken out.
 *
 * The prose in this repository is long and it quotes the very attributes this
 * file scans for — the paragraph above says `aria-hidden` three times. Read raw,
 * every rule below would be asserted against its own explanation.
 */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
}

/** An opening JSX tag: its name, and the text of its attributes. */
interface Tag {
  name: string
  attrs: string
}

/**
 * The chain of JSX elements **enclosing** the file's `<ResponsiveContainer>`,
 * outermost first.
 *
 * Written because the two questions this file asks are ancestry questions and a
 * regex cannot answer either: *is the plot inside something hidden* accepted a
 * sibling's `aria-hidden` as evidence, and *is it outside everything hidden*
 * could not see an attribute placed above the `<figure>`. Both are now read off
 * the chain.
 *
 * It is a scanner and not a parser, and the one thing it has to get right is
 * where a tag ends: `>` inside `{...}` — an arrow function, a comparison like
 * `points.length > 1` — is not the end of anything, so brace depth and quotes
 * are tracked and only a `>` at depth zero closes a tag. Fragments (`<>`, `</>`)
 * carry no attributes and are skipped on both sides, which leaves the stack
 * balanced.
 */
function ancestry(body: string): Tag[] {
  const stack: Tag[] = []
  let at = 0
  while (at < body.length) {
    const open = body.indexOf('<', at)
    if (open === -1) break
    const rest = body.slice(open)
    const closing = /^<\/([A-Za-z][\w.]*)\s*>/.exec(rest)
    if (closing) {
      stack.pop()
      at = open + closing[0].length
      continue
    }
    const opening = /^<([A-Za-z][\w.]*)/.exec(rest)
    // A generic argument is not a tag. `useState<Reading>` put a `Reading` at the
    // root of `PortfolioChart`'s chain, and `i<n` would read as one too: a real
    // JSX tag is never preceded immediately by an identifier character, a `?`, a
    // `.`, or a closing bracket.
    const before = open === 0 ? '' : body[open - 1]
    if (opening === null || /[\w?.)\]]/.test(before)) {
      at = open + 1
      continue
    }
    let depth = 0
    let quote: string | null = null
    let end = -1
    for (let cursor = open + opening[0].length; cursor < body.length; cursor += 1) {
      const character = body[cursor]
      if (quote !== null) {
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'" || character === '`') quote = character
      else if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      else if (character === '>' && depth === 0) {
        end = cursor
        break
      }
    }
    if (end === -1) break
    const selfClosing = body[end - 1] === '/'
    if (opening[1] === 'ResponsiveContainer') return stack
    if (!selfClosing) {
      stack.push({
        name: opening[1],
        attrs: body.slice(open + opening[0].length, selfClosing ? end - 1 : end),
      })
    }
    at = end + 1
  }
  return stack
}

/**
 * Whether a tag hides its subtree.
 *
 * `aria-hidden` bare or `={true}`; `={false}` hides nothing and must not read as
 * though it did.
 */
function hides(tag: Tag): boolean {
  return /(?:^|\s)aria-hidden(?:\s|$|=\{true\})/.test(tag.attrs)
}

const CHARTS = sources()
  .map((file) => ({ file, rel: path.relative(SOURCE, file), body: code(file) }))
  .filter((one) => one.body.includes('<ResponsiveContainer'))
  .map((one) => ({ ...one, chain: ancestry(one.body) }))

describe('every plot the product mounts', () => {
  it('is found by this file at all', () => {
    // The net is drawn from the tree and not from a list, so a fifth chart is
    // covered the day it is written. If this ever reads zero, the walker is
    // broken rather than the product clean.
    // The list is asserted rather than counted because it is how this file was
    // useful on its first run: #1003 was planned and reviewed against **six**
    // surfaces, and the walker found a seventh on the spot — `AccountsCard`'s
    // sparkline, one per account row, each an `<svg>` Recharts had made focusable
    // inside an `aria-hidden` span.
    expect(CHARTS.map((one) => one.rel).sort()).toEqual([
      'components/accounts/AccountCurve.tsx',
      'components/benchmark/BenchmarkChart.tsx',
      'components/dashboard/HeroChart.tsx',
      'components/dashboard/PortfolioChart.tsx',
      'components/shares/Allocation.tsx',
      'components/shares/PriceChart.tsx',
    ])
  })

  it('either writes a reading beside it or is named as hidden on purpose', () => {
    for (const { rel, body } of CHARTS) {
      if (rel in HIDDEN_ON_PURPOSE) {
        expect(body, `${rel} is hidden on purpose and must not also read`).not.toContain(
          '<ChartReading',
        )
        continue
      }
      expect(body, `${rel} mounts a plot with no <figure> around it`).toContain('<figure')
      expect(body, `${rel} mounts a plot with no reading beside it`).toContain('<ChartReading')
    }
  })

  it('is not hidden from the reader, unless it is hidden on purpose', () => {
    for (const { rel, chain, body } of CHARTS) {
      // The chain is what the question is about, so an empty one is a scanner
      // that failed rather than a plot at the root of a file.
      expect(chain.length, `${rel}: no enclosing element found for its plot`).toBeGreaterThan(0)
      if (rel in HIDDEN_ON_PURPOSE) {
        // The exception has to be *complete*: hidden from the tree **and** out of
        // the tab order. Half of it would leave a focus stop that says nothing,
        // which is the defect this ticket removed everywhere else.
        expect(
          chain.some(hides),
          `${rel} claims to hide its plot, but no element enclosing it does`,
        ).toBe(true)
        expect(body, `${rel} hides a plot it leaves in the tab order`).toContain(
          'accessibilityLayer={false}',
        )
        continue
      }
      const hidden = chain.filter(hides).map((tag) => tag.name)
      expect(hidden, `${rel} hides a focusable plot from the reader`).toEqual([])
      expect(
        chain.some((tag) => tag.name === 'figure'),
        `${rel} mounts a plot no <figure> encloses`,
      ).toBe(true)
      expect(body, `${rel} switches off a keyboard layer it keeps in the tree`).not.toContain(
        'accessibilityLayer={false}',
      )
    }
  })

  it('carries an accessible name, which no rendering test can see', () => {
    for (const { rel, body } of CHARTS) {
      if (rel in HIDDEN_ON_PURPOSE) continue
      // On `aria-label` and never on Recharts' `title` prop: `Surface` renders
      // `<title></title>` whether a title was passed or not, and an empty title
      // competing with a name is a coin toss across implementations.
      // `[^>]` and not `[\s\S]`: the name has to be in the chart's **own**
      // opening tag. Allowed to cross `>`, the match would be satisfied by an
      // `aria-label` on a child three elements down, which names nothing.
      expect(body, `${rel} mounts a nameless application region`).toMatch(
        /<(Composed|Line|Area|Bar|Scatter)Chart[^>]{0,300}aria-label=\{t\(/,
      )
      expect(body, `${rel} names its plot with the library's own title prop`).not.toMatch(
        /<(Composed|Line|Area|Bar|Scatter)Chart[^>]{0,300}\stitle=/,
      )
    }
  })

  it('reads the rows it draws, by the keys it draws them with', () => {
    for (const { rel, body } of CHARTS) {
      if (rel in HIDDEN_ON_PURPOSE) continue
      // Every key handed to the reading is a key the file gives a `<Line>`. This
      // is what makes the sentence unable to drift from the curve: there is one
      // projection of the series, not two.
      // **Series keys only.** An axis carries a `dataKey` too — `<XAxis
      // dataKey="t">` — so a set built from every `dataKey` in the file would let
      // `key: 't'` pass as a drawn curve. The `\b` is what keeps `<Line` from
      // matching `<LineChart`.
      const plotted = new Set(
        Array.from(body.matchAll(/<(?:Line|Area|Bar|Scatter)\b[^>]*?dataKey="([^"]+)"/g)).map(
          (match) => match[1],
        ),
      )
      const everyKey = new Set(
        Array.from(body.matchAll(/dataKey="([^"]+)"/g)).map((match) => match[1]),
      )
      const read = Array.from(body.matchAll(/key:\s*'([^']+)'/g)).map((match) => match[1])
      expect(read.length, `${rel} hands the reading no key at all`).toBeGreaterThan(0)
      for (const key of read) {
        expect(plotted, `${rel} reads "${key}", which no series of that file draws`).toContain(key)
      }
      // The day comes from `t` on every chart here, which is what lets the
      // helper stay ignorant of four row shapes. It is an axis key, not a series
      // one, so it is checked against the wider set.
      expect(everyKey, `${rel} names its days with something other than "t"`).toContain('t')
    }
  })
})

describe('the sentence has one author', () => {
  it('is composed in ChartReading and nowhere else', () => {
    const writers = sources()
      .map((file) => ({ rel: path.relative(SOURCE, file), body: code(file) }))
      .filter((one) => one.body.includes("'chart.reading."))
      .map((one) => one.rel)
    // Four surfaces mounting one primitive, and not four spellings of one
    // sentence: `Stat`, `EmptyState`, `Refusal`, `EntryPair` and `ShareBar` all
    // exist because the prototype held several copies of one object.
    expect(writers).toEqual(['components/ChartReading.tsx'])
  })
})
