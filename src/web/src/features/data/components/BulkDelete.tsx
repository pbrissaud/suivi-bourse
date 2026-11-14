/**
 * **Deleting the selection** — the rows the reader ticked (#1113), successor of
 * the deletion on the reduction (#814, #834).
 *
 * The gesture every table app has: tick rows, delete the ticked rows. The
 * button is **rendered only with a selection** (#1278), on the ledger's control
 * line: with nothing ticked no destructive control exists on the page. Emptying
 * the ledger is no gesture of its own: no filter, tick the header, delete.
 *
 * **The confirmation is kept**, and it states the count. The count in the box
 * is the **table's** — what is ticked, said before the click. The count in the
 * receipt is the **server's** — what actually left, an id deleted from another
 * tab meanwhile being skipped. They are deliberately two: a box has to say
 * what will happen, and the app owes the reader what did.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { dataApi } from '@/features/data/lib/api'
import { useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

interface BulkDeleteProps {
  /** The ids of the ticked rows the reduction still shows. */
  selected: readonly string[]
  /** The selection is spent: the caller clears it. */
  onDeleted: () => void
}

export function BulkDelete({ selected, onDeleted }: BulkDeleteProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: (ids: readonly string[]) => dataApi.deleteEvents(ids),
    onSuccess: (result) => {
      setOpen(false)
      onDeleted()
      const receipt = receiptMessage({ kind: 'events.removed', count: result.events_removed })
      toast.success(t(receipt.message, receipt.values))
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously — the performance series included since #812 —
      // before answering, so what is invalidated is everything rather than a
      // list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
    },
  })

  const close = () => {
    remove.reset()
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="pointer-coarse:min-h-11"
        onClick={() => {
          // A mutation error outlives its gesture, so reopening on another
          // selection would show a sentence about the previous one.
          remove.reset()
          setOpen(true)
        }}
      >
        {t('data.selection.delete')}
      </Button>

      <ConfirmDestructive
        open={open}
        onOpenChange={(next) => (next ? null : close())}
        title={t('data.bulk.confirm.title', { count: selected.length })}
        line={t('confirm.events.line')}
        confirmLabel={t('confirm.delete')}
        pending={remove.isPending}
        // A refetch can take the ticked rows away while the box is open.
        disabled={selected.length === 0}
        // Rendered **here** and not on the page: the box stays open on a
        // failure, and Radix marks everything behind the overlay
        // `aria-hidden`, so a refusal outside it is a sentence nobody can
        // read while the only thing on screen is the box that produced it.
        error={remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
        onConfirm={() => remove.mutate(selected)}
      />
    </>
  )
}
