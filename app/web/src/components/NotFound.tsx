import { Link } from '@tanstack/react-router'

import { useT } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'

export function NotFound() {
  const t = useT()
  // An address that matches nothing is still a place, and the header names it
  // the way it names the four that do (#789).
  usePageHeading(t('notFound.title'))
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t('notFound.body')}{' '}
        <Link to="/" className="underline">
          {t('notFound.link')}
        </Link>
      </p>
    </div>
  )
}
