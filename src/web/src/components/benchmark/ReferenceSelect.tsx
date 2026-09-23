/**
 * The reference selector — and it says everything **before** the click.
 *
 * One flat list, and three columns each earning its place:
 *
 *  - the **inception** makes truncation visible before the choice. Without it a
 *    2024 fund silently costs an owner who started in 2013 eleven years of
 *    their own history, discovered after a rebuild they have already paid for.
 *  - the **download state** is what finally makes #760's own rule useful: the
 *    series of a reference already consulted is kept alive *precisely so
 *    switching back is instant*, and with no marker every switch is a coin
 *    flip between instant and two hours.
 *
 * No section headings: a tax-wrapper eligibility split the list in two until
 * #1019, and the note under the group had to explain that the split meant
 * nothing to the arithmetic.
 *
 * A stored value outside the five is rendered as a named entry rather than
 * dropped: `PUT /api/settings` stays open, and a reference missing from its own
 * selector is one the owner cannot switch away from.
 *
 * Choosing **is a write**, so the refusal belongs beside the control, and the
 * receipt is the screen changing under the gesture — there is no second one.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type OfferedBenchmark } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

interface ReferenceSelectProps {
  /** The stored reference, or `null` while none is named. */
  value: string | null
  offered: readonly OfferedBenchmark[]
  /** The references whose series this install already holds. */
  downloaded: readonly string[]
  /** Under the control from the start — the wait is announced, not discovered. */
  hint?: boolean
  /** The trigger's width where the default `sm:w-96` is too wide for its row. */
  triggerClassName?: string
}

export function ReferenceSelect({
  value,
  offered,
  downloaded,
  hint = false,
  triggerClassName,
}: ReferenceSelectProps) {
  const { t } = useI18n()
  const client = useQueryClient()

  const write = useMutation({
    mutationFn: (symbol: string) => api.saveSettings({ benchmark_symbol: symbol }),
    onSuccess: () => {
      // The whole screen is one read, so one invalidation is the receipt.
      client.invalidateQueries({ queryKey: ['benchmark'] })
      client.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const chosen = offered.find((entry) => entry.symbol === value) ?? null
  const offList = value !== null && chosen === null

  return (
    <div className="space-y-2">
      <Select value={value ?? undefined} onValueChange={(symbol) => write.mutate(symbol)}>
        {/* Full width on a 390 px viewport, where ~350 px are left once the
            sidebar is a drawer, and 44 px tall — the touch minimum the kit's
            own 36 px falls under. */}
        <SelectTrigger aria-label={t('benchmark.select.label')} className={cn('w-full sm:w-96', triggerClassName)}>
          {/* **The chosen fund, not the row it was chosen from.** Left to
              render itself, `SelectValue` echoes the whole `SelectItem` —
              inception and download state included — and those two columns
              only mean something *between* options. On the trigger they read
              as facts about the current choice, and *already downloaded* sits
              there permanently saying nothing. */}
          <SelectValue placeholder={t('benchmark.select.placeholder')}>
            {chosen === null
              ? t('benchmark.select.offList', { symbol: value ?? '' })
              : `${chosen.index} · ${chosen.symbol.split('.')[0]}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {offList ? (
            <SelectItem value={value}>{t('benchmark.select.offList', { symbol: value })}</SelectItem>
          ) : null}
          <SelectGroup>
            {offered.map((entry) => (
              <Row key={entry.symbol} entry={entry} downloaded={downloaded} />
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {write.error ? <Refusal>{t(problemMessageKey(write.error))}</Refusal> : null}

      {hint ? (
        <p className="max-w-prose text-xs text-muted-foreground">{t('benchmark.select.hint')}</p>
      ) : null}
    </div>
  )
}

/** One offered fund: the index first, then what it costs and what it holds. */
function Row({
  entry,
  downloaded,
}: {
  entry: OfferedBenchmark
  downloaded: readonly string[]
}) {
  const { t } = useI18n()

  return (
    <SelectItem value={entry.symbol}>
      {/* Three columns on a wide viewport, **two lines** under it: the name on
          the first, what it costs and what it holds on the second. Truncating
          instead would drop the inception, which is the column that exists to
          be read before the click. */}
      <span className="flex w-full flex-col gap-y-0.5 sm:flex-row sm:items-baseline sm:gap-x-3">
        {/* The index leads and the ticker is subordinate — the legend names the
            index too, never the ticker. */}
        <span className="min-w-0 flex-1 truncate">
          {entry.index} · {entry.symbol.split('.')[0]}
        </span>
        <span className="flex gap-x-3 text-xs text-muted-foreground">
          <span className="tabular shrink-0">
            {t('benchmark.select.since', { year: entry.inception.slice(0, 4) })}
          </span>
          <span className="shrink-0">
            {downloaded.includes(entry.symbol)
              ? t('benchmark.select.downloaded')
              : t('benchmark.select.toRebuild')}
          </span>
        </span>
      </span>
    </SelectItem>
  )
}
