/**
 * **The agent's proposal as `ProposalReview`'s source** (#1119).
 *
 * **The server remembers this one**: the proposal is a stored row that expires
 * in seven days, so nothing is re-uploaded. *Importer* calls `/merge`, and an
 * answer re-runs `/preview`. (A statement file is imported on its own page,
 * `ImportPreview`, through the two-step preview/commit routes.) A ledger that changed since the proposal answers
 * `409 proposal-stale`: the window closes on that sentence and the card reads
 * *stale*.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  editsBody,
  eventProposalsApi,
  NO_EDITS,
  proposalPath,
  type StatementEdit,
  type StatementEdits,
  type StatementPreview,
} from '@/features/agent/lib/eventProposals'
import type { AmountsIn, ImportReceipt } from '@/features/data/lib/api'
import {
  keptAsOne,
  NO_CORRESPONDENCE,
  repeatGroups,
  type Correspondence,
} from '@/features/data/lib/imports'
import type { ProposedLine } from '@/lib/api.gen'
import { ApiProblem, ROUTES, send } from '@/lib/api'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { PROBLEM_TYPES } from '@/lib/problem'

/**
 * **The whole answer the window collects**, and the parameter of every preview
 * (#835).
 *
 * The correspondence and the duplicates travel together because they are judged
 * together: the duplicate key carries the account, so *where these rows go* and
 * *what becomes of the ones the ledger already holds* are one question asked in
 * two halves. Either half changing costs a fresh forecast, and that is what
 * makes *no refusal arrives after the button* true rather than merely intended —
 * a flag the preview never carried would be a flag the server judges for the
 * first time under the button.
 */
export interface Answer {
  correspondence: Correspondence
  /** *These are real orders, write them* — the rows the ledger already holds. */
  writeDuplicates: boolean
  /**
   * **Which currency the foreign-quoted amounts are written in** (#1261).
   * `undefined` is *nobody said*, and nothing is preselected: the window blocks
   * the write until the reader answers.
   */
  amountsIn: AmountsIn | undefined
  /**
   * The groups of identical lines the file repeats that the reader keeps **one
   * copy** of, by the index of their first copy (#1267). `undefined` is *the
   * reader has not said*, and then the default stands (#1266): a group inside one
   * file is written whole, since only the reader knows whether two identical
   * lines are one order filled twice; a group spanning files keeps one copy,
   * since two overlapping exports are the usual cause.
   */
  collapsed: ReadonlySet<number> | undefined
}

/** Nothing answered yet — the first preview's answer, and a reset. */
export const NO_ANSWER: Answer = {
  correspondence: NO_CORRESPONDENCE,
  writeDuplicates: false,
  amountsIn: undefined,
  collapsed: undefined,
}

/**
 * **The groups to write whole**: every group the census names, but the ones the
 * reader collapsed — or, until they have said, the ones spanning files (#1266).
 * Computed from the census just read and never held, so an id a remapped
 * account has dropped is never sent (#1267).
 */
export function repeatsToWrite(
  census: ImportReceipt,
  collapsed: ReadonlySet<number> | undefined,
): number[] {
  const kept = keptAsOne(collapsed, census.duplicate_rows)
  return repeatGroups(census.duplicate_rows)
    .map((group) => group.first)
    .filter((first) => !kept.has(first))
}

/**
 * **What one answer forecasts**: the file, and what that answer would land.
 *
 * Two receipts and not one, and the reason is the server's own reading of
 * `?write_duplicates=1` — it moves the rows the ledger already holds out of
 * `duplicates` and into `written`, leaving **none to name**. So a preview taken
 * under the flag can no longer say which lines are duplicated, and the window is
 * drawn from exactly that. The file is therefore read with the duplicates
 * skipped — `file`, the census every block stands on — and, where the reader has
 * ticked the box, read a **second** time under the flag: `writing`, what the
 * button would really do, judged by the same `entries.judge` the write runs.
 *
 * `refused` is that second reading turned back — the `SELL` that only replays
 * because its duplicate was skipped, and stops replaying once it is not. It is
 * the refusal arriving **at the box** instead of after the button, which is the
 * criterion itself; and the census stands beside it rather than being replaced
 * by it, so the reader can untick and go on instead of being left with *Annuler*
 * as their only move.
 */
export interface Forecast {
  /** The file read with the duplicates skipped: the census, and its figures. */
  file: ImportReceipt
  /** What the answer would write, or nothing at all where it is refused. */
  writing: ImportReceipt | undefined
  /** The refusal that answer meets — the same problem the write would raise. */
  refused: unknown
}

/**
 * What `ProposalReview` reads: the proposal the agent made (`useProposalImport`,
 * #1119). The file import left for its own page (`ImportPreview`).
 */
export interface ImportReview {
  /**
   * Write the files that were previewed — by **re-uploading them**, in the
   * order they were first sent.
   *
   * The `File`s the reader chose are held in this hook for exactly as long as
   * their forecast stands, and they are sent again. There is no import id to
   * commit instead, because the server remembers no import: a pending-import
   * token would be `import_source` under another name, with a lifetime and a
   * sweeper to write.
   */
  commit: (options?: { declineCurrency?: boolean }) => void
  /** Put the batch down without writing it — the refusal the preview is for. */
  discard: () => void
  /**
   * **Read the same file again under a new answer** (#835).
   *
   * Not a convenience: the duplicate key carries the account, so a line sent
   * from `TR` into `pea` may be one the ledger already holds — and the forecast
   * the reader is looking at would say otherwise. The box about the duplicates
   * is the same question from the other end, and it is re-read for the harder
   * reason: writing the rows the ledger already holds is a **different ledger**
   * to replay, and one that skipped a `SELL` may stop replaying once it does
   * not. Every answer therefore costs a fresh preview, which is the same double
   * upload #813 already pays for and for the same reason: the server remembers
   * no import, ever.
   */
  reconsider: (answer: Answer) => void
  pending: boolean
  /**
   * A file is in hand — handed over and neither written nor put down.
   *
   * What the modal is open on, and it is **not** `forecast !== undefined`: a
   * file whose forecast was refused is still in hand, and that refusal is
   * exactly what the reader has to be shown, with the button disabled beside it.
   */
  held: boolean
  /** The files in hand, in the order they are sent (#1266). */
  filenames: string[]
  /** What *would* be written, while a file stands unwritten. */
  forecast: Forecast | undefined
  receipt: ImportReceipt | undefined
  error: unknown
  /**
   * The rows are the agent's proposal and not files (#1119): there is no file
   * to take out of the batch, and the window says whose rows they are.
   */
  proposal?: {
    lines: readonly ProposedLine[]
    /** A broker statement's preview, with the gestures it offers (#1120). */
    statement?: StatementPreview
    edit?: StatementEdit
  }
}

/** What a merge answers: the receipt, and the ids of the rows it wrote. */
export interface MergedReceipt extends ImportReceipt {
  written_ids: string[]
  proposal: { id: string; title: string; status: string }
}

function query(
  answer: Answer,
  writeDuplicates: boolean,
  repeats: readonly number[],
  foreign: readonly string[] = [],
): string {
  const params = [
    ...(writeDuplicates ? ['write_duplicates=1'] : []),
    // A proposal has at most 200 lines: the answers fit the query string.
    ...repeats.map((first) => `write_repeat=${first}`),
    ...(answer.amountsIn ? [`amounts_in=${answer.amountsIn}`] : []),
    ...foreign.map((pair) => `foreign=${encodeURIComponent(pair)}`),
  ]
  return params.length === 0 ? '' : `?${params.join('&')}`
}

const preview = (
  id: string,
  answer: Answer,
  writeDuplicates: boolean,
  repeats: readonly number[] = [],
  edits: StatementEdits = NO_EDITS,
) =>
  send<MergedReceipt>(
    proposalPath(ROUTES.agentProposalPreview, id) + query(answer, writeDuplicates, repeats),
    'POST',
    editsBody(edits),
  )

interface Options {
  /** The rows a merge wrote, so the ledger can mark them for a moment. */
  onMerged: (ids: string[]) => void
  /** The window is put down, merged or not: the address stops naming the proposal. */
  onClose: () => void
}

export function useProposalImport(
  id: string | undefined,
  { onMerged, onClose }: Options,
): ImportReview {
  const { t } = useI18n()
  const client = useQueryClient()
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER)
  // A statement's answers: the server keeps none, so every reading carries them.
  const [edits, setEdits] = useState<StatementEdits>(NO_EDITS)
  // The forecast on screen, held beside the mutation for the reason
  // TanStack gives: it empties `data` on every `mutate`.
  const [standing, setStanding] = useState<Forecast | undefined>(undefined)
  // The proposal on screen now: a reading that lands for another is let go of.
  const latest = useRef(id)
  // The proposal a reading was started for; keeps the effect below from
  // starting it twice (React runs effects twice in development).
  const started = useRef<string | undefined>(undefined)
  // Every line the owner is about to merge, not the eight the card lists.
  const lines = useQuery({
    queryKey: ['proposals', 'review', id],
    queryFn: () => eventProposalsApi.proposals([id as string]),
    enabled: id !== undefined,
  })

  /**
   * **The proposal cannot be acted on any more**: the ledger moved, or it was
   * decided or expired meanwhile. The window closes on the sentence, and the
   * card reads what the server holds.
   */
  const closing = (error: unknown): MessageKey | undefined => {
    if (!(error instanceof ApiProblem)) return undefined
    if (error.type === PROBLEM_TYPES.proposalStale) return 'problem.proposalStale'
    return error.type === PROBLEM_TYPES.conflict ? 'data.import.proposal.decided' : undefined
  }
  const closeOn = (key: MessageKey) => {
    toast.error(t(key))
    void client.invalidateQueries({ queryKey: ['proposals'] })
    setStanding(undefined)
    onClose()
  }

  const read = useMutation({
    mutationFn: async ({
      given,
      proposal,
      edited,
    }: {
      given: Answer
      proposal: string
      edited: StatementEdits
    }) => {
      const file = await preview(proposal, given, false, [], edited)
      // Repeats within one proposal are written whole until the owner says
      // otherwise, as for a file; the census read carries none.
      const repeats = repeatsToWrite(file, given.collapsed)
      const forecast: Forecast = { file, writing: file, refused: undefined }
      if (!given.writeDuplicates && repeats.length === 0) return { proposal, forecast }
      // The second reading, as the file's: it is a different ledger to replay.
      try {
        const writing = await preview(proposal, given, given.writeDuplicates, repeats, edited)
        return { proposal, forecast: { file, writing, refused: undefined } }
      } catch (refused) {
        return { proposal, forecast: { file, writing: undefined, refused } }
      }
    },
    onSuccess: ({ proposal, forecast }) => {
      if (proposal === latest.current) setStanding(forecast)
    },
    onError: (error) => {
      const key = closing(error)
      if (key) closeOn(key)
      else
        setStanding((previous) =>
          previous === undefined ? previous : { ...previous, writing: undefined, refused: error },
        )
    },
  })
  const write = useMutation({
    mutationFn: ({
      foreign,
      repeats,
    }: {
      foreign: readonly string[]
      repeats: readonly number[]
    }) =>
      send<MergedReceipt>(
        proposalPath(ROUTES.agentProposalMerge, id as string) +
          query(answer, answer.writeDuplicates, repeats, foreign),
        'POST',
        editsBody(edits),
      ),
    onSuccess: (receipt) => {
      // Every figure is downstream of the ledger (the ledger moved).
      void client.invalidateQueries()
      setStanding(undefined)
      setAnswer(NO_ANSWER)
      onMerged(receipt.written_ids)
      onClose()
    },
    onError: (error) => {
      const key = closing(error)
      if (key) closeOn(key)
    },
  })

  // The first reading of a proposal, once its id arrives; another id starts over.
  const { mutate: readFirst, reset: resetRead } = read
  const { reset: resetWrite } = write
  // Only the id starts a reading: the mutations' own functions are stable.
  useEffect(() => {
    // Set here and not while rendering, and before the reading it guards.
    latest.current = id
    if (started.current === id) return
    started.current = id
    setStanding(undefined)
    setAnswer(NO_ANSWER)
    setEdits(NO_EDITS)
    resetRead()
    resetWrite()
    if (id !== undefined) readFirst({ given: NO_ANSWER, proposal: id, edited: NO_EDITS })
  }, [id])

  const pending = read.isPending || write.isPending
  const held = id !== undefined

  /** An edit is kept, and the proposal is read again under it. */
  const edit = (next: StatementEdits) => {
    if (!held || pending) return
    setEdits(next)
    read.mutate({ given: answer, proposal: id as string, edited: next })
  }
  const pick = (n: number, symbol: string) => {
    const { [String(n)]: _, ...rest } = edits.symbols
    edit({ ...edits, symbols: symbol.trim() === '' ? rest : { ...rest, [String(n)]: symbol } })
  }
  const price = (symbol: string, value: number | null) => {
    const { [symbol]: _, ...rest } = edits.prices
    edit({ ...edits, prices: value === null ? rest : { ...rest, [symbol]: value } })
  }

  return {
    reconsider: (next) => {
      if (!held || pending) return
      setAnswer(next)
      read.mutate({ given: next, proposal: id as string, edited: edits })
    },
    commit: () => {
      if (!held || !standing || pending) return
      // The pairs the standing forecast listed, so the server converts what was judged.
      const foreign = answer.amountsIn
        ? (standing.file.foreign_lines ?? []).map((line) => `${line.symbol}:${line.currency}`)
        : []
      write.mutate({ foreign, repeats: repeatsToWrite(standing.file, answer.collapsed) })
    },
    discard: () => {
      setStanding(undefined)
      read.reset()
      write.reset()
      onClose()
    },
    pending,
    held,
    filenames: standing ? [standing.file.filename] : [],
    forecast: standing,
    receipt: undefined,
    error: pending ? undefined : (write.error ?? read.error ?? standing?.refused),
    proposal: held
      ? {
          // A statement's lines are the preview's own: they follow the edits.
          lines: standing?.file.statement?.lines ?? lines.data?.proposals[0]?.events ?? [],
          statement: standing?.file.statement,
          edit: { edits, pick, price },
        }
      : undefined,
  }
}
