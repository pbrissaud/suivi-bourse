/**
 * The link contract. It is one string, and both of its
 * moving parts are the kind that fails silently.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/lib/api'
import { DOCS_ANCHORS, docsHref, docsOrigin, docsPageHref, useDocs } from '@/lib/docs'
import { server } from '@/test/server'
import { aRuntime } from '@/test/factories'

describe('the documentation link', () => {
  it('carries the version, frozen at the major', () => {
    // Without the version segment `/docs` means *latest*, so this link would
    // serve v6's page the day v6 ships — not a stale page, a correct page about
    // another product, reached from an app that promised to explain itself.
    expect(docsHref('en', 'total-gain')).toBe(
      'https://pbrissaud.github.io/suivi-bourse/docs/v5/read-your-figures#total-gain',
    )
  })

  it('carries the locale, and English has none because it is the default', () => {
    expect(docsHref('fr', 'total-gain')).toBe(
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#total-gain',
    )
  })

  it('names one page whatever the count of anchors, never one page per figure', () => {
    // The rule is **one page**, and the count is descriptive: a figure that
    // earns a bubble earns a heading there, and the list grows with it. What
    // must not drift is the page, so that is what is asserted.
    for (const anchor of DOCS_ANCHORS) {
      expect(docsHref('fr', anchor)).toContain('/docs/v5/read-your-figures#')
    }
    expect(new Set(DOCS_ANCHORS).size).toBe(DOCS_ANCHORS.length)
  })
})

describe('the documentation root', () => {
  const ROOT = 'https://docs.example.net/suivi-bourse'

  it('replaces the default origin, in English and in French, version and anchor unchanged', () => {
    expect(docsHref('en', 'xirr', ROOT)).toBe(`${ROOT}/docs/v5/read-your-figures#xirr`)
    expect(docsPageHref('fr', 'settings', 'agent', ROOT)).toBe(`${ROOT}/fr/docs/v5/settings#agent`)
  })

  it('accepts a host root and a LAN http address, and drops a trailing slash', () => {
    expect(docsOrigin('https://docs-staging.example.net')).toBe('https://docs-staging.example.net')
    expect(docsOrigin('http://nas.lan:8000/docs/')).toBe('http://nas.lan:8000/docs')
  })

  it.each([undefined, null, '', '  ', '/suivi-bourse', 'docs.example', 'ftp://docs.example'])(
    'refuses %j and falls back to the default',
    (value) => {
      expect(docsOrigin(value)).toBe('https://pbrissaud.github.io/suivi-bourse')
    },
  )

  function hook() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    return { client, ...renderHook(() => useDocs().docsHref('fr', 'xirr'), { wrapper }) }
  }

  // The runtime query has answered (or failed): what is read next is its verdict, not the wait for it.
  const settled = (client: QueryClient) =>
    waitFor(() => expect(client.getQueryState(['runtime'])?.fetchStatus).toBe('idle'))

  it('is the default while the runtime has not answered', () => {
    const { result } = hook()
    expect(result.current).toBe(
      'https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#xirr',
    )
  })

  it('follows the runtime answer', async () => {
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ documentation_url: ROOT }))),
    )
    const { result } = hook()
    await waitFor(() => expect(result.current).toBe(`${ROOT}/fr/docs/v5/read-your-figures#xirr`))
  })

  it('keeps the default when the runtime fails', async () => {
    server.use(http.get(ROUTES.runtime, () => HttpResponse.json({}, { status: 500 })))
    const { client, result } = hook()
    await waitFor(() => expect(client.getQueryState(['runtime'])?.status).toBe('error'))
    expect(result.current).toContain('https://pbrissaud.github.io/suivi-bourse/')
  })

  it('keeps the default when the runtime names a relative root', async () => {
    server.use(
      http.get(ROUTES.runtime, () => HttpResponse.json(aRuntime({ documentation_url: '/docs' }))),
    )
    const { client, result } = hook()
    await waitFor(() => expect(client.getQueryState(['runtime'])?.status).toBe('success'))
    await settled(client)
    expect(result.current).toContain('https://pbrissaud.github.io/suivi-bourse/')
  })
})
