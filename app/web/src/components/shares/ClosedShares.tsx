/**
 * The closed positions — they **fold**, they are never filtered out (ADR-0017).
 *
 * The fold is a fold: the header above the live table goes on summing them, so
 * the identity holds without the reader having to know it exists. A *hide the
 * closed ones* switch would have made a second figure that is also correct
 * (+977,61 € against +1 686,53 € on the real portfolio, 73 % of what is shown,
 * over seven lines out of nineteen) with nothing on screen to say which one is
 * the gain.
 *
 * Three properties, each measured rather than preferred:
 *
 *  - **Its columns are its own** — `Titre · Soldée le · Réalisée · Dividendes ·
 *    Compte`. No price, no quantity, no unit cost, no latent gain: in a single
 *    table those five cells are an em dash on every row of the section. It is
 *    not the same table; it is the same vocabulary.
 *  - **It sorts on the closing date, descending.** Market value is zero across
 *    the whole section, and a column of zeros orders nothing. That column is the
 *    only one that discriminates these rows, and the live table does not have it.
 *  - **It is closed on load, and its summary line already carries `Réalisée` and
 *    `Dividendes`** — so the figure that matters is legible folded, and opening
 *    it is an intention rather than a discovery.
 *
 * **No icon lives here.** ADR-0016 is *one per figure and per surface*, and the
 * folded section is not a surface but a part of the page (#684 D7) — which is
 * what takes the page's eleven candidate icons down to nine.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { renderAccounts } from '@/components/shares/SharesTable'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { ShareRow } from '@/lib/shares'
import { signClass } from '@/lib/sign'

export interface ClosedSharesProps {
  rows: readonly ShareRow[]
  currency: string | null
  onSelect: (symbol: string) => void
}

export function ClosedShares({ rows, currency, onSelect }: ClosedSharesProps) {
  const { t } = useI18n()
  const f = useFormatters()
  // Closed at the first load, deliberately. It is a state of the page and not a
  // preference: nothing remembers it, so opening it never becomes the default
  // for a reader who opened it once.
  // No `aria-controls`: the section is closed at the first load, so the panel it
  // would name is not in the document at the very moment the page renders — a
  // reference that resolves to nothing is worse than none. `aria-expanded`
  // already carries what a reader needs, and the panel follows the button.
  const [open, setOpen] = useState(false)

  if (rows.length === 0) return null

  const realised = rows.reduce((sum, row) => sum + row.realised, 0)
  const dividends = rows.reduce((sum, row) => sum + row.dividends, 0)

  return (
    <section className="rounded-lg border">
      <h2 className="sr-only">{t('shares.closed.label')}</h2>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
          className="inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
        >
          <ChevronRight
            className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          {t('shares.closed.toggle', { count: rows.length })}
        </button>

        {/* The summary line — the information is legible folded. */}
        <span className="text-sm text-muted-foreground">
          {t('shares.column.realised')}{' '}
          <span className={`tabular ${signClass(realised)}`}>{f.currency(realised, currency)}</span>
        </span>
        <span className="text-sm text-muted-foreground">
          {t('shares.column.dividends')}{' '}
          <span className={`tabular ${signClass(0)}`}>{f.currency(dividends, currency)}</span>
        </span>
      </div>

      {open ? (
        <div className="border-t">
          <Table>
            <caption className="sr-only">{t('shares.closed.label')}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('shares.column.symbol')}</TableHead>
                <TableHead>{t('shares.column.closedOn')}</TableHead>
                <TableHead className="text-right">{t('shares.column.realised')}</TableHead>
                <TableHead className="text-right">{t('shares.column.dividends')}</TableHead>
                <TableHead>{t('shares.column.account')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.symbol}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium underline-offset-4 hover:underline"
                      onClick={() => onSelect(row.symbol)}
                    >
                      {row.name ?? row.symbol}
                    </button>
                    <span className="block text-xs text-muted-foreground">{row.symbol}</span>
                  </TableCell>
                  {/* The one column that discriminates these rows. An em dash
                      where the store has no date: there is nothing to compute. */}
                  <TableCell>{row.closedAt === null ? ABSENT : f.date(row.closedAt)}</TableCell>
                  <TableCell className={`text-right tabular ${signClass(row.realised)}`}>
                    {f.currency(row.realised, currency)}
                  </TableCell>
                  <TableCell className={`text-right tabular ${signClass(0)}`}>
                    {f.currency(row.dividends, currency)}
                  </TableCell>
                  <TableCell>{renderAccounts(row.accounts)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </section>
  )
}
