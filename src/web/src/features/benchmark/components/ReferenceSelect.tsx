/**
 * The reference selector — it offers **what can be compared right now**.
 *
 * Only the ETFs the owner follows *and* whose history is complete are here
 * (#1312): the « déjà téléchargé / à reconstituer » column is gone, because a
 * choice is never a gamble on a rebuild any more. What is still downloading is
 * said **under the trigger**, never inside the menu, whose list only accepts
 * options; « Gérer les références » is a real link to the sheet that follows
 * them.
 *
 * One row per fund, and the **inception** earns its place: it makes truncation
 * visible before the choice. A 2024 fund silently costs an owner who started
 * in 2013 eleven years of their own history.
 *
 * Choosing **is a write**, so the refusal belongs beside the control, and the
 * receipt is the screen changing under the gesture — there is no second one.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Refusal } from '@/components/Refusal'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { flooredPercent } from '@/features/benchmark/components/ReferenceProgress'
import type { BenchmarkReference, OfferedBenchmark } from '@/features/benchmark/lib/api'
import { useReferences } from '@/features/benchmark/lib/useReferences'
import { settingsApi } from '@/features/settings/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

interface ReferenceSelectProps {
  /** The displayed reference. */
  value: string
  /** The followed, complete ETFs: the whole menu. */
  offered: readonly OfferedBenchmark[]
  /** The trigger's width where the default `sm:w-96` is too wide for its row. */
  triggerClassName?: string
}

export function ReferenceSelect({ value, offered, triggerClassName }: ReferenceSelectProps) {
  const { t } = useI18n()
  const client = useQueryClient()
  const references = useReferences()

  const write = useMutation({
    mutationFn: (symbol: string) => settingsApi.saveSettings({ benchmark_symbol: symbol }),
    onSuccess: () => {
      // The whole screen is one read, so one invalidation is the receipt.
      client.invalidateQueries({ queryKey: ['benchmark'] })
      client.invalidateQueries({ queryKey: ['config'] })
    },
  })

  const chosen = offered.find((entry) => entry.symbol === value)

  return (
    <div className="space-y-2">
      <Select value={value} onValueChange={(symbol) => write.mutate(symbol)}>
        {/* Full width on a 390 px viewport, where ~350 px are left once the
            sidebar is a drawer, and 44 px tall — the touch minimum the kit's
            own 36 px falls under. */}
        <SelectTrigger
          aria-label={t('benchmark.select.label')}
          className={cn('w-full sm:w-96', triggerClassName)}
        >
          {/* **The chosen fund, not the row it was chosen from**: the inception
              only means something *between* options. */}
          <SelectValue placeholder={t('benchmark.select.placeholder')}>
            {chosen ? `${chosen.index} · ${chosen.symbol.split('.')[0]}` : value}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {offered.map((entry) => (
              <Row key={entry.symbol} entry={entry} />
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Note rows={references.data} />

      {write.error ? <Refusal>{t(problemMessageKey(write.error))}</Refusal> : null}
    </div>
  )
}

/** One offered fund: the index first, then what it costs. */
function Row({ entry }: { entry: OfferedBenchmark }) {
  const { t } = useI18n()

  return (
    <SelectItem value={entry.symbol}>
      {/* Two columns on a wide viewport, **two lines** under it. Truncating
          instead would drop the inception, which is the column that exists to
          be read before the click. */}
      <span className="flex w-full flex-col gap-y-0.5 sm:flex-row sm:items-baseline sm:gap-x-3">
        {/* The index leads and the ticker is subordinate — the legend names the
            index too, never the ticker. */}
        <span className="min-w-0 flex-1 truncate">
          {entry.index} · {entry.symbol.split('.')[0]}
        </span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          {t('benchmark.select.since', { year: entry.inception.slice(0, 4) })}
        </span>
      </span>
    </SelectItem>
  )
}

/** What is still downloading, then the way to the sheet that follows them. */
function Note({ rows }: { rows: readonly BenchmarkReference[] | undefined }) {
  const { t } = useI18n()
  const f = useFormatters()

  const pending = (rows ?? []).filter((row) => row.followed && !row.ready)
  const running = pending.find((row) => row.waiting === null)
  const percent = running ? flooredPercent(running.ratio) : null
  const waiting = pending.filter((row) => row !== running && row.waiting !== 'no_events')

  const said = [
    running && percent !== null
      ? t('benchmark.select.downloading', { index: running.index, percent: percent / 100 })
      : null,
    waiting.length > 0
      ? t('benchmark.select.waiting', { index: f.list(waiting.map((row) => row.index)) })
      : null,
  ].filter((part) => part !== null)

  return (
    <p className="text-sm text-muted-foreground">
      {said.length > 0 ? <>{said.join(' · ')} · </> : null}
      <Link
        to="/settings"
        hash="portfolio-references"
        className="font-medium text-foreground underline underline-offset-4"
      >
        {t('benchmark.followed.manage')}
      </Link>
    </p>
  )
}
