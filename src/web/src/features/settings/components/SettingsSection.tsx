import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

/**
 * A titled section of the Settings page (#1279). From 1 024 px the title and
 * one sentence sit in a 220 px gutter that sticks while the rows scroll; below,
 * they sit above the rows. **Nothing interactive lives in the gutter**: a
 * section's switch is its first row.
 *
 * The section reads its own data and says so itself. `read` is what its rows
 * stand on: `pending` holds the place with an empty plane, `failed` says one
 * sentence and offers to read again, and the rest of the page still works.
 */
export function SettingsSection({
  id,
  title,
  summary,
  read = { kind: 'ready' },
  children,
}: {
  /** The anchor: `/settings#agent` lands on it, with focus. */
  id: string
  title: string
  /** One sentence, only where the title and the rows do not already say it. */
  summary?: string
  read?: SectionRead
  children: ReactNode
}) {
  const heading = `${id}-title`
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={heading}
      className="scroll-mt-20 border-t py-8 outline-none first:border-t-0 first:pt-0 lg:grid lg:grid-cols-[220px_1fr] lg:gap-x-10"
    >
      <header className="mb-4 lg:sticky lg:top-20 lg:mb-0 lg:self-start">
        <h2 id={heading} className="text-2xl font-semibold">
          {title}
        </h2>
        {summary ? <p className="label mt-1 text-muted-foreground">{summary}</p> : null}
      </header>
      <div className="min-w-0">
        {read.kind === 'pending' ? (
          <div aria-hidden className="h-24 rounded-section bg-muted" />
        ) : read.kind === 'failed' ? (
          <SectionUnread read={read} />
        ) : (
          children
        )}
      </div>
    </section>
  )
}

/** What a section says in place of its rows when its read failed. */
export function SectionUnread({ read }: { read: Extract<SectionRead, { kind: 'failed' }> }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-base text-muted-foreground">
        {t(read.failure.message, read.failure.values)}
      </p>
      <Button variant="outline" className="max-md:h-11" onClick={read.retry}>
        {t('settings.section.retry')}
      </Button>
    </div>
  )
}

export type SectionRead =
  | { kind: 'ready' }
  | { kind: 'pending' }
  | { kind: 'failed'; failure: ReadFailure; retry: () => void }
