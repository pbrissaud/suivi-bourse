import { expect } from 'vitest'

/**
 * A page's own block is a tinted section, and a card exists only for something
 * the reader decides (DESIGN.md, #1273). Nothing under `root` is a card, or a
 * hand-drawn one: a `border` over `bg-card`. A control (an input, a button) is
 * drawn that way on purpose and is not a block.
 */
export function expectNoBox(root: ParentNode = document.body) {
  expect(root.querySelectorAll('[data-slot="card"]')).toHaveLength(0)
  const drawn = [...root.querySelectorAll('*')].filter(
    (element) =>
      element.classList.contains('border') &&
      element.classList.contains('bg-card') &&
      !element.matches('input, textarea, select, button'),
  )
  expect(drawn.map((element) => element.outerHTML.slice(0, 120))).toEqual([])
}
