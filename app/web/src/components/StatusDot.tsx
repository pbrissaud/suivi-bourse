/**
 * The status dot: a **state, never a count**, and a **link** (ADR-0021 as
 * amended by ADR-0022 on its location only).
 *
 * It sits at the right of the content header bar because that is the only place
 * that survives all three sidebar states — shadcn hides `SidebarMenuBadge` in
 * icon mode, and the drawer takes the whole navigation with it. Moving it off
 * the navigation strips its anchor, so it regains one by *leading* to the
 * installation tab instead of indicating without pointing. Without it, the only
 * hold a trial user has on *this container keeps nothing* is the modal they
 * closed.
 */
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { installationState, type InstallationState } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The four states, in colour. Exported because the sidebar's status card is the
 * **development** of this dot (#789) and a second copy of the mapping is a
 * second opinion on what *attention* looks like.
 */
export const STATE_TONE: Record<InstallationState, string> = {
  unknown: 'bg-muted-foreground',
  ok: 'bg-gain',
  attention: 'bg-attention',
  unreachable: 'bg-destructive',
}

export function StatusDot() {
  const t = useT()
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const state = installationState({ runtime: runtime.data, error: runtime.error })

  return (
    <Link
      to="/donnees"
      hash="installation"
      className="flex size-7 items-center justify-center rounded-md hover:bg-accent"
      aria-label={`${t('status.link')} — ${t('status.dot', { state })}`}
    >
      <span aria-hidden className={cn('size-2 rounded-full', STATE_TONE[state])} />
    </Link>
  )
}
