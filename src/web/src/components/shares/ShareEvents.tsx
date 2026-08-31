/**
 * The events of one security, and **the other half of the selection** (#720,
 * ADR-0016).
 *
 * #675/D2 described *hovering a line lights its point*. ADR-0016 was written
 * after it and refuses hover on exactly the argument that applies here: hover
 * does not exist on a finger and says nothing to a keyboard, so a link carried
 * by it alone is a link half the readers do not have. The substance is
 * unchanged, the mechanism is not — **the liaison is a selection**: clicking a
 * line selects its day, clicking a marker selects that day and brings the list
 * to it. Pointing still enriches, and never alone.
 *
 * **The unit of the selection is the day, not the event.** That is what makes
 * *several lines when the marker announces `×3`* true by construction rather
 * than by a second rule: a day is what the marker counts, so selecting one marks
 * every line it counted. Selecting one line of a `×3` day therefore marks its
 * two neighbours, which is the truth of what the reader pointed at — a marker
 * cannot grow for a third of itself.
 */
import { useEffect, useRef } from 'react'

import { EmptyState } from '@/components/EmptyState'
import type { LedgerEvent, LedgerEventType } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { accountOf, FIELDS, rowKey } from '@/lib/ledger'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<LedgerEventType, MessageKey> = {
  BUY: 'event.type.BUY',
  SELL: 'event.type.SELL',
  GRANT: 'event.type.GRANT',
  DIVIDEND: 'event.type.DIVIDEND',
  DEPOSIT: 'event.type.DEPOSIT',
  WITHDRAWAL: 'event.type.WITHDRAWAL',
}

export interface ShareEventsProps {
  events: readonly LedgerEvent[]
  currency: string | null
  selectedDay: string | null
  onSelectDay: (day: string) => void
  /**
   * Bumped by the **chart** and by nothing else. A line that was just clicked is
   * on screen already, so scrolling on every selection would move the list under
   * the pointer that chose it; the marker is the one gesture whose target may be
   * anywhere in the list.
   */
  scrollRequest: number
}

export function ShareEvents({
  events,
  currency,
  selectedDay,
  onSelectDay,
  scrollRequest,
}: ShareEventsProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const lines = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (scrollRequest === 0 || selectedDay === null) return
    lines.current.get(selectedDay)?.scrollIntoView({ block: 'nearest' })
  }, [scrollRequest, selectedDay])

  return (
    <section className="space-y-3">
      <h3 className="eyebrow">{t('shares.events.title')}</h3>
      {events.length === 0 ? (
        <EmptyState title={t('shares.events.empty')} />
      ) : (
        <ul
          aria-label={t('shares.events.title')}
          className="max-h-64 divide-y overflow-y-auto rounded border"
        >
          {events.map((event, index) => {
            const selected = event.date !== null && event.date === selectedDay
            const fields = FIELDS[event.event_type]
            return (
              <li key={rowKey(event, index)}>
                <button
                  type="button"
                  ref={(node) => {
                    // The **first** line of a day is what the scroll lands on:
                    // a day of three is one marker, so it is one destination.
                    if (node && event.date && !lines.current.has(event.date)) {
                      lines.current.set(event.date, node)
                    }
                  }}
                  aria-current={selected ? 'date' : undefined}
                  onClick={() => event.date && onSelectDay(event.date)}
                  className={cn(
                    'flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left text-sm',
                    // Pointing enriches; it never carries the state on its own.
                    'hover:bg-muted/50',
                    selected ? 'bg-secondary font-medium' : undefined,
                  )}
                >
                  <span className="tabular text-muted-foreground">{f.date(event.date)}</span>
                  <span>{t(TYPE_LABEL[event.event_type])}</span>
                  {fields.quantity ? (
                    <span className="tabular">
                      {t('shares.events.quantity', { quantity: f.quantity(event.quantity) })}
                    </span>
                  ) : null}
                  {fields.unitPrice !== 'none' && event.unit_price !== null ? (
                    <span className="tabular">{f.currency(event.unit_price, currency)}</span>
                  ) : null}
                  {fields.amount && event.amount !== null ? (
                    <span className="tabular">{f.currency(event.amount, currency)}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {accountOf(event)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
