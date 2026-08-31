/**
 * **The way back out — four entries** (#710, #794, #796, #836, ADR-0020,
 * ADR-0030, ADR-0034, spec #787).
 *
 * Every event as an importable `.csv`, the same ledger as a **workbook with one
 * sheet per year**, the **filtered selection** — what the chips retain at the
 * instant of the click — and the **accounts with their positions**. The fourth
 * had left with the accounts file (ADR-0034) and comes back a different thing
 * altogether: #787 puts it in the menu on an argument that is not the one that
 * removed it, *declaring an account is a gesture of the domain, exporting is a
 * gesture on data* — so the way out of the accounts lives where the data are
 * looked at, and what leaves is a **report** (balances, PMP, valuations) rather
 * than a declaration nothing reads back. The trap ADR-0034 closed stays closed
 * because the import refuses this file **by name**, for want of `date` and
 * `event_type`: it cannot be filed beside a backup and mistaken for one.
 *
 * **Every entry states its own perimeter**, and the menu is laid out so that it
 * does: a label, the note under it saying what is in the file, and the format on
 * the right. The workbook is the ledger *entire*, deliberately — the resource
 * takes the reduction in either shape, so a workbook of the selection is one
 * parameter away, and what stops the menu from offering it is that the reader
 * was promised entries they can tell apart. The perimeter is named by the one
 * entry that reduces, and by no other.
 *
 * **Nothing here narrows anything.** The selection is the ledger's own
 * reduction, carried to the server as the five names the chips hold (`q`,
 * `type`, `account`, `symbol`, and since #810 `since`/`until`) and answered
 * there: the importable form belongs to `events/export.py`, and a partial file
 * assembled in TypeScript would be a second spelling of a format written once.
 * What comes back is therefore an ordinary event file — droppable,
 * re-importable — and not an extract that looks like one. The fourth entry
 * sends no parameter at all: a position has no type and no date, so the
 * reduction is not a question that resource can be asked.
 *
 * It is also read from the **store** and not from the snapshot this page draws.
 * The two hold the same rows on the common path and part exactly where it
 * matters: a snapshot the validator refused leaves the previous one standing,
 * and a backup is of what is stored. The counts in the notes are this page's
 * own — they describe the table the reader is looking at, which is what makes
 * them honest labels for the gesture.
 *
 * **The confirmation is the receipt, and it lasts as long as the operation.**
 * That is why the entries are gestures rather than `<a download>` links: a link
 * hands the request to the browser, which reports nothing back, so anything said
 * over it would be a guess with a timer on it — the three-second confirmation
 * the criterion refuses by name. Fetched, the gesture has an end, and the
 * sentence leaves when the file is there.
 *
 * The receipt shows the library's own indicator while it stands, and that is
 * not the spinner the product refuses: `noSpinner.test.ts` holds a rule about
 * **reads** — nothing may be claimed about a subject nobody has heard from, so
 * a wait on one is not dressed, it renders nothing. This wait is the reader's
 * own act, it is not a claim about anything, and #796 asks in as many words for
 * it to be visible for exactly as long as it lasts.
 *
 * The file's **name is the server's**, and it carries no date: a re-import
 * identifies a source by its file name, so under dated names two exports of one
 * install are droppable side by side and every event they share is recorded
 * twice. A *reduction* does get its own name, which is the same argument from
 * the other end — a partial file must not replace a whole one on a disk. The
 * arbitration is beside `EXPORT_FILENAMES` in `web/api.py`.
 */
import { toast } from 'sonner'

import { ChevronDown, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, ROUTES, type ExportFile } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { exportHref, selectionParams, type LedgerFilters } from '@/lib/ledger'
import { problemMessageKey } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'
import { saveFile } from '@/lib/save'

export interface ExportMenuProps {
  /** Whether this install has anything to put in a file. */
  files: { events: boolean }
  /** The reduction in force, as the table holds it at the instant of the click. */
  selection: LedgerFilters
  /** How many rows it retains — the third entry's own note. */
  selected: number
  /** How many the ledger holds entire — the first entry's, and the workbook's. */
  total: number
}

export function ExportMenu({ files, selection, selected, total }: ExportMenuProps) {
  const { t } = useI18n()

  function run(file: ExportFile, path: string) {
    const running = receiptMessage({ kind: 'export.running', file })
    const saved = receiptMessage({ kind: 'export.saved', file })
    // The promise is the receipt's own clock: it stands while the file is being
    // made and is replaced the moment it is on the reader's disk. No duration
    // is set anywhere, which is the criterion — and no receipt is infinite
    // either, because an operation ends.
    toast.promise(api.download(path).then(saveFile), {
      loading: t(running.message, running.values),
      success: () => t(saved.message, saved.values),
      // A refusal is read the way every other refusal in the front is: by
      // `problem.type`, never by the sentence the server wrote for a log.
      error: (error: unknown) => t(problemMessageKey(error)),
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The drawing's own control: the gesture's icon, the word, then a
            hairline and a chevron — one button that says both *this exports*
            and *there is a choice under it*. */}
        <Button
          type="button"
          variant="outline"
          className="h-8.5 gap-2.5 rounded-lg bg-transparent pr-2 pl-3.5 dark:bg-transparent"
        >
          <Download aria-hidden className="size-3.5" />
          {t('data.export.title')}
          <span aria-hidden className="h-4.5 w-px bg-input" />
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {/* The menu says what the four entries answer, once, rather than four
            times over: *what you are exporting*. */}
        <DropdownMenuLabel className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {t('data.export.heading')}
        </DropdownMenuLabel>
        {files.events ? (
          <>
            <Entry
              label={t('data.export.events')}
              note={t('data.export.events.note', { count: total })}
              format="CSV"
              onSelect={() => run('events', ROUTES.exportEvents)}
            />
            <Entry
              label={t('data.export.workbook')}
              note={t('data.export.workbook.note')}
              format="XLSX"
              onSelect={() => run('workbook', ROUTES.exportEventsWorkbook)}
            />
            {/* The count is part of the label: it is what the entry will
                produce, said before the click rather than discovered in a file.
                It is the reduction's own count and **not** the number of rows
                drawn — the table reveals forty at a time (ADR-0031), so *what
                is on screen* would be a sentence the file contradicts. With
                nothing pressed the reduction is the whole ledger, which is what
                the chips retain then — and the receipt then says *your events*,
                like the file the server answers under. The kind is read off the
                reduction and never off the entry that was clicked, or the one
                sentence on screen would contradict the name on the disk. */}
            <Entry
              label={t('data.export.selection')}
              note={t('data.export.selection.note', { count: selected })}
              format="CSV"
              onSelect={() =>
                run(
                  selectionParams(selection).size > 0 ? 'selection' : 'events',
                  exportHref(ROUTES.exportEvents, selection),
                )
              }
            />
            {/* **The fourth does not follow the declaration** (#787), and that
                is the whole of why it is here rather than on the accounts page:
                declaring an account is a gesture of the domain, exporting is a
                gesture on data, and the ledger is where the data are looked at.
                It is under the same condition as the other three all the same —
                not because it is about the ledger, but because this whole bar
                is: a block with nothing in it does not exist (#724), and a
                portfolio derived from no event is one seeded account and no
                position, which is a file with nothing to say. */}
            <Entry
              label={t('data.export.portfolio')}
              note={t('data.export.portfolio.note')}
              format="CSV"
              onSelect={() => run('portfolio', ROUTES.exportPortfolio)}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One entry: what leaves, what is in it, and the shape it leaves in.
 *
 * The format rides on the right as a badge rather than inside the sentence,
 * because it is the one thing a reader scans the column of entries for — two of
 * the four differ by nothing else. It is **not** hidden from the accessible
 * name for exactly that reason: the two entries it separates are read out
 * identically without it.
 */
function Entry({
  label,
  note,
  format,
  onSelect,
}: {
  label: string
  note: string
  format: string
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-3">
      <span className="min-w-0 flex-1">
        {label}
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
      <span className="shrink-0 rounded border px-1.5 font-mono text-[11px] text-muted-foreground">
        {format}
      </span>
    </DropdownMenuItem>
  )
}
