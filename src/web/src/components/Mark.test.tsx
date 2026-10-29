import fs from 'node:fs'
import path from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Mark } from '@/components/Mark'

describe('the product mark (#1337)', () => {
  it('draws dots at 28 px and a heavier solid line under 24 px', () => {
    const big = render(<Mark size={28} />).container.querySelector('svg')!
    const small = render(<Mark size={16} />).container.querySelector('svg')!
    expect(big.querySelector('[stroke-dasharray]')).not.toBeNull()
    expect(small.querySelector('[stroke-dasharray]')).toBeNull()
    expect(Number(small.getAttribute('stroke-width'))).toBeGreaterThan(
      Number(big.getAttribute('stroke-width')),
    )
  })

  it('takes its colours from the sidebar tokens, none of its own', () => {
    const svg = render(<Mark />).container.querySelector('svg')!
    expect(svg.querySelector('rect')!.getAttribute('class')).toContain('fill-sidebar-primary')
    expect(svg.getAttribute('class')).toContain('text-sidebar-primary-foreground')
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}|oklch|rgb/i)
  })

  it('is declared as the favicon', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
      expect(html).toContain(`/${file}`)
      expect(fs.existsSync(path.join(root, 'public', file))).toBe(true)
    }
  })
})
