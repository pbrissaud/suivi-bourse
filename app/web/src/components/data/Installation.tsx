/**
 * Tab 2 — **the installation**, as opposed to what the user declared (#724,
 * ADR-0020, ADR-0014).
 *
 * The line between the two tabs is ADR-0014's boot test transposed to the
 * render, and this side of it holds three blocks in one order: **Notices ·
 * Settings · The store**. What comes first is what the installation has to say
 * to its owner, then what they can change about it, then what it *is*.
 *
 * **A block with nothing in it does not exist.** The notices block is absent at
 * zero and the layout shifts when one appears — that shift is the point, and it
 * is the counterpart of the badge on the tab: a badge that promised something
 * and left the reader hunting for it is the failure the criterion names.
 *
 * The reads follow the rule the other pages keep: `/api/runtime` answers from
 * process memory and never opens the store (#668), so the shell's banner is
 * **silent** on the one failure that empties this tab — and a tab that rendered
 * nothing there would make *the store is unreadable* and *there is nothing to
 * say about this installation* the same screen, in its worst form, a blank one.
 * `lib/status.ts` keeps the causal order, so it is still one band or none.
 *
 * The store block is the exception that proves it: its two facts about the file
 * ride on the runtime, so they stay on screen through exactly that failure —
 * and through that read being merely **in flight**, which is why the block
 * waits a row at a time rather than whole (#777, ADR-0026). Both reads reach it
 * as `?? null`, the shape a read that has not landed crosses a prop as.
 */
import { useQuery } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { AdvisoriesBlock } from '@/components/data/AdvisoriesBlock'
import { SettingsBlock } from '@/components/data/SettingsBlock'
import { RebuildBlock } from '@/components/data/RebuildBlock'
import { StoreBlock } from '@/components/data/StoreBlock'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { oneBand, readConditions } from '@/lib/status'

export interface InstallationProps {
  /** Take the reader to the ledger, reduced to every security a notice names. */
  onShowInLedger: (symbols: readonly string[]) => void
}

export function Installation({ onShowInLedger }: InstallationProps) {
  const { t } = useI18n()

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const advisories = useQuery({ queryKey: ['advisories'], queryFn: api.advisories })
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const store = useQuery({ queryKey: ['store'], queryFn: api.store })
  // The reconstruction's two other facts (#787). Both are **optional** to it:
  // the ledger gives the bar its denominator and the declaration gives the
  // lagging account its name, and an absent one removes a bar or a name rather
  // than falsifying the sentence — so neither is waited for.
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  const firstEvent = (events.data ?? []).reduce<string | null>(
    (oldest, event) =>
      event.date !== null && (oldest === null || event.date < oldest) ? event.date : oldest,
    null,
  )

  const failure = oneBand(
    readConditions({
      shellError: runtime.error,
      // Causal order: the dials and the notices both live in the store, so the
      // first of the two to fail is the one that names the cause.
      errors: [config.error, advisories.error, store.error],
    }),
  )

  return (
    <div className="space-y-8">
      {failure ? <Band>{t(failure.message)}</Band> : null}

      {/* First, because it is what the dot sent the reader here for. */}
      <RebuildBlock
        runtime={runtime.data ?? null}
        firstEvent={firstEvent}
        accounts={accounts.data ?? null}
      />

      {advisories.data ? (
        <AdvisoriesBlock advisories={advisories.data} onShowInLedger={onShowInLedger} />
      ) : null}

      {/* The settings surface needs the registry to draw itself, so it waits
          for it: a form of six fields that appeared empty and then filled in
          would let a reader type into a dial whose bounds had not arrived. */}
      {config.data ? <SettingsBlock config={config.data} runtime={runtime.data} /> : null}

      <StoreBlock runtimeStore={runtime.data?.store ?? null} store={store.data ?? null} />
    </div>
  )
}
