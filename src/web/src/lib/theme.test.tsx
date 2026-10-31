/** `setPreviewGround` (#1314): a ground shown whatever the reader chose, never remembered. */
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from '@/lib/theme'

function Probe() {
  const { ground, setChoice, setPreviewGround } = useTheme()
  return (
    <>
      <output>{ground}</output>
      <button type="button" onClick={() => setChoice('light')}>
        light
      </button>
      <button type="button" onClick={() => setPreviewGround('dark')}>
        preview
      </button>
      <button type="button" onClick={() => setPreviewGround(null)}>
        stop
      </button>
    </>
  )
}

afterEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
})

describe('the preview ground', () => {
  it('wins over the choice, is never stored, and null gives the choice back', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const click = (name: string) => act(() => screen.getByRole('button', { name }).click())

    click('light')
    expect(screen.getByRole('status')).toHaveTextContent('light')
    click('preview')
    expect(screen.getByRole('status')).toHaveTextContent('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    click('stop')
    expect(screen.getByRole('status')).toHaveTextContent('light')
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
