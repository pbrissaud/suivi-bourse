import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import type { ReadFailure } from '@/lib/status'

/**
 * A section of the Settings page: a tinted plane (`muted`, 18 px corners, no
 * border) whose title sits in a 220 px gutter from 1 024 px and above its rows
 * below. The title carries **no sentence** (« l'état, pas l'explication ») and
 * **nothing interactive lives in the gutter**: a section's switch is its first
 * row.
 *
 * The section reads its own data and says so itself. `read` is what its rows
 * stand on: `pending` holds the place with an empty plane, `failed` says one
 * sentence and offers to read again, and the rest of the page still works.
 */
export function SettingsSection({
  id,
  title,
  read = { kind: 'ready' },
  children,
}: {
  /** The anchor: `/settings#agent` lands on it, with focus. */
  id: string
  title: string
  read?: SectionRead
  children: ReactNode
}) {
  const heading = `${id}-title`
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={heading}
      className="mt-5 scroll-mt-20 rounded-section bg-muted px-6 pt-5 pb-6 outline-none first:mt-0 lg:grid lg:grid-cols-[220px_1fr] lg:gap-x-10"
    >
      <header className="mb-3 lg:mb-0">
        <h2 id={heading} className="text-2xl font-semibold">
          {title}
        </h2>
      </header>
      <div className="min-w-0">
        {read.kind === 'pending' ? (
          <div aria-hidden className="h-24" />
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
      <Button variant="outline" onClick={read.retry}>
        {t('settings.section.retry')}
      </Button>
    </div>
  )
}

export type SectionRead =
  | { kind: 'ready' }
  | { kind: 'pending' }
  | { kind: 'failed'; failure: ReadFailure; retry: () => void }
