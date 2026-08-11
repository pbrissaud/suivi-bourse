/**
 * The live table — **nine columns** (#684 D3, ADR-0016, ADR-0017).
 *
 *     Titre · Cours · Détenu · PRU · Valorisation · Latente · Réalisée ·
 *     Dividendes · Compte
 *
 * with the percentage on a **second line under the latent gain** rather than in
 * a column of its own. Three columns are absent on purpose and each for its own
 * reason:
 *
 *  - **`Écart unitaire` is dead.** It is `Cours − PRU`, two columns already on
 *    the same line, and a position carried at its cost makes it **nil by
 *    construction** — a column whose remarkable value is a zero that means
 *    nothing.
 *  - **`Investi` does not come in**: it is `Valorisation − latente`, and it
 *    stays on the sheet.
 *  - **There is no fourth `Gain total` column.** The header *is* their sum, and
 *    a total never shares a row with its terms (ADR-0016): five numeric columns
 *    of equal weight say nothing about the last four being *inside* the first.
 *
 * **The label stays `PRU`** — the word the owner reads at their broker. *PMP*
 * is the name of the rule, and stating the rule is what ADR-0016 gave the
 * information icon for a job.
 *
 * **The market-state pill is not a column.** Eleven rows rendered ten identical
 * *Marché ouvert* and one *Cours figé*: a per-row marker that does not
 * discriminate is noise however correct it is. What is left is an icon glued to
 * the `Titre` cell of a share **the app** cannot price — never one the market
 * simply has closed — which is the single exception ADR-0016 allows to *icons
 * never go on a cell*, its text being a repair rather than a convention.
 *
 * **And there is no date column.** One mention at the level of the page says
 * *Cours au …*; the rows that depart from it already say so by the absence rule,
 * the em dash in `Cours` being the signal itself.
 */
import { TriangleAlert } from 'lucide-react'

import { Explain } from '@/components/Explain'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { positionRenderings, type Rendering } from '@/lib/absence'
import type { DocsAnchor } from '@/lib/docs'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import { isAnomalous, marketValue, unitCost, unrealised, unrealisedRatio, type ShareRow } from '@/lib/shares'
import { signClass } from '@/lib/sign'

type Translate = (key: MessageKey, values?: MessageValues) => string

function figure(rendering: Rendering, format: () => string, t: Translate) {
  switch (rendering.kind) {
    case 'figure':
      return format()
    case 'dash':
      return ABSENT
    case 'named':
      return t(rendering.message, rendering.values)
  }
}

/** The colour of a cell whose content is not a number at all. */
function toneOf(rendering: Rendering, value: number | null): string {
  return rendering.kind === 'figure' ? signClass(value) : signClass(null)
}

/**
 * The four column headers that rest on a convention — and only four. `Cours`
 * and `Valorisation` carry none here because the carrying rule is stated once,
 * on the page header's `Valorisation`, and `Détenu`, `Titre` and `Compte` are
 * facts rather than figures: the test is *would this be verifiable without
 * knowing a rule?*
 */
const COLUMN_EXPLAIN: Partial<Record<MessageKey, { body: MessageKey; anchor: DocsAnchor }>> = {
  'shares.column.avgCost': { body: 'shares.avgCost.explain', anchor: 'avg-cost' },
  'shares.column.unrealised': { body: 'shares.unrealised.explain', anchor: 'latent-gain' },
  'shares.column.realised': { body: 'shares.realised.explain', anchor: 'realized-gain' },
  'shares.column.dividends': { body: 'shares.dividends.explain', anchor: 'dividends' },
}

function ColumnHead({ label, numeric }: { label: MessageKey; numeric?: boolean }) {
  const { t } = useI18n()
  const explain = COLUMN_EXPLAIN[label]
  return (
    <TableHead className={numeric ? 'text-right' : undefined}>
      <span className={`inline-flex items-center gap-1.5 ${numeric ? 'justify-end' : ''}`}>
        {t(label)}
        {explain ? (
          <Explain figure={t(label)} body={explain.body} anchor={explain.anchor} />
        ) : null}
      </span>
    </TableHead>
  )
}

export interface SharesTableProps {
  rows: readonly ShareRow[]
  currency: string | null
  onSelect: (symbol: string) => void
}

export function SharesTable({ rows, currency, onSelect }: SharesTableProps) {
  const { t } = useI18n()
  const f = useFormatters()

  return (
    <Table>
      <caption className="sr-only">{t('shares.table.label')}</caption>
      <TableHeader>
        <TableRow>
          <ColumnHead label="shares.column.symbol" />
          <ColumnHead label="shares.column.price" numeric />
          <ColumnHead label="shares.column.quantity" numeric />
          <ColumnHead label="shares.column.avgCost" numeric />
          <ColumnHead label="shares.column.value" numeric />
          <ColumnHead label="shares.column.unrealised" numeric />
          <ColumnHead label="shares.column.realised" numeric />
          <ColumnHead label="shares.column.dividends" numeric />
          <ColumnHead label="shares.column.account" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const renderings = positionRenderings(row)
          const value = marketValue(row)
          const gain = unrealised(row)
          const ratio = unrealisedRatio(row)
          return (
            <TableRow key={row.symbol}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    onClick={() => onSelect(row.symbol)}
                  >
                    {row.name ?? row.symbol}
                  </button>
                  {isAnomalous(row) ? (
                    <span className="inline-flex items-center text-attention">
                      <TriangleAlert className="size-4" aria-hidden />
                      <span className="sr-only">
                        {t('absence.noQuote', { count: row.consecutiveFailures })}
                      </span>
                    </span>
                  ) : null}
                </span>
                <span className="block text-xs text-muted-foreground">{row.symbol}</span>
              </TableCell>

              {/* The native quote, deliberately: it is the price the reader's
                  broker shows them, and the converted one is what the value
                  column is built from. */}
              <TableCell className="text-right tabular">
                {figure(
                  renderings.price,
                  () => f.currency(row.price?.value ?? null, row.price?.currency ?? currency),
                  t,
                )}
              </TableCell>

              <TableCell className="text-right tabular">{f.quantity(row.quantity)}</TableCell>

              {/* Undefined on a closed position, which is the truth: it has a
                  realised gain instead (ADR-0003). */}
              <TableCell className="text-right tabular">
                {f.currency(unitCost(row), currency)}
              </TableCell>

              <TableCell className={`text-right tabular ${toneOf(renderings.valuation, value)}`}>
                {figure(renderings.valuation, () => f.currency(value, currency), t)}
              </TableCell>

              <TableCell className={`text-right tabular ${toneOf(renderings.unrealised, gain)}`}>
                {figure(renderings.unrealised, () => f.currency(gain, currency), t)}
                {/* The percentage is a second line, never a tenth column. */}
                {renderings.unrealised.kind === 'figure' && ratio !== null ? (
                  <span className="block text-xs text-muted-foreground">{f.percent(ratio)}</span>
                ) : null}
              </TableCell>

              {/* Realised and dividends are figures on **every** row, closed or
                  not — a zero is a figure and wears the colour of text, never
                  the grey of absence. */}
              <TableCell className={`text-right tabular ${signClass(row.realised)}`}>
                {f.currency(row.realised, currency)}
              </TableCell>
              <TableCell className={`text-right tabular ${signClass(0)}`}>
                {f.currency(row.dividends, currency)}
              </TableCell>

              <TableCell>{renderAccounts(row.accounts)}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * One account is **plain text, never a list of one** (#684 D11). The model stays
 * multi-account — the same ETF on a PEA and on a CTO is the most ordinary case
 * of the domain, and that none of the nineteen real symbols shows it is
 * contingent — so it is the rendering that bends, not the shape.
 */
export function renderAccounts(accounts: readonly string[]) {
  if (accounts.length === 0) return ABSENT
  if (accounts.length === 1) return <span>{accounts[0]}</span>
  return (
    <ul className="flex flex-wrap gap-1">
      {accounts.map((account) => (
        <li key={account} className="rounded border px-1.5 py-0.5 text-xs">
          {account}
        </li>
      ))}
    </ul>
  )
}
