/**
 * The segmented control — **one**, where the redesign draws the same object on
 * four surfaces (#838).
 *
 * The maquette gives a fixed, short list of mutually exclusive choices one
 * shape and one shape only: a track on the ground under the card, the options
 * laid inside it with a hair of padding, and the one in force raised out of the
 * track. It is the dashboard's period, the chart's two readings, the share
 * sheet's window — the same drawing three times — and written three times it
 * would drift three ways, which is the mistake `Stat` was written to stop
 * repeating.
 *
 * **Two semantics, one look, and the caller says which.** A period is a
 * *setting* — one of four, exactly one in force — so it is a `radiogroup`,
 * which is one tab stop and arrow keys. The chart's readings *swap what the
 * slot below draws*, which is what `aria-pressed` says; a tab would misname it
 * (there is no place to go, and the shell's navigation is what the product has
 * of those) and two sibling radio groups on one card read as two settings of
 * the same thing. Neither is a matter of taste, so neither is a default: the
 * `mode` is stated at every call site.
 *
 * **The track's ground is the page's, not the card's** — that is what makes the
 * raised option read as raised on a card and on the page alike, and it is why
 * the border is a prop: on the page the track needs an edge to be a track, on a
 * card the card's own edge is one already.
 */
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedProps<T extends string> {
  /** The accessible name of the group — what the four options are four of. */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /**
   * `radio` for a setting one of whose values is always in force; `pressed` for
   * a switch between two renderings of one slot. Never defaulted — see above.
   */
  mode: 'radio' | 'pressed'
  /** The track's own edge, for where it sits on the page rather than on a card. */
  bordered?: boolean
  className?: string
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  mode,
  bordered = false,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role={mode === 'radio' ? 'radiogroup' : 'group'}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 gap-0.5 rounded-lg bg-background p-0.75',
        bordered && 'border',
        className,
      )}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role={mode === 'radio' ? 'radio' : undefined}
            aria-checked={mode === 'radio' ? on : undefined}
            aria-pressed={mode === 'pressed' ? on : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors',
              on
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
