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
import type { MessageKey, MessageValues } from '@/lib/i18n'

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
   * The gesture would leave a ledger that does not replay — an oversell (#824).
   *
   * `conflict`'s status and not its sentence. The four write paths that meet an
   * oversell used to answer `conflict`, whose phrase was written for #698's
   * refusals and is a plain untruth here: nothing exists already, and nothing
   * rests on anything. #811 made the case ordinary — an export that starts
   * mid-history sells positions opened before it — so the reader now meets it
   * holding a whole file that was refused for a reason that is not the reason.
   *
   * It carries `gesture` (`write` or `remove`), and `symbol`, `wanted`, `owned`
   * as the three facts the true sentence names.
   */
  unreplayableLedger: '/problems/unreplayable-ledger',
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
  // The sentence with **no** values in it — what is left to say when the
  // refusal arrived without its three numbers (an `AggregationError` raised
  // somewhere that does not know them leaves them `null`, and the server type
  // admits that rather than promising it cannot happen). The two that name the
  // security are reached through `problemMessage` below.
  [PROBLEM_TYPES.unreplayableLedger]: 'problem.unreplayableLedger',
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

/** An extension member, read only when it is the type the caller expects. */
function text(problem: ApiProblem, member: string): string | null {
  const value = problem.members[member]
  return typeof value === 'string' && value !== '' ? value : null
}

function quantity(problem: ApiProblem, member: string): number | null {
  const value = problem.members[member]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * `problemMessageKey`'s sibling, for a refusal whose sentence has **values in
 * it** (#824) — on `receiptMessage`'s model, and pure for the same reason: the
 * sentence is decided here and rendered by whoever holds a `t`.
 *
 * It is a second function and not a rewrite of the seventeen sites that read a
 * refusal: a caller with nothing to interpolate goes on calling
 * `problemMessageKey`, which is the whole of what it needs.
 *
 * The oversell is the one type that reaches its own branch, and it takes it
 * only when the server sent the three facts. Absent them there is still a true
 * sentence to say, and it is the table's.
 */
export function problemMessage(error: unknown): {
  message: MessageKey
  values: MessageValues
} {
  if (error instanceof ApiProblem && error.type === PROBLEM_TYPES.unreplayableLedger) {
    const symbol = text(error, 'symbol')
    const wanted = quantity(error, 'wanted')
    const owned = quantity(error, 'owned')
    if (symbol !== null && wanted !== null && owned !== null) {
      // `gesture` is a closed set of two, and the two are two pieces of news:
      // *this sells shares you do not hold* is not *taking this away leaves a
      // later sale without its shares*. Anything else on the wire is a contract
      // drift, and the writing sentence is the one that is true of a file —
      // which is how the refusal is overwhelmingly met.
      const removing = text(error, 'gesture') === 'remove'
      return {
        message: removing
          ? 'problem.unreplayableLedger.remove'
          : 'problem.unreplayableLedger.write',
        values: { symbol, wanted, owned },
      }
    }
  }
  return { message: problemMessageKey(error), values: {} }
}

/**
 * {@link problemMessage} rendered, for the callers that hold a `t` and want a
 * string. One line, and written once: a component doing the two steps itself is
 * a component that can forget to pass the values, and the sentence would then
 * render its own ICU source.
 */
export function problemSentence(
  t: (key: MessageKey, values?: MessageValues) => string,
  error: unknown,
): string {
  const said = problemMessage(error)
  return t(said.message, said.values)
}
