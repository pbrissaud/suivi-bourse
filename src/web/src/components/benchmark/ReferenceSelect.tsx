/**
 * The reference selector — and it says everything **before** the click.
 *
 * Three columns, each earning its place:
 *
 *  - the **inception** makes truncation visible before the choice. Without it a
 *    2024 fund silently costs an owner who started in 2013 eleven years of
 *    their own history, discovered after a rebuild they have already paid for.
 *  - the **download state** is what finally makes #760's own rule useful: up to
 *    seven consulted series are kept alive *precisely so switching back is
 *    instant*, and with no marker every switch is a coin flip between instant
 *    and two hours.
 *  - the **PEA group** defuses a label the ticket itself says enters no
 *    computation. Ungrouped and unexplained it reads as advice, and it points
 *    at the worst available answer.
 *
 * A stored value outside the seven is rendered as a named entry rather than
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
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, type OfferedBenchmark } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

interface ReferenceSelectProps {
  /** The stored reference, or `null` while none is named. */
  value: string | null
  offered: readonly OfferedBenchmark[]
  /** The references whose series this install already holds. */
  downloaded: readonly string[]
  /** Under the control from the start — the wait is announced, not discovered. */
  hint?: boolean
}

export function ReferenceSelect({
  value,
  offered,
  downloaded,
  hint = false,
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

  const general = offered.filter((entry) => !entry.pea)
  const pea = offered.filter((entry) => entry.pea)
  const offList = value !== null && !offered.some((entry) => entry.symbol === value)

  return (
    <div className="space-y-2">
      <Select value={value ?? undefined} onValueChange={(symbol) => write.mutate(symbol)}>
        <SelectTrigger aria-label={t('benchmark.select.label')} className="sm:w-96">
          <SelectValue placeholder={t('benchmark.select.placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {offList ? (
            <SelectItem value={value}>{t('benchmark.select.offList', { symbol: value })}</SelectItem>
          ) : null}
          <SelectGroup>
            {general.map((entry) => (
              <Row key={entry.symbol} entry={entry} downloaded={downloaded} />
            ))}
          </SelectGroup>
          {pea.length === 0 ? null : (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('benchmark.select.pea')}</SelectLabel>
                {pea.map((entry) => (
                  <Row key={entry.symbol} entry={entry} downloaded={downloaded} />
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>

      {write.error ? <Refusal>{t(problemMessageKey(write.error))}</Refusal> : null}

      {pea.length === 0 ? null : (
        <p className="max-w-prose text-xs text-muted-foreground">
          {t('benchmark.select.peaNote')}
        </p>
      )}
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
      <span className="flex w-full items-baseline gap-x-3">
        {/* The index leads and the ticker is subordinate — the legend names the
            index too, never the ticker. */}
        <span className="min-w-0 flex-1 truncate">
          {entry.index} · {entry.symbol.split('.')[0]}
        </span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          {t('benchmark.select.since', { year: entry.inception.slice(0, 4) })}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {downloaded.includes(entry.symbol)
            ? t('benchmark.select.downloaded')
            : t('benchmark.select.toRebuild')}
        </span>
      </span>
    </SelectItem>
  )
}
