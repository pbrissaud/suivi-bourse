/**
 * The rail's threads, grouped by day (« Relevé »): *Aujourd’hui*, *Hier*, then
 * one group per month — *Octobre*, and *Septembre 2025* once the year is not
 * the current one. Pure, so the grouping is proved without a page.
 */
import type { AgentThreadSummary } from '@/features/agent/lib/api'

export interface ThreadGroup {
  /** `today`, `yesterday`, or the month's `YYYY-MM`. */
  key: string
  /** The group's month, for the caller to name; `null` for today and yesterday. */
  month: Date | null
  threads: AgentThreadSummary[]
}

const DAY = 86_400_000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `threads` are already newest first (the server sorts them); the groups keep that order. */
export function groupThreads(threads: AgentThreadSummary[], now: Date): ThreadGroup[] {
  const today = startOfDay(now)
  const groups: ThreadGroup[] = []
  for (const thread of threads) {
    const at = thread.updated_at ? new Date(thread.updated_at) : null
    let key: string
    let month: Date | null = null
    if (at === null || Number.isNaN(at.getTime())) {
      key = 'unknown'
    } else if (startOfDay(at) >= today) {
      key = 'today'
    } else if (startOfDay(at) >= today - DAY) {
      key = 'yesterday'
    } else {
      key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
      month = new Date(at.getFullYear(), at.getMonth(), 1)
    }
    const last = groups.at(-1)
    if (last?.key === key) last.threads.push(thread)
    else groups.push({ key, month, threads: [thread] })
  }
  return groups
}

/** A month group's name: the month in capitals' first letter, and the year when it is not this one. */
export function monthName(month: Date, now: Date, locale: string): string {
  const name = new Intl.DateTimeFormat(locale, { month: 'long' }).format(month)
  const cap = name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
  return month.getFullYear() === now.getFullYear() ? cap : `${cap} ${month.getFullYear()}`
}

/** Tokens, compact: `912`, `283 k`, `1 284 k`. Mono digits are the caller's. */
export function compactTokens(count: number, locale: string): string {
  if (count < 1_000) return new Intl.NumberFormat(locale).format(count)
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(count / 1_000)} k`
}
