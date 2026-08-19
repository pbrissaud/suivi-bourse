/**
 * The ledger — **eight columns plus the provenance** (#723, ADR-0020).
 *
 *     Date · Type · De quoi il s'agit · Quantité · Prix unitaire · Frais ·
 *     Montant · Compte          (+ Provenance)
 *
 * Two decisions were taken here **against** the interview, both in front of a
 * board mounted on the 285 real events:
 *
 *  - **The identity column is not `Titre`.** The interview had concluded the
 *    free-text label should leave the table, *"empty almost everywhere"*.
 *    Measured, it is the opposite: **278 rows out of 285** carry one, median 36
 *    characters, 101 distinct values — and a `DEPOSIT` or a `WITHDRAWAL` has no
 *    symbol at all (`Apple Pay Top up`, `Incoming transfer from BRISSAUD`), so
 *    there the label **is** the identity. One column does the work for both
 *    families, in place of a `Symbole` empty 105 times out of 285 doubled by a
 *    `Notes` truncated one row in two.
 *  - **`Nom` is not a column.** The security's name is an attribute of the
 *    security, not of each of its 285 events; repeating it is declaration
 *    duplicated, and the ticker already identifies the line.
 *
 * **And there is no padlock column.** Rendered, read-only-per-row gave 285 rows
 * out of 285 carrying an identical lock — a per-row marker that does not
 * discriminate is noise however correct it is (ADR-0016). Nothing replaces it,
 * because nothing has to: *a row that carries a provenance came from a file; a
 * row that carries none was typed here*. The information was already in the one
 * column that actually discriminates, and it is that same column that says
 * `Saisi dans l'application` on the rows the app may edit.
 *
 * **The provenance is a label, never an address** — the file's *name* and its
 * line, never a path, and never its presence on disk: the drop folder is an
 * optional read-only bind (ADR-0015), so *file not found* would be a permanent
 * false defect on every install without one.
 *
 * Since #728 it is also a **link**, and that is the whole of what it is worth
 * besides the label: it names the **unit of revocation**, and it leads to the
 * one place that unit can be acted on. What it does *not* carry is the gesture
 * itself — three consecutive lines showed three identical red *Oublier cet
 * import (214)* buttons and somebody deletes 214 events believing they are
 * removing one. A row carries information; the mass action attached to it lives
 * where its subject is, once.
 *
 * **Zero explanation icons.** The page's two live on the create form, where the
 * sentence can still change a behaviour (#684 D7).
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { LedgerEvent, LedgerEventType } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { accountOf, identityOf, isEditable, rowKey } from '@/lib/ledger'

/** The six, named by their **effect** and never by their code (ADR-0024). */
export const TYPE_LABEL: Record<LedgerEventType, MessageKey> = {
  BUY: 'event.type.BUY',
  SELL: 'event.type.SELL',
  GRANT: 'event.type.GRANT',
  DIVIDEND: 'event.type.DIVIDEND',
  DEPOSIT: 'event.type.DEPOSIT',
  WITHDRAWAL: 'event.type.WITHDRAWAL',
}

export interface LedgerTableProps {
  events: readonly LedgerEvent[]
  currency: string | null
  /** Opens the panel on a row. Offered for editable rows only. */
  onEdit: (event: LedgerEvent) => void
  /**
   * Marks this row's source in *Import et export*, where the one forget is —
   * and **`null` while that list has not landed**: a label that leads to a
   * block which is not on screen is a promise the page cannot keep, so it stays
   * the plain label it has always been.
   */
  onShowImport: ((id: number) => void) | null
}

export function LedgerTable({ events, currency, onEdit, onShowImport }: LedgerTableProps) {
  const { t } = useI18n()
  const f = useFormatters()

  return (
    <Table>
      <caption className="sr-only">{t('data.ledger.label')}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('data.column.date')}</TableHead>
          <TableHead>{t('data.column.type')}</TableHead>
          <TableHead>{t('data.column.what')}</TableHead>
          <TableHead className="text-right">{t('data.column.quantity')}</TableHead>
          <TableHead className="text-right">{t('data.column.unitPrice')}</TableHead>
          <TableHead className="text-right">{t('data.column.fee')}</TableHead>
          <TableHead className="text-right">{t('data.column.amount')}</TableHead>
          <TableHead>{t('data.column.account')}</TableHead>
          <TableHead>{t('data.column.provenance')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event, index) => {
          const identity = identityOf(event)
          return (
            <TableRow key={rowKey(event, index)}>
              <TableCell className="whitespace-nowrap">{f.date(event.date)}</TableCell>
              <TableCell>{t(TYPE_LABEL[event.event_type])}</TableCell>

              {/* The ticker in first rank, the label in second — and the label
                  alone where there is no security to name. */}
              <TableCell>
                <Identity event={event} onEdit={onEdit} />
                {identity.ticker !== null && identity.label !== null ? (
                  <span className="block text-xs text-muted-foreground">{identity.label}</span>
                ) : null}
              </TableCell>

              {/* An em dash here is ADR-0016's own: a transfer has no quantity
                  to be missing, and a dividend no unit price. */}
              <TableCell className="text-right tabular">{f.quantity(event.quantity)}</TableCell>
              <TableCell className="text-right tabular">
                {f.currency(event.unit_price, currency)}
              </TableCell>
              <TableCell className="text-right tabular">
                {f.currency(event.fee, currency)}
              </TableCell>
              <TableCell className="text-right tabular">
                {f.currency(event.amount, currency)}
              </TableCell>

              <TableCell>{accountOf(event)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <Provenance event={event} onShowImport={onShowImport} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * The row's own name — and the **only** editing affordance on the page. It is a
 * button exactly where a row may be edited, which is where the inline editor of
 * #662 survives and nowhere else: on an install that has only ever imported, it
 * is never rendered at all. A column for it would fail the same test the padlock
 * failed, one heading appearing on a table where no row can use it.
 */
function Identity({
  event,
  onEdit,
}: {
  event: LedgerEvent
  onEdit: (event: LedgerEvent) => void
}) {
  const identity = identityOf(event)
  const name = identity.ticker ?? identity.label

  if (name === null) return <span className="text-muted-foreground">{ABSENT}</span>
  if (!isEditable(event)) return <span className="font-medium">{name}</span>
  return (
    <button
      type="button"
      className="font-medium underline-offset-4 hover:underline"
      onClick={() => onEdit(event)}
    >
      {name}
    </button>
  )
}

/**
 * The label, composed **here** rather than read off the wire. The store renders
 * one of its own (`2024.csv, row 14`) and it is kept as a fallback only: a
 * rendering follows the reader's language (ADR-0024), and a sentence built in
 * the server's is a French page with an English cell in it.
 *
 * A row with no source says so in words. The em dash was refused: by ADR-0016 it
 * means *there is nothing to compute*, and there is something here — the row was
 * typed in the app, which is precisely the fact the padlock column was trying to
 * carry 285 times.
 */
function Provenance({
  event,
  onShowImport,
}: {
  event: LedgerEvent
  onShowImport: ((id: number) => void) | null
}) {
  const { t } = useI18n()
  const source = event.source_id
  if (source === null) return <>{t('data.provenance.app')}</>
  if (onShowImport === null) return <>{label(event, t)}</>

  // Its accessible name is the label itself: a second one would be a second
  // rendering of the provenance, and the two would drift.
  return (
    <button
      type="button"
      className="text-left underline-offset-4 hover:underline"
      title={t('data.imports.show')}
      onClick={() => onShowImport(source)}
    >
      {label(event, t)}
    </button>
  )
}

/** The label, composed in the reader's language, the store's own as a fallback. */
function label(event: LedgerEvent, t: ReturnType<typeof useI18n>['t']): string {
  const file = event.source_filename
  if (!file) return event.provenance ?? ''
  if (event.source_row === null) return t('data.provenance.file', { file })
  if (event.source_sheet) {
    return t('data.provenance.sheet', {
      file,
      sheet: event.source_sheet,
      line: event.source_row,
    })
  }
  return t('data.provenance.line', { file, line: event.source_row })
}
