/**
 * Turning a failure into a sentence — by `type`, never by `status`, and never
 * by `detail` (ADR-0024).
 *
 * The server declares stable `type` identifiers and documents them as the thing
 * a client branches on; the prototype branched on `status` and rendered `detail`
 * raw, which is how a French title ended up over an English sentence in the
 * app's most consequential alert. `Accept-Language` was weighed and dropped: it
 * would buy a second implementation of the same message table.
 *
 * A `type` this table does not know falls back to the *unexpected error*
 * sentence rather than to the server's prose — an unknown type is a contract
 * drift, and the reader is not the one who can act on it.
 */
import { ApiProblem } from '@/lib/api'
import type { MessageKey } from '@/lib/i18n'

/** Mirrors `app/src/web/problem.py`. Relative URI references, as RFC 9457 allows. */
export const PROBLEM_TYPES = {
  storageUnavailable: '/problems/storage-unavailable',
  notFound: '/problems/not-found',
  badRequest: '/problems/bad-request',
  /**
   * The request is well formed and the **store's state** refuses it (#698): an
   * account an event names, an account a file provisioned, an id already taken.
   * It joins the table with #729, the first ticket whose gestures can meet one —
   * and until then a `409` fell through to *an error it did not expect*, which
   * is the opposite of what a refusal by design is.
   */
  conflict: '/problems/conflict',
  /**
   * A file this app writes no row from (#811): an unrecognised header, a
   * declaration of accounts, a v4 `config.yaml`, a format it does not read, or
   * a row the ledger's own rules refuse. Its own identifier rather than
   * `badRequest`, because the reader is holding a file and *the request is
   * malformed* would send them to look at the wrong thing.
   */
  invalidFile: '/problems/invalid-file',
  /** The upload is past the bound the server states (#811). */
  tooLarge: '/problems/payload-too-large',
  internal: '/problems/internal-error',
} as const

const MESSAGES: Record<string, MessageKey> = {
  [PROBLEM_TYPES.storageUnavailable]: 'problem.storageUnavailable',
  [PROBLEM_TYPES.notFound]: 'problem.notFound',
  [PROBLEM_TYPES.badRequest]: 'problem.badRequest',
  [PROBLEM_TYPES.conflict]: 'problem.conflict',
  [PROBLEM_TYPES.invalidFile]: 'problem.invalidFile',
  [PROBLEM_TYPES.tooLarge]: 'problem.tooLarge',
  [PROBLEM_TYPES.internal]: 'problem.internal',
}

/**
 * The catalogue key for a failed query. Anything that is not an `ApiProblem`
 * carrying a known `type` — a network error, an HTML page from a proxy, a
 * `type` we have never heard of — is the app not answering.
 */
export function problemMessageKey(error: unknown): MessageKey {
  if (error instanceof ApiProblem && error.type) {
    return MESSAGES[error.type] ?? 'problem.internal'
  }
  return 'problem.unreachable'
}
