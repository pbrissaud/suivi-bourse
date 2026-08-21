/**
 * **The cut of `index.css` is held on the source** (ADR-0023, ADR-0029).
 *
 * ADR-0023 put the whole decision in a cut — *the preset owns the chrome, the
 * product owns the meaning* — and ADR-0029 changed which preset arrives without
 * touching how it arrives. Neither half of that is true by construction: the
 * file is three blocks because someone kept it three blocks, and the moment a
 * value is convenient to type in by hand, the two halves stop being tellable
 * apart. That is not a hypothesis — it is what the prototype did, with a
 * `radix-nova` style nobody chose and a hand-written layer piled on top.
 *
 * So the rules are asserted where they live, which is the file. Four of them:
 *
 *  - **Three blocks.** A fourth block, or a missing one, is the collapse
 *    ADR-0029 names in as many words: *a theme vendored as JSON stops
 *    regenerating, and the three-block cut collapses into two*.
 *  - **The domain layer holds only what the preset cannot say.** This is
 *    ADR-0023's sizing rule, and it is the one that decays silently: every page
 *    has a reason to add just one token. Asserted as a set relation — a name
 *    the preset already declares may not be redeclared below it — which is
 *    exactly the sentence the ADR wrote.
 *  - **`--loss` is not `--destructive`**, and stays lower in chroma. The theme's
 *    red says *this failed*; an unrealised loss is not an error. ADR-0029 adds
 *    the half this test exists for: the redesign's lift in **lightness** for the
 *    darker ground is the right correction and must not be applied to chroma.
 *  - **The light theme has its own accent.** A ground chosen for one of the two
 *    states is a preset that only half exists (ADR-0024 gives the theme three
 *    states, so both grounds are real).
 *
 * Two more are about what must be **absent**, and absence is exactly what no
 * screen can show: no theme JSON anywhere in the repository, and no third-party
 * preview script in the build's one entry.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { blocks, declarations, oklch, WEB_ROOT } from '@/test/stylesheet'

const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..')

describe('the cut of index.css', () => {
  it('has exactly three blocks: the preset, the domain, the bridge', () => {
    const cut = blocks()
    expect(cut.map((block) => block.index)).toEqual([1, 2, 3])
    // The titles are not decoration: they are what tells a reader which half a
    // value belongs to before they read the value.
    expect(cut[0].title).toMatch(/primitives/i)
    expect(cut[1].title).toMatch(/domain/i)
    expect(cut[2].title).toMatch(/bridge/i)
  })

  it('never redeclares below the preset a name the preset already says', () => {
    // ADR-0023's sizing rule, as a set relation. `--price` and `--grant` may
    // *take* a preset token — `var(--chart-1)` is an alias, not a second
    // opinion — but a name declared in block 1 may not reappear in block 2 with
    // a different value, because then nothing in the file says which wins.
    const [preset, domain] = blocks()
    for (const ground of ['light', 'dark'] as const) {
      const said = declarations(preset, ground)
      const added = declarations(domain, ground)
      const both = [...added.keys()].filter((name) => said.has(name))
      expect(both, `the preset already declares ${both.join(', ')} in ${ground}`).toEqual([])
    }
  })

  it('keeps --loss lower in chroma than --destructive, by a margin that shows', () => {
    // A bare `<` would pass at 0,2095 against 0,2096, and the claim is not that
    // the two differ — it is that a reader can **see** they differ. The margin
    // is the one ADR-0023 shipped with and #788 restored after briefly halving
    // it: below it the theme's *this failed* and an unrealised −0,4 % start
    // reading as the same red.
    const [preset, domain] = blocks()
    for (const ground of ['light', 'dark'] as const) {
      const destructive = oklch(declarations(preset, ground).get('--destructive')!)
      const loss = oklch(declarations(domain, ground).get('--loss')!)
      expect(
        destructive.chroma - loss.chroma,
        `--loss must sit a visible step below --destructive in chroma on the ${ground} ground`,
      ).toBeGreaterThanOrEqual(0.04)
    }
  })

  it('states --loss as its own value and never as the theme’s red', () => {
    // ADR-0023: *`--loss` is not `--destructive` despite two degrees of hue
    // between them*. An alias would make the two move together, and the whole
    // reason they are two tokens is that they must not — the lift in lightness
    // the darker ground needs applies to one of them and not to the other.
    const [, domain] = blocks()
    for (const ground of ['light', 'dark'] as const) {
      const loss = declarations(domain, ground).get('--loss')!
      expect(loss, `--loss may not be an alias on the ${ground} ground`).not.toMatch(
        /var\(--destructive\)/,
      )
    }
  })

  it('gives the light theme its own accent rather than reusing the dark one', () => {
    const [preset] = blocks()
    for (const token of ['--primary', '--ring', '--sidebar-primary']) {
      const light = declarations(preset, 'light').get(token)
      const dark = declarations(preset, 'dark').get(token)
      expect(light, `${token} is declared on both grounds`).toBeDefined()
      expect(dark).toBeDefined()
      expect(light, `${token} may not be the dark value reused`).not.toBe(dark)
    }
  })
})

describe('what the theme must not bring with it', () => {
  it('versions no theme JSON anywhere in the repository', () => {
    // ADR-0023 refused pasting, and ADR-0029 kept that half on its own: a theme
    // vendored as JSON stops regenerating. The failure is invisible until the
    // domain layer has grown back, so it is caught at the moment it lands.
    const vendored = versionedJson().filter(looksLikeATheme)
    expect(vendored.map((file) => path.relative(REPO_ROOT, file))).toEqual([])
  })

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

/**
 * Every `.json` the repository **keeps** — asked of git, not of the disk.
 *
 * The criterion is that no theme JSON is *versioned*, and those are two
 * different questions: a walk of the working tree reads `website/build/` and a
 * scratch file someone dropped in an untracked directory, while missing a theme
 * committed under a path the walk skips. Asking the index is the only way this
 * assertion means what its name says.
 */
function versionedJson(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '*.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return listed
    .split('\0')
    .filter(Boolean)
    .map((relative) => path.join(REPO_ROOT, relative))
}

/** A shadcn registry item, which is the shape a pasted tweakcn theme wears. */
function looksLikeATheme(file: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const item = parsed as Record<string, unknown>
  return item.type === 'registry:style' || 'cssVars' in item
}
