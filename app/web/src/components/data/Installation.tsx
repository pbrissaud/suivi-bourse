/**
 * Tab 3 — **the installation**, as opposed to what the user declared (#724,
 * #794, ADR-0020, ADR-0014, ADR-0030).
 *
 * The line between the tabs is ADR-0014's boot test transposed to the render,
 * and what is left on this side of it is *what the installation is*: the
 * reconstruction the dot leads to, the settings, the store and its orphans.
 * **The notices left** at #794 — a notice is prose, and a card in a column
 * beside the store has nowhere to say *a `config.yaml` of the v4 sits in the
 * configuration directory and is not read*, with a date, an acknowledgement and
 * a link to the events concerned.
 *
 * **Two tracks from `lg`**, and the split is what each block is about: the
 * settings are a form the reader fills in, the store is a fact they read. Below
 * `lg` — the 976 px case ADR-0022 measured — it is one column, in the order the
 * blocks are written.
 *
 * **A read that did not answer is said where its block would have been** (#829,
 * ADR-0037). There is no band above this tab any more: the settings are a
 * *read* as much as a form, so `/api/config` refusing leaves the column that
 * holds them empty, and that column is where it says so — a tab that rendered
 * nothing would make *the store is unreadable* and *there is nothing to say
 * about this installation* the same screen, in its worst form, a blank one.
 *
 * The store block is the exception that proves it: its two facts about the file
 * ride on the runtime, so they stay on screen through exactly that failure —
 * and through that read being merely **in flight**, which is why the block
 * waits a row at a time rather than whole (#777, ADR-0026). Both reads reach it
 * as `?? null`, the shape a read that has not landed crosses a prop as.
 */
import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { SettingsBlock } from '@/components/data/SettingsBlock'
import { RebuildBlock } from '@/components/data/RebuildBlock'
import { StoreBlock } from '@/components/data/StoreBlock'
import { api } from '@/lib/api'
import { oneFailure, readConditions } from '@/lib/status'

export function Installation() {
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
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

  // **One failure per block, said by the block.** The dials and the store's own
  // figures both come out of the store, and either read can refuse on its own;
  // what the reader loses is that block, and what they are told is why, in the
  // space it would have filled. `/api/runtime` is in neither list — see above.
  const settingsFailure = oneFailure(readConditions({ errors: [config.error] }))
  const storeFailure = oneFailure(readConditions({ errors: [store.error] }))

  return (
    <div className="space-y-8">
      {/* Full width and first, because it is what the dot sent the reader here
          for, and because a progress bar in a column is a progress bar nobody
          reads across. */}
      <RebuildBlock
        runtime={runtime.data ?? null}
        firstEvent={firstEvent}
        accounts={accounts.data ?? null}
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* The settings surface needs the registry to draw itself, so it waits
            for it: a form of six fields that appeared empty and then filled in
            would let a reader type into a dial whose bounds had not arrived. */}
        <div className="space-y-8">
          {settingsFailure !== null ? (
            <Unreadable failure={settingsFailure} />
          ) : config.data ? (
            <SettingsBlock config={config.data} runtime={runtime.data} />
          ) : null}
        </div>
        <div className="space-y-8">
          <StoreBlock
            runtimeStore={runtime.data?.store ?? null}
            store={store.data ?? null}
            failure={storeFailure}
          />
        </div>
      </div>
    </div>
  )
}
