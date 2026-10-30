/**
 * « Nothing followed »: a title, one sentence and a primary button to the sheet
 * that follows them (#1312).
 *
 * **No numbered steps and no promised duration.** An ETF back to 2008 takes
 * about twenty minutes, and the sentence under the title already says the
 * download goes on without the owner.
 */
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'

export function NothingFollowed() {
  const { t } = useI18n()

  return (
    <EmptyState
      title={t('benchmark.empty.title')}
      description={t('benchmark.empty.body')}
      action={
        <Button asChild className="max-md:h-11">
          <Link to="/settings" hash="portfolio-references">
            {t('benchmark.empty.choose')}
          </Link>
        </Button>
      }
    />
  )
}
