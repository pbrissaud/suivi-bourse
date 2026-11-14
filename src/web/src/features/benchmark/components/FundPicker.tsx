/**
 * The fund picker — **the underlined word of the sentence** (« Relevé »).
 *
 * « Vos titres face au MSCI World » carries the one choice the whole page
 * depends on: the fund's name is the trigger, underlined like a link, and opens
 * a listbox popover anchored to it. One row per followed fund: ticker, index,
 * and what the fund costs to choose — *depuis 2009*, or, for one still
 * downloading, how far it has got. A fund whose history is not complete is
 * listed and cannot be picked (#1312): a choice is never a gamble on a rebuild.
 * « Ajouter un fonds » closes the list and goes to the sheet that follows them.
 *
 * Choosing **is a write**, so a refusal belongs beside the control, and the
 * receipt is the screen changing under the gesture.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Plus, Search } from 'lucide-react'
import { type KeyboardEvent, useId, useRef, useState } from 'react'

import { Refusal } from '@/components/Refusal'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { flooredPercent } from '@/features/benchmark/components/ReferenceProgress'
import type { BenchmarkReference, OfferedBenchmark } from '@/features/benchmark/lib/api'
import { useReferences } from '@/features/benchmark/lib/useReferences'
import { settingsApi } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

interface FundPickerProps {
  /** The displayed reference's symbol. */
  value: string
  /** The followed funds, ready or not: the whole list. */
  offered: readonly OfferedBenchmark[]
  /** The followed funds whose history is complete: the ones that can be chosen. */
  ready: readonly string[]
}

/** The ticker without its exchange suffix: `CW8.PA` is read `CW8`. */
const ticker = (symbol: string) => symbol.split('.')[0]

export function FundPicker({ value, offered, ready }: FundPickerProps) {
  const { t } = useI18n()
  const client = useQueryClient()
  const references = useReferences()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()

  const write = useMutation({
    mutationFn: (symbol: string) => settingsApi.saveSettings({ benchmark_symbol: symbol }),
    onSuccess: () => {
      // The whole screen is one read, so one invalidation is the receipt.
      client.invalidateQueries({ queryKey: ['benchmark'] })
      client.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const chosen = offered.find((entry) => entry.symbol === value)
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? offered.filter((entry) =>
        `${entry.index} ${ticker(entry.symbol)}`.toLowerCase().includes(needle),
      )
    : offered

  function choose(symbol: string) {
    setOpen(false)
    if (symbol !== value) write.mutate(symbol)
  }

  /** The arrows walk the search field and the entries. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const stops = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'input, [role="option"]:not([aria-disabled="true"]), a',
      ),
    ]
    const at = stops.indexOf(document.activeElement as HTMLElement)
    stops[Math.min(stops.length - 1, Math.max(0, at + step))]?.focus()
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            className="inline-flex items-center gap-1 text-foreground underline decoration-muted-foreground decoration-1 underline-offset-4 outline-none hover:decoration-foreground focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {chosen?.index ?? value}
            <ChevronDown aria-hidden className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-90 p-1.5" onKeyDown={onKeyDown}>
          <div className="relative mb-1.5">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('benchmark.pick.search')}
              placeholder={t('benchmark.pick.search')}
              className="h-8.5 rounded-none border-0 border-b bg-transparent pl-8 text-md shadow-none focus-visible:ring-0"
            />
          </div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={t('benchmark.pick.label')}
            className="flex flex-col"
          >
            {shown.map((entry) => {
              const on = entry.symbol === value
              const can = ready.includes(entry.symbol)
              return (
                <button
                  key={entry.symbol}
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-disabled={!can || undefined}
                  onClick={() => (can ? choose(entry.symbol) : undefined)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.75 text-left text-md outline-none hover:bg-accent focus-visible:bg-accent',
                    on && 'bg-accent',
                    !can && 'text-muted-foreground',
                  )}
                >
                  <span className="fig w-10 shrink-0 text-xs text-muted-foreground">
                    {ticker(entry.symbol)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.index}</span>
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    {stateOf(
                      entry,
                      references.data?.find((row) => row.symbol === entry.symbol),
                    )}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="mt-1.5 -mx-1.5 border-t px-1.5 pt-1.5">
            <Link
              to="/settings"
              hash="portfolio-references"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.75 text-md text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <Plus aria-hidden className="size-4 w-10" />
              {t('benchmark.pick.add')}
            </Link>
          </div>
        </PopoverContent>
      </Popover>
      {write.error ? <Refusal>{t(problemMessageKey(write.error))}</Refusal> : null}
    </>
  )

  /** What the fund costs to choose: its first year, then how far its download is. */
  function stateOf(entry: OfferedBenchmark, row: BenchmarkReference | undefined): string {
    const since = t('benchmark.select.since', { year: entry.inception.slice(0, 4) })
    if (ready.includes(entry.symbol) || row === undefined) return since
    const percent = flooredPercent(row.ratio)
    const detail = row.never_priced
      ? t('benchmark.pick.neverPriced')
      : row.waiting !== null
        ? t('benchmark.pick.waiting')
        : percent !== null
          ? t('benchmark.pick.downloading', { percent: percent / 100 })
          : t(row.failing ? 'benchmark.pick.failing' : 'benchmark.pick.starting')
    return `${since} · ${detail}`
  }
}
