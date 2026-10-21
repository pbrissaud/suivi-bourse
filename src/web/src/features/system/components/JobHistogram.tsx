import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import type { JobPass, JobSlot, JobTrack, PassOutcome } from '@/features/settings/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export const HOUR = 3_600_000

type Tone = PassOutcome | 'none'

/** An hour's colour: its worst pass, `idle` only when every pass was idle. */
function toneOf(slot: JobSlot): Tone {
  if (slot.passes === 0) return 'none'
  if (slot.errors > 0) return 'error'
  if (slot.attentions > 0) return 'attention'
  if (slot.idles === slot.passes) return 'idle'
  return 'ok'
}

/** The newest hour that had an error or an attention, for a job the bell flags. */
export function lastFaultyHour(track: JobTrack): number | null {
  for (let i = track.slots.length - 1; i >= 0; i--) {
    if (track.slots[i].errors + track.slots[i].attentions > 0) return i
  }
  return null
}

/**
 * Several tracks as one: the scrape job is the sum of its symbols. `hours` is
 * any track's slots: every track of one read covers the same 24 hours.
 */
export function mergeTracks(
  bySymbol: Record<string, JobTrack>,
  hours: readonly JobSlot[],
  recent: JobPass[],
): JobTrack {
  const tracks = Object.values(bySymbol)
  return {
    slots: hours.map((hour, i) => {
      const slot: JobSlot = { ...hour, passes: 0, errors: 0, attentions: 0, idles: 0, duration: 0 }
      slot.last_error = null
      slot.last_error_at = null
      for (const track of tracks) {
        const one = track.slots[i]
        if (one === undefined) continue
        slot.passes += one.passes
        slot.errors += one.errors
        slot.attentions += one.attentions
        slot.idles += one.idles
        slot.duration += one.duration
        if (one.last_error_at !== null && (slot.last_error_at ?? '') < one.last_error_at) {
          slot.last_error = one.last_error
          slot.last_error_at = one.last_error_at
        }
      }
      return slot
    }),
    passes: recent,
    last: tracks.reduce<JobPass | null>(
      (newest, track) =>
        track.last !== null && (newest === null || newest.at < track.last.at) ? track.last : newest,
      null,
    ),
  }
}

function useClock() {
  const { locale } = useI18n()
  return useMemo(() => {
    const shape = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    return (value: string) => shape.format(new Date(value))
  }, [locale])
}

interface JobHistogramProps {
  /** The listbox's name: the job, or the symbol. */
  label: string
  track: JobTrack
  /** The hour open before the owner touches anything (a job the bell flags). */
  initial?: number | null
  /** 70 px for a job, less for a symbol under the scrape. */
  height?: number
  /** When the process started: an hour that ended before it draws no mark. */
  started?: string
}

/**
 * **One job's last 24 hours, one bar an hour** (#1236): the height is the
 * hour's mean duration, the colour its worst pass. One tab stop
 * (`role="listbox"`), the arrows move the open hour, and on touch the whole
 * height takes a drag. Divs and not Recharts: there is no axis to draw.
 */
export function JobHistogram({
  label,
  track,
  initial = null,
  height = 70,
  started,
}: JobHistogramProps) {
  const { t } = useI18n()
  const format = useFormatters()
  const clock = useClock()
  const id = useId()
  const area = useRef<HTMLDivElement>(null)
  // Kept as the hour and not its index: the window moves an hour on, and the
  // open hour must stay the same hour (or close once it has left the window).
  const [chosen, setChosen] = useState<{ hour: string | null } | null>(null)
  const hour =
    chosen === null ? (initial === null ? null : track.slots[initial]?.hour) : chosen.hour
  const found =
    hour === null || hour === undefined ? -1 : track.slots.findIndex((slot) => slot.hour === hour)
  const selected = found === -1 ? null : found
  const select = (index: number | null) =>
    setChosen({ hour: index === null ? null : track.slots[index].hour })

  const last = track.slots.length - 1
  // Nothing was running: not a quiet hour.
  const isDown = (slot: JobSlot) =>
    started !== undefined && Date.parse(slot.hour) + HOUR <= Date.parse(started)
  const means = track.slots.map((slot) => (slot.passes > 0 ? slot.duration / slot.passes : 0))
  const longest = Math.max(...means, 0)

  const onKeyDown = (event: KeyboardEvent) => {
    const from = selected ?? last + 1
    const moves: Record<string, number | null> = {
      ArrowLeft: Math.max(0, from - 1),
      ArrowRight: Math.min(last, selected === null ? last : from + 1),
      Home: 0,
      End: last,
      Escape: null,
    }
    if (!(event.key in moves)) return
    const to = moves[event.key]
    event.preventDefault()
    select(to)
  }

  // The column under the pointer opens on the way down. On touch the pointer
  // is captured, so a drag across the full height moves the open hour; a mouse
  // is not, because a captured pointer's click no longer reaches the option.
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = area.current
    if (box === null) return
    const rect = box.getBoundingClientRect()
    if (rect.width === 0) return
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * track.slots.length)
    select(Math.min(last, Math.max(0, index)))
  }

  return (
    <div>
      <div
        ref={area}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={selected === null ? undefined : `${id}-${selected}`}
        aria-controls={selected === null ? undefined : `${id}-detail`}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch')
            event.currentTarget.setPointerCapture?.(event.pointerId)
          pick(event)
        }}
        onPointerMove={(event) => {
          if (area.current?.hasPointerCapture?.(event.pointerId)) pick(event)
        }}
        style={{ height }}
        className="flex touch-pan-y items-stretch gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {track.slots.map((slot, i) => {
          const tone = toneOf(slot)
          const down = isDown(slot)
          const share = longest > 0 ? means[i] / longest : 0
          return (
            <div
              key={slot.hour}
              id={`${id}-${i}`}
              role="option"
              aria-selected={selected === i}
              aria-label={
                down
                  ? t('settings.jobs.hour.down', { hour: clock(slot.hour) })
                  : t('settings.jobs.hour', {
                      hour: clock(slot.hour),
                      passes: slot.passes,
                      errors: slot.errors,
                      attentions: slot.attentions,
                    }) +
                    (slot.passes > 0
                      ? `, ${t('settings.jobs.mean', {
                          value: t('settings.jobs.seconds', { value: format.number(means[i], 1) }),
                        })}`
                      : '')
              }
              onClick={() => select(i)}
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer flex-col items-stretch justify-end rounded-xs px-px',
                i === last && 'outline outline-1 -outline-offset-1 outline-muted-foreground',
                selected === i && 'bg-primary/15',
              )}
            >
              {tone === 'error' || tone === 'attention' ? (
                <span
                  aria-hidden
                  className={cn(
                    'text-center text-xs leading-none',
                    tone === 'error' ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {tone === 'error' ? '✕' : '▲'}
                </span>
              ) : null}
              {down ? null : (
                <span
                  aria-hidden
                  style={
                    tone === 'ok' || tone === 'attention' || tone === 'error'
                      ? { height: `${Math.max(8, share * 80)}%` }
                      : undefined
                  }
                  className={cn(
                    'block rounded-[1px]',
                    tone === 'ok' && 'bg-muted-foreground',
                    tone === 'attention' && 'bg-foreground',
                    tone === 'error' && 'bg-destructive',
                    tone === 'idle' && 'h-1 bg-border',
                    tone === 'none' && 'h-1.5 border border-dashed border-border',
                  )}
                />
              )}
            </div>
          )
        })}
      </div>
      {selected === null ? null : isDown(track.slots[selected]) ? (
        <p
          id={`${id}-detail`}
          aria-live="polite"
          className="mt-2 py-1.5 text-xs text-muted-foreground"
        >
          {t('settings.jobs.hour.down', { hour: clock(track.slots[selected].hour) })}
        </p>
      ) : (
        <HourDetail
          id={`${id}-detail`}
          slot={track.slots[selected]}
          passes={passesIn(track.passes, track.slots[selected])}
        />
      )}
    </div>
  )
}

function passesIn(passes: readonly JobPass[], slot: JobSlot): JobPass[] {
  const start = Date.parse(slot.hour)
  return passes.filter((one) => {
    const at = Date.parse(one.at)
    return at >= start && at < start + HOUR
  })
}

/** The open hour, as ruled rows: its totals, its last error, then its kept passes. */
function HourDetail({ id, slot, passes }: { id: string; slot: JobSlot; passes: JobPass[] }) {
  const { t } = useI18n()
  const format = useFormatters()
  const clock = useClock()
  const seconds = (value: number) => t('settings.jobs.seconds', { value: format.number(value, 1) })
  const end = new Date(Date.parse(slot.hour) + HOUR).toISOString()

  return (
    <div id={id} className="mt-2 divide-y text-xs [overflow-wrap:anywhere]">
      <p aria-live="polite" className="tabular py-1.5 text-muted-foreground">
        {t('settings.jobs.hour.totals', {
          from: clock(slot.hour),
          to: clock(end),
          passes: slot.passes,
          errors: slot.errors,
          attentions: slot.attentions,
        })}
        {slot.passes > 0
          ? ` · ${t('settings.jobs.mean', { value: seconds(slot.duration / slot.passes) })}`
          : null}
      </p>
      {slot.last_error === null ? null : (
        <p className="py-1.5 text-destructive">
          {t('settings.jobs.hour.lastError', {
            at: slot.last_error_at === null ? '' : clock(slot.last_error_at),
            error: slot.last_error,
          })}
        </p>
      )}
      {passes.map((one) => (
        <div key={`${one.symbol ?? ''}${one.at}`} className="py-1.5">
          <p className="tabular flex flex-wrap gap-x-3">
            <span>{clock(one.at)}</span>
            {one.symbol === undefined ? null : <span>{one.symbol}</span>}
            <span className="text-muted-foreground">{seconds(one.duration)}</span>
            <span className={cn(one.outcome === 'error' && 'text-destructive')}>
              {t('settings.jobs.outcome', { outcome: one.outcome })}
            </span>
          </p>
          {one.error === null ? null : <p className="mt-0.5 text-destructive">{one.error}</p>}
          {one.lines.map((line, i) => (
            <p key={i} className="mt-0.5 font-mono text-muted-foreground">
              {line.level} {line.logger}: {line.message}
            </p>
          ))}
          {one.overflow > 0 ? (
            <p className="mt-0.5 text-muted-foreground">
              {t('settings.jobs.overflow', { count: one.overflow })}
            </p>
          ) : null}
        </div>
      ))}
      {passes.length < slot.passes ? (
        <p className="py-1.5 text-muted-foreground">{t('settings.jobs.hour.kept')}</p>
      ) : null}
    </div>
  )
}
