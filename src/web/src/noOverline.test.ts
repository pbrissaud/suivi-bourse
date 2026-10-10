/**
 * **No overline, and no card that floats** (#1111).
 *
 * DESIGN.md: "Don't use uppercase letter-spaced overlines or a kicker above a
 * heading", and the app is flat, depth coming from the step between grounds.
 * Both are absences, which no rendering test can see, so they are held on the
 * source: every class string in every component, `ui/` included, since the
 * table header and the menu shortcut lived there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { read, WEB_ROOT } from '@/test/stylesheet'

const SRC = path.join(WEB_ROOT, 'src')
const OVERLINE = new Set([
  'uppercase',
  'tracking-caps',
  'tracking-wide',
  'tracking-wider',
  'tracking-widest',
  'eyebrow',
])

function components(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return components(full)
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : []
  })
}

/** Every token of every string literal, comments removed first. */
function classTokens(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '')
  return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].flatMap((literal) =>
    (literal[1] ?? literal[2] ?? literal[3])
      .split(/\s+/)
      // A variant is not the class: `xl:tracking-widest` is `tracking-widest`.
      .map((token) => token.slice(token.lastIndexOf(':') + 1)),
  )
}

describe('the overline is gone', () => {
  it('is set by no class in any component', () => {
    const offenders = components(SRC).flatMap((file) =>
      classTokens(fs.readFileSync(file, 'utf8'))
        .filter((token) => OVERLINE.has(token))
        .map((token) => `${path.relative(WEB_ROOT, file)} — ${token}`),
    )
    expect(offenders).toEqual([])
  })

  it('has no utility or tracking left to be reached for', () => {
    const source = read()
    expect(source).not.toMatch(/@utility eyebrow/)
    expect(source).not.toMatch(/--tracking-caps/)
  })
})

describe('the card is flat', () => {
  it('carries no shadow', () => {
    const card = fs.readFileSync(path.join(SRC, 'components', 'ui', 'card.tsx'), 'utf8')
    expect(classTokens(card).filter((token) => /^shadow(-|$)/.test(token))).toEqual([])
  })
})
