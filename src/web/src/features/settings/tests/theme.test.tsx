/**
 * *Thème* in Settings (#1248): the theme kept in the store, imported from
 * tweakcn or pasted, the whole app in jsdom and HTTP the only faked edge.
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
  const rendered = renderApp({ url: '/settings' })
  const block = await screen.findByRole('region', { name: 'Thème' })
  return { ...rendered, block }
}

/** The Dialog a button opened: it is portalled out of the section. */
async function dialogOf(user: Awaited<ReturnType<typeof openTheme>>['user'], opener: HTMLElement) {
  await user.click(opener)
  return within(await screen.findByRole('dialog'))
}

const jsonField = (dialog: ReturnType<typeof within>) =>
  dialog.getByRole('textbox', { name: 'Modifier le JSON' }) as HTMLTextAreaElement

function addLink() {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/api/theme.css'
  document.head.append(link)
  return link
}

afterEach(() => {
  document.head.querySelectorAll('link').forEach((link) => link.remove())
  document.getElementById('theme-preview')?.remove()
  document.documentElement.classList.remove('dark')
})

describe('the theme card', () => {
  it('says Atelier and offers no reset when nothing is stored', async () => {
    store()
    const { block } = await openTheme()

    expect(within(block).getByRole('status')).toHaveTextContent('Thème livré (Atelier)')
    expect(within(block).queryByRole('button', { name: 'Revenir à Atelier' })).toBeNull()
  })

  it('offers nothing to apply once the JSON is cleared', async () => {
    store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )

    await user.clear(jsonField(dialog))

    expect(dialog.getByRole('button', { name: 'Appliquer' })).toBeDisabled()
  })

  it('opens the JSON on Atelier when nothing is stored, and saves it as any theme', async () => {
    const writes = store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )

    expect(JSON.parse(jsonField(dialog).value)).toEqual(atelier)
    await user.click(dialog.getByRole('button', { name: 'Appliquer' }))

    expect(await within(block).findByText('Thème personnalisé · appliqué')).toBeInTheDocument()
    expect(writes).toEqual([['put', atelier]])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says a custom theme is stored, and resets it', async () => {
    const writes = store(THEME)
    const { user, block } = await openTheme()

    expect(within(block).getByRole('status')).toHaveTextContent('Thème personnalisé')
    await user.click(within(block).getByRole('button', { name: 'Revenir à Atelier' }))

    expect(await within(block).findByText('Atelier rétabli')).toBeInTheDocument()
    expect(writes).toEqual([['delete', null]])
    expect(within(block).queryByRole('button', { name: 'Revenir à Atelier' })).toBeNull()
  })

  it('imports by id, closes the dialog, and repaints', async () => {
    const link = addLink()
    const writes = store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Importer depuis tweakcn' }),
    )

    await user.type(dialog.getByLabelText('Identifiant ou adresse du thème'), 'claude')
    await user.click(dialog.getByRole('button', { name: 'Importer' }))

    expect(await within(block).findByText('Thème personnalisé · appliqué')).toBeInTheDocument()
    expect(writes).toEqual([['import', { id: 'claude' }]])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/)
  })

  it('imports from the address of a theme', async () => {
    const writes = store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Importer depuis tweakcn' }),
    )

    await user.type(
      dialog.getByLabelText('Identifiant ou adresse du thème'),
      'https://tweakcn.com/themes/claude?tab=1',
    )
    await user.click(dialog.getByRole('button', { name: 'Importer' }))

    await waitFor(() => expect(writes).toEqual([['import', { id: 'claude' }]]))
  })

  it('sends nothing on unreadable JSON and marks the field', async () => {
    const writes = store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )
    const field = jsonField(dialog)

    await user.clear(field)
    await user.paste('{ nope')
    await user.click(dialog.getByRole('button', { name: 'Appliquer' }))

    expect(dialog.getByRole('alert')).toHaveTextContent(/^JSON illisible : /)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    expect(writes).toEqual([])
  })

  it('names the key the server refused', async () => {
    store()
    server.use(
      http.put(ROUTES.theme, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.badRequest, title: 'Invalid request', status: 422, key: 'gain' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )
    const field = jsonField(dialog)

    await user.clear(field)
    await user.paste('{"light": {"gain": "red"}, "dark": {}}')
    await user.click(dialog.getByRole('button', { name: 'Appliquer' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent('Clé refusée : gain')
    await waitFor(() => expect(field).toHaveFocus())
    expect(field).toHaveAttribute('aria-invalid', 'true')
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
            detail: 'tweakcn: OSError: HTTP 404',
            provider: 'tweakcn',
            reason: 'unreachable',
          },
          { status: 502, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Importer depuis tweakcn' }),
    )

    await user.type(dialog.getByLabelText('Identifiant ou adresse du thème'), 'nope')
    await user.click(dialog.getByRole('button', { name: 'Importer' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'tweakcn n’a pas rendu de thème : OSError: HTTP 404',
    )
    expect(dialog.getByLabelText('Identifiant ou adresse du thème')).not.toHaveAttribute(
      'aria-invalid',
    )
  })

  it('marks the id field when the server refuses the id', async () => {
    store()
    server.use(
      http.post(ROUTES.themeImport, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.badRequest, title: 'Invalid request', status: 422, key: 'id' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Importer depuis tweakcn' }),
    )
    const field = dialog.getByLabelText('Identifiant ou adresse du thème')

    await user.type(field, 'Nope')
    await user.click(dialog.getByRole('button', { name: 'Importer' }))

    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Un identifiant tweakcn ne contient que',
    )
    expect(field).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(field).toHaveFocus())
  })

  it('applies pasted JSON, repaints, and shows what the store kept', async () => {
    const link = addLink()
    const writes = store()
    const { user, block } = await openTheme()
    const dialog = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )

    await user.clear(jsonField(dialog))
    await user.paste('{"light": {"primary": "red"}, "dark": {"primary": "blue"}}')
    await user.click(dialog.getByRole('button', { name: 'Appliquer' }))

    expect(await within(block).findByText('Thème personnalisé · appliqué')).toBeInTheDocument()
    expect(writes).toEqual([['put', { light: { primary: 'red' }, dark: { primary: 'blue' } }]])
    expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/)

    const reopened = await dialogOf(
      user,
      within(block).getByRole('button', { name: 'Modifier le JSON' }),
    )
    expect(JSON.parse(jsonField(reopened).value)).toEqual(THEME)
  })
})

const preview = () => document.getElementById('theme-preview')

async function openForm() {
  const rendered = await openTheme()
  await rendered.user.click(within(rendered.block).getByRole('button', { name: 'Modifier' }))
  return rendered
}

/** Move a colour field's native input, as the picker does. */
const pick = (name: string, hex: string) =>
  fireEvent.change(screen.getByLabelText(name), { target: { value: hex } })

describe('the theme form', () => {
  it('opens in place, shows the light palette by name, and hides the import and the JSON', async () => {
    store()
    const { block } = await openForm()

    expect(within(block).getByRole('radio', { name: 'Clair' })).toBeChecked()
    for (const name of ['Fond', 'Encre', 'Gain', 'Perte', 'Répartition 4']) {
      expect(within(block).getByLabelText(name)).toBeInTheDocument()
    }
    expect(within(block).getByRole('slider', { name: 'Arrondi' })).toBeInTheDocument()
    expect(within(block).queryByRole('button', { name: 'Importer depuis tweakcn' })).toBeNull()
    expect(within(block).queryByRole('button', { name: 'Modifier le JSON' })).toBeNull()
    expect(within(block).getByRole('button', { name: 'Appliquer' })).toBeDisabled()
    expect(preview()).toBeNull()
  })

  it('previews an edit over the whole app, and marks the field as edited', async () => {
    store()
    const { user, block } = await openForm()

    pick('Encre', '#ff0000')

    await waitFor(() => expect(preview()).not.toBeNull())
    expect(preview()?.textContent).toContain('html:root{')
    expect(preview()?.textContent).toMatch(/--ring: oklch\(0\.6\d* 0\.2\d* 29/)
    expect(within(block).getByText(/1 modification non appliquée/)).toBeInTheDocument()
    await user.click(within(block).getByRole('button', { name: 'Rétablir : Encre' }))
    expect(preview()).toBeNull()
    expect(within(block).getByText(/aucune modification/)).toBeInTheDocument()
  })

  it('applies once, and keeps the preview until the new stylesheet has loaded', async () => {
    const link = addLink()
    const writes = store()
    const { user, block } = await openForm()
    pick('Encre', '#ff0000')
    await waitFor(() => expect(preview()).not.toBeNull())

    await user.click(within(block).getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0][0]).toBe('put')
    expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/)
    expect(preview()).not.toBeNull()
    link.dispatchEvent(new Event('load'))
    await waitFor(() => expect(preview()).toBeNull())
    expect(within(block).getByText(/aucune modification/)).toBeInTheDocument()
  })

  it('keeps the preview and says so when the new stylesheet does not load', async () => {
    const link = addLink()
    store()
    const { user, block } = await openForm()
    pick('Encre', '#ff0000')
    await waitFor(() => expect(preview()).not.toBeNull())

    await user.click(within(block).getByRole('button', { name: 'Appliquer' }))
    await waitFor(() => expect(link.getAttribute('href')).toMatch(/\?v=/))
    link.dispatchEvent(new Event('error'))

    expect(await within(block).findByRole('alert')).toHaveTextContent(
      'Le thème est enregistré, mais la feuille de style n’a pas pu être rechargée',
    )
    expect(preview()).not.toBeNull()
  })

  it('shows the dark ground while the dark palette is edited, and gives it back on Annuler', async () => {
    const writes = store()
    const { user, block } = await openForm()

    await user.click(within(block).getByRole('radio', { name: 'Sombre' }))
    expect(document.documentElement).toHaveClass('dark')
    pick('Fond', '#101010')
    await waitFor(() => expect(preview()).not.toBeNull())
    await user.click(within(block).getByRole('button', { name: 'Annuler' }))

    expect(document.documentElement).not.toHaveClass('dark')
    expect(preview()).toBeNull()
    expect(within(block).getByRole('button', { name: 'Modifier' })).toBeInTheDocument()
    expect(writes).toEqual([])
  })

  it('writes Ombres as opacity and strings, and the letter spacing under both its keys', async () => {
    const writes = store()
    const { user, block } = await openForm()

    const shadows = within(block).getByRole('slider', { name: 'Ombres' })
    shadows.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    const tracking = within(block).getByRole('slider', { name: 'Espacement des lettres' })
    tracking.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(within(block).getByRole('button', { name: 'Appliquer' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    const sent = writes[0][1] as ThemeVars
    expect(sent.theme['shadow-opacity']).toBe('0.02')
    expect(sent.theme['shadow-2xl']).toBe('0px 1px 2px 0px hsl(0 0% 0% / 0.05)')
    expect(sent.theme['tracking-normal']).toBe('0.005em')
    expect(sent.theme['letter-spacing']).toBe('0.005em')
  })
})

describe('leaving the form with edits', () => {
  async function dirty() {
    const writes = store()
    const rendered = await openForm()
    pick('Encre', '#ff0000')
    await waitFor(() => expect(preview()).not.toBeNull())
    return { ...rendered, writes }
  }
  const leave = (router: Awaited<ReturnType<typeof openTheme>>['router']) =>
    act(() => {
      void router.navigate({ to: '/' })
    })

  it('asks nothing when nothing was edited', async () => {
    store()
    const { router } = await openForm()

    leave(router)

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays on Rester, and on Escape, with the edits and the preview kept', async () => {
    const { user, router } = await dirty()

    leave(router)
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('1 modification non appliquée')).toBeInTheDocument()
    expect(dialog.getByText('Abandonner rétablit le thème enregistré.')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Rester' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/settings')

    leave(router)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/settings')
    expect(preview()).not.toBeNull()
  })

  it('leaves on Abandonner and restores the saved theme', async () => {
    const { user, router, writes } = await dirty()

    leave(router)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abandonner' }),
    )

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(preview()).toBeNull()
    expect(writes).toEqual([])
  })

  it('applies, then leaves, on Appliquer', async () => {
    const { user, router, writes } = await dirty()

    leave(router)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Appliquer' }),
    )

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(writes).toHaveLength(1)
    expect(preview()).toBeNull()
  })

  it('stays, with the edits and the refusal in the bar, when Appliquer fails', async () => {
    const { user, router, block } = await dirty()
    server.use(
      http.put(ROUTES.theme, () =>
        HttpResponse.json(
          { type: PROBLEM_TYPES.badRequest, title: 'Invalid request', status: 422, key: 'ring' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    )

    leave(router)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Appliquer' }),
    )

    expect(await within(block).findByRole('alert')).toHaveTextContent('Clé refusée : ring')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(router.state.location.pathname).toBe('/settings')
    expect(preview()).not.toBeNull()
  })
})
