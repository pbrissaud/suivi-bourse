/**
 * The two derivations of the shell, and the problem table they read.
 */
import { describe, expect, it } from 'vitest'

import { ApiProblem } from '@/lib/api'
import { formatMessage } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessage, problemMessageKey } from '@/lib/problem'
import { installationState, oneBand, readConditions, shellConditions } from '@/lib/status'
import { NOW, aFrozenScrape, aHealth, aHealthJobs, aRuntime } from '@/test/factories'

describe('the status dot is a state, never a count', () => {
  it('says nothing before the first answer, rather than saying "fine"', () => {
    expect(installationState({})).toBe('unknown')
  })

  it('reads a well install as fine', () => {
    expect(installationState({ health: aHealth() })).toBe('ok')
  })

  it('turns amber on a writer frozen since Tuesday — the behaviour #819 adds', () => {
    // The dot read `/api/runtime` before this ticket, whose one detectable
    // problem is a stopped scheduler: this install has a running scheduler, a
    // store that answers and a scrape that has written nothing for days, and it
    // was **green**. It is the body that says so, and it says so with a `200`.
    expect(installationState({ health: aFrozenScrape() })).toBe('attention')
  })

  it('still turns amber on the one problem it could already see', () => {
    // A stopped scheduler is folded into the body's own word by the server, so
    // the front reads one member where it used to read two.
    expect(
      installationState({
        health: aHealth({ status: 'attention', scheduler_running: false }),
      }),
    ).toBe('attention')
  })

  it('reads a failed query as unreachable, whatever the payload said', () => {
    expect(
      installationState({
        health: aHealth(),
        error: new ApiProblem({ status: 503, type: PROBLEM_TYPES.storageUnavailable }),
      }),
    ).toBe('unreachable')
  })

  it('is red on a route that answers with no body it can read', () => {
    // ADR-0036's trade, and the half of it that is not a `503`: the body goes
    // when the store goes, and the colour has to stay true when the detail
    // disappears. A proxy's own JSON, an image whose body has moved on — the
    // dot says *the app is not answering*, which is what has happened.
    expect(installationState({ health: null })).toBe('unreachable')
    expect(installationState({ health: 'ok' })).toBe('unreachable')
    expect(installationState({ health: {} })).toBe('unreachable')
    expect(installationState({ health: { status: 'degraded' } })).toBe('unreachable')
    // The most ordinary proxy body of all, and the one that would cost the
    // most: a word this front *does* know, alone, with none of the three
    // members that make it this object — green on somebody else's JSON.
    expect(installationState({ health: { status: 'ok' } })).toBe('unreachable')
  })

  it('keeps grey for "nothing has run yet", which is not "something is wrong"', () => {
    // A container a minute old. The body says `unknown` and the dot says the
    // same — grey claims nothing, and amber would send a reader looking for a
    // fault that does not exist.
    expect(installationState({ health: aHealth({ status: 'unknown' }) })).toBe('unknown')
  })

  it('reads a rebuild off the backfill’s verdict, not off the whole’s word', () => {
    // The backfill's own `status` is `ok` while it runs, deliberately: a
    // reconstruction is not something to look at. Read off that word the dot
    // would be green during a rebuild, which is exactly what #787 removed.
    const rebuilding = aHealth({
      jobs: aHealthJobs({
        backfill: {
          status: 'ok',
          at: '2026-03-02T11:59:00.000Z',
          verdict: 'running',
          complete: 1,
          in_scope: 3,
          attention: [],
        },
      }),
    })
    expect(installationState({ health: rebuilding })).toBe('rebuilding')
  })

  it('puts attention above a rebuild: a stopped job is why one never finishes', () => {
    const both = aHealth({
      status: 'attention',
      jobs: aHealthJobs({
        scrape: {
          status: 'attention',
          at: NOW,
          verdict: 'frozen',
          held: 3,
          attention: ['ZETA'],
        },
        backfill: {
          status: 'ok',
          at: NOW,
          verdict: 'running',
          complete: 1,
          in_scope: 3,
          attention: [],
        },
      }),
    })
    expect(installationState({ health: both })).toBe('attention')
  })

  it('survives a body whose jobs the app itself could not read', () => {
    // `web/health.py` guards its own fold: a defect in the shaping is not a
    // reason to restart the container, and what it fails to say it says it
    // could not say. That is a readable body — grey, and never red.
    expect(
      installationState({
        health: aHealth({ status: 'unknown', jobs: null, error: 'The jobs could not be read' }),
      }),
    ).toBe('unknown')
  })
})

describe('the banner shows one band or none', () => {
  it('shows nothing when nothing is wrong', () => {
    expect(oneBand(shellConditions({}))).toBeNull()
  })

  it('keeps the first condition of the causal order, never two', () => {
    const band = oneBand([{ message: 'problem.unreachable' }, { message: 'problem.internal' }])
    expect(band).toEqual({ message: 'problem.unreachable' })
  })
})

describe('the causal order of the shell’s two conditions (#726, #787)', () => {
  const rebuilding = aRuntime({ rebuilding: true, accounts: [] })

  it('puts the app not answering first: nothing under it has a figure to excuse', () => {
    expect(
      oneBand(
        shellConditions({
          error: new TypeError('Failed to fetch'),
          currencyUnanswered: true,
          runtime: rebuilding,
        }),
      ),
    ).toEqual({ message: 'problem.unreachable' })
  })

  it('renders the currency band, whatever else is true of the installation', () => {
    // The property is *what reaches the slot*, not how long the list is:
    // `oneBand` is the cap, and asserting the length would fail on an ordered
    // list built whole — which is the same behaviour on screen.
    const conditions = shellConditions({ currencyUnanswered: true, runtime: rebuilding })
    expect(oneBand(conditions)).toEqual({
      message: 'banner.currency',
      gesture: { to: '/donnees', hash: 'installation', label: 'banner.currency.gesture' },
    })
  })

  it('frees the slot the moment the question is answered, and hands it to nobody', () => {
    // The order is one condition shorter since #787: the reconstruction is a
    // **state of the dot** now, not a band. A condition that ends by itself does
    // not take the top of every page on every route, and the dot it moved to is
    // a link — so the fact kept its address and lost its cost.
    expect(oneBand(shellConditions({ currencyUnanswered: false, runtime: rebuilding }))).toBeNull()
    // The dot's own reading of the same installation, off `/health` since #819:
    // the fact is the backfill's verdict rather than the runtime's boolean, and
    // the state it lands on is unchanged.
    expect(
      installationState({
        health: aHealth({
          jobs: aHealthJobs({
            backfill: {
              status: 'ok',
              at: NOW,
              verdict: 'running',
              complete: 0,
              in_scope: 2,
              attention: [],
            },
          }),
        }),
      }),
    ).toBe('rebuilding')
  })

  it('keeps its gesture, because the reader can make this condition stop', () => {
    // A link to its own field, and never an acknowledgement: acknowledging
    // *I have no currency* means nothing, which is why it is not one of the
    // acknowledgement table's five keys (ADR-0021).
    const band = oneBand(shellConditions({ currencyUnanswered: true }))
    expect(band?.gesture?.to).toBe('/donnees')
  })

  it('raises no band on a silence', () => {
    // `undefined` is *nothing has been observed about it* — a claim about the
    // reader's installation made before anybody looked (ADR-0026).
    expect(shellConditions({ currencyUnanswered: undefined })).toEqual([])
  })
})

describe('a page names its own failed read, and the shell cannot do it for it', () => {
  const unreadable = new ApiProblem({ status: 503, type: PROBLEM_TYPES.storageUnavailable })

  it('names a read the shell is structurally blind to', () => {
    // `/api/runtime` answers from process memory and never opens the store, so
    // `shellConditions` is empty on precisely the failure that empties a page.
    // Without this the page renders nothing at all, and *"the store is
    // unreadable"* and *"you own nothing yet"* become the same blank screen.
    expect(shellConditions({})).toEqual([])
    expect(oneBand(readConditions({ errors: [unreadable] }))).toEqual({
      message: 'problem.storageUnavailable',
    })
  })

  it('says nothing while the shell is already saying the app does not answer', () => {
    // The order is causal: while nothing answers, that is the cause of every
    // failed read under it, and two announcers for one fact is the defect.
    expect(
      readConditions({ shellError: new TypeError('Failed to fetch'), errors: [unreadable] }),
    ).toEqual([])
  })

  it('says nothing when the reads are fine', () => {
    expect(readConditions({ errors: [undefined, null] })).toEqual([])
  })
})

describe('the front branches on problem.type, never on status', () => {
  it('maps each declared type to its own sentence', () => {
    expect(problemMessageKey(new ApiProblem({ status: 503, type: PROBLEM_TYPES.storageUnavailable })))
      .toBe('problem.storageUnavailable')
    expect(problemMessageKey(new ApiProblem({ status: 404, type: PROBLEM_TYPES.notFound })))
      .toBe('problem.notFound')
    expect(problemMessageKey(new ApiProblem({ status: 400, type: PROBLEM_TYPES.badRequest })))
      .toBe('problem.badRequest')
  })

  it('does not read a 503 as a store failure when the type says otherwise', () => {
    // Branching on `status` is what made two unrelated failures the same
    // screen. The same status, two types, two sentences.
    const other = new ApiProblem({ status: 503, type: PROBLEM_TYPES.internal })
    expect(problemMessageKey(other)).toBe('problem.internal')
  })

  it('treats an unknown type, and anything that is not a problem, as the app not answering', () => {
    expect(problemMessageKey(new ApiProblem({ status: 500, type: '/problems/from-the-future' })))
      .toBe('problem.internal')
    expect(problemMessageKey(new ApiProblem({ status: 502 }))).toBe('problem.unreachable')
    expect(problemMessageKey(new TypeError('Failed to fetch'))).toBe('problem.unreachable')
  })
})

describe('the oversell says a sentence with values in it (#824)', () => {
  const oversell = (members: Record<string, unknown>) =>
    new ApiProblem({
      status: 409,
      type: PROBLEM_TYPES.unreplayableLedger,
      title: 'Ledger does not replay',
      detail: 'Cannot sell 12.0 shares of AAPL (only 10.0 owned) on 2024-09-15',
      ...members,
    })

  it('selects the sentence on the gesture the server named', () => {
    // The two are two pieces of news, and no payload distinguishes them: the
    // same three numbers arrive whether the ledger stopped replaying because
    // something was written or because something was taken away.
    const values = { symbol: 'AAPL', wanted: 12, owned: 10 }
    expect(problemMessage(oversell({ ...values, gesture: 'write' })))
      .toEqual({ message: 'problem.unreplayableLedger.write', values })
    expect(problemMessage(oversell({ ...values, gesture: 'remove' })))
      .toEqual({ message: 'problem.unreplayableLedger.remove', values })
  })

  it('falls back to the sentence with no values when the facts did not travel', () => {
    // `AggregationError` admits all four members being absent — a raise from
    // somewhere that does not know them — so the front must have something true
    // to say rather than render an ICU source with a hole in it.
    expect(problemMessage(oversell({ gesture: 'write' })))
      .toEqual({ message: 'problem.unreplayableLedger', values: {} })
    // And a member of the wrong shape is an absent member, not a cast.
    expect(problemMessage(oversell({ symbol: 'AAPL', wanted: '12', owned: 10 })))
      .toEqual({ message: 'problem.unreplayableLedger', values: {} })
  })

  it('names the security in both catalogues, and renders the server’s prose in neither', () => {
    const said = problemMessage(
      oversell({ gesture: 'write', symbol: 'AAPL', wanted: 12, owned: 10.5 }),
    )

    for (const language of ['fr', 'en'] as const) {
      const sentence = formatMessage(language, said.message, said.values)
      expect(sentence).toContain('AAPL')
      expect(sentence).not.toContain('Cannot sell')
      // The quantities are formatted by the reader's own locale, out of the
      // catalogue rather than by a caller that could forget to.
      expect(sentence).not.toContain('{')
    }
    expect(formatMessage('fr', said.message, said.values)).toContain('10,5')
    expect(formatMessage('en', said.message, said.values)).toContain('10.5')
  })

  it('agrees the counted noun with the quantity, from the catalogue', () => {
    // A file selling one share of a security never bought is reachable, and
    // *vend 1 parts* / *sells 1 shares* is the catalogue rendering its own
    // hole. The branch lives in the message, where the language decides it —
    // French counts 1,5 as singular and English does not.
    const one = problemMessage(oversell({ gesture: 'write', symbol: 'AAPL', wanted: 1, owned: 0 }))
    expect(formatMessage('fr', one.message, one.values)).toContain('vend 1 part de AAPL')
    expect(formatMessage('en', one.message, one.values)).toContain('sells 1 share of AAPL')

    const many = problemMessage(oversell({ gesture: 'remove', symbol: 'AAPL', wanted: 2, owned: 0 }))
    expect(formatMessage('fr', many.message, many.values)).toContain('vend 2 parts')
    expect(formatMessage('en', many.message, many.values)).toContain('sells 2 shares')

    const half = problemMessage(oversell({ gesture: 'write', symbol: 'AAPL', wanted: 1.5, owned: 0 }))
    expect(formatMessage('fr', half.message, half.values)).toContain('vend 1,5 part de AAPL')
    expect(formatMessage('en', half.message, half.values)).toContain('sells 1.5 shares of AAPL')
  })

  it('carries what a refusal declares beside its four standard members', () => {
    // RFC 9457's extension members, kept whole: the three numbers here, `key`
    // on a `422`, `limit` on a `413`. `ApiProblem` used to drop all of them.
    const problem = oversell({ gesture: 'write', symbol: 'AAPL', wanted: 12, owned: 10 })
    expect(problem.members).toEqual({
      gesture: 'write', symbol: 'AAPL', wanted: 12, owned: 10,
    })
    expect(problem.detail).toBe(
      'Cannot sell 12.0 shares of AAPL (only 10.0 owned) on 2024-09-15',
    )
  })
})
