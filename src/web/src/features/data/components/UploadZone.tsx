/**
 * **The rectangle becomes a target** (#811), and since #1266 it takes **several
 * files at once**: they are previewed as one batch, in one request, and written
 * by one request.
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
 * touched — which is more than a passing sentence carries. A toast would have
 * to be read in three seconds and would leave nowhere for the forecast to
 * stand.
 *
 * **And since #835 the forecast is a window** (`ImportPreview`), because it
 * stopped being a sentence: it collects where each account of the file goes,
 * what becomes of the lines the ledger already holds, and whether the reporting
 * currency the file declares is taken up. This hook is where all three are
 * held, for the same reason the receipt is — it survives the swap the first
 * import makes.
 *
 * **And since #813 the gesture has two halves.** Handing a file over *previews*
 * it: the server judges it, counts what of it the ledger already holds, and
 * answers the receipt having written nothing. What writes is the reader
 * pressing *Import*, which **re-uploads the same file** — the `File` is held in
 * the hook for as long as the forecast stands, and no identifier is held
 * anywhere else. A few hundred kilobytes on a local hop is the price of *the
 * server remembers no import, ever*.
 *
 * The reason it is not held here is the **first import**, which is the gesture
 * this whole ticket exists for: an empty ledger renders the zone inside
 * `EntryPair`, the import fills the ledger, the pair unmounts and the toolbar's
 * *Importer* mounts above the table. A receipt held by the component
 * would be destroyed by the very write it is announcing — it would flash and
 * vanish for the one reader who has never seen this app work. So the mutation
 * is a hook (`useEventUpload`) held by `Ledger`, which survives that swap, and
 * the sentence is rendered by `UploadReceipt` there; what is mounted twice is
 * only the control.
 *
 * **The wait is dressed, and that is not the spinner rule's business.**
 * `lint/no-wait-dressing.grit` is about a **read**: nothing may be claimed about a
 * subject nobody has heard from, so a block waiting on one renders nothing at
 * all. This is the reader's own act, it claims nothing about their data, and
 * the app owes them its end — the same argument #796 made for the export.
 *
 * **A refusal is read by `problem.type`, never by the sentence the server
 * wrote**. The server's `detail` names the account, the missing column or the
 * v4 file for whoever reads a log or a `curl`; the front says, in the reader's
 * own language, that the file was refused and nothing was written.
 */
import { useId, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Upload, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { dataApi, type AmountsIn, type ImportReceipt } from '@/features/data/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  keptAsOne,
  NO_CORRESPONDENCE,
  repeatGroups,
  type Correspondence,
} from '@/features/data/lib/imports'
import type { ProposedLine } from '@/lib/api.gen'
import { receiptMessage } from '@/lib/receipts'

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
 * What `ImportPreview` reads, whatever the source of the rows: the files the
 * reader handed over (`useEventUpload`) or the proposal the agent made
 * (`useProposalImport`, #1119).
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
  proposal?: { lines: readonly ProposedLine[] }
}

/** The gesture, held by whoever survives the write it causes. */
export interface EventUpload extends ImportReview {
  /**
   * Hand the files over, whichever way they arrived. They are **previewed** as
   * one batch, not written (#813): what comes back is the forecast below. A new
   * hand replaces the batch (#1266).
   */
  hand: (files: readonly File[]) => void
  /**
   * Take one file out of the batch and read the rest again (#1266). The answer
   * and the standing forecast go with it; the last file out is `discard`.
   */
  drop: (index: number) => void
}

/** One handing-over: the files, and the answer standing when it was sent. */
interface Handed {
  files: readonly File[]
  answer: Answer
}

/**
 * One handing-over that writes: the offer the reader may decline rides with it,
 * and so do the foreign pairs the standing forecast judged (#1261).
 */
interface Written extends Handed {
  declineCurrency?: boolean
  foreign: readonly string[]
  writeRepeats: readonly number[]
}

export function useEventUpload(): EventUpload {
  const queryClient = useQueryClient()
  // The files themselves, held between the two halves of the gesture. They are
  // the one piece of state the double upload costs, and they live in the
  // browser — which is the point: nothing on the server outlives the preview.
  // Re-sent in the same order every time: the row indexes are positions in the
  // merged list, and the order is what keeps them stable (#1266).
  const [held, setHeld] = useState<readonly File[]>([])
  // The answer the reader has given so far, held beside the file and for the
  // file's own lifetime: it is a parameter of *this* gesture and it is dropped
  // with it, which is what keeps the correspondence from becoming a
  // second truth about the account an event names.
  const [answer, setAnswer] = useState<Answer>(NO_ANSWER)
  // **The forecast standing on screen**, held here rather than read off the
  // mutation. TanStack drops a mutation's `data` the instant a second `mutate`
  // starts, so a forecast read off `preview.data` would vanish for the length of
  // every round trip — taking the window's own body and footer with it, the
  // select the reader has just used included, focus and all. Held here it is
  // replaced by the next answer's forecast and by nothing else: a refusal stands
  // *beside* it (`Forecast.refused`), so an answer that cannot be written can
  // still be taken back.
  const [standing, setStanding] = useState<Forecast | undefined>(undefined)
  const preview = useMutation({
    mutationFn: async ({ files, answer: given }: Handed): Promise<Forecast> => {
      const seen = await dataApi.importEvents(files, {
        dryRun: true,
        mapping: given.correspondence.mapping,
        declaring: given.correspondence.declaring,
        amountsIn: given.amountsIn,
      })
      // **The census read carries no `write_repeat` and no flag**, so it never
      // refuses because of a repeat; what the answer would write is the second
      // reading's business (#1267).
      const writeRepeats = repeatsToWrite(seen, given.collapsed)
      // The census answers the whole window on its own while the duplicates are
      // being skipped and no repeat is written: one read.
      if (!given.writeDuplicates && writeRepeats.length === 0) {
        return { file: seen, writing: seen, refused: undefined }
      }
      // **The second reading, and it is the criterion's** (#835). Under the flag
      // the server judges the file *whole* — the rows the ledger already holds
      // included — and that is a different ledger to replay. It is asked here,
      // at the box, so that the answer the button carries has already been
      // judged; and its refusal is **returned** rather than thrown, because the
      // census beside it is what lets the reader untick.
      try {
        return {
          file: seen,
          writing: await dataApi.importEvents(files, {
            dryRun: true,
            writeDuplicates: given.writeDuplicates,
            writeRepeats,
            mapping: given.correspondence.mapping,
            declaring: given.correspondence.declaring,
            amountsIn: given.amountsIn,
          }),
          refused: undefined,
        }
      } catch (refused) {
        return { file: seen, writing: undefined, refused }
      }
    },
    onSuccess: (forecast) => setStanding(forecast),
    // **A refused census takes the writable half of the standing forecast with
    // it**, and that is the whole of the criterion on this path. The first read
    // carries `map` and `declare`, so it is the one `_settled_mapping` (422) and
    // `entries.judge` (409) refuse when the reader retargets an account — and it
    // is *thrown*, so `onSuccess` never runs and `standing` keeps the previous
    // answer's forecast. Left alone, the window would show a footer promising
    // *three events will be written* for a mapping the server has just refused,
    // with `Importer` still live above it: the refusal would arrive after the
    // button, which is the one thing #835 exists to prevent.
    //
    // The forecast is not dropped, though — dropping it would unmount the body
    // and the select the reader has just used, which is what D3 repaired. What
    // leaves is `writing`: the button is disabled on its absence, the footer is
    // rendered on its presence, and the refusal takes its place in `error`. So
    // the reader keeps every control they need to answer differently, and none
    // that would write.
    onError: (refused) =>
      setStanding((previous) =>
        previous === undefined ? previous : { ...previous, writing: undefined, refused },
      ),
  })
  const write = useMutation({
    mutationFn: ({ files, answer: given, declineCurrency, foreign, writeRepeats }: Written) =>
      dataApi.importEvents(files, {
        writeDuplicates: given.writeDuplicates,
        writeRepeats,
        declineCurrency,
        mapping: given.correspondence.mapping,
        declaring: given.correspondence.declaring,
        amountsIn: given.amountsIn,
        foreign,
      }),
    onSuccess: () => {
      // Every figure in the product is downstream of the ledger, and the server
      // replays synchronously before answering (#697), so what is invalidated
      // is everything rather than a list of keys somebody has to keep in step.
      void queryClient.invalidateQueries()
      // The file has landed; nothing is holding it any more. What stays on
      // screen is the receipt, which is a sentence and not a pending gesture.
      setHeld([])
    },
  })

  const pending = preview.isPending || write.isPending

  const discard = () => {
    setHeld([])
    setAnswer(NO_ANSWER)
    setStanding(undefined)
    preview.reset()
    write.reset()
  }

  return {
    hand: (files) => {
      // **One gesture at a time.** The control disables itself while a file is
      // in flight; a drop does not go through the control, and two POSTs racing
      // the server's writer mutex would show the reader whichever receipt
      // resolved last — the other import having written rows nothing says.
      if (files.length === 0 || pending) return
      // A second batch handed over replaces the first outright: the forecast on
      // screen must never describe files other than the ones the button would
      // send, which is the whole reason the preview is worth reading. The
      // correspondence goes with it — the next batch asks the question again.
      write.reset()
      setStanding(undefined)
      setHeld(files)
      setAnswer(NO_ANSWER)
      preview.mutate({ files, answer: NO_ANSWER })
    },
    drop: (index) => {
      if (pending || index < 0 || index >= held.length) return
      const rest = held.filter((_, at) => at !== index)
      if (rest.length === 0) {
        discard()
        return
      }
      // The answers were given about files that are no longer all there: the
      // account census, the repeat groups and the foreign lines are the batch's.
      write.reset()
      setStanding(undefined)
      setHeld(rest)
      setAnswer(NO_ANSWER)
      preview.mutate({ files: rest, answer: NO_ANSWER })
    },
    reconsider: (next) => {
      if (held.length === 0 || pending) return
      setAnswer(next)
      preview.mutate({ files: held, answer: next })
    },
    commit: (options) => {
      if (held.length === 0 || !standing || pending) return
      // The pairs the forecast on screen listed, sent back so the server converts
      // what was judged and looks nothing up (#1261). Only with an answer: a
      // pair without one has nothing to apply.
      const foreign = answer.amountsIn
        ? (standing.file.foreign_lines ?? []).map((line) => `${line.symbol}:${line.currency}`)
        : []
      write.mutate({
        files: held,
        answer,
        foreign,
        writeRepeats: repeatsToWrite(standing.file, answer.collapsed),
        ...options,
      })
    },
    discard,
    pending,
    held: held.length > 0,
    filenames: held.map((file) => file.name),
    // **The forecast stands only while nothing has been written**: the fact
    // replaces it rather than joining it, or the reader would read one file's
    // future beside its past and have to work out which is which.
    //
    // It stands **through a second forecast**, though, and that is #835's: an
    // answer re-reads the file, and a forecast that vanished for the length of
    // that round trip would take the window's own controls with it — the select
    // the reader has just used included, focus and all. That is why it is
    // `standing` and not `preview.data`, which TanStack empties on every
    // `mutate`; what guards it meanwhile is `pending`, which disables every
    // control in the window, so the figures on screen are the previous answer's
    // for as long as the new one is in flight and nothing can be done with them.
    forecast: write.isPending || write.data ? undefined : standing,
    receipt: pending ? undefined : write.data,
    // The refusal the standing answer meets is an error like the other two: it
    // is what the window renders and what keeps the button disabled — a refusal
    // the reader reads **before** pressing it rather than after (#835).
    error: pending || write.data ? undefined : (write.error ?? preview.error ?? standing?.refused),
  }
}

interface UploadZoneProps {
  /** The gesture, from `useEventUpload` — held one level up (see above). */
  upload: EventUpload
  /**
   * The rectangle, or the control alone.
   *
   * `false` is the band, the empty ledger's file entry (`EntryPair`), where the
   * zone *is* the surface. `true` is the toolbar's *Importer* of a populated
   * ledger (#1278): the picker alone, the drop being taken by the table card.
   */
  compact?: boolean
  /** The picker's word: *Importer* in the toolbar, *Parcourir…* in the band. */
  label?: string
}

/**
 * **The drop half of the gesture**, shared by the band and by the table card
 * (#1278). A drag that carries no file — a selected word, a link — is left
 * alone, so the browser keeps its own behaviour for it.
 */
export function useFileDrop(hand: EventUpload['hand']) {
  const [over, setOver] = useState(false)
  const carriesFile = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (!carriesFile(event)) return
        event.preventDefault()
        setOver(true)
      },
      // Moving onto a child of the target also leaves the target: only a real
      // exit puts the highlight down.
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFile(event)) return
        event.preventDefault()
        setOver(false)
        hand(Array.from(event.dataTransfer.files ?? []))
      },
    },
  }
}

/** The two formats, stated to the picker and to the reader alike. */
const ACCEPTED = '.csv,.xlsx'

export function UploadZone({ upload, compact = false, label }: UploadZoneProps) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  // The two mounts of this component are **not** mutually exclusive across a
  // gesture: the first import unmounts one and mounts the other, so the id is
  // generated rather than written down.
  const field = useId()
  const hand = upload.hand
  const { over, handlers } = useFileDrop(hand)

  const name = label ?? t('data.drop.choose')

  const picker = (
    <>
      <input
        ref={input}
        id={field}
        type="file"
        multiple
        accept={ACCEPTED}
        className="sr-only"
        disabled={upload.pending}
        onChange={(event) => {
          hand(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Button
        type="button"
        variant="outline"
        size={compact ? 'sm' : 'default'}
        className={cn(
          'rounded-lg bg-transparent pointer-coarse:min-h-11 dark:bg-transparent',
          !compact && 'h-8.5',
        )}
        disabled={upload.pending}
        onClick={() => input.current?.click()}
      >
        {compact ? <Upload aria-hidden /> : null}
        {name}
      </Button>
      {/* The label the input is reached by. It is visually hidden and not
          absent: the button above is what a pointer presses, and this is what a
          screen reader and a test address the file field by. */}
      <label htmlFor={field} className="sr-only">
        {name}
      </label>
    </>
  )

  if (compact) return picker

  return (
    // **A band and not a rectangle** (#838). The drawing gives the import one
    // row across the top of the ledger: the gesture's own icon, what the
    // gesture does in one sentence with its qualification under it, and the
    // picker at the right. It was a 120 px dashed box with a paragraph in it,
    // which is the shape of an empty state and not of a bar.
    // The dashed edge stays: it is what says *you may drop something here*.
    <div
      // The drop half. It is an alternative to the control below and never the
      // only way in — which is why it carries no role of its own.
      {...handlers}
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border-[1.5px] border-dashed border-primary/25 bg-primary/4 px-5.5 py-4.5 transition-colors',
        over && 'border-primary bg-primary/8',
      )}
    >
      <Upload aria-hidden className="size-5.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 basis-55">
        <p className="text-md font-medium">{t('data.drop.title')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('data.drop.body')}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2.5">{picker}</div>
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
 * entitled to read it twice. **Dismissing puts down one sentence and not a
 * filename**: every import says its own, the second import of `operations.csv`
 * included.
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
  // Dismissed by the reader, and by nothing else — **this** receipt, and it is
  // held by identity rather than by name. A name would put down every later
  // receipt bearing it, and the file that bears it again is the ordinary case
  // and not the odd one: the broker's weekly export is `operations.csv` every
  // week, and the file somebody corrected and handed back keeps the name it had.
  // An import whose sentence never appeared is an import the reader has no way
  // of reading, which is the receipt rule (`CONTEXT.md` § Receipt) failing on
  // exactly the gesture it exists for. Each write answers a fresh object, so
  // what a reader put down is one gesture's sentence and never a filename's.
  const [dismissed, setDismissed] = useState<ImportReceipt | undefined>(undefined)

  if (!receipt || dismissed === receipt) return null

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
        onClick={() => setDismissed(receipt)}
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
      ? receiptMessage({ kind: 'import.empty', files: receipt.files.map((file) => file.filename) })
      : receiptMessage({
          kind: 'import.written',
          count: receipt.written,
          duplicates: receipt.duplicates,
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
