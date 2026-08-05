import { Link, Outlet } from '@tanstack/react-router'

/**
 * The app shell: the nav the four pages hang off, and the only thing that
 * outlives a page.
 *
 * Real URLs rather than tab state, and that is not a detail — Flask's catch-all
 * was built for client-side routing (it falls through to `index.html` for every
 * unknown path, guarding only `/api` and `/metrics`), and a test in
 * `test_web_api.py` already reaches for `/titres/AAPL`. Tab state would have
 * left that machinery unused and cost the deep link, the back button and
 * survival across a refresh.
 */

const LINKS = [
  { to: '/', label: 'Tableau de bord' },
  { to: '/titres', label: 'Titres' },
  { to: '/comptes', label: 'Comptes' },
  { to: '/donnees', label: 'Données' },
] as const

export function Shell() {
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <span className="font-semibold tracking-tight">SuiviBourse</span>
          <nav className="flex gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                // `exact` on the index route only: without it "/" matches every
                // path and both links would light up at once.
                activeOptions={{ exact: link.to === '/' }}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                activeProps={{ className: 'bg-secondary text-foreground font-medium' }}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-6">
        <Outlet />
      </main>
    </div>
  )
}

export function NotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Page introuvable</h1>
      <p className="text-sm text-muted-foreground">
        Cette adresse ne correspond à aucune page.{' '}
        <Link to="/" className="underline">
          Revenir au tableau de bord
        </Link>
        .
      </p>
    </div>
  )
}
