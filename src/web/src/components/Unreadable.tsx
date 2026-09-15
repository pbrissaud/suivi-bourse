/**
 * **A read that did not answer**, said where its content would have been
 * (#829).
 *
 * It is what the band used to say, one floor down. **There is no band
 * anywhere.**
 *
 * It is an `EmptyState` and not an `Alert`, and that is the whole decision.
 *
 * It carries no `role`. The one announcer of *the app is not answering* is the
 * bell, which is red and says so in prose the moment `/health` refuses — and a
 * live region per failed read would announce the same store six times.
 */
import { EmptyState } from '@/components/EmptyState'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

export function Unreadable({ failure }: { failure: ReadFailure }) {
  const { t } = useI18n()

  return (
    <EmptyState
      title={t('empty.unread.title')}
      description={t(failure.message, failure.values)}
    />
  )
}
