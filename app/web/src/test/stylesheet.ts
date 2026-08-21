/**
 * `index.css`, read as a structure rather than as text.
 *
 * Two tests need the same three things out of that file — which block a token
 * was declared in, what its `oklch()` components are, and what the ground of
 * each theme is — and they need them for the same reason: **the stylesheet is
 * the only source of those values**. `alloc.ts` generates the twelve allocation
 * stops but does not know the ground they are drawn on; `index.css` knows the
 * ground but generates nothing. A test that hard-coded either would be pinning
 * a copy, and a copy is what ADR-0023's cut exists to prevent.
 *
 * The parse is deliberately shallow: three banner comments cut the file into
 * blocks, and inside a block a `:root {` / `.dark {` header opens a run of
 * `--name: value;` lines. That is the whole grammar the file uses, and reaching
 * for a CSS parser would let this helper accept shapes the file is not allowed
 * to grow.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { Ground } from '@/lib/alloc'

export const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..')
export const INDEX_CSS = path.join(WEB_ROOT, 'src', 'index.css')

/** A numbered banner comment opens a block; the text after it is the block. */
const BANNER = /\/\*\s*=+\s*\n\s*\*\s*(\d+)\.\s*(.*?)\n/g

export interface Block {
  /** The number the banner carries — 1, 2, 3. */
  readonly index: number
  /** The banner's first line, for a failure message that names the block. */
  readonly title: string
  readonly text: string
}

/** The blocks of `index.css`, in file order. */
export function blocks(source: string = read()): readonly Block[] {
  const heads = [...source.matchAll(BANNER)]
  return heads.map((head, at) => ({
    index: Number(head[1]),
    title: head[2].trim(),
    text: source.slice(head.index + head[0].length, heads[at + 1]?.index ?? source.length),
  }))
}

export function read(): string {
  return fs.readFileSync(INDEX_CSS, 'utf8')
}

const SELECTOR: Record<Ground, RegExp> = {
  // `:root` also opens the `@theme inline` bridge's neighbours, so the match is
  // anchored at the start of a line — a selector, never a nested rule.
  light: /^:root\s*\{/m,
  dark: /^\.dark\s*\{/m,
}

/**
 * The custom properties one selector declares inside one block.
 *
 * Returns a map rather than a list because every caller asks *what is `--x`
 * here*, and none of them cares about declaration order.
 */
export function declarations(block: Block, ground: Ground): ReadonlyMap<string, string> {
  const opening = SELECTOR[ground].exec(block.text)
  if (!opening) return new Map()
  const body = block.text.slice(opening.index + opening[0].length)
  const end = body.indexOf('\n}')
  const rule = end === -1 ? body : body.slice(0, end)
  const found = new Map<string, string>()
  for (const line of rule.split('\n')) {
    const declaration = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line)
    if (declaration) found.set(declaration[1], declaration[2].trim())
  }
  return found
}

export interface Oklch {
  readonly lightness: number
  readonly chroma: number
  readonly hue: number
}

/** `oklch(L C H)` → its three components. Anything else is not a colour here. */
export function oklch(value: string): Oklch {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  if (!match) throw new Error(`not a plain oklch() value: ${value}`)
  return { lightness: Number(match[1]), chroma: Number(match[2]), hue: Number(match[3]) }
}

/**
 * The ground a theme is drawn on — `--background`, wherever it was declared.
 *
 * This is what makes *rank 1 is the most contrasted* testable: the claim is
 * about the ramp **against the ground**, and until now the ramp was only ever
 * compared with its own other end.
 */
export function ground(theme: Ground): Oklch {
  for (const block of blocks()) {
    const background = declarations(block, theme).get('--background')
    if (background) return oklch(background)
  }
  throw new Error(`no --background declared for the ${theme} theme`)
}
