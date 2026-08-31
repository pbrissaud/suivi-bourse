/**
 * **Why this page is empty**, said one floor below where the band said it
 * (#829, ADR-0037).
 *
 * The banner's own sentence — *no base currency has been chosen, so nothing is
 * converted and no performance is computed* — took the top of every route for a
 * condition that is about **three** of them. ADR-0037 retires the strip and
 * moves the sentence to its subject: the dashboard, the securities and the
 * accounts each render this instead of a column of em dashes, and the reader is
 * told why what they are looking at is not there.
 *
 * **The ledger is deliberately not one of the three.** Its events are
 * *declared*, and a declaration needs no unit to be read back: it is their
 * valuation that waits. A page that hid the ledger over a missing currency
 * would hide the only thing the owner can act on.
 *
 * The condition is also an entry in the notifications panel, pinned, and that
 * is not two announcers on one fact but the rule ADR-0037 writes in its place:
 * *the empty state says why what you are looking at is empty; the panel says
 * what you might do about something that is nonetheless right.*
 */
import { Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/EmptyState'
import { useI18n } from '@/lib/i18n'

export function NoBaseCurrency() {
  const { t } = useI18n()

  return (
    <EmptyState
      title={t('empty.noCurrency.title')}
      description={t('empty.noCurrency.body')}
      action={
        // To the field, and never to an acknowledgement: this is a condition
        // the reader can make stop, and what makes it stop is an answer.
        <Link to="/settings" className="font-medium underline underline-offset-4">
          {t('empty.noCurrency.link')}
        </Link>
      }
    />
  )
}
