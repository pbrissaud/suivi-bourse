/**
 * **What `index.css` holds, read off the file** (#1130).
 *
 * The theme is replaceable (`SB_TWEAKCN_THEME`), so nothing here asserts a
 * colour Atelier happens to carry. What stays is what holds whatever the theme:
 * the controls the browser paints are drawn from the tokens, DESIGN.md's type
 * ladder is the one stated, the build's entry loads nothing from a third party,
 * and block 2 says the same meanings on both grounds — the allocation ramp
 * included, which is the one place block 2 mixes rather than names.
 *
 * That every block-2 value is an alias is `lint/semantic-token-alias.grit`'s
 * job; this file holds what a lint rule cannot, which is two rules compared.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { blocks, declarations, read, WEB_ROOT } from '@/test/stylesheet'

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
    // The hero is fluid, and DESIGN.md's 60 px is its ceiling.
    expect(said('--text-hero')).toBe(
      `clamp(2.25rem, 1rem + 4.5vw, ${rem(designType('hero', 'fontSize'))})`,
    )
    expect(said('--text-hero--line-height')).toBe('calc(64 / 60)')
    expect(said('--tracking-hero')).toBe(designType('hero', 'letterSpacing'))
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
    for (const source of entry.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
      expect(source[1], 'the entry loads only its own module').toMatch(/^\//)
    }
  })
})

/** Rank 1 is the primary itself, and each rank after it is mixed further into the ground. */
const ALLOC_SHARES = [100, 88, 76, 64, 52, 40, 30, 20]

describe('the domain block', () => {
  it('says the same names on both grounds', () => {
    const domain = blocks()[1]
    const light = [...declarations(domain, 'light').keys()].sort()
    const dark = [...declarations(domain, 'dark').keys()].sort()
    expect(light.length).toBeGreaterThan(0)
    expect(dark).toEqual(light)
  })

  it('mixes the eight allocation stops from the primary into the ground', () => {
    const domain = blocks()[1]
    for (const ground of ['light', 'dark'] as const) {
      const stops = [...declarations(domain, ground)].filter(([name]) =>
        name.startsWith('--alloc-'),
      )
      expect(stops, `the ${ground} allocation ramp`).toEqual(
        ALLOC_SHARES.map((share, index) => [
          `--alloc-${index + 1}`,
          `color-mix(in oklch, var(--primary) ${share}%, var(--background))`,
        ]),
      )
    }
  })
})
