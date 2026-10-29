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

  it('switches variant exactly at 24 px, 28 by default', () => {
    const at = (size?: number) => render(<Mark size={size} />).container.querySelector('svg')!
    expect(at(23).querySelector('[stroke-dasharray]')).toBeNull()
    expect(at(23).querySelector('circle')!.getAttribute('r')).toBe('2.6')
    expect(at(24).querySelector('[stroke-dasharray]')).not.toBeNull()
    expect(at(24).querySelector('circle')!.getAttribute('r')).toBe('2.2')
    expect(at().getAttribute('width')).toBe('28')
  })

  it('takes its colours from the sidebar tokens, none of its own', () => {
    const svg = render(<Mark />).container.querySelector('svg')!
    expect(svg.querySelector('rect')!.getAttribute('class')).toContain('fill-sidebar-primary')
    expect(svg.getAttribute('class')).toContain('text-sidebar-primary-foreground')
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}|oklch|rgb/i)
  })

  const root = path.resolve(import.meta.dirname, '../..')
  const asset = (file: string) => fs.readFileSync(path.join(root, 'public', file))

  it('is declared as the favicon, the SVG last so a browser that reads it prefers it', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    const icons = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)]
    expect(icons.map(([, href]) => href)).toEqual([
      '/favicon-32.png',
      '/favicon.svg',
      '/apple-touch-icon.png',
    ])
    expect(html).toMatch(/type="image\/svg\+xml" sizes="any"/)
  })

  it('draws the favicon from the small variant, and the PNGs at their stated sizes', () => {
    const favicon = asset('favicon.svg').toString('utf8')
    const small = render(<Mark size={16} />).container.querySelector('svg')!
    expect(favicon).toContain(`viewBox="${small.getAttribute('viewBox')}"`)
    expect(favicon).toContain(`rx="${small.querySelector('rect')!.getAttribute('rx')}"`)
    for (const path of small.querySelectorAll('path')) {
      expect(favicon).toContain(`d="${path.getAttribute('d')}"`)
    }
    const dot = small.querySelector('circle')!
    for (const attribute of ['cx', 'cy', 'r']) {
      expect(favicon).toContain(`${attribute}="${dot.getAttribute(attribute)}"`)
    }
    // A PNG's width and height sit in its IHDR chunk, at bytes 16 and 20.
    for (const [file, side] of [
      ['favicon-32.png', 32],
      ['apple-touch-icon.png', 180],
    ] as const) {
      expect([asset(file).readUInt32BE(16), asset(file).readUInt32BE(20)]).toEqual([side, side])
    }
  })
})
