/**
 * **What a broker statement needs from the owner before it can be merged**
 * (#1120), drawn under the proposal's lines in the import preview.
 *
 * Four things, none of them stored: a warning when the stated total and the
 * lines read disagree (non-blocking); the lines still waiting for a ticker, each
 * with the ticker field of the event form (a Yahoo search seeded with the
 * ISIN); the price of every gap line, prefilled and labelled *prix estimé* or
 * *prix à saisir*; and the sentence for the titles held that wait for those
 * choices. Each answer is handed up and re-runs the preview.
 */
import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import type { StatementEdit, StatementPreview } from '@/features/agent/lib/eventProposals'
import { dataApi } from '@/features/data/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

const SEARCH_PAUSE_MS = 300
const SEARCH_MIN = 2
const SEARCH_MAX = 64
const SEARCH_STALE_MS = 5 * 60_000

export function StatementReview({
  statement,
  edit,
  busy,
  container,
}: {
  statement: StatementPreview
  edit: StatementEdit
  busy: boolean
  /** The dialog's node: the ticker list is drawn inside it (`Combobox`). */
  container: HTMLElement | null
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const gaps = statement.lines.filter((line) => line.marks?.includes('gap') && line.symbol)
  const check = statement.total_check

  return (
    <div className="space-y-3">
      {statement.dropped > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('data.import.statement.dropped', { count: statement.dropped })}
        </p>
      ) : null}

      {check === 'unverifiable' ? (
        <p role="status" className="text-sm text-attention">
          {t('data.import.statement.total.unverifiable')}
        </p>
      ) : check ? (
        <p role="status" className="text-sm text-attention">
          {t('data.import.statement.total', {
            stated: f.number(check.stated, 2),
            read: f.number(check.read, 2),
            gap: `${check.gap_pct > 0 ? '+' : ''}${f.number(check.gap_pct, 1)} %`,
          })}
        </p>
      ) : null}

      {statement.unresolved.length > 0 ? (
        <ul className="space-y-2">
          {statement.unresolved.map((line) => (
            <li key={line.n}>
              <TitlePick
                n={line.n}
                name={line.name}
                isin={line.isin}
                disabled={busy}
                container={container}
                onPick={edit.pick}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {statement.pending_held > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('data.import.statement.pending', { count: statement.pending_held })}
        </p>
      ) : null}

      {gaps.length > 0 ? (
        <ul className="space-y-2">
          {gaps.map((line) => (
            <li key={line.symbol}>
              <GapPrice
                symbol={line.symbol as string}
                price={line.unit_price}
                estimated={line.marks?.includes('estimated_price') === true}
                disabled={busy}
                onPrice={edit.price}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The ticker of a line the app could not name: type one, or pick Yahoo's. */
function TitlePick({
  n,
  name,
  isin,
  disabled,
  container,
  onPick,
}: {
  n: number
  name: string
  isin: string | null
  disabled: boolean
  container: HTMLElement | null
  onPick: (n: number, symbol: string) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [typed, setTyped] = useState('')
  const [asked, setAsked] = useState('')
  useEffect(() => {
    const pause = setTimeout(() => setAsked(typed.trim()), SEARCH_PAUSE_MS)
    return () => clearTimeout(pause)
  }, [typed])
  // Until something is typed, the ISIN is the best question there is.
  const query = asked.length >= SEARCH_MIN ? asked : (isin ?? '')
  const searched = useQuery({
    queryKey: ['securities', query],
    queryFn: () => dataApi.searchSecurities(query),
    enabled: query.length >= SEARCH_MIN && query.length <= SEARCH_MAX,
    staleTime: SEARCH_STALE_MS,
    retry: false,
  })
  const items: ComboboxItem[] = (searched.data?.securities ?? []).map((line) => ({
    value: line.symbol,
    label: line.symbol,
    hint: [line.name, line.exchange].filter(Boolean).join(' · ') || null,
    mono: true,
  }))
  const label = isin
    ? t('data.import.statement.pick', { name, isin })
    : t('data.import.statement.pick.noIsin', { name })

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        #{n} · {label}
      </label>
      <Combobox
        id={id}
        value={typed}
        items={items}
        container={container}
        disabled={disabled}
        placeholder={t('data.import.statement.pick.placeholder')}
        listLabel={t('data.form.symbol.suggestions')}
        onValueChange={(next, chosen) => {
          setTyped(next)
          if (chosen) onPick(n, next)
        }}
        // A ticker typed by hand is taken when the field is left.
        onBlur={() => {
          if (typed.trim() !== '') onPick(n, typed.trim())
        }}
      />
    </div>
  )
}

/** The price of one gap line: the statement's, the last close's, or the owner's. */
function GapPrice({
  symbol,
  price,
  estimated,
  disabled,
  onPrice,
}: {
  symbol: string
  price: number | null
  estimated: boolean
  disabled: boolean
  onPrice: (symbol: string, value: number | null) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [typed, setTyped] = useState(price === null ? '' : String(price))
  // The reading came back with another price (an edit, a new close): follow it.
  useEffect(() => setTyped(price === null ? '' : String(price)), [price])

  const commit = () => {
    const value = Number(typed.replace(',', '.'))
    if (typed.trim() !== '' && Number.isFinite(value) && value > 0 && value !== price) {
      onPrice(symbol, value)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {t('data.import.statement.price', { symbol })}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        className="w-32"
        value={typed}
        disabled={disabled}
        aria-invalid={price === null && typed.trim() === ''}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      {price === null ? (
        <span className="text-xs text-attention">{t('data.import.statement.price.missing')}</span>
      ) : estimated ? (
        <span className="text-xs text-muted-foreground">
          {t('data.import.statement.price.estimated')}
        </span>
      ) : null}
    </div>
  )
}
