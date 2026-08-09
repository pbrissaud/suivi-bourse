import { Link } from '@tanstack/react-router'

import { useT } from '@/lib/i18n'

export function NotFound() {
  const t = useT()
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t('notFound.title')}</h1>
      <p className="text-sm text-muted-foreground">
        {t('notFound.body')}{' '}
        <Link to="/" className="underline">
          {t('notFound.link')}
        </Link>
      </p>
    </div>
  )
}
