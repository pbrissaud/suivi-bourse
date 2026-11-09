import { useEffect, useState } from 'react'

/** From here the threads are a rail beside the conversation. */
const WIDE_FROM = 1024

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_FROM)
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE_FROM)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return wide
}
