/**
 * *Thème* in Settings (#1248): the theme kept in the store, imported from
 * tweakcn or pasted, the whole app in jsdom and HTTP the only faked edge.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { ThemeVars } from '@/features/settings/lib/api'
import { ROUTES } from '@/lib/api'
import { PROBLEM_TYPES } from '@/lib/problem'
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

afterEach(() => document.head.querySelectorAll('link').forEach((link) => link.remove()))

describe('the theme card', () => {
  it('says Atelier and offers no reset when nothing is stored', async () => {
    store()
    const { user, block } = await openTheme()

    expect(within(block).getByRole('status')).toHaveTextContent('Thème livré (Atelier)')
    await user.click(within(block).getByRole('button', { name: 'Modifier le JSON' }))
    expect(within(block).queryByRole('button', { name: 'Revenir à Atelier' })).toBeNull()
    expect(within(block).getByRole('button', { name: 'Appliquer' })).toBeDisabled()
  })

  it('says a custom theme is stored, and resets it', async () => {
    const writes = store(THEME)
    const { user, block } = await openTheme()

    expect(within(block).getByRole('status')).toHaveTextContent('Thème personnalisé')
    await user.click(within(block).getByRole('button', { name: 'Modifier le JSON' }))
    await user.click(within(block).getByRole('button', { name: 'Revenir à Atelier' }))

    expect(await within(block).findByRole('status')).toHaveTextContent('Atelier rétabli')
    expect(writes).toEqual([['delete', null]])
    expect(within(block).queryByRole('button', { name: 'Revenir à Atelier' })).toBeNull()
  })

  it('imports by id, opens the JSON on what was kept, and repaints', async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/api/theme.css'
    document.head.append(link)
    const writes = store()
    const { user, block } = await openTheme()

    await user.type(within(block).getByLabelText('Importer depuis tweakcn'), 'claude')
    await user.click(within(block).getByRole('button', { name: 'Importer' }))

    expect(await within(block).findByRole('status')).toHaveTextContent(
      'Thème personnalisé · appliqué',
    )
    expect(writes).toEqual([['import', { id: 'claude' }]])
    expect(
      JSON.parse(
        (within(block).getByRole('textbox', { name: 'Modifier le JSON' }) as HTMLTextAreaElement)
          .value,
      ),
    ).toEqual(THEME)
    expect(link.getAttribute('href')).toMatch(/^\/api\/theme\.css\?v=\d+$/)
  })

  it('moves the one primary button from Importer to Appliquer as the JSON opens', async () => {
    store()
    const { user, block } = await openTheme()
    const importer = within(block).getByRole('button', { name: 'Importer' })

    expect(importer).toHaveAttribute('data-variant', 'default')
    await user.click(within(block).getByRole('button', { name: 'Modifier le JSON' }))

    expect(importer).toHaveAttribute('data-variant', 'secondary')
    expect(within(block).getByRole('button', { name: 'Appliquer' })).toHaveAttribute(
      'data-variant',
      'default',
    )
  })

  it('sends nothing on unreadable JSON and marks the field', async () => {
    const writes = store()
    const { user, block } = await openTheme()
    await user.click(within(block).getByRole('button', { name: 'Modifier le JSON' }))
    const field = within(block).getByRole('textbox', { name: 'Modifier le JSON' })

    await user.click(field)
    await user.paste('{ nope')
    await user.click(within(block).getByRole('button', { name: 'Appliquer' }))

    expect(within(block).getByRole('alert')).toHaveTextContent(/^JSON illisible : /)
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
    await user.click(within(block).getByRole('button', { name: 'Modifier le JSON' }))
    const field = within(block).getByRole('textbox', { name: 'Modifier le JSON' })

    await user.click(field)
    await user.paste('{"light": {"gain": "red"}, "dark": {}}')
    await user.click(within(block).getByRole('button', { name: 'Appliquer' }))

    expect(await within(block).findByRole('alert')).toHaveTextContent('Clé refusée : gain')
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

    await user.type(within(block).getByLabelText('Importer depuis tweakcn'), 'nope')
    await user.click(within(block).getByRole('button', { name: 'Importer' }))

    expect(await within(block).findByRole('alert')).toHaveTextContent(
      'tweakcn n’a pas rendu de thème : OSError: HTTP 404',
    )
    expect(within(block).getByLabelText('Importer depuis tweakcn')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })
})
