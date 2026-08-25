/**
 * **Deleting the reduction** — the successor of *forget this import* (#814,
 * ADR-0032).
 *
 * The revocation by file went with the provenance at #816, and what replaced it
 * is worth more: it undoes a whole import without ever naming one, and it also
 * repairs the twelve rows somebody mistyped, which no revocation ever reached.
 * The price is that the gesture is **general**, and a general destructive
 * gesture has to say what it is about — which is where this component's three
 * decisions come from.
 *
 * **It lives with the table, under the reduction it consumes.** Not in the band
 * above, where the export menu is: what it acts on is the chips, and a
 * destructive button one surface away from the thing it destroys is how a
 * reader deletes two hundred and eighty-five events believing they are removing
 * a file. It is the padlock's rule (`ImportsBlock.tsx`) from the other end.
 *
 * **It is not offered while nothing is reduced.** With no chip pressed the
 * reduction is the whole ledger, so the button would be *delete everything*
 * wearing the same clothes as *delete this year* — and the reader would tell the
 * two apart by a count they have to read first. Emptying the ledger stays
 * possible, by reducing on something that covers it, and therefore
 * deliberately. The server refuses an unreduced request in `422` all the same:
 * two guards, because this one is a rendering and that one is the contract.
 *
 * **The confirmation names the reduction and counts its rows**, and never a
 * bare *are you sure*. That is the rule #794 wrote when three consecutive rows
 * of the export showed three identical red buttons: the reader has to read the
 * **subject** of what they are destroying, and here the subject is not a file
 * name — it is the five dimensions, each said in the vocabulary the chips are
 * already labelled with. The period reuses `data.filter.period.chip` rather than
 * spelling an interval a second time: one sentence, so the box and the chip
 * cannot come to disagree about which days are in.
 *
 * The count in the box is the **table's** — what the reduction retains, said
 * before the click. The count in the receipt is the **server's** — what actually
 * left. They are deliberately two, exactly as the revocation box and its answer
 * were: a box has to say what will happen, and the app owes the reader what did.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Band } from '@/components/Band'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { selectionParams, type LedgerFilters } from '@/lib/ledger'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

export interface BulkDeleteProps {
  /** The reduction in force: what the gesture consumes, and what it names. */
  selection: LedgerFilters
  /** How many rows it retains — counted on the table the reader is looking at. */
  selected: number
}

export function BulkDelete({ selection, selected }: BulkDeleteProps) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const queryClient = useQueryClient()
  const lines = useReductionLines(selection)

  const remove = useMutation({
    mutationFn: () => api.deleteEvents(selectionParams(selection)),
    onSuccess: (result) => {
      setConfirming(false)
      const receipt = receiptMessage({ kind: 'events.removed', count: result.events_removed })
      toast.success(t(receipt.message, receipt.values))
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously — the performance series included since #812 —
      // before answering, so what is invalidated is everything rather than a
      // list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
    },
  })

  // Nothing is reduced: there is no subject, so there is no gesture. The
  // whole-ledger case is reached by reducing on something that covers it.
  //
  // And nothing is retained: there is a subject and it is empty, so the gesture
  // would read *delete these 0 events* beside *no event matches*. The reduction
  // that holds nothing is the state this button says the least about, not the
  // one it shouts on — and the server answers such a request `200` and zero,
  // which is the same judgement one road over.
  if (lines.length === 0 || selected === 0) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          // The refusal is forgotten with the box that carried it: a mutation
          // error outlives its gesture, so reopening on another reduction would
          // show a sentence about the previous one.
          remove.reset()
          setConfirming(true)
        }}
      >
        {t('data.bulk.title', { count: selected })}
      </Button>

      <Dialog open={confirming} onOpenChange={(open) => (open ? null : setConfirming(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('data.bulk.confirm.title', { count: selected })}</DialogTitle>
            <DialogDescription>{t('data.bulk.confirm.body')}</DialogDescription>
          </DialogHeader>

          {/* The reduction, dimension by dimension. A list and not a sentence:
              the five compose, and a sentence enumerating up to five clauses in
              two languages is one nobody can keep true. */}
          <ul className="space-y-1 text-sm">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <p className="text-sm text-muted-foreground">{t('data.bulk.confirm.undo')}</p>

          {/* Rendered **here** and not on the page: the box stays open on a
              failure, and Radix marks everything behind the overlay
              `aria-hidden`, so a band outside it is a sentence nobody can read
              while the only thing on screen is the box that produced it. */}
          {remove.error ? <Band>{problemSentence(t, remove.error)}</Band> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              {t('data.bulk.confirm.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('data.bulk.confirm.submit')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * What the reduction retains, one rendered line per dimension in force.
 *
 * It is also the **test of whether anything is reduced at all**: an empty list
 * is `selectionParams(selection).size === 0` said in the vocabulary this
 * component renders, so the button and the box cannot come to disagree about
 * what a reduction is.
 */
function useReductionLines(selection: LedgerFilters): string[] {
  const { t } = useI18n()
  const f = useFormatters()

  const lines: string[] = []
  const query = selection.query.trim()
  if (query !== '') lines.push(t('data.bulk.confirm.on.query', { subject: query }))
  if (selection.type !== null) {
    lines.push(t('data.bulk.confirm.on.type', { type: t(TYPE_LABEL[selection.type]) }))
  }
  if (selection.account !== null) {
    lines.push(t('data.bulk.confirm.on.account', { account: selection.account }))
  }
  if (selection.symbols && selection.symbols.length > 0) {
    lines.push(
      t('data.bulk.confirm.on.symbols', {
        count: selection.symbols.length,
        // A sentence, so the enumeration is the language's (#768).
        symbols: f.list(selection.symbols),
      }),
    )
  }
  if (selection.since !== null || selection.until !== null) {
    // The chip's own sentence, reused rather than respelled: the box and the
    // chip must not come to disagree about which days the interval holds.
    lines.push(
      t('data.filter.period.chip', {
        bounds:
          selection.since !== null && selection.until !== null
            ? 'both'
            : selection.since !== null
              ? 'since'
              : 'until',
        since: f.date(selection.since),
        until: f.date(selection.until),
      }),
    )
  }
  return lines
}
