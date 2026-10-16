/**
 * Whether the session ended under the page (#1203): one flag, set by the first
 * `401` `authFetch` sees, cleared once the code is typed again.
 *
 * Module state and not React state, because `authFetch` is not a component: it
 * runs inside query functions, mutations and the chat transport alike.
 */
import { useSyncExternalStore } from 'react'

let ended = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function sessionEnded() {
  if (ended) return
  ended = true
  emit()
}

export function sessionResumed() {
  if (!ended) return
  ended = false
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore(subscribe, () => ended)
}

/** What the chat transport throws on a `401`: the question goes back into the input. */
export class SessionEnded extends Error {
  readonly status = 401

  constructor() {
    super('The session ended')
    this.name = 'SessionEnded'
  }
}

export function isSessionEnded(error: unknown): boolean {
  return error instanceof SessionEnded || (error instanceof Error && error.name === 'SessionEnded')
}
