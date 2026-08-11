/**
 * A band — one live condition of the content column, in one spelling.
 *
 * There are two mounts and they are not two mechanisms: the shell's `Banner`
 * puts the full-bleed one at the top of the column for what is true of the
 * whole installation, and a page mounts its own, in place, for a condition only
 * that page can observe — its own read having failed. `lib/status.ts` keeps the
 * causal order between them, so there is still **one band on screen or none**.
 *
 * It carries `role="status"` rather than the component's default `alert`: a
 * band describes a condition that *lasts*, and an assertive live region would
 * interrupt a screen reader on every navigation for as long as it holds.
 */
import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'

export function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Alert role="status" variant="destructive" className={className}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
