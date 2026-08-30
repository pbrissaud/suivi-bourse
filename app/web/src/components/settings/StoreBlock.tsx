/**
 * *The store* — a card of the settings page (#724, #830, ADR-0015, ADR-0038,
 * spec #695 § 10).
 *
 * Four things, and each one is here because of what it prevents:
 *
 *  - **The path, and whether it survives.** Both come off `/api/runtime`, which
 *    opens nothing — so they are still on screen when the store itself cannot
 *    answer, which is exactly the moment *"where did my data go?"* is asked.
 *  - **An ephemeral store dominates the block** instead of appearing in it as a
 *    note. This is the only screen where a trial run learns that it is a trial
 *    run, and *this container keeps nothing* is not a footnote to a file size.
 *    It is **never a notice**: its predicate is not acknowledgeable — the
 *    container either keeps nothing or it does — so acknowledging it would make
 *    it go quiet while it was still true, and counting it would give a permanent
 *    badge.
 *  - **The size, with what a purge will not do.** Measured: 79 % of a real
 *    store's rows purged for **zero bytes** returned — 126,0 Mo before, 126,0 Mo
 *    after, the same content rebuilt from scratch fitting in 26,0. Shown bare
 *    beside a purge button the figure is a lie by juxtaposition; hidden, it is
 *    still there for anyone who runs `du`, and only its explanation is gone.
 *  - **The last write of the ledger**, and never the last observed price. The
 *    second is liveness, which the bell answers (#829, ADR-0037); here it would
 *    make a store whose last import was a year ago read as freshly written.
 *
 * **Its rows come from two reads, so it waits a row at a time** (#777,
 * ADR-0026). The rule as ADR-0026 writes it — *a block that waits renders
 * nothing, title included* — would take the first of the four with it, and that
 * one is on `/api/runtime` precisely so that it survives the store not
 * answering. So it is applied one notch lower, on the rows a read owns, the way
 * #775 applied it to the accounts table's `perf` cells: what a read has not
 * answered yet is not rendered at all, an em dash and a sentence being two ways
 * of stating something nobody has observed. The block waits **whole** in one
 * state only, neither read having landed.
 *
 * **The orphans are a card of their own** since #830 (`OrphansBlock`), which is
 * what the mock-up draws and what the enumeration of ADR-0038 already implied:
 * a securities list with a destructive gesture on it is not a fifth row of a
 * key/value list about a file. What is left here is the file.
 */
import { Unreadable } from '@/components/Unreadable'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import type { RuntimeStore, StoreState } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

/** The id the card's landmark is named by — one constant, two readers. */
const STORE_HEADING = 'settings-store'

export interface StoreBlockProps {
  /**
   * The path and the persistence, from the resource that opens nothing —
   * **`null` until `GET /api/runtime` has landed** (#777, ADR-0026).
   */
  runtimeStore: RuntimeStore | null
  /**
   * The figures — **`null` until `GET /api/store` has landed**, failure
   * included (#777, ADR-0026). The two facts above them come off
   * `/api/runtime`, which opens nothing, so the card itself never waits: what
   * waits is what this read alone can say.
   */
  store: StoreState | null
  /**
   * `GET /api/store` refused — `null` when it answered or is still in flight.
   * The two are **not** the same news: in flight the figures are simply not
   * there yet, refused they are not coming, and since #829 there is no band
   * above the page to say so on the card's behalf (ADR-0037).
   */
  failure?: ReadFailure | null
}

export function StoreBlock({ runtimeStore, store, failure = null }: StoreBlockProps) {
  const { t } = useI18n()
  const format = useFormatters()

  // **Neither read has landed, so the block does not exist yet** (#777,
  // ADR-0026): a title over an empty frame is the hand-written skeleton this
  // product has none of. It is the only state where the block waits as a
  // whole — the moment *one* of the two answers, what that one knows is on
  // screen and stays there whatever becomes of the other.
  if (!runtimeStore && !store) {
    // Unless the read was **refused**, and then even a block with nothing in it
    // owes the reason: a settings page with a hole where the store's figures
    // go, and no word anywhere, is the screen ADR-0037 moved the sentence down
    // a floor to abolish.
    return failure === null ? null : <Unreadable failure={failure} />
  }

  return (
    <Card role="region" aria-labelledby={STORE_HEADING}>
      <CardHeader>
        <h2 id={STORE_HEADING} className="eyebrow">
          {t('installation.store')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-4">
      {/* It dominates. Not a note under the size, not a notice in the block
          above — the one screen where a trial run learns what it is. */}
      {runtimeStore?.persistence === 'ephemeral' ? (
        <div className="rounded-lg border border-attention/50 bg-attention/10 p-4">
          <p className="font-medium">{t('installation.store.ephemeral.title')}</p>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t('installation.store.ephemeral.body')}
          </p>
        </div>
      ) : null}

      <dl className="divide-y rounded-lg border text-sm">
        {/* Same rule on the other read: *« Impossible d’observer d’ici »* is
            one of the three answers the kernel gives, so writing it while
            `/api/runtime` is in flight states an observation nobody made — and
            the em dash beside it said *there is nothing to compute* about a
            path that exists. Found by widening the net, in the block the
            widening was written for. */}
        {runtimeStore ? (
          <div className="space-y-1 px-4 py-3">
            <dt className="text-muted-foreground">{t('installation.store.path')}</dt>
            {/* The em dash survives the gate, and only there: the read has
                landed and the process named no store, which is ADR-0016's
                *there is nothing to compute*. The `??` the row was gated out of
                was carrying two states at once — that one and a read that had
                said nothing yet — and only the second is #777's. */}
            <dd className="font-mono text-xs break-all">{runtimeStore.path ?? ABSENT}</dd>
            <p className="text-xs text-muted-foreground">
              {t('installation.store.persistence', { state: runtimeStore.persistence })}
            </p>
          </div>
        ) : null}

        {/* **The two rows this read owns do not exist until it has landed**
            (#777, ADR-0026): *« Rien n’a encore été importé »* is a statement
            about the reader's own ledger, and an em dash on the size is
            ADR-0016's *there is nothing to compute* about a file that has one.
            Both were written from the absence of a value, which a silence is
            not. It is the block's own rule — *a block that waits renders
            nothing, title included* — applied one notch lower, exactly as #775
            applied it to the accounts table's `perf` cells; and it is what lets
            the path and the persistence stay on screen, which is the whole
            point of #668's split and the moment *« où sont passées mes
            données ? »* is asked. */}
        {store ? (
          <>
            <div className="space-y-1 px-4 py-3">
              <dt className="text-muted-foreground">{t('installation.store.size')}</dt>
              <dd className="tabular">{format.bytes(store.size_bytes)}</dd>
              {/* The sentence travels with the figure, always — it is what stops
                  the purge below reading as a way to get bytes back. */}
              <p className="max-w-prose text-xs text-muted-foreground">
                {t('installation.store.size.note')}
              </p>
            </div>

            <div className="space-y-1 px-4 py-3">
              <dt className="text-muted-foreground">{t('installation.store.lastWrite')}</dt>
              <dd className="tabular">
                {store.ledger_last_write
                  ? format.dateTime(store.ledger_last_write)
                  : t('installation.store.lastWrite.never')}
              </dd>
            </div>
          </>
        ) : failure !== null ? (
          // **The two rows the read owns, replaced by the reason they are not
          // there** (#829, ADR-0037). In flight they simply do not exist yet;
          // refused, they never will, and the path and the persistence beside
          // them — which ride on `/api/runtime` — must not make the block look
          // whole. It sits in the list, in the slot the rows would have taken.
          <Unreadable failure={failure} />
        ) : null}
      </dl>

      </CardContent>
    </Card>
  )
}
