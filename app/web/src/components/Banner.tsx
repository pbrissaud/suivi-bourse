/**
 * The banner: **one band, never two**, and it lives *inside* the content column.
 *
 * Mounted full width under a sidebar its left edge would run behind the column
 * — it has no honest left edge there (ADR-0022). "Visible from any page" loses
 * nothing: the content column is present on all four.
 *
 * What it says is a **condition the reader can make stop**, in causal order; a
 * fact they can only acknowledge belongs to the installation tab's notices
 * instead. Today one condition is observable, and it is the first cause of an
 * empty screen: the app is not answering. The rest arrive with the first-run
 * ticket as more entries in the same ordered list.
 */
import { useQuery } from '@tanstack/react-query'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { oneBand, shellConditions } from '@/lib/status'

export function Banner() {
  const t = useT()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const band = oneBand(shellConditions({ error: runtime.error }))

  if (!band) return null

  // `status` rather than the component's default `alert`: a band describes a
  // condition that *lasts*, and an assertive live region would interrupt a
  // screen reader on every navigation for as long as it holds.
  return (
    <Alert role="status" variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertDescription>{t(band.message)}</AlertDescription>
    </Alert>
  )
}
