import { useMemo } from 'react'

import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'

/** A local calendar day as a sortable key. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** The Système and Journal pages' clock: a time alone, or a day for an older instant. */
export function useClock() {
  const { locale } = useI18n()
  const f = useFormatters()
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    const day = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' })
    return {
      /** `17:35`. */
      time: (iso: string) => time.format(new Date(iso)),
      /** `17:35` today, `6 nov. 2026, 17:35` otherwise. */
      when: (iso: string, now: Date) =>
        dayKey(new Date(iso)) === dayKey(now) ? time.format(new Date(iso)) : f.dateTime(iso),
      /** `Vendredi 6 nov.`, its key, and whether it is today. */
      day: (iso: string, now: Date) => {
        const date = new Date(iso)
        const text = day.format(date)
        return {
          key: dayKey(date),
          today: dayKey(date) === dayKey(now),
          text: text.charAt(0).toUpperCase() + text.slice(1),
        }
      },
    }
  }, [locale, f])
}
