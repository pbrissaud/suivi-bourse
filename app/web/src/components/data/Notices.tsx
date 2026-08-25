/**
 * Tab 2 — **the notices**, and the one block in the product that exists when it
 * has nothing in it (#794, ADR-0030).
 *
 * *A block with nothing in it does not exist* is unchanged everywhere else —
 * the orphan list, the empty ledger, the import band. It is reversed here, and
 * for one reason: the status dot **leads** somewhere (ADR-0022) instead of
 * indicating without pointing, and a destination that existed only while the
 * dot was amber would give one control two addresses. A tab answering *nothing
 * to report* answers exactly the question the dot asks. The alternative loses on
 * its own terms too: acknowledging the last notice would make the tab vanish
 * under the reader's cursor.
 *
 * What is **not** reversed is ADR-0026. *Nothing to report* is a claim about
 * this installation, so it is never written while `/api/installation-facts` is in
 * flight: the tab is mounted, and it renders nothing at all — title included —
 * until the read lands. The tab's own permanence is the trigger's, not this
 * block's.
 *
 * The notice that names events **leads to them**, and its subject is on the
 * other tab, so the reduction is decided one level up where both halves are in
 * scope (`DataPage`).
 */
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { EmptyState } from '@/components/EmptyState'
import { InstallationFactsBlock } from '@/components/data/InstallationFactsBlock'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { shownFacts } from '@/lib/installationFacts'
import { oneBand, readConditions } from '@/lib/status'

export interface NoticesProps {
  /** Take the reader to the ledger, reduced to every security a notice names. */
  onShowInLedger: (symbols: readonly string[]) => void
}

export function Notices({ onShowInLedger }: NoticesProps) {
  const { t } = useI18n()

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const facts = useQuery({ queryKey: ['installation-facts'], queryFn: api.installationFacts })

  // One band on screen or none, and the causal order is the shell's own: the
  // notices live in the store, so an unreadable store names the cause rather
  // than letting this tab say the installation has nothing to report.
  const failure = oneBand(
    readConditions({ shellError: runtime.error, errors: [facts.error] }),
  )

  // **A needed read** (ADR-0026): both of the two things this tab can say — a
  // list of notices, and *nothing to report* — are statements about the
  // reader's own installation.
  const landed = facts.data

  return (
    <div className="space-y-8">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {!landed ? null : shownFacts(landed).length === 0 ? (
        <EmptyState
          title={t('data.notices.empty.title')}
          description={t('data.notices.empty.body')}
        />
      ) : (
        <InstallationFactsBlock facts={landed} onShowInLedger={onShowInLedger} />
      )}
    </div>
  )
}
