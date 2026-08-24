/**
 * **The rectangle becomes a target** (#811, ADR-0032).
 *
 * What stood here named a folder, and it was right to: there was no upload
 * route, the drop folder was the mechanism, and a rectangle that swallowed a
 * file and did nothing would have been the worst of the three. There is a route
 * now, so the rectangle takes the file — dropped on it, or chosen from the
 * picker — and hands it to `POST /api/events/import`.
 *
 * Four things about it are decisions.
 *
 * **The picker is the target, and the rectangle is around it.** A drag-and-drop
 * zone with no keyboard way in is a gesture a pointer-less reader cannot make,
 * so what carries the accessible name is a real `<input type="file">` with a
 * real `<label>`; the drop handler is the same call, reached another way. That
 * ordering — the input first, the drop as an alternative — is what keeps the
 * feature testable and usable by the same means.
 *
 * **The receipt lasts as long as the operation, and it therefore does not live
 * in this component** (`CONTEXT.md` § Receipt). It says what the gesture
 * produced — lines written, the period covered, the accounts and securities
 * touched — which is more than a passing sentence carries. A toast would have to
 * be read in three seconds and would leave nowhere for the forecast to stand.
 *
 * **And since #813 the gesture has two halves.** Handing a file over *previews*
 * it: the server judges it, counts what of it the ledger already holds, and
 * answers the receipt having written nothing. What writes is the reader pressing
 * *Import*, which **re-uploads the same file** — the `File` is held in the hook
 * for as long as the forecast stands, and no identifier is held anywhere else.
 * That double upload is deliberate and it is ADR-0032's: a pending-import id
 * would be the table this lot deleted, under another name, with a lifetime and a
 * sweeper to write. A few hundred kilobytes on a local hop is the price of *the
 * server remembers no import, ever*.
 *
 * The reason it is not held here is the **first import**, which is the gesture
 * this whole ticket exists for: an empty ledger renders the zone inside
 * `EntryPair`, the import fills the ledger, the pair unmounts and a second zone
 * mounts in the band above the table. A receipt held by the component would be
 * destroyed by the very write it is announcing — it would flash and vanish for
 * the one reader who has never seen this app work. So the mutation is a hook
 * (`useEventUpload`) held by `Ledger`, which survives that swap, and the
 * sentence is rendered by `UploadReceipt` there; what is mounted twice is only
 * the control.
 *
 * **The wait is dressed, and that is not the spinner rule's business.**
 * `noSpinner.test.ts` is about a **read**: nothing may be claimed about a
 * subject nobody has heard from, so a block waiting on one renders nothing at
 * all. This is the reader's own act, it claims nothing about their data, and
 * the app owes them its end — the same argument #796 made for the export.
 *
 * **A refusal is read by `problem.type`, never by the sentence the server
 * wrote** (ADR-0024). The server's `detail` names the account, the missing
 * column or the v4 file for whoever reads a log or a `curl`; the front says, in
 * the reader's own language, that the file was refused and nothing was written.
 */
import { useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { api, type ImportReceipt } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

/** The gesture, held by whoever survives the write it causes. */
export interface EventUpload {
  /**
   * Hand one file over, whichever way it arrived. It is **previewed**, not
   * written (#813): what comes back is the forecast below.
   */
  hand: (file: File | null | undefined) => void
  /**
   * Write the file that was previewed — by **re-uploading it** (ADR-0032).
   *
   * The `File` the reader chose is held in this hook for exactly as long as
   * their forecast stands, and it is sent again. There is no import id to
   * commit instead, because the server remembers no import: a pending-import
   * token would be `import_source` under another name, with a lifetime and a
   * sweeper to write.
   */
  commit: (options?: { writeDuplicates?: boolean }) => void
  /** Put the file down without writing it — the refusal the preview is for. */
  discard: () => void
  pending: boolean
  /** The file on its way in — the running sentence names it. */
  filename: string | undefined
  /** What *would* be written, while a file stands unwritten. */
  forecast: ImportReceipt | undefined
  receipt: ImportReceipt | undefined
  error: unknown
}

export function useEventUpload(): EventUpload {
  const queryClient = useQueryClient()
  // The file itself, held between the two halves of the gesture. It is the one
  // piece of state the double upload costs, and it lives in the browser — which
  // is the point: nothing on the server outlives the preview.
  const [held, setHeld] = useState<File | null>(null)
  const preview = useMutation({
    mutationFn: (file: File) => api.importEvents(file, { dryRun: true }),
  })
  const write = useMutation({
    mutationFn: ({ file, writeDuplicates }: { file: File; writeDuplicates?: boolean }) =>
      api.importEvents(file, { writeDuplicates }),
    onSuccess: () => {
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously before answering (#697), so what is invalidated
      // is everything rather than a list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
      // The file has landed; nothing is holding it any more. What stays on
      // screen is the receipt, which is a sentence and not a pending gesture.
      setHeld(null)
    },
  })

  const pending = preview.isPending || write.isPending

  return {
    hand: (file) => {
      // **One gesture at a time.** The control disables itself while a file is
      // in flight; a drop does not go through the control, and two POSTs racing
      // the server's writer mutex would show the reader whichever receipt
      // resolved last — the other import having written rows nothing says.
      if (!file || pending) return
      // A second file handed over replaces the first outright: the forecast on
      // screen must never describe a file other than the one the button would
      // send, which is the whole reason the preview is worth reading.
      write.reset()
      setHeld(file)
      preview.mutate(file)
    },
    commit: (options) => {
      if (!held || pending) return
      write.mutate({ file: held, writeDuplicates: options?.writeDuplicates })
    },
    discard: () => {
      setHeld(null)
      preview.reset()
      write.reset()
    },
    pending,
    filename: (write.isPending ? write.variables?.file.name : preview.variables?.name) ?? held?.name,
    // **The forecast stands only while nothing has been written**: the fact
    // replaces it rather than joining it, or the reader would read one file's
    // future beside its past and have to work out which is which.
    forecast: pending || write.data ? undefined : preview.data,
    receipt: pending ? undefined : write.data,
    error: pending ? undefined : (write.error ?? preview.error),
  }
}

export interface UploadZoneProps {
  /** The gesture, from `useEventUpload` — held one level up (see above). */
  upload: EventUpload
  /**
   * The rectangle, or the control alone.
   *
   * `false` is the band above the ledger, where the zone *is* the surface.
   * `true` is the empty state's first entry (`EntryPair`), which is already a
   * bordered box saying the same thing — a second rectangle inside it would be
   * a border around a border and two instructions for one gesture.
   */
  compact?: boolean
}

/** The two formats, stated to the picker and to the reader alike. */
const ACCEPTED = '.csv,.xlsx'

export function UploadZone({ upload, compact = false }: UploadZoneProps) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  // The two mounts of this component are **not** mutually exclusive across a
  // gesture: the first import unmounts one and mounts the other, so the id is
  // generated rather than written down.
  const field = useId()
  const [over, setOver] = useState(false)
  const hand = upload.hand

  return (
    <div className="space-y-3">
      <div
        // The drop half. It is an alternative to the control below and never
        // the only way in — which is why it carries no role of its own: what a
        // reader without a pointer operates is the labelled input.
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          hand(event.dataTransfer.files?.[0])
        }}
        className={
          compact
            ? 'space-y-3'
            : `space-y-3 rounded-lg border border-dashed p-6 transition-colors ${
                over ? 'border-primary bg-primary/5' : ''
              }`
        }
      >
        {compact ? null : (
          <div>
            <p className="font-medium">{t('data.drop.title')}</p>
            <p className="max-w-prose text-sm text-muted-foreground">{t('data.drop.body')}</p>
          </div>
        )}
        <input
          ref={input}
          id={field}
          type="file"
          accept={ACCEPTED}
          className="sr-only"
          disabled={upload.pending}
          onChange={(event) => {
            hand(event.target.files?.[0])
            // The same file chosen twice has to be uploaded twice: without
            // this the input's value has not moved and `change` never fires.
            event.target.value = ''
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={upload.pending}
          onClick={() => input.current?.click()}
        >
          {t('data.drop.choose')}
        </Button>
        {/* The label the input is reached by. It is visually hidden and not
            absent: the button above is what a pointer presses, and this is what
            a screen reader and a test address the file field by. */}
        <label htmlFor={field} className="sr-only">
          {t('data.drop.choose')}
        </label>
      </div>
    </div>
  )
}

/**
 * What the gesture is doing, what it *would* do, or what it produced — mounted
 * where it outlives the write.
 *
 * One polite region for the four states: they are answers to one gesture, and a
 * reader who cannot see the rectangle has to hear whichever came. A block with
 * nothing in it does not exist, so it renders nothing at all while nothing has
 * been handed over.
 *
 * **The forecast is the one state that carries controls** (#813). It is the
 * moment the reader may still refuse the file, so it offers the two answers —
 * *import it* and *put it down* — and, only when there are duplicates to argue
 * about, the box that says *these are real orders*. The sentence above them is
 * `import.written`'s with its tense moved: the reader recognises afterwards what
 * they read before, which is the whole of *one object, two moments*.
 */
export function UploadReceipt({ upload }: { upload: EventUpload }) {
  const { t } = useI18n()
  const f = useFormatters()
  // Cleared by the swap below: a box ticked for one file must not survive into
  // the forecast of the next, which would write duplicates nobody looked at.
  const [writeDuplicates, setWriteDuplicates] = useState(false)
  const forecast = upload.forecast
  const previewed = forecast?.filename
  const [lastPreviewed, setLastPreviewed] = useState(previewed)
  if (lastPreviewed !== previewed) {
    setLastPreviewed(previewed)
    setWriteDuplicates(false)
  }

  if (!upload.pending && !forecast && !upload.receipt && !upload.error) return null

  return (
    <div className="space-y-3">
      <div role="status" aria-live="polite">
        {upload.pending ? <Said>{running(t, upload.filename)}</Said> : null}
        {forecast ? <Said>{foreseen(t, f, forecast)}</Said> : null}
        {forecast && forecast.duplicates > 0 ? (
          <Said>{known(t, forecast.duplicates, true)}</Said>
        ) : null}
        {upload.receipt ? <Said>{written(t, f, upload.receipt)}</Said> : null}
        {upload.receipt && upload.receipt.duplicates > 0 ? (
          <Said>{known(t, upload.receipt.duplicates, false)}</Said>
        ) : null}
        {upload.error ? <Said attention>{t(problemMessageKey(upload.error))}</Said> : null}
      </div>

      {forecast ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => upload.commit({ writeDuplicates })}>
            {t('data.import.confirm')}
          </Button>
          <Button type="button" variant="outline" onClick={() => upload.discard()}>
            {t('data.import.cancel')}
          </Button>
          {/* Offered only when the file has duplicates in it: a box asking about
              rows that do not exist is a question the reader cannot answer, and
              story 6 is about the owner who *knows* they placed the order
              twice — nobody else has to be asked. */}
          {forecast.duplicates > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={writeDuplicates}
                onChange={(event) => setWriteDuplicates(event.target.checked)}
              />
              {t('data.import.duplicates')}
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** One sentence under the zone — the only shape this region ever takes. */
function Said({ children, attention }: { children: string; attention?: boolean }) {
  return (
    <p className={`text-sm ${attention ? 'text-attention' : 'text-muted-foreground'}`}>
      {children}
    </p>
  )
}

function running(t: ReturnType<typeof useI18n>['t'], filename: string | undefined): string {
  const said = receiptMessage({ kind: 'import.running', filename: filename ?? '' })
  return t(said.message, said.values)
}

/**
 * What the gesture produced. The two days are rendered **here**, by the
 * reader's own formatter, and handed to the catalogue as text: `lib/format.ts`
 * owns the calendar-day parse, and `lib/receipts.ts` stays pure.
 */
function written(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  receipt: ImportReceipt,
): string {
  const said =
    receipt.period === null
      ? receiptMessage({ kind: 'import.empty', filename: receipt.filename })
      : receiptMessage({
          kind: 'import.written',
          count: receipt.written,
          from: f.date(receipt.period.from),
          to: f.date(receipt.period.to),
          accounts: receipt.accounts.length,
          symbols: receipt.symbols.length,
        })
  return t(said.message, said.values)
}

/** The same sentence, one moment earlier — `written`'s twin, tense apart. */
function foreseen(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  receipt: ImportReceipt,
): string {
  const said =
    receipt.period === null
      ? receiptMessage({ kind: 'import.forecast.empty', filename: receipt.filename })
      : receiptMessage({
          kind: 'import.forecast',
          count: receipt.written,
          from: f.date(receipt.period.from),
          to: f.date(receipt.period.to),
          accounts: receipt.accounts.length,
          symbols: receipt.symbols.length,
        })
  return t(said.message, said.values)
}

/** What of the file the ledger already has, said at whichever moment it is. */
function known(t: ReturnType<typeof useI18n>['t'], count: number, forecast: boolean): string {
  const said = receiptMessage(
    forecast ? { kind: 'import.known.forecast', count } : { kind: 'import.known', count },
  )
  return t(said.message, said.values)
}
