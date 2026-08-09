/**
 * The two derivations of the shell, and the problem table they read.
 */
import { describe, expect, it } from 'vitest'

import { ApiProblem } from '@/lib/api'
import { PROBLEM_TYPES, problemMessageKey } from '@/lib/problem'
import { installationState, oneBand, shellConditions } from '@/lib/status'
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
