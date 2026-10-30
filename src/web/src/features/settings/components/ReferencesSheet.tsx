/**
 * The sheet that follows the ETFs the Benchmark page compares against (#1312).
 *
 * There is no Save button: a switch is saved on click. **One mutation** serves
 * every switch, and every switch is disabled while it is on its way, so the
 * list sent is always built from the latest answer with the new symbol
 * appended — the order of the clicks is the order of the downloads. The sheet is
 * `aria-busy` for as long as a save is in flight, and a refusal is said once,
 * under the list, with the switch back on the server's state (it is read from
 * the server, never held locally).
 *
 * The download itself is a server job: closing the sheet stops nothing, and
 * reopening it reads the progress where it stood.
 *
 * **One polite live region** says « <index> est prêt » once, when an ETF turns
 * ready. Percentages are never announced.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Unreadable } from '@/components/Unreadable'
import { ReferenceProgress } from '@/features/benchmark/components/ReferenceProgress'
import { type BenchmarkReference, benchmarkApi } from '@/features/benchmark/lib/api'
import { REFERENCES_KEY } from '@/features/benchmark/lib/useReferences'
import { type ConfigResponse, settingsApi } from '@/features/settings/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { oneFailure, readConditions } from '@/lib/status'

const FOLLOWED = 'benchmark_symbols'

export function ReferencesSheet({
  open,
  onClose,
  references,
}: {
  open: boolean
  onClose: () => void
  references: UseQueryResult<BenchmarkReference[]>
}) {
  const { t } = useI18n()
  const client = useQueryClient()
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const rows = references.data
  const failure = oneFailure(readConditions({ queries: [references] }))

  // The order the owner turned them on, from the latest answer.
  const followedNow = (config.data?.settings.find((one) => one.key === FOLLOWED)?.value ??
    []) as string[]

  const write = useMutation({
    mutationFn: (symbols: string[]) => settingsApi.saveSettings({ [FOLLOWED]: symbols }),
    onSuccess: (answer) => {
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous ? { ...previous, settings: answer.settings } : previous,
      )
    },
    // Moved or refused, the server's state is what the switches show again.
    // Not `config`: the answer already carries it, and a refetch under another
    // row being typed in is what the live reads are kept away from.
    // Returned, so the save stays pending until both reads are fresh and the
    // switches never flash the old state between the answer and the refetch.
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: REFERENCES_KEY }),
        client.invalidateQueries({ queryKey: ['benchmark'] }),
      ]),
  })

  const remove = useMutation({
    mutationFn: ({ symbol, kept }: { symbol: string; kept: boolean }) =>
      benchmarkApi.keep(symbol, kept),
    onSuccess: (answer) => {
      client.setQueryData(REFERENCES_KEY, answer)
      client.invalidateQueries({ queryKey: ['store'] })
    },
  })

  const announcement = useReadyAnnouncement(rows)

  // Radix focuses the first thing it finds when the sheet opens, which is the
  // close button while the list is still on its way: the first switch takes the
  // focus once there is one.
  const list = useRef<HTMLUListElement>(null)
  const listed = rows !== undefined
  useEffect(() => {
    if (open && listed) list.current?.querySelector<HTMLElement>('[role="switch"]')?.focus()
  }, [open, listed])
  const pending = write.isPending ? write.variables : null

  // A refusal belongs to the visit that caused it: closing the sheet forgets it,
  // so it neither comes back on reopen nor outlives a later success.
  const { reset: resetWrite } = write
  const { reset: resetRemove } = remove
  useEffect(() => {
    if (open) return
    resetWrite()
    resetRemove()
  }, [open, resetWrite, resetRemove])

  function toggle(symbol: string, on: boolean) {
    const others = followedNow.filter((one) => one !== symbol)
    write.mutate(on ? [...others, symbol] : others)
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* biome-ignore lint/plugin: the design review asks for `aria-busy` on a save in flight; the rule is about a block waiting on a *read* (#795) */}
      <SheetContent className="w-full overflow-y-auto sm:max-w-md" aria-busy={write.isPending}>
        <SheetHeader>
          <SheetTitle className="text-lg">{t('settings.refs.title')}</SheetTitle>
          <SheetDescription>{t('settings.refs.description')}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6">
          {failure !== null ? (
            <Unreadable failure={failure} />
          ) : rows ? (
            <ul ref={list}>
              {rows.map((row) => (
                <Item
                  key={row.symbol}
                  row={row}
                  rows={rows}
                  checked={pending ? pending.includes(row.symbol) : row.followed}
                  // No switch before the latest list is known: a toggle built on an
                  // empty one would send only itself and unfollow the rest.
                  busy={write.isPending || config.data === undefined}
                  onToggle={(on) => toggle(row.symbol, on)}
                  onKeep={(kept) => remove.mutate({ symbol: row.symbol, kept })}
                />
              ))}
            </ul>
          ) : null}
          {write.error ? (
            <Refusal className="mt-4">{t(problemMessageKey(write.error))}</Refusal>
          ) : null}
          {remove.error ? (
            <Refusal className="mt-4">{t(problemMessageKey(remove.error))}</Refusal>
          ) : null}
        </div>

        {/* Mounted before it has anything to say. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** « <index> est prêt », once per ETF that turns ready while the sheet is mounted. */
function useReadyAnnouncement(rows: readonly BenchmarkReference[] | undefined): string {
  const { t } = useI18n()
  const [said, setSaid] = useState('')
  const waiting = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!rows) return
    const before = waiting.current
    const turned = rows.filter((row) => before?.has(row.symbol) && row.ready)
    if (turned.length > 0)
      setSaid(turned.map((row) => t('benchmark.refs.ready', { index: row.index })).join('. '))
    waiting.current = new Set(
      rows.filter((row) => row.followed && !row.ready).map((row) => row.symbol),
    )
  }, [rows, t])

  return said
}

function Item({
  row,
  rows,
  checked,
  busy,
  onToggle,
  onKeep,
}: {
  row: BenchmarkReference
  rows: readonly BenchmarkReference[]
  checked: boolean
  busy: boolean
  onToggle: (on: boolean) => void
  onKeep: (kept: boolean) => void
}) {
  const { t } = useI18n()

  return (
    <li className="border-t py-3 first:border-t-0">
      {/* The whole row is the switch's label: 44 px tall, and named for what it does. */}
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-base font-medium">
            {row.index} · {row.symbol.split('.')[0]}
          </span>
          <span className="label block text-muted-foreground">
            {t('settings.refs.since', { year: row.inception.slice(0, 4) })}
          </span>
        </span>
        <Switch
          aria-label={t('settings.refs.follow', { index: row.index })}
          className="max-md:after:-inset-3.5"
          checked={checked}
          disabled={busy}
          onCheckedChange={onToggle}
        />
      </label>

      {row.followed && !row.ready ? <Download row={row} rows={rows} /> : null}

      {!row.followed && row.kept ? (
        <Button
          variant="link"
          className="h-auto px-0 text-sm max-md:min-h-11"
          onClick={() => onKeep(false)}
        >
          {t('settings.refs.forget')}
        </Button>
      ) : null}
      {!row.followed && row.freed ? (
        <p className="text-sm text-muted-foreground">
          {t('settings.refs.freed')} ·{' '}
          <Button
            variant="link"
            className="h-auto px-0 text-sm max-md:min-h-11"
            onClick={() => onKeep(true)}
          >
            {t('settings.refs.undo')}
          </Button>
        </p>
      ) : null}
    </li>
  )
}

/** Under a followed ETF that is not ready: the bar, the queue, or why nothing moves. */
function Download({ row, rows }: { row: BenchmarkReference; rows: readonly BenchmarkReference[] }) {
  const { t } = useI18n()

  if (row.waiting === 'no_events') {
    return (
      <p className="text-sm text-muted-foreground">
        {t('benchmark.refs.noEvents')} ·{' '}
        <Link to="/ledger" className="font-medium text-foreground underline underline-offset-4">
          {t('benchmark.refs.recordEvent')}
        </Link>
      </p>
    )
  }
  if (row.waiting === 'queued') {
    const after = rows.find((one) => one.symbol === row.after)
    return (
      <p className="text-sm text-muted-foreground">
        {t('benchmark.refs.queued', { index: after?.index ?? '' })}
      </p>
    )
  }
  return (
    <ReferenceProgress
      index={row.index}
      reached={row.reached}
      target={row.target}
      ratio={row.ratio}
    />
  )
}
