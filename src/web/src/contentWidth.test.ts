/**
 * **The content column may be narrower than what is in it** (#832), held on the
 * source for the same reason `lint/grid-base-columns.grit` is: nothing makes it true by
 * construction, and no rendering test could see it — jsdom lays nothing out, so
 * a table 976 px wide inside a 672 px column is a fact only a browser has.
 *
 * The defect it closes is one CSS default with no symptom until it bites, and
 * it is the flex sibling of the grid one next door. `SidebarInset` is a flex
 * item beside the navigation, so its `min-width` resolves to `auto` — *never
 * narrower than my content* — and a table wider than the column therefore
 * **grew the column** instead of scrolling inside it. Measured on `/shares`
 * against a real API at the five prescribed widths: the page itself overflowed
 * by 256 px at 768 and by 238 px at 976, and the `overflow-x-auto` that
 * `components/ui/table.tsx` wraps around every table did nothing whatsoever —
 * its parent having grown to fit, there was nothing left to scroll.
 *
 * So the rule is a **pair**, and this file holds both halves because either one
 * alone is inert:
 *
 *  - the shell's content column declares `min-w-0`, which is what lets it be
 *    narrower than the widest table on the page;
 *  - the table primitive keeps its own `overflow-x-auto`, which is what then
 *    catches the overflow instead of the page.
 *
 * Lose the first and the page scrolls sideways; lose the second and the table
 * is clipped. Neither failure carries a word for a rendering test to read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = path.resolve(import.meta.dirname)

const SHELL = fs.readFileSync(path.join(SOURCE, 'components', 'Shell.tsx'), 'utf8')
const TABLE = fs.readFileSync(path.join(SOURCE, 'components', 'ui', 'table.tsx'), 'utf8')
const FACETS = fs.readFileSync(
  path.join(SOURCE, 'features/data/components/LedgerFacets.tsx'),
  'utf8',
)

const SIDEBAR = fs.readFileSync(path.join(SOURCE, 'components', 'ui', 'sidebar.tsx'), 'utf8')
const AGENT_CHAT = fs.readFileSync(
  path.join(SOURCE, 'features/agent/components/AgentChat.tsx'),
  'utf8',
)
const DESIGN = fs.readFileSync(path.join(SOURCE, '..', '..', '..', 'DESIGN.md'), 'utf8')

/** The opening tag of the content column, whatever else is on it. */
const INSET = /<SidebarInset\b[^>]*>/

describe('the content column may be narrower than what is in it', () => {
  it('declares a floor of zero on the shell’s content column', () => {
    const [tag] = SHELL.match(INSET) ?? []
    expect(tag).toBeDefined()
    expect(tag).toMatch(/\bmin-w-0\b/)
  })

  it('keeps the scroller the floor hands the overflow to', () => {
    // The other half. `min-w-0` does not scroll anything by itself: it only
    // makes room for the container that does, and that container is the table
    // primitive's — one place, so every dense surface inherits it.
    expect(TABLE).toMatch(/overflow-x-auto/)
  })

  it('reads the tag it is supposed to be reading', () => {
    // The coverage half: a pattern that stopped matching would make the
    // assertions above pass on a shell that had lost the rule entirely.
    expect(SHELL).toMatch(/SidebarInset/)
    expect(INSET.test('<SidebarInset>')).toBe(true)
  })
})

/**
 * **The ledger's facet panel folds under 768 px** (#834), and it is the same
 * kind of pair for the same reason: two classes, each inert without the other,
 * and jsdom lays neither of them out. What a rendering test *can* see — that
 * the control exists and says whether the panel is open — is asserted in
 * `data.test.tsx`; what only a browser has is here.
 *
 *  - the panel's body carries `hidden md:flex`, so the state folds it on the
 *    narrow layout and can never fold it on the wide one — a reader who folded
 *    it on a phone and turned the phone would otherwise find the ledger's whole
 *    vocabulary missing;
 *  - the toggle carries `md:hidden`, so the control that does nothing above
 *    that width is not on screen there.
 *
 * Lose the first and the panel is a fold nobody asked for at every width; lose
 * the second and there is a dead control above 768. Neither failure carries a
 * word.
 */
describe('the facet panel folds where there is no room for it', () => {
  it('hides its body under `md` alone, never above', () => {
    expect(FACETS).toMatch(/'hidden md:flex'/)
  })

  it('keeps the toggle off the wide layout, where it would do nothing', () => {
    // The first class list after the control's own attribute, which is that
    // control's: an arrow function in between makes `>` a poor terminator.
    const [, classes] =
      FACETS.match(/aria-controls="ledger-facets"[\s\S]*?className="([^"]*)"/) ?? []
    expect(classes).toBeDefined()
    expect(classes).toMatch(/\bmd:hidden\b/)
  })

  it('reads the panel it is supposed to be reading', () => {
    // The coverage half: a body that stopped being addressed by that id would
    // make both assertions above pass on a panel that had lost the fold.
    expect(FACETS).toMatch(/id="ledger-facets"/)
  })
})

/**
 * **The layout widths are DESIGN.md's, and a page names them** (#1276). The
 * tokens live in `index.css` (`stylesheet.test.ts` holds them to DESIGN.md);
 * what is held here is the code that draws with them.
 */
describe('the layout widths are the ones DESIGN.md sets', () => {
  it('draws the navigation at the width DESIGN.md sets', () => {
    const [, px] = DESIGN.match(/^ {2}sidebar:\n {4}width: (\d+)px$/m) ?? []
    const [, rem] = SIDEBAR.match(/const SIDEBAR_WIDTH = '([\d.]+)rem'/) ?? []
    expect(px).toBeDefined()
    expect(Number(rem) * 16).toBe(Number(px))
  })

  it('sets the conversation on the column and reading widths', () => {
    expect(AGENT_CHAT).toMatch(/\bmax-w-column\b/)
    expect(AGENT_CHAT).toMatch(/\blg:max-w-reading\b/)
  })

  it('writes no width the tokens already name', () => {
    const named = /max-w-(?:180|192|\[720px\]|\[768px\]|\[45rem\]|\[48rem\])/
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (file !== path.join(SOURCE, 'components', 'ui')) walk(file)
        } else if (
          /\.(ts|tsx|css)$/.test(entry.name) &&
          fs.readFileSync(file, 'utf8').match(named)
        ) {
          // This file names the classes it forbids.
          if (file !== import.meta.filename) found.push(path.relative(SOURCE, file))
        }
      }
    }
    walk(SOURCE)
    expect(found).toEqual([])
  })
})
