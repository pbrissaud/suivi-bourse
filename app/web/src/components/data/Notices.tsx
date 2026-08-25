/**
 * Tab 2 — **the notices**, an ordinary block again (#821, ADR-0036).
 *
 * This was the one place in the product where a block with nothing in it
 * existed, and the reason was the status dot: ADR-0022 made it *lead* somewhere
 * rather than indicate without pointing, and a destination that came and went
 * with the dot's colour would give one control two addresses — so the tab
 * answered *nothing to report*, which was said to answer exactly the question
 * the dot asks. **The dot does not ask it.** It points at the installation tab,
 * where the jobs and the store are, which is where one repairs, and that is
 * what the code has always done. The exception outlived its argument, so it
 * goes: the block **does not exist when it is empty**, and *a block with
 * nothing in it does not exist* has no exception anywhere.
 *
 * The objection the exception was defended with — acknowledging the last notice
 * makes the surface vanish under the reader — is now the behaviour, and it is
 * the ordinary one: the tab stays, still selected, and it has nothing left to
 * say.
 *
 * What is **not** withdrawn is ADR-0026. *Nothing to report* was a claim about
 * this installation, and so is every notice: nothing is rendered — title
 * included — while `/api/installation-facts` is in flight. It is the same
 * silence the block renders once the read lands empty, and the two being
 * identical on screen is exactly the member ADR-0026 holds on the source rather
 * than through the net.
 *
 * The notice that names events **leads to them**, and its subject is on the
 * other tab, so the reduction is decided one level up where both halves are in
 * scope (`DataPage`).
 */
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { InstallationFactsBlock } from '@/components/data/InstallationFactsBlock'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
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
  // than letting this tab render the silence of an installation with nothing to
  // report over a read that failed.
  const failure = oneBand(
    readConditions({ shellError: runtime.error, errors: [facts.error] }),
  )

  // **A needed read** (ADR-0026): a notice is a statement about the reader's own
  // installation, so nothing crosses into the block until the read lands — and
  // the block itself is what decides that a landed empty list renders nothing.
  const landed = facts.data

  return (
    <div className="space-y-8">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {landed ? (
        <InstallationFactsBlock facts={landed} onShowInLedger={onShowInLedger} />
      ) : null}
    </div>
  )
}
