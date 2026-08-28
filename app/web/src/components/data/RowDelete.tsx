/**
 * **One row, removed** (#834, ADR-0032).
 *
 * The bulk gesture beside it undoes an import; this one repairs the event
 * somebody entered twice, or on the wrong day — and ADR-0032 asks for both by
 * name, the removal being *the* gesture now that no file is ever read again.
 * There is one population of rows, so nothing here asks where the row came
 * from: `DELETE /api/events/<id>` refuses nothing the editor does not.
 *
 * **The box names the row rather than asking *are you sure***, which is the
 * rule the bulk box already holds one file over: the subject of a destructive
 * gesture has to be readable *in* the box, because the table behind it is
 * `aria-hidden` the moment the overlay is up. What names a row is what the row
 * shows — its type, its identity and its day — and never its key: a ledger row
 * has no address (ADR-0020), so a sentence naming one would say nothing to
 * anybody.
 *
 * It is mounted **once, by the ledger**, and handed the row: a box per row
 * would be 285 dialogs in the document, and the state *which row is being
 * removed* would be split across them.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Refusal } from '@/components/Refusal'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, type LedgerEvent } from '@/lib/api'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { identityOf } from '@/lib/ledger'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

export interface RowDeleteProps {
  /** The row the reader asked to remove, or `null` while none is. */
  event: LedgerEvent | null
  onClose: () => void
}

export function RowDelete({ event, onClose }: RowDeleteProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const queryClient = useQueryClient()

  const remove = useMutation({
    mutationFn: (id: string) => api.removeEvent(id),
    onSuccess: () => {
      onClose()
      const receipt = receiptMessage({ kind: 'events.removed', count: 1 })
      toast.success(t(receipt.message, receipt.values))
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously before answering — so what is invalidated is
      // everything rather than a list somebody has to keep in step.
      void queryClient.invalidateQueries()
    },
  })

  const identity = event === null ? null : identityOf(event)
  // The key the removal is addressed by. `isEditable` is what the table asked
  // before offering the gesture, and this is that predicate read again — a row
  // with no key has nothing to name in the request.
  const key = typeof event?.id === 'string' ? event.id : null

  return (
    <Dialog
      open={event !== null}
      onOpenChange={(open) => {
        if (open) return
        // The refusal is forgotten with the box that carried it: a mutation
        // error outlives its gesture, so reopening on another row would show a
        // sentence about the previous one.
        remove.reset()
        onClose()
      }}
    >
      <DialogContent>
        {event === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>{t('data.row.delete.title')}</DialogTitle>
              <DialogDescription>
                {t('data.row.delete.body', {
                  type: t(TYPE_LABEL[event.event_type]),
                  what: identity?.ticker ?? identity?.label ?? ABSENT,
                  date: f.date(event.date),
                })}
              </DialogDescription>
            </DialogHeader>

            <p className="text-sm text-muted-foreground">{t('data.bulk.confirm.undo')}</p>

            {/* Rendered **here** and not on the page: the box stays open on a
                failure, and everything behind the overlay is `aria-hidden`. */}
            {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  remove.reset()
                  onClose()
                }}
              >
                {t('data.row.delete.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={remove.isPending || key === null}
                onClick={() => {
                  if (key !== null) remove.mutate(key)
                }}
              >
                {t('data.row.delete')}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
