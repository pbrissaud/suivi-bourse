/**
 * *Thème* as a page (#1248, #1314): the theme kept in the store, edited in a
 * token list with the real pages beside it, the whole app in jsdom and HTTP the
 * only faked edge.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { ThemeVars } from '@/features/settings/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
import atelier from '@/theme/atelier.json'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const THEME: ThemeVars = { theme: {}, light: { primary: 'red' }, dark: { primary: 'blue' } }

/** The store's row, faked; every write is kept, in order. */
function store(initial: ThemeVars | null = null) {
  let row = initial
  const writes: [string, unknown][] = []
  server.use(
    http.get(ROUTES.theme, () => HttpResponse.json(row)),
    http.put(ROUTES.theme, async ({ request }) => {
      writes.push(['put', await request.json()])
      row = THEME
      return HttpResponse.json(row)
    }),
    http.post(ROUTES.themeImport, async ({ request }) => {
      writes.push(['import', await request.json()])
      row = THEME
      return HttpResponse.json(row)
    }),
    http.delete(ROUTES.theme, () => {
      writes.push(['delete', null])
      row = null
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

async function openTheme() {
  const rendered = renderApp({ url: '/settings/theme' })
  await screen.findByRole('heading', { level: 1, name: 'Thème' })
  await screen.findByRole('button', { name: 'Modifier le JSON' })
  return rendered
}

function addLink() {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/api/theme.css'
  document.head.append(link)
  return link
}

/** A colour picked in the native input of a token's row. */
const pick = (name: string, hex: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value: hex } })

const preview = () => screen.getByTestId('theme-preview').firstElementChild as HTMLElement

const jsonField = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole('textbox', { name: 'Modifier le JSON' }) as HTMLTextAreaElement

afterEach(() => {
  document.head.querySelectorAll('link').forEach((link) => link.remove())
  document.documentElement.classList.remove('dark')
})

describe('the page', () => {
  it('leads back to Réglages, offers the three ways in, and lists the tokens by name', async () => {
    store()
    await openTheme()

    expect(screen.getByRole('link', { name: '← Réglages' })).toHaveAttribute('href', '/settings')
    for (const name of ['Importer depuis tweakcn', 'Modifier le JSON', 'Exporter']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: 'Clair' })).toHaveAttribute('aria-selected', 'true')
    for (const name of [
      'Fond de page',
      'Plan de section',
      'Encre',
      'Gain',
      'Perte',
      'Répartition 4',
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument()
    }
    expect(screen.getByRole('slider', { name: 'Rayon des angles' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Appliquer' })).toBeDisabled()
    // Atelier is what is in force: there is nothing to restore.
    expect(screen.getByRole('button', { name: 'Rétablir Atelier' })).toBeDisabled()
  })

  it('draws the real pages beside the tokens, one tab each, inert', async () => {
    store()
    const { user } = await openTheme()

    const frame = screen.getByTestId('theme-preview')
    expect(frame.firstElementChild).toHaveAttribute('inert')
    const tabs = screen.getByRole('tablist', { name: 'Page en aperçu' })
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((one) => one.textContent),
    ).toEqual(['Tableau de bord', 'Titres', 'Comptes', 'Grand livre'])

    await user.click(within(tabs).getByRole('tab', { name: 'Comptes' }))
    expect(within(tabs).getByRole('tab', { name: 'Comptes' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // The Thème page keeps its own title whatever page is drawn.
    expect(screen.getByRole('heading', { level: 1, name: 'Thème' })).toBeInTheDocument()
  })

  it('paints an edit in the preview only, marks the token, and reverts it', async () => {
    store()
    const { user } = await openTheme()

    pick('Encre', '#ff0000')

    await waitFor(() => expect(preview().style.getPropertyValue('--primary')).toMatch(/oklch/))
    expect(screen.getByRole('img', { name: 'Modifié' })).toBeInTheDocument()
    // The rest of the app is not repainted: no document-wide stylesheet.
    expect(document.getElementById('theme-preview')).toBeNull()
    expect(screen.getByText(/1 modification non appliquée/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Rétablir : Encre' }))
    expect(screen.queryByRole('img', { name: 'Modifié' })).toBeNull()
    expect(screen.getByText(/aucune modification/)).toBeInTheDocument()
  })

  it('previews the dark palette in dark, whatever the device is set to', async () => {
    store()
    const { user } = await openTheme()

    expect(preview()).not.toHaveClass('dark')
    await user.click(screen.getByRole('tab', { name: 'Sombre' }))

    expect(preview()).toHaveClass('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('applies once, and repaints with the new stylesheet', async () => {
    const link = addLink()
    const writes = store()
    const { user } = await openTheme()
    pick('Encre', '#ff0000')
    const apply = screen.getByRole('button', { name: 'Appliquer' })

    const done = user.click(apply)
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/))
    act(() => {
      link.dispatchEvent(new Event('load'))
    })
    await done

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0][0]).toBe('put')
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Modifié' })).toBeNull())
  })

  it('writes Ombres as opacity and strings, and the letter spacing under both its keys', async () => {
    const writes = store()
    await openTheme()

    const shadows = screen.getByRole('slider', { name: 'Ombres' })
    shadows.focus()
    fireEvent.keyDown(shadows, { key: 'End' })
    const tracking = screen.getByRole('slider', { name: 'Interlettrage' })
    tracking.focus()
    fireEvent.keyDown(tracking, { key: 'End' })
    fireEvent.click(screen.getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    const sent = writes[0][1] as ThemeVars
    expect(sent.theme['shadow-opacity']).toBe('0.5')
    expect(sent.theme['letter-spacing']).toBe('0.1em')
    expect(sent.theme['tracking-normal']).toBe('0.1em')
    expect(sent.theme['shadow-sm']).toContain('/ 0.5')
  })

  it('restores Atelier through the store, once something is stored', async () => {
    const writes = store(THEME)
    const link = addLink()
    const { user } = await openTheme()

    const restore = screen.getByRole('button', { name: 'Rétablir Atelier' })
    expect(restore).toBeEnabled()
    const done = user.click(restore)
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/))
    act(() => {
      link.dispatchEvent(new Event('load'))
    })
    await done

    await waitFor(() => expect(writes).toEqual([['delete', null]]))
  })

  it('says a refused apply in the bar, with the edits kept', async () => {
    store()
    server.use(
      http.put(ROUTES.theme, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.badRequest, title: 'Invalid request', status: 422, key: 'ring' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openTheme()
    pick('Encre', '#ff0000')

    await user.click(screen.getByRole('button', { name: 'Appliquer' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Clé refusée : ring')
    expect(screen.getByRole('img', { name: 'Modifié' })).toBeInTheDocument()
  })
})

describe('the JSON and the import', () => {
  async function dialogOf(user: Awaited<ReturnType<typeof openTheme>>['user'], name: string) {
    await user.click(screen.getByRole('button', { name }))
    return within(await screen.findByRole('dialog'))
  }

  it('opens the JSON on Atelier when nothing is stored, and saves it as any theme', async () => {
    const link = addLink()
    const writes = store()
    const { user } = await openTheme()
    const dialog = await dialogOf(user, 'Modifier le JSON')

    expect(JSON.parse(jsonField(dialog).value)).toEqual(atelier)
    const done = user.click(dialog.getByRole('button', { name: 'Appliquer' }))
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/))
    act(() => {
      link.dispatchEvent(new Event('load'))
    })
    await done

    await waitFor(() => expect(writes).toEqual([['put', atelier]]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers nothing to apply once the JSON is cleared, and sends nothing on unreadable JSON', async () => {
    const writes = store()
    const { user } = await openTheme()
    const dialog = await dialogOf(user, 'Modifier le JSON')
    const field = jsonField(dialog)

    await user.clear(field)
    expect(dialog.getByRole('button', { name: 'Appliquer' })).toBeDisabled()
    await user.paste('{ nope')
    await user.click(dialog.getByRole('button', { name: 'Appliquer' }))

    expect(dialog.getByRole('alert')).toHaveTextContent(/^JSON illisible : /)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(writes).toEqual([])
  })

  it('imports by id or by address, and marks the id field when the server refuses it', async () => {
    const link = addLink()
    const writes = store()
    const { user } = await openTheme()
    const dialog = await dialogOf(user, 'Importer depuis tweakcn')

    await user.type(
      dialog.getByLabelText('Identifiant ou adresse du thème'),
      'https://tweakcn.com/themes/claude',
    )
    const done = user.click(dialog.getByRole('button', { name: 'Importer' }))
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/))
    act(() => {
      link.dispatchEvent(new Event('load'))
    })
    await done

    await waitFor(() => expect(writes).toEqual([['import', { id: 'claude' }]]))
  })

  it('says what tweakcn answered when the import fails', async () => {
    store()
    server.use(
      http.post(ROUTES.themeImport, () =>
        HttpResponse.json(
          {
            type: PROBLEM_TYPES.providerRefused,
            title: 'Provider refused',
            status: 502,
            detail: 'tweakcn: answered 404',
            provider: 'tweakcn',
            reason: 'refused',
          },
          { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user } = await openTheme()
    const dialog = await dialogOf(user, 'Importer depuis tweakcn')

    await user.type(dialog.getByLabelText('Identifiant ou adresse du thème'), 'nope')
    await user.click(dialog.getByRole('button', { name: 'Importer' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('tweakcn n’a pas rendu de thème')
  })
})

describe('leaving the page with edits', () => {
  const leave = (router: Awaited<ReturnType<typeof openTheme>>['router']) =>
    act(() => {
      void router.navigate({ to: '/' })
    })

  it('asks nothing when nothing was edited', async () => {
    store()
    const { router } = await openTheme()

    leave(router)

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays on Rester, and on Escape, with the edits kept', async () => {
    store()
    const { user, router } = await openTheme()
    pick('Encre', '#ff0000')

    leave(router)
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('1 modification non appliquée')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Rester' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/settings/theme')

    leave(router)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/settings/theme')
    expect(screen.getByRole('img', { name: 'Modifié' })).toBeInTheDocument()
  })

  it('leaves on Abandonner, writing nothing', async () => {
    const writes = store()
    const { user, router } = await openTheme()
    pick('Encre', '#ff0000')

    leave(router)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abandonner' }),
    )

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(writes).toEqual([])
  })

  it('applies, then leaves, on Appliquer', async () => {
    const writes = store()
    const link = addLink()
    const { user, router } = await openTheme()
    pick('Encre', '#ff0000')

    leave(router)
    const done = user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Appliquer' }),
    )
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/))
    act(() => {
      link.dispatchEvent(new Event('load'))
    })
    await done

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(writes).toHaveLength(1)
  })
})
