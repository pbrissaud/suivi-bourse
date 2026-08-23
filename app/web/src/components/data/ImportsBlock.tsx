/**
 * **Import et export** — the unit of revocation, and the way back out (#728,
 * #794, ADR-0020, ADR-0030, ADR-0015, ADR-0005).
 *
 * Since #794 it is **one band above the ledger table**, and it holds three
 * things: the drop zone, the export menu and the imported files with their
 * revocation. That placement is ADR-0020's, restored — provenance is a property
 * of a *declared row*, and the provenance cell is already a link into this
 * list, so split across two tabs that link crossed the page.
 *
 * What replaces #662's per-row repair apparatus is not another per-row gesture:
 * it is **the source**. A decision was taken against the interview here and it
 * refutes itself once rendered — *« Oublier l'import »* is not offered from a
 * line. Three consecutive rows of the export showed three identical red
 * *« Oublier cet import (214) »* buttons: the subject of the gesture is the
 * file, repeating it on 214 rows makes it read as a row gesture, and **somebody
 * deletes 214 events believing they are removing one**. It is the padlock's rule
 * from the other end — what a row carries is information, never the mass action
 * attached to it.
 *
 * Five things about the block are decisions:
 *
 *  - **The file's presence on disk is never shown.** The store is the truth and
 *    the drop folder is an optional read-only bind, so *not found* would be a
 *    permanent false defect on every install without one.
 *  - **The fingerprint is not a column.** Nobody reads a hexadecimal, and what
 *    it has to say — *the same file was dropped again, nothing moved* — is a
 *    message at the instant of the import, which is where the server says it
 *    (`main._import_drop_folder`).
 *  - **The box counts before, not after**, in the three units a reader owns —
 *    rows, securities, accounts — and every one of them is a difference against
 *    what survives rather than the size of the source.
 *  - **It never says *reversible*.** Re-importing is possible; the bind is
 *    optional, so the app **does not know** whether the reader still has the
 *    file. *« Ré-importable si vous avez encore le fichier »* is the sentence
 *    that is true, and *« annulable »* is discarded for that reason alone.
 *  - **The export is four files and one of them is the reduction** (#796). It
 *    was *total or nothing* until this ticket, on the argument that a partial
 *    file is not a round trip and makes re-importing look like a restore. What
 *    settles it is the **name**: the server calls a reduction a selection and
 *    not a backup, so the file cannot replace the whole one on a disk — and the
 *    reduction is taken on the side that owns the importable form, so what
 *    comes back is an ordinary event file rather than an extract wearing one's
 *    clothes. The menu itself is `ExportMenu.tsx`.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { ExportMenu } from '@/components/data/ExportMenu'
import { UploadZone, type EventUpload } from '@/components/data/UploadZone'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { declaredLabel } from '@/lib/accounts'
import {
  api,
  type AccountsResponse,
  type ImportKind,
  type ImportsResponse,
  type LedgerEvent,
} from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { exportable, importRows, type ImportRow } from '@/lib/imports'
import type { LedgerFilters } from '@/lib/ledger'
import { problemMessageKey } from '@/lib/problem'

/** One key per kind, so the catalogue is reached by a name and not by a fold. */
const KIND_KEYS: Record<ImportKind, MessageKey> = {
  events: 'data.imports.kind.events',
  accounts: 'data.imports.kind.accounts',
}

export interface ImportsBlockProps {
  /**
   * The upload gesture, held by the tab (#811). It comes down rather than being
   * made here because the zone is mounted in **two** places and the first
   * import moves the reader from one to the other.
   */
  upload: EventUpload
  /** What `/api/imports` served. `null` — it has not landed (ADR-0026). */
  imports: ImportsResponse | null
  /** The ledger this tab has already read: what a revocation is counted from. */
  events: readonly LedgerEvent[]
  /**
   * The declaration. **A needed read, `null` while it has not landed** — it is
   * what the verdict rests on, so read as *nothing is declared* this block
   * offers a gesture the server refuses and states an effect nobody measured.
   */
  accounts: AccountsResponse | null
  /**
   * The source a provenance cell asked to see, and a **fresh object per
   * gesture**: following the same line twice has to mark the row twice.
   */
  highlight?: { id: number }
  /**
   * The reduction the table holds, and how many rows it retains (#796) — what
   * the *filtered selection* entry of the menu exports. It comes down from the
   * tab rather than being read here: the chips are the ledger's, and this band
   * only offers the gesture.
   */
  selection: LedgerFilters
  selected: number
}

export function ImportsBlock({
  upload,
  imports,
  events,
  accounts,
  highlight,
  selection,
  selected,
}: ImportsBlockProps) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState<ImportRow | null>(null)
  const queryClient = useQueryClient()

  const forget = useMutation({
    mutationFn: (id: number) => api.forgetImport(id),
    onSuccess: () => {
      setConfirming(null)
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously before answering (#697), so what is invalidated is
      // everything rather than a list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
    },
  })

  const rows = importRows(imports, events, accounts)
  const files = exportable(events, accounts)

  // A block with nothing in it does not exist (#724) — and *nothing* here is
  // both halves at once: no source has ever been imported and there is nothing
  // to hand back. A read in flight takes the same road, which is the one road
  // that claims nothing: `importRows` answers `[]` on either of its two, and
  // `exportable` answers *no accounts file* on a declaration that has not
  // landed.
  //
  // **It waits by the rows a read owns, not whole** (#777's notch). The list
  // and the accounts file both rest on the declaration and are withheld with
  // it; the events file rests on the ledger alone, which this tab has already
  // read, so it renders. What must never appear is a *verdict* about a source —
  // the gesture, or the effect it announces — decided on a payload that has not
  // arrived.
  if (rows.length === 0 && !files.events && !files.accounts) return null

  return (
    <section
      aria-labelledby="data-imports"
      className="space-y-4 rounded-lg border border-dashed p-4"
    >
      <h2 id="data-imports" className="sr-only">
        {t('data.imports.title')}
      </h2>

      {/* The drop zone and the way back out, on one line: the two gestures a
          file is the unit of. Since #811 the zone is a **target** rather than
          the name of a folder — there is a route now, and a rectangle that
          named a mount was the honest answer only while there was not.

          It is **not said twice**: with nothing recorded, the ledger's own
          empty state carries the same gesture as one of its two entries of
          equal weight, one line below this band. An install with a source on
          record and no event — an accounts file, or every import forgotten —
          is exactly where both would otherwise render. */}
      {events.length > 0 || files.events || files.accounts ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          {events.length > 0 ? <UploadZone upload={upload} /> : null}
          {files.events || files.accounts ? (
            <ExportMenu files={files} selection={selection} selected={selected} />
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ImportsTable
          rows={rows}
          highlight={highlight?.id ?? null}
          // The refusal is forgotten with the box that carried it: a mutation
          // error outlives its gesture, so opening the next source's box would
          // show it a `409` about the previous one.
          onForget={(row) => {
            forget.reset()
            setConfirming(row)
          }}
          pending={forget.isPending}
        />
      ) : null}

      <ForgetDialog
        row={confirming}
        accounts={accounts}
        pending={forget.isPending}
        error={forget.error}
        onClose={() => setConfirming(null)}
        onConfirm={(id) => forget.mutate(id)}
      />
    </section>
  )
}

/**
 * Five columns — `Fichier · Nature · Importé le · Lignes` and the gesture —
 * ordered **by kind then by name**, accounts sources first. That order is the
 * one `event.account` referencing `account(id)` imposes on an import, shown as
 * it is rather than chosen.
 */
function ImportsTable({
  rows,
  highlight,
  onForget,
  pending,
}: {
  rows: readonly ImportRow[]
  highlight: number | null
  onForget: (row: ImportRow) => void
  pending: boolean
}) {
  const { t } = useI18n()
  const f = useFormatters()

  return (
    <Table>
      <caption className="sr-only">{t('data.imports.title')}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('data.imports.column.file')}</TableHead>
          <TableHead>{t('data.imports.column.kind')}</TableHead>
          <TableHead>{t('data.imports.column.at')}</TableHead>
          <TableHead className="text-right">{t('data.imports.column.rows')}</TableHead>
          <TableHead>{t('data.imports.column.revocation')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ record, revocation }) => {
          const marked = highlight === record.id
          return (
            <TableRow
              key={record.id}
              id={`import-${record.id}`}
              aria-current={marked ? 'true' : undefined}
              className={marked ? 'bg-attention/10' : undefined}
            >
              <TableCell className="font-medium">
                {record.filename}
                {marked ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t('data.imports.highlighted')}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>{t(KIND_KEYS[record.kind])}</TableCell>
              <TableCell className="whitespace-nowrap">{f.dateTime(record.imported_at)}</TableCell>
              {/* An accounts source lays down no event, and `0` there would read
                  as a file that carried nothing rather than as one that carries
                  another kind of thing. */}
              <TableCell className="text-right tabular">
                {record.kind === 'accounts' ? (
                  <span className="text-xs text-muted-foreground">
                    {t('data.imports.rows.accounts')}
                  </span>
                ) : (
                  f.quantity(record.events)
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {revocation.kind === 'offered' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => onForget({ record, revocation })}
                  >
                    {t('data.imports.forget')}
                  </Button>
                ) : (
                  // The refusal `accounts.delete_account` would answer, named
                  // rather than offered and refused: the count is the exact
                  // thing the owner has to act on, and the order to follow is
                  // readable from it.
                  t('data.imports.forget.blocked', { count: revocation.count })
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * The box, which **counts before the gesture and never after it** — and says
 * two things the mock-up brought out and no question aimed at: what re-importing
 * really depends on, and that forgetting a source of *events* changes the
 * deletability of an account it does not touch.
 */
function ForgetDialog({
  row,
  accounts,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  row: ImportRow | null
  accounts: AccountsResponse | null
  pending: boolean
  /**
   * A refusal the reader could not foresee — the ledger moved under them between
   * the render and the click. It is rendered **here** and not in the section: the
   * box stays open on a failure, and Radix marks everything behind the overlay
   * `aria-hidden`, so a band in the section is a sentence nobody can read while
   * the only thing on screen is the box that produced it.
   */
  error: unknown
  onClose: () => void
  onConfirm: (id: number) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()

  const effect = row?.revocation.kind === 'offered' ? row.revocation.effect : null

  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        {row && effect ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('data.imports.confirm.title', { file: row.record.filename })}</DialogTitle>
              <DialogDescription>
                {row.record.kind === 'accounts'
                  ? t('data.imports.confirm.effect.accounts', { accounts: effect.accounts })
                  : t('data.imports.confirm.effect', {
                      events: effect.events,
                      symbols: effect.symbols,
                      accounts: effect.accounts,
                    })}
              </DialogDescription>
            </DialogHeader>

            {effect.frees.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('data.imports.confirm.frees', {
                  count: effect.frees.length,
                  accounts: f.list(effect.frees.map((id) => nameOf(id, accounts))),
                })}
              </p>
            ) : null}

            {/* Never *reversible*: the app cannot observe whether the file is
                still on the reader's disk, and the drop folder may not even be
                mounted. */}
            <p className="text-sm text-muted-foreground">{t('data.imports.confirm.reimport')}</p>

            {error ? <Band>{t(problemMessageKey(error))}</Band> : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t('data.imports.confirm.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => onConfirm(row.record.id)}
              >
                {t('data.imports.confirm.submit')}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** An account under the name the declaration gives it, never a bare id. */
function nameOf(id: string, accounts: AccountsResponse | null): string {
  const account = accounts?.accounts.find((candidate) => candidate.id === id)
  // The seeded row is never one of these — `removalOf` answers `seeded` for it
  // before it can ever be freed — so there is no catalogue name to reach for
  // here, only the name its owner gave it and the id events spell.
  return account ? (declaredLabel(account) ?? account.id) : id
}
