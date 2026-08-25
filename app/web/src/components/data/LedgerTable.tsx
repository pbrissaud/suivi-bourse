/**
 * The ledger — **eight columns** (#723, ADR-0020, ADR-0032).
 *
 *     Date · Type · De quoi il s'agit · Quantité · Prix unitaire · Frais ·
 *     Montant · Compte
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
 * **And there is no padlock column**, which the table proved before ADR-0032
 * settled it: rendered, read-only-per-row gave 285 rows out of 285 carrying an
 * identical lock, and a per-row marker that does not discriminate is noise
 * however correct it is (ADR-0016). Since #816 there is nothing left for it to
 * have discriminated on — **every** row is editable — so the lock, and the
 * `Provenance` column that carried the same fact more usefully, are both gone.
 *
 * Since #795 the table is also **bounded and revealed** (ADR-0031): the header
 * is sticky, the body scrolls inside its own container, and how many rows are in
 * it is the caller's business — this component draws what it is handed and
 * says nothing about what it was not. The type is a coloured badge and the four
 * money columns are set in the mono face, both for the same reason: forty rows
 * are read by scanning down a column, not across a row.
 *
 * **The ninth column left with its subject** (#816). It said *"row 14 of
 * 2024.csv"* and linked to the file's revocation, and both halves rested on the
 * same thing: a mounted file was re-read, so its rows had to be named and
 * revoked whole rather than corrected. A file is handed over once now. There is
 * no source to name, no revocation to lead to, and a row that came out of a file
 * is a row — so what the column would carry on all 285 lines is the same
 * nothing the padlock carried.
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
 * movements name no security at all and take an unhued pill, because the
 * product's colour vocabulary has nothing to say about a transfer.
 *
 * **The hue is the ground and the word is the foreground**, which is the one
 * thing here that was measured rather than chosen. The redesign draws these
 * badges as coloured *text* on a wash of its own hue, and that pairing cannot
 * clear 4,5:1 at 12 px on the light ground whatever the wash is set to — the
 * text and the wash share a hue, so raising the wash lowers the contrast and
 * lowering it converges on the token alone, which is 4,77:1 for `--primary` and
 * 4,85:1 for `--attention`. Measured on the light ground, a hovered row
 * included: 4,06 for the purchase and 4,30 for the dividend. Put the hue under
 * the foreground instead and the same six pills read at **12:1 or better on both
 * grounds**, the wash carrying the whole of the colour — which is also the more
 * honest reading of *the badge is coloured*.
 *
 * The risk the other way round would have run — a green pill read as *this row
 * gained* — was never open here either: **no figure in this table is coloured**.
 * The amounts are the plain foreground (`f.currency`, never `signClass`), so
 * `lib/sign.ts` keeps its monopoly on colouring a *figure*, which is the
 * invariant `index.css` states.
 */
const TYPE_BADGE: Record<LedgerEventType, string> = {
  BUY: 'bg-price/20',
  SELL: 'bg-loss/20',
  GRANT: 'bg-grant/20',
  DIVIDEND: 'bg-dividend/20',
  DEPOSIT: 'bg-muted',
  WITHDRAWAL: 'bg-muted',
}

export interface LedgerTableProps {
  events: readonly LedgerEvent[]
  currency: string | null
  /** Opens the panel on a row. Offered for every row that has a key. */
  onEdit: (event: LedgerEvent) => void
}

export function LedgerTable({ events, currency, onEdit }: LedgerTableProps) {
  const { t } = useI18n()
  const f = useFormatters()

  // The header stays put while the body scrolls under it: on a table revealed
  // forty rows at a time, a heading that leaves the viewport takes the meaning
  // of nine columns with it. The ground is opaque because the rows pass beneath.
  // The rule under it is a `box-shadow` and not the row's `border-b`: preflight
  // sets `border-collapse: collapse`, and under collapsed borders the border
  // belongs to the table box rather than to the cell — so a stuck header keeps
  // its ground and lets its own separator scroll away with the rows.
  const head =
    'sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)]'

  return (
    <Table containerClassName="max-h-[calc(100dvh-22rem)] min-h-64 overflow-y-auto rounded-md border">
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
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * The row's own name — and the **only** editing affordance on the page. It is a
 * button exactly where a row may be edited, which since #816 is every row that
 * has a key. A column for it would fail the same test the padlock failed: one
 * heading repeating on 285 rows what 285 rows already share.
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
