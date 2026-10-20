import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useIsMobile } from '@/hooks/use-mobile'
import { setViewportWidth } from '@/test/media'

describe('useIsMobile', () => {
  it('answers from the width at the first render, before any effect', () => {
    setViewportWidth(390)
    const seen: boolean[] = []
    renderHook(() => {
      const mobile = useIsMobile()
      seen.push(mobile)
      return mobile
    })

    // A phone never renders the desktop layout, not even once.
    expect(seen[0]).toBe(true)
    expect(new Set(seen)).toEqual(new Set([true]))
  })

  it('follows the viewport across the breakpoint', () => {
    setViewportWidth(1024)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)

    act(() => setViewportWidth(767))
    expect(result.current).toBe(true)
    act(() => setViewportWidth(768))
    expect(result.current).toBe(false)
  })
})
