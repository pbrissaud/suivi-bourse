/**
 * The dashboard. Its **head** lands with #718, together with the three shared
 * primitives it is the first surface to need; the single chart with its two
 * readings, the allocation and the movers are the rest of the page and arrive
 * after it.
 */
import { DashboardHead } from '@/components/dashboard/Head'
import { useT } from '@/lib/i18n'

export default function DashboardPage() {
  const t = useT()
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t('page.dashboard')}</h1>
      <DashboardHead />
    </div>
  )
}
