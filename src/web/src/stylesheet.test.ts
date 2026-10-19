/**
 * **What `index.css` holds, read off the file** (#1130).
 *
 * The theme is replaceable (Settings › Thème, #1248), so nothing here asserts a
 * colour Atelier happens to carry. What stays is what holds whatever the theme:
 * the controls the browser paints are drawn from the tokens, DESIGN.md's type
 * ladder is the one stated, the build's entry loads nothing from a third party,
 * and block 2 says the same meanings on both grounds, the allocation stops and
 * the signs (#1283) included.
 *
 * That every block-2 value is an alias is `lint/semantic-token-alias.grit`'s
 * job; this file holds what a lint rule cannot, which is two rules compared.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cn } from '@/lib/utils'
import { blocks, declarations, type Oklch, oklch, read, WEB_ROOT } from '@/test/stylesheet'

const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..')
const DESIGN_MD = path.join(REPO_ROOT, 'DESIGN.md')

/** One rung of the front matter's `typography:` block, by name and key. */
function designType(rung: string, key: string): string {
  const front = fs.readFileSync(DESIGN_MD, 'utf8').split(/^---$/m)[1]
  const block = new RegExp(`^ {2}${rung}:\\n((?: {4}.*\\n)+)`, 'm').exec(front)
  const value = block && new RegExp(`^ {4}${key}: (.+)$`, 'm').exec(block[1])
  if (!value) throw new Error(`DESIGN.md says no ${key} for ${rung}`)
  return value[1].trim()
}

/** One entry of the front matter's `components:` block — same shape as a rung. */
const designComponent = designType

/** What a custom property is declared as, anywhere in the file. */
function declared(source: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(source)?.[1].trim()
}

describe('the controls the browser paints itself', () => {
  /**
   * **The theme reaches the native controls too** (#837).
   *
   * `ThemeProvider` writes `color-scheme` beside the `.dark` class, and that is
   * only half of what a user agent needs: it says *paint your light furniture
   * or your dark one*, never *paint it in our colours*. The initial
   * `accent-color: auto` is the reader's **desktop** accent, so the settings
   * page's rebuild bar came out in whatever colour the machine was set to —
   * measured green on one Mac, and the mint by coincidence rather than by
   * decision. On the light ground the bar's *track*, which no accent reaches,
   * read as a mid-grey rule drawn across a white card.
   */
  it('states the accent rather than inheriting the reader’s desktop', () => {
    expect(read()).toMatch(/accent-color:\s*var\(--primary\)/)
  })

  it('draws the one progress bar from the tokens, both halves of it', () => {
    const source = read()
    // The value is the accent's; the track is the half `accent-color` does not
    // reach, and it is the one that broke on the light ground.
    expect(source).toMatch(
      /progress::-webkit-progress-bar\s*\{\s*background-color:\s*var\(--input\)/,
    )
    expect(source).toMatch(
      /progress::-webkit-progress-value\s*\{\s*background-color:\s*var\(--primary\)/,
    )
    expect(source).toMatch(
      /progress::-moz-progress-bar\s*\{\s*background-color:\s*var\(--primary\)/,
    )
  })

  it('never puts two agents’ pseudo-elements in one selector list', () => {
    // A selector list containing a pseudo-element the agent does not know is a
    // list the agent drops **whole**, taking the half it does know with it. So
    // the two names are two rules, and this is the assertion that keeps them
    // apart when someone tidies the file.
    // Comments go first: a selector list runs over several lines, so the span
    // this reads is *everything between one brace and the next*, and a prose
    // paragraph in there would be scanned as if it were a selector.
    const source = read().replace(/\/\*[\s\S]*?\*\//g, '')
    for (const list of source.matchAll(/(?:^|[{}])([^{}]*::-[\w-]+[^{}]*)\{/g)) {
      const vendors = new Set([...list[1].matchAll(/::-(\w+)-/g)].map((prefix) => prefix[1]))
      expect(vendors.size, `two vendors in one selector list: ${list[1].trim()}`).toBeLessThan(2)
    }
  })
})

describe('index.css says what DESIGN.md says', () => {
  it('states the type ladder DESIGN.md sets', () => {
    const source = read()
    const said = (name: string) => {
      const value = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(source)
      if (!value) throw new Error(`index.css declares no ${name}`)
      return value[1].trim()
    }
    const rem = (px: string) => `${Number.parseFloat(px) / 16}rem`
    expect(said('--text-xs')).toBe(rem(designType('label', 'fontSize')))
    expect(said('--text-xs--line-height')).toBe(rem(designType('label', 'lineHeight')))
    expect(said('--text-base')).toBe(rem(designType('body', 'fontSize')))
    expect(said('--text-base--line-height')).toBe(rem(designType('body', 'lineHeight')))
    expect(said('--text-md')).toBe(said('--text-base'))
    expect(said('--text-prose')).toBe(rem(designType('prose', 'fontSize')))
    expect(said('--text-prose--line-height')).toBe(rem(designType('prose', 'lineHeight')))
    expect(said('--text-2xl')).toBe(rem(designType('section-title', 'fontSize')))
    expect(said('--text-2xl--line-height')).toBe(rem(designType('section-title', 'lineHeight')))
    expect(said('--text-4xl')).toBe(rem(designType('figure', 'fontSize')))
    expect(said('--text-4xl--line-height')).toBe(rem(designType('figure', 'lineHeight')))
    // The page title rides the prose rung: one size, two names in DESIGN.md.
    expect(said('--text-prose')).toBe(rem(designType('page-title', 'fontSize')))
    expect(said('--text-prose--line-height')).toBe(rem(designType('page-title', 'lineHeight')))
    // The hero is fluid, and DESIGN.md's 60 px is its ceiling.
    expect(said('--text-hero')).toBe(
      `clamp(2.25rem, 1rem + 4.5vw, ${rem(designType('hero', 'fontSize'))})`,
    )
    expect(said('--text-hero--line-height')).toBe('calc(64 / 60)')
    expect(said('--tracking-hero')).toBe(designType('hero', 'letterSpacing'))
  })
})

describe('index.css says what DESIGN.md says about the colours', () => {
  /** One entry of the front matter's `colors:` block, as its `oklch()` parts. */
  function designColour(name: string): Oklch {
    const front = fs.readFileSync(DESIGN_MD, 'utf8').split(/^---$/m)[1]
    const value = new RegExp(`^ {2}${name}: "(.+)"$`, 'm').exec(front)
    if (!value) throw new Error(`DESIGN.md says no ${name}`)
    return oklch(value[1])
  }

  it('DESIGN.md states the preset’s primary and gain', () => {
    const primitives = blocks()[0]
    const cases = [
      ['primary', 'light', '--primary'],
      ['dark-primary', 'dark', '--primary'],
      ['gain', 'light', '--chart-2'],
      ['dark-gain', 'dark', '--chart-2'],
    ] as const
    for (const [name, ground, token] of cases) {
      const said = oklch(declarations(primitives, ground).get(token) ?? '')
      const stated = designColour(name)
      expect(Math.abs(stated.lightness - said.lightness), `${name} L`).toBeLessThanOrEqual(0.01)
      expect(Math.abs(stated.chroma - said.chroma), `${name} C`).toBeLessThanOrEqual(0.01)
      expect(Math.abs(stated.hue - said.hue), `${name} H`).toBeLessThanOrEqual(1)
    }
  })
})

describe('index.css says what DESIGN.md says about the layout', () => {
  const rem = (px: string) => `${Number.parseFloat(px) / 16}rem`

  it('states the content widths DESIGN.md sets', () => {
    const source = read()
    expect(declared(source, '--container-column')).toBe(
      rem(designComponent('content-column', 'maxWidth')),
    )
    expect(declared(source, '--container-reading')).toBe(
      rem(designComponent('content-reading', 'maxWidth')),
    )
    expect(declared(source, '--breakpoint-3xl')).toBe('100rem')
  })

  it('keeps the layout widths out of a theme’s reach', () => {
    // A theme replaces blocks 1 and 2, `:root` and `.dark`; the bridge is
    // inlined at build time, so a width declared there is out of its way.
    const source = read()
    const inline = source.slice(source.indexOf('@theme inline'))
    for (const name of ['--container-column', '--container-reading', '--breakpoint-3xl']) {
      expect(declared(inline, name), name).toMatch(/^\d+(\.\d+)?rem$/)
      // Declared once, and after `@theme inline` opens: never in a `:root` or `.dark`.
      expect(source.match(new RegExp(`${name}:`, 'g'))).toHaveLength(1)
      expect(source.indexOf(`${name}:`), name).toBeGreaterThan(source.indexOf('@theme inline'))
    }
  })
})

describe('every rung index.css declares is a size to cn', () => {
  it('lets the later rung win over another size, and keeps a colour beside it', () => {
    // A rung tailwind-merge has no name for is read as a colour: `text-prose`
    // lost to the bubble's `text-sm` and the questions came out at 13 px.
    const rungs = [...read().matchAll(/^\s*--text-([a-z0-9]+):/gm)].map((rung) => rung[1])
    expect(rungs).toContain('prose')
    for (const rung of rungs) {
      const other = rung === 'sm' ? 'text-lg' : 'text-sm'
      expect(cn(other, `text-${rung}`), rung).toBe(`text-${rung}`)
      expect(cn(`text-${rung}`, 'text-gain'), rung).toBe(`text-${rung} text-gain`)
    }
  })
})

describe('what the theme must not bring with it', () => {
  it('leaves no third-party script in the build’s one entry', () => {
    // tweakcn's live preview is a script loaded at runtime, and `index.html` is
    // the single entry built into the statics Flask serves. A preview that
    // shipped would put a third party on the reader's page for a value the
    // stylesheet already carries.
    const entry = fs.readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8')
    expect(entry).not.toMatch(/tweakcn/i)
    // The stored theme comes in same-origin, served by the app.
    expect(entry).toMatch(/<link rel="stylesheet" href="\/api\/theme\.css"/)
    for (const source of entry.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
      expect(source[1], 'the entry loads only its own module').toMatch(/^\//)
    }
  })
})

describe('the domain block', () => {
  it('says the same names on both grounds', () => {
    const domain = blocks()[1]
    const light = [...declarations(domain, 'light').keys()].sort()
    const dark = [...declarations(domain, 'dark').keys()].sort()
    expect(light.length).toBeGreaterThan(0)
    expect(dark).toEqual(light)
  })

  it('takes the allocation stops from the chart hues, the fold from the muted foreground', () => {
    const domain = blocks()[1]
    for (const ground of ['light', 'dark'] as const) {
      const stops = [...declarations(domain, ground)].filter(([name]) =>
        name.startsWith('--alloc-'),
      )
      expect(stops, `the ${ground} allocation ring`).toEqual([
        ['--alloc-1', 'var(--chart-1)'],
        ['--alloc-2', 'var(--chart-3)'],
        ['--alloc-3', 'var(--chart-4)'],
        ['--alloc-4', 'var(--chart-5)'],
        ['--alloc-5', 'var(--muted-foreground)'],
      ])
    }
  })

  it('aliases gain to chart-2 and loss to destructive', () => {
    const domain = blocks()[1]
    for (const ground of ['light', 'dark'] as const) {
      const said = declarations(domain, ground)
      expect(said.get('--gain'), ground).toBe('var(--chart-2)')
      expect(said.get('--loss'), ground).toBe('var(--destructive)')
    }
  })

  it('atelier.json carries the #1283 values', () => {
    const ink = { light: 'oklch(0.3 0.03 60)', dark: 'oklch(0.92 0.012 80)' }
    const hues = {
      light: [
        'oklch(0.5 0.14 255)',
        'oklch(0.4825 0.1032 163.7504)',
        'oklch(0.47 0.16 305)',
        'oklch(0.58 0.09 215)',
        'oklch(0.38 0.06 45)',
      ],
      dark: [
        'oklch(0.7 0.12 255)',
        'oklch(0.8001 0.1297 165.0822)',
        'oklch(0.66 0.15 305)',
        'oklch(0.82 0.06 220)',
        'oklch(0.55 0.08 50)',
      ],
    }
    const theme = JSON.parse(
      fs.readFileSync(path.join(WEB_ROOT, 'src', 'theme', 'atelier.json'), 'utf8'),
    )
    const primitives = blocks()[0]
    for (const ground of ['light', 'dark'] as const) {
      const said = declarations(primitives, ground)
      // The JSON and the generated block say the same thing, and it is the ticket's.
      for (const name of ['primary', 'ring', 'sidebar-primary', 'sidebar-ring'])
        for (const value of [theme[ground][name], said.get(`--${name}`)])
          expect(oklch(value), `${name}, ${ground}`).toEqual(oklch(ink[ground]))
      hues[ground].forEach((hue, at) => {
        for (const value of [theme[ground][`chart-${at + 1}`], said.get(`--chart-${at + 1}`)])
          expect(oklch(value), `chart-${at + 1}, ${ground}`).toEqual(oklch(hue))
      })
    }
  })
})
