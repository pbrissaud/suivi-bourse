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
 *
 * **It reads `/health`** since #819 (ADR-0036), and that is an assumed trade
 * rather than a detail: it read `/api/runtime`, which touches no store and
 * therefore outlives one that has failed — but that resource has exactly one
 * detectable problem in it, the scheduler being stopped, so a scrape frozen
 * since Tuesday left the dot green. Health is said in one place now and the dot
 * reads that place; the cost is that the body goes when the store goes, and
 * what survives is the half that matters then — the route answers `503`, the
 * read fails, and the dot is **red**.
 */
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { installationState, type InstallationState } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * The five states, in colour, and **exported exactly once**: the sidebar's
 * status card is the **development** of this dot (#789), and a second copy of
 * the mapping would be a second opinion on what *attention* looks like — which
 * is the one thing a development of something must never be.
 *
 * `rebuilding` shares `attention`'s tone and not its word (#787): both say *not
 * everything on screen is what it will be*, which is what a colour can carry,
 * and only the sentence can say that one needs a hand and the other only time.
 */
export const STATE_TONE: Record<InstallationState, string> = {
  unknown: 'bg-muted-foreground',
  ok: 'bg-gain',
  attention: 'bg-attention',
  rebuilding: 'bg-attention',
  unreachable: 'bg-destructive',
}

export function StatusDot() {
  const t = useT()
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const state = installationState({ health: health.data, error: health.error })

  return (
    // Still the installation tab, which is where the jobs and the store are —
    // the place where one repairs (ADR-0022, ADR-0036). The route it reads
    // changed; where it leads did not.
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
