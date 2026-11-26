/**
 * The About-me text on the memory page (#1620): the field and its count, the
 * server's refusal in its own words, *Effacer*, and where the text goes.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AgentProvider } from '@/lib/api'
import type { Profile } from '@/features/agent/lib/profile'
import { aProvider } from '@/features/agent/tests/agentFixtures'
import { ROUTES } from '@/lib/api'
import { setViewportWidth } from '@/test/media'
import { renderApp } from '@/test/render'
import { server } from '@/test/server'

const CONFIRMED = '2026-11-20T09:00:00+00:00'

function memoryOf(about: string | null, providers: AgentProvider[] = [aProvider()]) {
  const writes: { method: string; body: unknown }[] = []
  let current: Profile = {
    facts: {},
    projects: [],
    about: about === null ? null : { text: about, confirmed_at: CONFIRMED },
  }
  server.use(
    http.get(ROUTES.agentThreads, () => HttpResponse.json([])),
    http.get(ROUTES.agentConfig, () => HttpResponse.json({ enabled: true, reasoning: 'low' })),
    http.get(ROUTES.agentProviders, () => HttpResponse.json(providers)),
    http.get(ROUTES.profile, () => HttpResponse.json(current)),
    http.put('/api/profile/about', async ({ request }) => {
      const body = (await request.json()) as { value: string }
      writes.push({ method: 'PUT', body })
      const text = body.value.trim()
      if ([...text].length > 1000)
        return HttpResponse.json(
          {
            title: 'Unprocessable',
            status: 422,
            detail: `the About-me text is at most 1000 characters (${[...text].length} given)`,
          },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        )
      current = { ...current, about: text ? { text, confirmed_at: CONFIRMED } : null }
      return HttpResponse.json(current)
    }),
    http.delete('/api/profile/about', () => {
      writes.push({ method: 'DELETE', body: null })
      current = { ...current, about: null }
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

async function openMemory() {
  setViewportWidth(1024)
  const view = renderApp({ url: '/agent/memory' })
  await screen.findByRole('heading', { level: 1, name: 'Mémoire' })
  const field = await screen.findByRole('textbox', { name: 'À propos de moi' })
  return { ...view, field }
}

describe('the About-me text (#1620)', () => {
  it('shows the saved text and its count, trimmed and in code points', async () => {
    memoryOf('  Je vis à Lyon 🙂  ')
    const { field } = await openMemory()
    expect(field).toHaveValue('  Je vis à Lyon 🙂  ')
    expect(screen.getByText(/^15 \/ 1\s000$/)).toBeInTheDocument()
    // The empty sentence would be false: the agent knows this text.
    expect(screen.queryByText('L’agent ne sait encore rien de vous.')).not.toBeInTheDocument()
  })

  it('saves the text, and the field shows what the server kept', async () => {
    const writes = memoryOf(null)
    const { user, field } = await openMemory()
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeDisabled()
    await user.type(field, ' Retraité, deux enfants. ')
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByDisplayValue('Retraité, deux enfants.')).toBe(field)
    expect(writes).toEqual([{ method: 'PUT', body: { value: ' Retraité, deux enfants. ' } }])
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeEnabled()
  })

  it('says the server’s refusal under the field, and saves nothing', async () => {
    const writes = memoryOf('Je vis à Lyon.')
    const { user, field } = await openMemory()
    fireEvent.change(field, { target: { value: 'a'.repeat(1001) } })
    expect(screen.getByText(/^1\s001 \/ 1\s000$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    const alert = await screen.findByRole('status')
    expect(alert).toHaveTextContent('the About-me text is at most 1000 characters (1001 given)')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field.getAttribute('aria-describedby')).toContain(alert.parentElement?.id)
    expect(writes).toHaveLength(1)
    expect(field).toHaveValue('a'.repeat(1001))
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeEnabled()

    // The next save that goes through takes the refusal away.
    fireEvent.change(field, { target: { value: 'Je vis à Paris.' } })
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByDisplayValue('Je vis à Paris.')).toBe(field)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears the text, and cannot clear what is not saved', async () => {
    const writes = memoryOf('Je vis à Lyon.')
    const { user, field } = await openMemory()
    const clear = screen.getByRole('button', { name: 'Effacer' })
    await user.click(clear)

    await waitFor(() => expect(field).toHaveValue(''))
    expect(writes).toEqual([{ method: 'DELETE', body: null }])
    expect(clear).toBeDisabled()
    expect(field).toHaveFocus()
    expect(screen.getByText('L’agent ne sait encore rien de vous.')).toBeInTheDocument()
  })

  it('names the default provider’s host the text is sent to', async () => {
    memoryOf(null, [
      aProvider({ id: 'p0', is_default: false, privacy: { ...aProvider().privacy, host: 'x.io' } }),
      aProvider(),
    ])
    await openMemory()
    expect(
      await screen.findByText('Ce texte est envoyé à api.anthropic.com à chaque question.'),
    ).toBeInTheDocument()
  })

  it('says the text stays on the network with a local provider', async () => {
    memoryOf(null, [
      aProvider({
        kind: 'ollama',
        privacy: { local: true, host: '192.168.1.10', fr: '', en: '' },
      }),
    ])
    const { field } = await openMemory()
    const line = await screen.findByText('Ce texte reste sur votre réseau.')
    expect(field.getAttribute('aria-describedby')).toContain(line.id)
    expect(within(screen.getByRole('main')).queryByText(/192\.168/)).not.toBeInTheDocument()
  })
})
