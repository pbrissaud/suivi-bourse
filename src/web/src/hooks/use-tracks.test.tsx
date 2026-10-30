import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useTrackCount } from '@/hooks/use-tracks'
import { setViewportWidth } from '@/test/media'

describe('useTrackCount', () => {
  it.each([
    [390, 1],
    [1024, 2],
    [1599, 2],
    [1600, 3],
    [1920, 3],
  ] as const)('is %i px wide: %i track(s), from the first render', (width, tracks) => {
    setViewportWidth(width)
    const { result } = renderHook(() => useTrackCount())

    expect(result.current).toBe(tracks)
  })

  it('follows the viewport across 768 px and 1 600 px', () => {
    setViewportWidth(1024)
    const { result } = renderHook(() => useTrackCount())

    act(() => setViewportWidth(1600))
    expect(result.current).toBe(3)
    act(() => setViewportWidth(1599))
    expect(result.current).toBe(2)
    act(() => setViewportWidth(767))
    expect(result.current).toBe(1)
  })
})
