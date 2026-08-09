/**
 * A page that exists, is reachable, is titled in the reader's language — and is
 * not built yet.
 *
 * The walking skeleton stops here on purpose. The four pages are **redesigned,
 * not ported**: almost every decision of the prototype's four pages was taken
 * blind, half of them were measured wrong, and reading `DashboardPage.tsx` to
 * modify it is the temptation the redesign exists to refuse. Each page arrives
 * whole, with its own ticket and its own measured decisions.
 */
import { useT, type MessageKey } from '@/lib/i18n'

export function PendingPage({ title }: { title: MessageKey }) {
  const t = useT()
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t(title)}</h1>
      <p className="text-sm text-muted-foreground">{t('page.pending')}</p>
    </div>
  )
}
