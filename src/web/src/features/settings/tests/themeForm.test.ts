/**
 * The Thème form's model (#1314): which keys a field writes, what follows, and
 * the theme the edits make — pure, no screen.
 */
import { converter } from 'culori'
import { describe, expect, it } from 'vitest'

import type { ThemeVars } from '@/features/settings/lib/api'
import {
  COLOUR_GROUPS,
  candidate,
  count,
  NO_EDITS,
  read,
  setEdit,
} from '@/features/settings/lib/themeForm'
import { fromHex, toHex } from '@/lib/oklch'
import { previewCss } from '@/lib/themePreview'
import atelierJson from '@/theme/atelier.json'
import { blocks, declarations } from '@/test/stylesheet'
import { distance } from '@/test/oklch'

const atelier = atelierJson as ThemeVars
const toOklch = converter('oklch')

const edit = (baseline: ThemeVars, ...changes: [string, string, string][]) =>
  candidate(
    baseline,
    changes.reduce(
      (edits, [scope, key, value]) => setEdit(baseline, edits, scope as 'light', key, value),
      NO_EDITS,
    ),
  )

describe('the colour fields', () => {
  it('write the keys the design names, on the ground being edited only', () => {
    const next = edit(atelier, ['light', 'chart-2', 'red'], ['dark', 'destructive', 'blue'])

    expect(next.light['chart-2']).toBe('red')
    expect(next.dark['chart-2']).toBe(atelier.dark['chart-2'])
    expect(next.dark.destructive).toBe('blue')
    expect(next.light.destructive).toBe(atelier.light.destructive)
    expect(COLOUR_GROUPS.flatMap((group) => group.fields.map((field) => field.key))).toHaveLength(
      16,
    )
  })

  it('bring along the hidden keys that were linked to them', () => {
    const next = edit(atelier, ['light', 'primary', 'red'], ['light', 'foreground', 'blue'])

    for (const key of ['ring', 'sidebar-primary', 'sidebar-ring'])
      expect(next.light[key]).toBe('red')
    for (const key of ['card-foreground', 'sidebar-foreground', 'accent-foreground']) {
      expect(next.light[key]).toBe('blue')
    }
    expect(next.dark.ring).toBe(atelier.dark.ring)
  })

  it('leave alone a hidden key an imported theme made its own', () => {
    const imported: ThemeVars = {
      theme: {},
      light: { ...atelier.light, sidebar: 'oklch(0.9 0.02 90)' },
      dark: { ...atelier.dark },
    }
    const next = edit(imported, ['light', 'background', 'red'])

    expect(next.light.background).toBe('red')
    expect(next.light.sidebar).toBe('oklch(0.9 0.02 90)')
    expect(next.light.popover).toBe(atelier.light.popover)
  })

  it('fill the other ground when a theme said a key on one only', () => {
    const sparse: ThemeVars = { theme: {}, light: { primary: 'red' }, dark: { primary: 'blue' } }
    const next = edit(sparse, ['light', 'chart-1', 'green'])

    expect(next.light['chart-1']).toBe('green')
    expect(next.dark['chart-1']).toBe(atelier.dark['chart-1'])
  })
})

describe('the shape and the type', () => {
  it('Ombres sets the opacity and recomposes the eight shadow strings', () => {
    const next = edit(atelier, ['theme', 'shadow-opacity', '0.1'])

    expect(next.theme['shadow-opacity']).toBe('0.1')
    expect(next.theme['shadow-2xs']).toBe('0px 1px 2px 0px hsl(0 0% 0% / 0.05)')
    expect(next.theme['shadow-md']).toBe(
      '0px 1px 2px 0px hsl(0 0% 0% / 0.1), 0px 2px 4px -1px hsl(0 0% 0% / 0.1)',
    )
    expect(next.theme['shadow-2xl']).toBe('0px 1px 2px 0px hsl(0 0% 0% / 0.25)')
  })

  it('Ombres wins over a theme that drew its shadows per ground', () => {
    const perGround: ThemeVars = {
      theme: {},
      light: { ...atelier.light, 'shadow-sm': '0px 1px 2px 0px hsl(0 0% 0% / 0.3)' },
      dark: { ...atelier.dark, 'shadow-sm': '0px 1px 2px 0px hsl(0 0% 0% / 0.3)' },
    }
    const next = edit(perGround, ['theme', 'shadow-opacity', '0.2'])

    expect(next.light['shadow-sm']).toBeUndefined()
    expect(next.theme['shadow-sm']).toBe('0px 1px 2px 0px hsl(0 0% 0% / 0.2)')
  })

  it('Espacement des lettres writes what body reads and mirrors letter-spacing', () => {
    const next = edit(atelier, ['theme', 'tracking-normal', '0.025em'])

    expect(next.theme['tracking-normal']).toBe('0.025em')
    expect(next.theme['letter-spacing']).toBe('0.025em')
  })
})

describe('the count', () => {
  it('counts edited fields, not the keys that follow them, and an edit back to the baseline is none', () => {
    let edits = setEdit(atelier, NO_EDITS, 'light', 'primary', 'red')
    edits = setEdit(atelier, edits, 'dark', 'primary', 'blue')
    edits = setEdit(atelier, edits, 'theme', 'shadow-opacity', '0.1')
    expect(count(edits)).toBe(3)

    edits = setEdit(atelier, edits, 'light', 'primary', atelier.light.primary)
    expect(count(edits)).toBe(2)
    expect(count(setEdit(atelier, edits, 'dark', 'primary', null))).toBe(1)
  })
})

describe('colours', () => {
  it('round-trip through the colour input within 0.01 ΔE_ok, on every Atelier colour', () => {
    for (const ground of ['light', 'dark'] as const) {
      for (const { fields } of COLOUR_GROUPS) {
        for (const { key } of fields) {
          const before = toOklch(read(atelier, ground, key))
          const after = toOklch(fromHex(toHex(read(atelier, ground, key))))
          const lch = (c: typeof before) => ({
            lightness: c?.l ?? 0,
            chroma: c?.c ?? 0,
            hue: c?.h ?? 0,
          })
          expect(distance(lch(before), lch(after)), `${ground} ${key}`).toBeLessThan(0.01)
        }
      }
    }
  })

  it('are written as oklch rounded to four decimals', () => {
    expect(fromHex('#ff0000')).toMatch(/^oklch\(\d(\.\d{1,4})? \d(\.\d{1,4})? \d+(\.\d{1,4})?\)$/)
  })
})

describe('the preview', () => {
  it('paints Atelier exactly as the stylesheet block that is generated from it', () => {
    const [preset] = blocks()
    const parse = (selector: string) =>
      new Map(
        [...previewCss(atelier).split('}')]
          .find((rule) => rule.trimStart().startsWith(`${selector}{`))
          ?.split('\n')
          .flatMap((line) => {
            const found = /^\s*--([\w-]+): (.+);$/.exec(line)
            return found ? [[`--${found[1]}`, found[2]] as [string, string]] : []
          }),
      )

    expect(parse('html:root')).toEqual(new Map(declarations(preset, 'light')))
    expect(parse('html:root.dark')).toEqual(new Map(declarations(preset, 'dark')))
  })

  it('emits a key only when both grounds say it, in alphabetical order', () => {
    const css = previewCss({
      theme: { radius: '1rem' },
      light: { primary: 'red', solo: 'x' },
      dark: { primary: 'blue' },
    })

    expect(css).toBe(
      'html:root{\n  --primary: red;\n  --radius: 1rem;\n}\nhtml:root.dark{\n  --primary: blue;\n  --radius: 1rem;\n}\n',
    )
  })
})
