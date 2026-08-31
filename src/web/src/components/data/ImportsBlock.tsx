/**
 * **Import et export** — the way in, and the way back out (#728, #794, #811,
 * ADR-0020, ADR-0030, ADR-0032, ADR-0005).
 *
 * One **imports bar** above the ledger table, and since #816 it holds **two**
 * things: the
 * drop zone and the export menu. The third — the imported files with their
 * revocation — went with the population it described.
 *
 * The argument for it was never a taste, and it is worth keeping written down
 * because it is what makes losing it safe. Offering *« Oublier l'import »* from
 * a *row* gave three consecutive lines carrying three identical red
 * *« Oublier cet import (214) »* buttons: the subject of the gesture was the
 * file, repeating it on 214 rows made it read as a row gesture, and **somebody
 * deletes 214 events believing they are removing one**. So the gesture lived
 * here, once, beside its subject.
 *
 * ADR-0032 removes the subject rather than the placement. A mounted file was a
 * second truth and had to be revocable whole because its rows could not be
 * corrected; an uploaded file is a payload, its rows are ordinary rows, and
 * undoing an import is **the deletion on the ledger's own reduction**
 * (`BulkDelete`) — which is offered where the reduction is, names it, counts its
 * rows, and reaches the twelve events somebody mistyped as well.
 *
 * Two things about what is left are still decisions:
 *
 *  - **The export is four files, one of which is the reduction and one of which
 *    is not a backup at all** (#796, #836, ADR-0034). It
 *    was *total or nothing* until #796, on the argument that a partial
 *    file is not a round trip and makes re-importing look like a restore. What
 *    settles it is the **name**: the server calls a reduction a selection and
 *    not a backup, so the file cannot replace the whole one on a disk — and the
 *    reduction is taken on the side that owns the importable form, so what comes
 *    back is an ordinary event file rather than an extract wearing one's
 *    clothes. The fourth, since #836, is the accounts and their positions: a
 *    *report*, refused by the import in one sentence, which is what keeps it on
 *    the right side of ADR-0034. The menu itself is `ExportMenu.tsx`.
 *  - **A block with nothing in it does not exist** (#724). Here *nothing* is
 *    both halves at once: nothing to hand over to and nothing to hand back.
 */
import { ExportMenu } from '@/components/data/ExportMenu'
import { UploadZone, type EventUpload } from '@/components/data/UploadZone'
import type { LedgerEvent } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { exportable } from '@/lib/imports'
import type { LedgerFilters } from '@/lib/ledger'

export interface ImportsBlockProps {
  /**
   * The upload gesture, held by the tab (#811). It comes down rather than being
   * made here because the zone is mounted in **two** places and the first
   * import moves the reader from one to the other.
   */
  upload: EventUpload
  /** The ledger this tab has already read: what there is to hand back. */
  events: readonly LedgerEvent[]
  /**
   * The reduction the table holds, and how many rows it retains (#796) — what
   * the *filtered selection* entry of the menu exports. It comes down from the
   * tab rather than being read here: the chips are the ledger's, and this bar
   * only offers the gesture.
   */
  selection: LedgerFilters
  selected: number
}

export function ImportsBlock({ upload, events, selection, selected }: ImportsBlockProps) {
  const { t } = useI18n()

  const files = exportable(events)

  // Nothing to hand over to and nothing to hand back: the block does not exist
  // (#724). One question and no longer two since ADR-0034 — there is no
  // accounts file to weigh, so what there is to export is what the ledger holds.
  if (events.length === 0 && !files.events) return null

  return (
    <section aria-labelledby="data-imports">
      <h2 id="data-imports" className="sr-only">
        {t('data.imports.title')}
      </h2>

      {/* **One band, and the two gestures a file is the unit of are on it**
          (#838). The drop zone is a *target* rather than the name of a folder
          (#811), and the way back out rides at its right rather than in a
          second box beside it — which is the drawing's own row, and what keeps
          the two together at the widths the band folds at.

          It is **not said twice**: with nothing recorded, the ledger's own
          empty state carries the same gesture as one of its two entries of
          equal weight, one line below this band. */}
      {events.length > 0 ? (
        <UploadZone
          upload={upload}
          trailing={
            files.events ? (
              <ExportMenu
                files={files}
                selection={selection}
                selected={selected}
                // The ledger entire, for the two entries whose perimeter it is:
                // the count is a note on what the file will hold.
                total={events.length}
              />
            ) : null
          }
        />
      ) : files.events ? (
        <div className="flex justify-end">
          <ExportMenu
            files={files}
            selection={selection}
            selected={selected}
            total={events.length}
          />
        </div>
      ) : null}
    </section>
  )
}