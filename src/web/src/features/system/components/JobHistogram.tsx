import type { JobPass, JobSlot, JobTrack, PassOutcome } from '@/features/settings/lib/api'
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

interface JobTicksProps {
  /** The job's name: the strip's accessible name carries it. */
  label: string
  track: JobTrack
  /** When the process started: an hour that ended before it draws nothing. */
  started: string
}

/**
 * **One job's last 24 hours, one tick an hour** (DESIGN.md › Colors, #1236):
 * a good hour is a `muted-foreground` tick, an idle one a `border` stub, an
 * hour with a pass that needs a look a full `foreground` tick, a failed one a
 * full `destructive` tick, an hour with no pass a dashed outline, and an hour
 * before the process started nothing. The newest hour is ringed. It is one
 * picture with one sentence of counts: the hours are not tab stops.
 */
export function JobTicks({ label, track, started }: JobTicksProps) {
  const { t } = useI18n()
  const last = track.slots.length - 1
  const total = (field: 'passes' | 'errors' | 'attentions') =>
    track.slots.reduce((sum, slot) => sum + slot[field], 0)

  return (
    <span
      role="img"
      aria-label={t('system.ticks', {
        job: label,
        passes: total('passes'),
        errors: total('errors'),
        attentions: total('attentions'),
      })}
      className="flex h-4.5 items-end gap-0.75"
    >
      {track.slots.map((slot, i) => {
        const tone = toneOf(slot)
        const down = Date.parse(slot.hour) + HOUR <= Date.parse(started)
        return (
          <span
            key={slot.hour}
            data-tone={down ? 'down' : tone}
            aria-hidden
            className={cn(
              'block w-1.5 rounded-xs',
              !down && tone === 'ok' && 'h-2.5 bg-muted-foreground',
              !down && tone === 'idle' && 'h-1.5 bg-border',
              !down && tone === 'none' && 'h-1 border border-dashed border-border',
              !down && tone === 'attention' && 'h-4.5 bg-foreground',
              !down && tone === 'error' && 'h-4.5 bg-destructive',
              i === last && 'outline outline-1 outline-offset-1 outline-foreground',
            )}
          />
        )
      })}
    </span>
  )
}
