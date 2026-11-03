/**
 * Whether the session ended under the page (#1203): one flag, set by the first
 * `401` `authFetch` sees, cleared once the code is typed again.
 *
 * Module state and not React state, because `authFetch` is not a component: it
 * runs inside query functions, mutations and the chat transport alike.
 */
import { useSyncExternalStore } from 'react'

import { LIVE_REFRESH_MS } from '@/lib/live'

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

/**
 * **When this tab was last touched** (#1313): a request sent longer than one
 * live refresh after it is a *background* one, and carries
 * `X-SB-Background: 1` — the server then never extends the session for it, so
 * an idle tab's polls do not keep the code from being asked again.
 *
 * Input recency and not the query key: the Dashboard reads only live queries,
 * so marking by key would lock someone actively clicking around. The page's
 * load counts as an input.
 */
let lastInput = Date.now()
let watching = false

function touched() {
  lastInput = Date.now()
}

/** Installed once by the browser entry, like `pollLiveReads`. */
export function watchInput(target: Pick<Window, 'addEventListener'> = window) {
  if (watching) return
  watching = true
  const passive = { passive: true, capture: true } as const
  target.addEventListener('pointerdown', touched, passive)
  target.addEventListener('keydown', touched, passive)
  target.addEventListener('focus', touched, passive)
}

export function isBackground(now: number = Date.now()): boolean {
  return now - lastInput > LIVE_REFRESH_MS
}

/** Tests only: the tab as just loaded. */
export function resetInput(at: number = Date.now()) {
  lastInput = at
}
