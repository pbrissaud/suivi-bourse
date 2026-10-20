import * as React from 'react'

const MOBILE_BREAKPOINT = 768

const isNarrow = () => window.innerWidth < MOBILE_BREAKPOINT

export function useIsMobile() {
  // Read at the first render, so a phone never paints the desktop layout first.
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => typeof window !== 'undefined' && isNarrow(),
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(isNarrow())
    mql.addEventListener('change', onChange)
    setIsMobile(isNarrow())
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
