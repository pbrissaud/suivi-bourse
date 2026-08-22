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
 * `Saisie manuelle` on the rows the app may edit.
 *
 * Since #795 the table is also **bounded and revealed** (ADR-0031): the header
 * is sticky, the body scrolls inside its own container, and how many rows are in
 * it is the caller's business — this component draws what it is handed and
 * says nothing about what it was not. The type is a coloured badge and the four
 * money columns are set in the mono face, both for the same reason: forty rows
 * are read by scanning down a column, not across a row.
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
import { cn } from '@/lib/utils'

/** The six, named by their **effect** and never by their code (ADR-0024). */
export const TYPE_LABEL: Record<LedgerEventType, MessageKey> = {
  BUY: 'event.type.BUY',
  SELL: 'event.type.SELL',
  GRANT: 'event.type.GRANT',
  DIVIDEND: 'event.type.DIVIDEND',
  DEPOSIT: 'event.type.DEPOSIT',
  WITHDRAWAL: 'event.type.WITHDRAWAL',
}

/**
 * The badge's hue, and **it is spent where the product already spends it**
 * (#787, ADR-0016's rationing one notch down).
 *
 * The attribution and the dividend own a colour already — `--grant` and
 * `--dividend` are the two marks the share's chart draws its events with — so
 * they wear the same one here and a reader crossing from one surface to the
 * other reads the same mark twice. The purchase takes the quotation's own mint
 * and the sale the loss's red, which is the pair the redesign drew; the two cash
 * movements name no security at all and take the muted pill, because the
 * product's colour vocabulary has nothing to say about a transfer.
 *
 * The risk this palette would otherwise run — a green pill read as *this row
 * gained* — is not open here: **no figure in this table is coloured**. The
 * amounts are the plain foreground (`f.currency`, never `signClass`), so the
 * badge is the only colour in the row and the only thing it can be about is the
 * word printed inside it. `lib/sign.ts` keeps its monopoly on colouring a
 * *figure*, which is the invariant `index.css` states.
 */
const TYPE_BADGE: Record<LedgerEventType, string> = {
  BUY: 'bg-price/12 text-price',
  SELL: 'bg-loss/12 text-loss',
  GRANT: 'bg-grant/15 text-grant',
  DIVIDEND: 'bg-dividend/15 text-dividend',
  DEPOSIT: 'bg-muted text-muted-foreground',
  WITHDRAWAL: 'bg-muted text-muted-foreground',
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

  // The header stays put while the body scrolls under it: on a table revealed
  // forty rows at a time, a heading that leaves the viewport takes the meaning
  // of nine columns with it. The ground is opaque because the rows pass beneath.
  const head = 'sticky top-0 z-10 bg-background'

  return (
    <Table containerClassName="max-h-[calc(100vh-22rem)] min-h-64 overflow-y-auto rounded-md border">
      <caption className="sr-only">{t('data.ledger.label')}</caption>
      <TableHeader>
        <TableRow>
          <TableHead className={head}>{t('data.column.date')}</TableHead>
          <TableHead className={head}>{t('data.column.type')}</TableHead>
          <TableHead className={head}>{t('data.column.what')}</TableHead>
          <TableHead className={cn(head, 'text-right')}>{t('data.column.quantity')}</TableHead>
          <TableHead className={cn(head, 'text-right')}>{t('data.column.unitPrice')}</TableHead>
          <TableHead className={cn(head, 'text-right')}>{t('data.column.fee')}</TableHead>
          <TableHead className={cn(head, 'text-right')}>{t('data.column.amount')}</TableHead>
          <TableHead className={head}>{t('data.column.account')}</TableHead>
          <TableHead className={head}>{t('data.column.provenance')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event, index) => {
          const identity = identityOf(event)
          return (
            <TableRow key={rowKey(event, index)}>
              <TableCell className="tabular whitespace-nowrap">{f.date(event.date)}</TableCell>
              <TableCell>
                <span
                  className={cn(
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    TYPE_BADGE[event.event_type],
                  )}
                >
                  {t(TYPE_LABEL[event.event_type])}
                </span>
              </TableCell>

              {/* The ticker in first rank, the label in second — and the label
                  alone where there is no security to name. */}
              <TableCell>
                <Identity event={event} onEdit={onEdit} />
                {identity.ticker !== null && identity.label !== null ? (
                  <span className="block text-xs text-muted-foreground">{identity.label}</span>
                ) : null}
              </TableCell>

              {/* An em dash here is ADR-0016's own: a transfer has no quantity
                  to be missing, and a dividend no unit price. The four money
                  columns are set in the **mono** face on top of the tabular
                  figures: read down a column of forty rows, the two together are
                  what lets a comma line up with a comma. */}
              <TableCell className="text-right font-mono tabular">
                {f.quantity(event.quantity)}
              </TableCell>
              <TableCell className="text-right font-mono tabular">
                {f.currency(event.unit_price, currency)}
              </TableCell>
              <TableCell className="text-right font-mono tabular">
                {f.currency(event.fee, currency)}
              </TableCell>
              <TableCell className="text-right font-mono tabular">
                {f.currency(event.amount, currency)}
              </TableCell>

              {/* An account id is typed, not written: the mono face is what
                  says so, and it is the one the accounts page already sets an
                  id in (`AccountDetail`, `AccountsRail`). */}
              <TableCell className="font-mono text-xs">{accountOf(event)}</TableCell>
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
