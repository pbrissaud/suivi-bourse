/**
 * **A read that did not answer**, said where its content would have been
 * (#829, ADR-0037).
 *
 * It is what the band used to say, one floor down. A *band* was a strip across
 * the top of the content column, and ADR-0037 retires it without replacement:
 * what was true of the installation is an entry of the notifications panel now,
 * and *this block asked for something and did not get it* is said by the block,
 * in the space the answer would have filled. **There is no band anywhere.**
 *
 * It is an `EmptyState` and not an `Alert`, and that is the whole decision. The
 * two claims a surface with nothing on it can make — *you own nothing yet* and
 * *the store would not answer* — are told apart by the **sentence**, which is
 * exactly what ADR-0026 asks for; they were told apart by a red strip somewhere
 * else on the page, which is what let a page be empty and explained at opposite
 * ends of the screen.
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
