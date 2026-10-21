import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'

// WCAG 2.5.8: the drawn size stays, the hit area grows to 24 px.
it.each([
  ['checkbox', <Checkbox key="c" aria-label="x" />],
  ['switch', <Switch key="s" aria-label="x" />],
])('the %s extends its hit area past its drawing', (role, node) => {
  render(node)
  const target = screen.getByRole(role)
  expect(target).toHaveClass('relative', 'after:-inset-1')
})

it('the small switch grows its height to 24 px as well', () => {
  render(<Switch size="sm" aria-label="x" />)
  expect(screen.getByRole('switch')).toHaveClass('data-[size=sm]:after:-inset-y-1.25')
})
