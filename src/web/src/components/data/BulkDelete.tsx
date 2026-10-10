/**
 * **Deleting the selection** — the rows the reader ticked (#1113), successor of
 * the deletion on the reduction (#814, #834).
 *
 * The gesture every table app has: tick rows, delete the ticked rows. The
 * button is **always there while the ledger has events**, disabled with
 * nothing ticked, so it is discovered once rather than when a box is ticked.
 * Emptying the ledger is no gesture of its own any more: no filter, tick the
 * header, delete.
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

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/lib/api'
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
    mutationFn: (ids: readonly string[]) => api.deleteEvents(ids),
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
      {/* **The colour of what it does** (#838): the drawing gives this control
          a loss-coloured outline where every other button on the row is
          neutral or mint — it is the one gesture on the bar that removes
          something, and the box behind it is what asks. The theme's red says
          *this failed*, so the tone here is `--loss`, which is the product's
          *money going away* rather than its error. */}
      <Button
        type="button"
        variant="outline"
        disabled={selected.length === 0}
        className="h-8 rounded-lg border-loss/45 bg-transparent px-3 text-xs text-loss hover:bg-loss/10 hover:text-loss dark:bg-transparent dark:hover:bg-loss/10"
        onClick={() => {
          // A mutation error outlives its gesture, so reopening on another
          // selection would show a sentence about the previous one.
          remove.reset()
          setOpen(true)
        }}
      >
        {t('data.bulk.title', { count: selected.length })}
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('data.bulk.confirm.title', { count: selected.length })}</DialogTitle>
            <DialogDescription>{t('data.bulk.confirm.body')}</DialogDescription>
          </DialogHeader>

          <p className="text-sm text-muted-foreground">{t('data.bulk.confirm.undo')}</p>

          {/* Rendered **here** and not on the page: the box stays open on a
              failure, and Radix marks everything behind the overlay
              `aria-hidden`, so a refusal outside it is a sentence nobody can
              read while the only thing on screen is the box that produced it. */}
          {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              {t('data.bulk.confirm.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              // A refetch can take the ticked rows away while the box is open.
              disabled={remove.isPending || selected.length === 0}
              onClick={() => remove.mutate(selected)}
            >
              {t('data.bulk.confirm.submit')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
