/**
 * The Thème page's side preview (`Reglages-Theme-Refonte`): **the real pages**,
 * Tableau de bord, Titres, Comptes and Grand livre, drawn at 1 440 px and scaled
 * to the column, under the candidate theme and nothing else.
 *
 * Two things keep the candidate off the rest of the app. The theme is laid on a
 * **wrapper** as inline variables — the colours of the ground being edited, the
 * radius, the fonts, the aliases that point at them — rather than on the
 * document, so the page around it stays in the saved theme. And each page runs in
 * a router of its own, over a memory history, with a heading context of its own,
 * so a page's `useSearch` finds the route it was written for and its title does
 * not replace the Thème page's. The wrapper is `inert` and takes no pointer:
 * this is a drawing, not a place to click.
 */
import { useMemo, useState, type CSSProperties } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { TextTabs } from '@/components/TextTabs'
import { validateLedgerSearch } from '@/features/data/lib/ledger'
import type { ThemeVars } from '@/features/settings/lib/api'
import { SEMANTIC_ALIASES } from '@/features/settings/lib/themeForm'
import { PageHeadingProvider } from '@/lib/pageHeading'
import { useI18n } from '@/lib/i18n'
import AccountsPage from '@/pages/AccountsPage'
import DashboardPage from '@/pages/DashboardPage'
import DataPage from '@/pages/DataPage'
import SharesPage from '@/pages/SharesPage'
import type { Ground } from '@/lib/theme'
import type { createAppRouter } from '@/router'

type PreviewPage = 'dashboard' | 'shares' | 'accounts' | 'ledger'

const PATH: Record<PreviewPage, string> = {
  dashboard: '/',
  shares: '/shares',
  accounts: '/accounts',
  ledger: '/ledger',
}

/** The width the pages are drawn at; the column scales it down. */
const DRAWN_AT = 1440

/** The theme on one ground as the inline variables of a wrapper. */
export function scopedVariables(theme: ThemeVars, ground: Ground): CSSProperties {
  const style: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...theme.theme, ...theme[ground] })) {
    style[`--${key}`] = value
  }
  for (const [key, value] of Object.entries(SEMANTIC_ALIASES)) style[`--${key}`] = value
  return style as CSSProperties
}

/** The four pages alone — no shell — on a memory history at `path`. */
function createPreviewRouter(path: string) {
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/', component: DashboardPage }),
      createRoute({ getParentRoute: () => root, path: '/shares', component: SharesPage }),
      createRoute({ getParentRoute: () => root, path: '/accounts', component: AccountsPage }),
      createRoute({
        getParentRoute: () => root,
        path: '/ledger',
        component: DataPage,
        validateSearch: validateLedgerSearch,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  // The app's own router is the registered one; this is a second, smaller tree.
  return router as unknown as ReturnType<typeof createAppRouter>
}

export function ThemePreview({ theme, ground }: { theme: ThemeVars; ground: Ground }) {
  const { t } = useI18n()
  const [shown, setShown] = useState<PreviewPage>('dashboard')
  const router = useMemo(() => createPreviewRouter(PATH[shown]), [shown])
  const style = useMemo(() => scopedVariables(theme, ground), [theme, ground])

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <TextTabs
        label={t('settings.theme.preview.pages')}
        value={shown}
        onChange={setShown}
        tabs={[
          { value: 'dashboard', label: t('nav.dashboard') },
          { value: 'shares', label: t('nav.shares') },
          { value: 'accounts', label: t('nav.accounts') },
          { value: 'ledger', label: t('nav.ledger') },
        ]}
      />
      <div
        data-testid="theme-preview"
        className="relative min-h-140 flex-1 overflow-hidden rounded-xl border bg-background"
      >
        <div
          inert
          aria-hidden
          style={{
            ...style,
            width: DRAWN_AT,
            transform: 'scale(0.52)',
            transformOrigin: 'top left',
            pointerEvents: 'none',
            fontFamily: 'var(--font-sans)',
            letterSpacing: 'var(--tracking-normal)',
          }}
          className={`absolute top-0 left-0 bg-background px-8 pt-8 pb-14 text-base text-foreground ${ground === 'dark' ? 'dark' : ''}`}
        >
          <PageHeadingProvider>
            <RouterProvider router={router} />
          </PageHeadingProvider>
        </div>
      </div>
    </div>
  )
}
