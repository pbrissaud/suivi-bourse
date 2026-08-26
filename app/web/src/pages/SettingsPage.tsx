/**
 * Settings — **the fifth page, and now a page rather than a copy of a tab**
 * (#830, ADR-0038).
 *
 * ADR-0030 cut the data page into three tabs and defended ADR-0020's four-page
 * cut with one sentence: *a tab is not a page*. Two records took tabs off that
 * page afterwards — ADR-0036 withdrew the notices' exception, ADR-0037 moved
 * them behind the header's bell — and what was left was the ledger and the
 * installation. **A two-tab bar is a bar that should not exist**: it spends a
 * control and a level of nesting on a choice between two things that have
 * nothing to do with each other, what the owner *declared* and what the
 * installation *is*. So the installation is an address of its own, the bar goes
 * with it, and ADR-0020's cut is amended in its count and kept in its
 * principle.
 *
 * **The block is the page now.** #828 gave this route the `Installation`
 * component unchanged, deliberately, and left the surface mounted twice; what
 * that cost was visible in the wording — an `<h1>` reading *Réglages* over an
 * `<h2>` reading *Réglages*, one page's title said twice with a card in
 * between. So the composition moves here and the wrapper disappears: the
 * sections are the five the mock-up names, each one a card that says what it
 * holds, and the page's own name is said once, in the header, by
 * `usePageHeading`.
 *
 * **One column, and it is narrower than the shell** (#787). The column itself
 * is uncapped since #792, because a dashboard and a table of ten columns want
 * every pixel; a form of six fields and four key/value lists wants the opposite,
 * and the mock-up bounds this page at 880 px for the reason any prose surface
 * is bounded — a label at the far left of a 2 560 px screen and its value at
 * the far right are one row nobody reads across. The bound is the *page's*, in
 * the same way the shares table's own is the table's.
 *
 * **A read that did not answer is said where its block would have been** (#829,
 * ADR-0037). There is no band above this page: the dials are a *read* as much
 * as a form, so `/api/config` refusing leaves the space they would have filled
 * and that space is where it says so — a page that rendered nothing would make
 * *the store is unreadable* and *there is nothing to say about this
 * installation* the same screen, in its worst form, a blank one.
 *
 * The store block is the exception that proves it: its two facts about the file
 * ride on the runtime, so they stay on screen through exactly that failure —
 * and through that read being merely **in flight**, which is why the block
 * waits a row at a time rather than whole (#777, ADR-0026). Both reads reach it
 * as `?? null`, the shape a read that has not landed crosses a prop as.
 */
import { useQuery } from '@tanstack/react-query'

import { Unreadable } from '@/components/Unreadable'
import { DialsBlock } from '@/components/settings/DialsBlock'
import { EnvironmentBlock } from '@/components/settings/EnvironmentBlock'
import { JobsBlock } from '@/components/settings/JobsBlock'
import { OrphansBlock } from '@/components/settings/OrphansBlock'
import { RebuildBlock } from '@/components/settings/RebuildBlock'
import { StoreBlock } from '@/components/settings/StoreBlock'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { oneFailure, readConditions } from '@/lib/status'

export default function SettingsPage() {
  const { t } = useI18n()

  // The heading is the shell's to draw (#789) and the page's to declare, which
  // is what gives a screen reader a title on this route like on the other four.
  usePageHeading(t('page.settings'))

  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const store = useQuery({ queryKey: ['store'], queryFn: api.store })
  // **The same read the bell makes**, under the same key: the panel's health
  // card is one word and this page is that word developed, so a second query
  // would be a second observation of one installation — and the two would
  // disagree the moment one of them refetched (ADR-0037).
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
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
    // 880 px, from the mock-up, and centred in whatever the shell gives. Every
    // block under here is a row of label and value: the bound is what keeps the
    // two ends of one row within a saccade of each other.
    <div className="mx-auto w-full max-w-[55rem] space-y-6">
      {/* Full width and first, because it is what the bell sent the reader here
          for, and because a progress bar in a column is a progress bar nobody
          reads across. */}
      <RebuildBlock
        runtime={runtime.data ?? null}
        firstEvent={firstEvent}
        accounts={accounts.data ?? null}
      />

      {/* The dials need the registry to draw themselves, so they wait for it: a
          form of six fields that appeared empty and then filled in would let a
          reader type into a dial whose bounds had not arrived. */}
      {settingsFailure !== null ? (
        <Unreadable failure={settingsFailure} />
      ) : config.data ? (
        <DialsBlock config={config.data} runtime={runtime.data} />
      ) : null}

      {/* What the bell's colour is a fold of, one line per workload (ADR-0037). */}
      <JobsBlock health={health.data ?? null} />

      {/* Absent at zero, and never a maintenance table: it is the visible
          consequence of a gesture the reader has just made. */}
      <OrphansBlock orphans={store.data?.orphans ?? null} />

      <StoreBlock
        runtimeStore={runtime.data?.store ?? null}
        store={store.data ?? null}
        failure={storeFailure}
      />

      {/* Last, because it is the only block on the page nothing can be done
          about from here. It rides on the same read as the dials. */}
      {config.data ? <EnvironmentBlock config={config.data} /> : null}
    </div>
  )
}
