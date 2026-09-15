/**
 * **Why this page is empty**, said one floor below where the band said it
 * (#829).
 *
 * The banner's own sentence — *no base currency has been chosen, so nothing is
 * converted and no performance is computed* — took the top of every route for a
 * condition that is about **three** of them.
 *
 * **The ledger is deliberately not one of the three.** Its events are
 * *declared*, and a declaration needs no unit to be read back: it is their
 * valuation that waits. A page that hid the ledger over a missing currency
 * would hide the only thing the owner can act on.
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
