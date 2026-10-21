/**
 * **The agent's proposal as the import preview's source** (#1119).
 *
 * `useProposalImport` has the shape of `useEventUpload` (`EventUpload`) so that
 * `ImportPreview` is drawn once for both, but **the server remembers this
 * one**: the proposal is a stored row that expires in seven days, so nothing is
 * re-uploaded. `hand` and `drop` do not exist, *Importer* calls `/merge`, and an
 * answer re-runs `/preview`. A ledger that changed since the proposal answers
 * `409 proposal-stale`: the window closes on that sentence and the card reads
 * *stale*.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  type Answer,
  type Forecast,
  type ImportReview,
  NO_ANSWER,
  repeatsToWrite,
} from '@/features/data/components/UploadZone'
import { eventProposalsApi, proposalPath } from '@/features/agent/lib/eventProposals'
import type { ImportReceipt } from '@/features/data/lib/api'
import { ApiProblem, ROUTES, send } from '@/lib/api'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { PROBLEM_TYPES } from '@/lib/problem'

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
) =>
  send<MergedReceipt>(
    proposalPath(ROUTES.agentProposalPreview, id) + query(answer, writeDuplicates, repeats),
    'POST',
    {},
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
  // The forecast on screen, held beside the mutation for the reason
  // `useEventUpload` gives: TanStack empties `data` on every `mutate`.
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
    mutationFn: async ({ given, proposal }: { given: Answer; proposal: string }) => {
      const file = await preview(proposal, given, false)
      // Repeats within one proposal are written whole until the owner says
      // otherwise, as for a file; the census read carries none.
      const repeats = repeatsToWrite(file, given.collapsed)
      const forecast: Forecast = { file, writing: file, refused: undefined }
      if (!given.writeDuplicates && repeats.length === 0) return { proposal, forecast }
      // The second reading, as the file's: it is a different ledger to replay.
      try {
        const writing = await preview(proposal, given, given.writeDuplicates, repeats)
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
        {},
      ),
    onSuccess: (receipt) => {
      // Every figure is downstream of the ledger (`useEventUpload` says why).
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
    resetRead()
    resetWrite()
    if (id !== undefined) readFirst({ given: NO_ANSWER, proposal: id })
  }, [id])

  const pending = read.isPending || write.isPending
  const held = id !== undefined

  return {
    reconsider: (next) => {
      if (!held || pending) return
      setAnswer(next)
      read.mutate({ given: next, proposal: id as string })
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
    proposal: held ? { lines: lines.data?.proposals[0]?.events ?? [] } : undefined,
  }
}
