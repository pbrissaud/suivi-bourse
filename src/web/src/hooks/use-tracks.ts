import * as React from 'react'

import { useIsMobile } from '@/hooks/use-mobile'

// The CSS `--breakpoint-3xl` (index.css), in the same unit: 1 600 px at the default root size.
const WIDE = '(min-width: 100rem)'

function useIsWide() {
  const [wide, setWide] = React.useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(WIDE).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(WIDE)
    const onChange = () => setWide(mql.matches)
    mql.addEventListener('change', onChange)
    setWide(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return wide
}

/** The dashboard grid's tracks: one under 768 px, three from 1 600 px, two between. */
export function useTrackCount(): 1 | 2 | 3 {
  const mobile = useIsMobile()
  const wide = useIsWide()
  return mobile ? 1 : wide ? 3 : 2
}
