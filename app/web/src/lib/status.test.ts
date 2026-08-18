/**
 * The two derivations of the shell, and the problem table they read.
 */
import { describe, expect, it } from 'vitest'

import { ApiProblem } from '@/lib/api'
import { PROBLEM_TYPES, problemMessageKey } from '@/lib/problem'
import { installationState, oneBand, readConditions, shellConditions } from '@/lib/status'
import { aRuntime } from '@/test/factories'

describe('the status dot is a state, never a count', () => {
  it('says nothing before the first answer, rather than saying "fine"', () => {
    expect(installationState({})).toBe('unknown')
  })

  it('reads a running scheduler as fine and a stopped one as worth a look', () => {
    expect(installationState({ runtime: aRuntime() })).toBe('ok')
    expect(installationState({ runtime: aRuntime({ scheduler_running: false }) })).toBe('attention')
  })

  it('reads a failed query as unreachable, whatever the payload said', () => {
    expect(
      installationState({
        runtime: aRuntime(),
        error: new ApiProblem({ status: 503, type: PROBLEM_TYPES.storageUnavailable }),
      }),
    ).toBe('unreachable')
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

describe('the causal order of the shell’s three conditions (#726)', () => {
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

  it('renders one band with both conditions true, and it is the currency', () => {
    // With no reporting currency nothing is converted and the perf job writes
    // nothing at all, so a reconstruction running underneath has no figure to
    // excuse yet. Two bands here would be the wall the ticket exists against.
    // The property is *what reaches the slot*, not how long the list is:
    // `oneBand` is the cap, and asserting the length would fail on an ordered
    // list built whole — which is the same behaviour on screen.
    const conditions = shellConditions({ currencyUnanswered: true, runtime: rebuilding })
    expect(oneBand(conditions)).toEqual({
      message: 'banner.currency',
      gesture: { to: '/donnees', hash: 'installation', label: 'banner.currency.gesture' },
    })
  })

  it('frees the slot the moment the question is answered', () => {
    expect(oneBand(shellConditions({ currencyUnanswered: false, runtime: rebuilding }))).toEqual({
      message: 'banner.rebuilding',
    })
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
