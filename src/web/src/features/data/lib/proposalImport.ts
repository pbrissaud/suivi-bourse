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
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import {
  type Answer,
  type Forecast,
  type ImportReview,
  NO_ANSWER,
} from '@/features/data/components/UploadZone'
import { proposalPath } from '@/features/agent/lib/eventProposals'
import type { ImportReceipt } from '@/features/data/lib/api'
import { ApiProblem, ROUTES, send } from '@/lib/api'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { PROBLEM_TYPES } from '@/lib/problem'

/** What a merge answers: the receipt, and the ids of the rows it wrote. */
export interface MergedReceipt extends ImportReceipt {
  written_ids: string[]
  proposal: { id: string; title: string; status: string }
}

function query(answer: Answer, writeDuplicates: boolean, foreign: readonly string[] = []): string {
  const params = [
    ...(writeDuplicates ? ['write_duplicates=1'] : []),
    ...(answer.amountsIn ? [`amounts_in=${answer.amountsIn}`] : []),
    ...foreign.map((pair) => `foreign=${encodeURIComponent(pair)}`),
  ]
  return params.length === 0 ? '' : `?${params.join('&')}`
}

const preview = (id: string, answer: Answer, writeDuplicates: boolean) =>
  send<MergedReceipt>(
    proposalPath(ROUTES.agentProposalPreview, id) + query(answer, writeDuplicates),
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
    mutationFn: async ({ given }: { given: Answer }): Promise<Forecast> => {
      const proposal = id as string
      const file = await preview(proposal, given, false)
      if (!given.writeDuplicates) return { file, writing: file, refused: undefined }
      // The second reading, as the file's: the flag is a different ledger to replay.
      try {
        return { file, writing: await preview(proposal, given, true), refused: undefined }
      } catch (refused) {
        return { file, writing: undefined, refused }
      }
    },
    onSuccess: (forecast) => setStanding(forecast),
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
    mutationFn: ({ foreign }: { foreign: readonly string[] }) =>
      send<MergedReceipt>(
        proposalPath(ROUTES.agentProposalMerge, id as string) +
          query(answer, answer.writeDuplicates, foreign),
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
    setStanding(undefined)
    setAnswer(NO_ANSWER)
    resetRead()
    resetWrite()
    if (id !== undefined) readFirst({ given: NO_ANSWER })
  }, [id])

  const pending = read.isPending || write.isPending
  const held = id !== undefined

  return {
    reconsider: (next) => {
      if (!held || pending) return
      setAnswer(next)
      read.mutate({ given: next })
    },
    commit: () => {
      if (!held || !standing || pending) return
      // The pairs the standing forecast listed, so the server converts what was judged.
      const foreign = answer.amountsIn
        ? (standing.file.foreign_lines ?? []).map((line) => `${line.symbol}:${line.currency}`)
        : []
      write.mutate({ foreign })
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
    proposal: held,
  }
}
