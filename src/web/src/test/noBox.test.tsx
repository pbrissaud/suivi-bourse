import { render } from '@testing-library/react'
import { expect, it } from 'vitest'

import { expectNoBox } from '@/test/noBox'

it('refuses a card, and a box drawn by hand', () => {
  const card = render(<div data-slot="card" />)
  expect(() => expectNoBox(card.container)).toThrow()
  card.unmount()

  const drawn = render(<section className="rounded-xl border bg-card" />)
  expect(() => expectNoBox(drawn.container)).toThrow()
  drawn.unmount()

  // A control is drawn that way on purpose, and a section is not a box.
  const fine = render(
    <>
      <input className="border bg-card" />
      <section data-slot="section" className="bg-muted" />
    </>,
  )
  expect(() => expectNoBox(fine.container)).not.toThrow()
})
