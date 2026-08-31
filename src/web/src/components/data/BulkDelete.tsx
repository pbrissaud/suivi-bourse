/**
 * **Deleting the reduction** — the successor of *forget this import* (#814,
 * #834, ADR-0032).
 *
 * The revocation by file went with the provenance at #816, and what replaced it
 * is worth more: it undoes a whole import without ever naming one, and it also
 * repairs the twelve rows somebody mistyped, which no revocation ever reached.
 * The price is that the gesture is **general**, and a general destructive
 * gesture has to say what it is about — which is where this component's
 * decisions come from.
 *
 * **It lives with the table, under the reduction it consumes.** Not in the bar
 * above, where the export menu is: what it acts on is the chips, and a
 * destructive button one surface away from the thing it destroys is how a
 * reader deletes two hundred and eighty-five events believing they are removing
 * a file.
 *
 * **The confirmation recites the reduction in full, and never a bare *are you
 * sure***. That is the rule #794 wrote when three consecutive rows of the
 * export showed three identical red buttons: the reader has to read the
 * **subject** of what they are destroying, and here the subject is the five
 * dimensions, each said in the vocabulary the pastilles are already labelled
 * with. #814 rendered them as a list, on the argument that a sentence
 * enumerating five clauses in two languages is one nobody can keep true; #834
 * takes that decision back, and the recital is the title — *« Supprimer les 47
 * événements de type Dividende, sur le compte pea, entre le 1 janv. 2025 et le
 * 31 déc. 2025 ? »*. What makes it keepable is that no clause is written twice:
 * each is a key of its own, the period reusing the pastille's own three
 * sentences, and the join is a **comma** because these are qualifiers stacked
 * on one noun rather than an enumeration of things — `Intl.ListFormat` closing
 * on *et* would put a conjunction between a type and a date.
 *
 * **With nothing reduced the gesture is refused, and the refusal points.** The
 * button is still there and it names what it does — *Supprimer la réduction* —
 * because a control that appears when a chip is pressed is a control the reader
 * has to discover twice. Pressing it with no reduction opens a **different
 * box**, not the same one with a bigger number: it says no reduction is active,
 * names the other gesture — *Vider le grand livre* — and that gesture has a
 * confirmation of its own, which counts the whole ledger and says what stays.
 * ADR-0032 and #787 both ask for exactly that split, and the two boxes are the
 * shape of it.
 *
 * **The wipe reduces on the ledger's own first day**, which is what
 * `DELETE /api/events` tells a client to do in as many words when it refuses a
 * request with no parameter at all: *reduce on something that covers the whole
 * ledger to empty it*. `event.date` is `NOT NULL` in the store, so a lower
 * bound on the oldest day retains every row — and the count in the box is read
 * back through the reduction rather than off `events.length`, so what is
 * announced is what the request takes.
 *
 * The count in a box is the **table's** — what the reduction retains, said
 * before the click. The count in the receipt is the **server's** — what
 * actually left. They are deliberately two: a box has to say what will happen,
 * and the app owes the reader what did.
 */
import { useState } from 'react'
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
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  filterEvents,
  reduces,
  selectionParams,
  wholeLedger,
  type LedgerFilters,
} from '@/lib/ledger'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

export interface BulkDeleteProps {
  /** The reduction in force: what the gesture consumes, and what it names. */
  selection: LedgerFilters
  /** How many rows it retains — counted on the table the reader is looking at. */
  selected: number
  /** The ledger entire — what *empty the ledger* is a reduction over. */
  events: readonly LedgerEvent[]
}

/** Which box is open: the recital, the refusal, or the wipe behind it. */
type Box = 'reduction' | 'refused' | 'wipe'

export function BulkDelete({ selection, selected, events }: BulkDeleteProps) {
  const { t } = useI18n()
  const [box, setBox] = useState<Box | null>(null)
  const queryClient = useQueryClient()
  const reduced = reduces(selection)
  const clauses = useReductionClauses(selection)

  // The whole ledger as a reduction, and what it retains — computed here so the
  // box states the count of the request it is about to make.
  const whole = wholeLedger(events)
  const wholeCount = whole === null ? 0 : filterEvents(events, whole).length

  const remove = useMutation({
    mutationFn: (filters: LedgerFilters) => api.deleteEvents(selectionParams(filters)),
    onSuccess: (result) => {
      setBox(null)
      const receipt = receiptMessage({ kind: 'events.removed', count: result.events_removed })
      toast.success(t(receipt.message, receipt.values))
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously — the performance series included since #812 —
      // before answering, so what is invalidated is everything rather than a
      // list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
    },
  })

  // A reduction that retains nothing has a subject and no rows: *delete these 0
  // events* beside *no event matches* is one button saying two things at once,
  // and the server answers such a request `200` and zero, which is the same
  // judgement one road over. With nothing reduced **and** nothing recorded
  // there is no ledger to empty either.
  if (reduced ? selected === 0 : whole === null) return null

  const close = () => {
    remove.reset()
    setBox(null)
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
        className="h-8 rounded-lg border-loss/45 bg-transparent px-3 text-xs text-loss hover:bg-loss/10 hover:text-loss dark:bg-transparent dark:hover:bg-loss/10"
        onClick={() => {
          // The refusal is forgotten with the box that carried it: a mutation
          // error outlives its gesture, so reopening on another reduction would
          // show a sentence about the previous one.
          remove.reset()
          setBox(reduced ? 'reduction' : 'refused')
        }}
      >
        {t('data.bulk.title', { count: selected, reduced: reduced ? 'yes' : 'no' })}
      </Button>

      <Dialog open={box !== null} onOpenChange={(open) => (open ? null : close())}>
        <DialogContent>
          {box === 'reduction' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('data.bulk.confirm.title', { count: selected, clauses })}
                </DialogTitle>
                <DialogDescription>{t('data.bulk.confirm.body')}</DialogDescription>
              </DialogHeader>

              <p className="text-sm text-muted-foreground">{t('data.bulk.confirm.undo')}</p>

              {/* Rendered **here** and not on the page: the box stays open on a
                  failure, and Radix marks everything behind the overlay
                  `aria-hidden`, so a refusal outside it is a sentence nobody can
                  read while the only thing on screen is the box that produced
                  it. */}
              {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={close}>
                  {t('data.bulk.confirm.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(selection)}
                >
                  {t('data.bulk.confirm.submit')}
                </Button>
              </div>
            </>
          ) : box === 'refused' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('data.wipe.refused.title')}</DialogTitle>
                <DialogDescription>{t('data.wipe.refused.body')}</DialogDescription>
              </DialogHeader>

              {/* The other gesture is **offered** rather than merely named: the
                  reader who pressed here wanted to remove something, and being
                  told the name of a control they now have to go and find is a
                  refusal that helps nobody. It is not destructive yet — what it
                  opens is that gesture's own confirmation. */}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={close}>
                  {t('data.wipe.cancel')}
                </Button>
                <Button type="button" onClick={() => setBox('wipe')}>
                  {t('data.wipe.submit')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('data.wipe.title', { count: wholeCount })}</DialogTitle>
                <DialogDescription>{t('data.wipe.body')}</DialogDescription>
              </DialogHeader>

              <p className="text-sm text-muted-foreground">{t('data.bulk.confirm.undo')}</p>

              {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={close}>
                  {t('data.wipe.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending || whole === null}
                  onClick={() => {
                    if (whole !== null) remove.mutate(whole)
                  }}
                >
                  {t('data.wipe.submit')}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * What the reduction retains, recited — one clause per dimension in force, in
 * the order the sentence reads best: the type, the account, the period, the
 * securities, the words.
 *
 * Empty where nothing is reduced, which is {@link reduces} said in the
 * vocabulary this component renders: the button, the box and the request cannot
 * come to disagree about what a reduction is.
 */
function useReductionClauses(selection: LedgerFilters): string {
  const { t } = useI18n()
  const f = useFormatters()

  const clauses: string[] = []
  if (selection.type !== null) {
    clauses.push(t('data.bulk.clause.type', { type: t(TYPE_LABEL[selection.type]) }))
  }
  if (selection.account !== null) {
    clauses.push(t('data.bulk.clause.account', { account: selection.account }))
  }
  if (selection.since !== null || selection.until !== null) {
    clauses.push(
      t('data.bulk.clause.period', {
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
  if (selection.symbols && selection.symbols.length > 0) {
    clauses.push(
      t('data.bulk.clause.symbols', {
        count: selection.symbols.length,
        // A sentence, so the enumeration is the language's (#768).
        symbols: f.list(selection.symbols),
      }),
    )
  }
  const query = selection.query.trim()
  if (query !== '') clauses.push(t('data.bulk.clause.query', { subject: query }))

  return clauses.join(', ')
}
