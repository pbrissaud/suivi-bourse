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
 * **And since #835 the forecast is a window** (`ImportPreview`), because it
 * stopped being a sentence: it collects where each account of the file goes,
 * what becomes of the lines the ledger already holds, and whether the reporting
 * currency the file declares is taken up. This hook is where all three are held,
 * for the same reason the receipt is — it survives the swap the first import
 * makes.
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
 * mounts in the imports bar above the table. A receipt held by the component would be
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
import { XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { api, type ImportReceipt } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { NO_CORRESPONDENCE, type Correspondence } from '@/lib/imports'
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
  commit: (options?: { writeDuplicates?: boolean; declineCurrency?: boolean }) => void
  /** Put the file down without writing it — the refusal the preview is for. */
  discard: () => void
  /**
   * **Read the same file again under a new correspondence** (#835).
   *
   * Not a convenience: the duplicate key carries the account, so a line sent
   * from `TR` into `pea` may be one the ledger already holds — and the forecast
   * the reader is looking at would say otherwise. Every answer therefore costs a
   * fresh preview, which is the same double upload #813 already pays for and for
   * the same reason: the server remembers no import, ever.
   */
  reconsider: (correspondence: Correspondence) => void
  pending: boolean
  /**
   * A file is in hand — handed over and neither written nor put down.
   *
   * What the modal is open on, and it is **not** `forecast !== undefined`: a
   * file whose forecast was refused is still in hand, and that refusal is
   * exactly what the reader has to be shown, with the button disabled beside it.
   */
  held: boolean
  /** The file on its way in — the running sentence names it. */
  filename: string | undefined
  /** What *would* be written, while a file stands unwritten. */
  forecast: ImportReceipt | undefined
  receipt: ImportReceipt | undefined
  error: unknown
}

/** One handing-over: the file, and the answer standing when it was sent. */
interface Handed {
  file: File
  answer: Correspondence
  writeDuplicates?: boolean
  declineCurrency?: boolean
}

export function useEventUpload(): EventUpload {
  const queryClient = useQueryClient()
  // The file itself, held between the two halves of the gesture. It is the one
  // piece of state the double upload costs, and it lives in the browser — which
  // is the point: nothing on the server outlives the preview.
  const [held, setHeld] = useState<File | null>(null)
  // The correspondence the reader has given so far, held beside the file and for
  // the file's own lifetime: it is a parameter of *this* gesture and it is
  // dropped with it (ADR-0006), which is what keeps it from becoming a second
  // truth about the account an event names.
  const [answer, setAnswer] = useState<Correspondence>(NO_CORRESPONDENCE)
  const preview = useMutation({
    mutationFn: ({ file, answer: given }: Handed) =>
      api.importEvents(file, {
        dryRun: true,
        mapping: given.mapping,
        declaring: given.declaring,
      }),
  })
  const write = useMutation({
    mutationFn: ({ file, answer: given, writeDuplicates, declineCurrency }: Handed) =>
      api.importEvents(file, {
        writeDuplicates,
        declineCurrency,
        mapping: given.mapping,
        declaring: given.declaring,
      }),
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
      // send, which is the whole reason the preview is worth reading. The
      // correspondence goes with it — the next file asks the question again.
      write.reset()
      setHeld(file)
      setAnswer(NO_CORRESPONDENCE)
      preview.mutate({ file, answer: NO_CORRESPONDENCE })
    },
    reconsider: (correspondence) => {
      if (!held || pending) return
      setAnswer(correspondence)
      preview.mutate({ file: held, answer: correspondence })
    },
    commit: (options) => {
      if (!held || pending) return
      write.mutate({ file: held, answer, ...options })
    },
    discard: () => {
      setHeld(null)
      setAnswer(NO_CORRESPONDENCE)
      preview.reset()
      write.reset()
    },
    pending,
    held: held !== null,
    filename:
      (write.isPending ? write.variables?.file.name : preview.variables?.file.name) ?? held?.name,
    // **The forecast stands only while nothing has been written**: the fact
    // replaces it rather than joining it, or the reader would read one file's
    // future beside its past and have to work out which is which.
    //
    // It stands **through a second forecast**, though, and that is #835's: an
    // answer to the correspondence re-reads the file, and a forecast that
    // vanished for the length of that round trip would take the window's own
    // controls with it — the select the reader has just used included, focus and
    // all. What guards it instead is `pending`, which disables every control in
    // the window: the figures on screen are the previous answer's for as long as
    // the new one is in flight, and nothing can be done with them.
    forecast: write.isPending || write.data ? undefined : preview.data,
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
   * `false` is the imports bar above the ledger, where the zone *is* the surface.
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
 * **What the gesture produced** — mounted where it outlives the write.
 *
 * One polite region, and since #835 it holds the **fact alone**: the forecast
 * and its three questions moved into `ImportPreview`, which is the window the
 * mockup draws, and what is left here is the sentence the reader is owed once
 * the rows have landed. A block with nothing in it does not exist, so it renders
 * nothing at all while nothing has been written.
 *
 * **It lasts as long as the operation** (#787's story 42, read of the import as
 * it was of the export): it stands until the reader dismisses it or hands over
 * another file, never for three seconds. What it says is more than a passing
 * sentence carries — lines written, the period covered, the accounts and the
 * securities touched — and the reader who has just imported two hundred rows is
 * entitled to read it twice.
 *
 * The **refusal** is not here, and that is not an omission: a file the server
 * turned back is still in the reader's hands, so the window stays open with the
 * sentence in it and the button disabled beside it. Nothing is refused after the
 * button.
 */
export function UploadReceipt({ upload }: { upload: EventUpload }) {
  const { t } = useI18n()
  const f = useFormatters()
  const receipt = upload.receipt
  // Dismissed by the reader, and by nothing else. `discard` is the same gesture
  // the window's *Annuler* makes — there is no file in hand any more, so what it
  // puts down is the sentence.
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)

  if (!receipt || dismissed === receipt.filename) return null

  return (
    <div className="flex items-start gap-2 rounded-lg border p-3" role="status" aria-live="polite">
      <span className="min-w-0 flex-1 space-y-1">
        <Said>{written(t, f, receipt)}</Said>
        {receipt.duplicates > 0 ? <Said>{known(t, receipt.duplicates)}</Said> : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('data.import.dismiss')}
        onClick={() => setDismissed(receipt.filename)}
      >
        <XIcon className="size-4" />
      </Button>
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

/** What of the file the ledger already had, and did not take a second time. */
function known(t: ReturnType<typeof useI18n>['t'], count: number): string {
  const said = receiptMessage({ kind: 'import.known', count })
  return t(said.message, said.values)
}
