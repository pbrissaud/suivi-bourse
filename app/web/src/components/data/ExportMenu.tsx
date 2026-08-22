/**
 * **The way back out — four entries since #796** (#710, #794, ADR-0020,
 * ADR-0030).
 *
 * Every event as an importable `.csv`, the same ledger as a **workbook with one
 * sheet per year**, the **filtered selection** — what the chips retain at the
 * instant of the click — and the declared accounts. The first two and the last
 * were the menu; the middle two are what this ticket adds.
 *
 * **Three of the four entries are a perimeter stated by the entry itself.** The
 * workbook is the ledger *entire*, deliberately: the resource takes the
 * reduction in either shape, so a workbook of the selection is one parameter
 * away, and what stops the menu from offering it is that four entries were what
 * the reader was promised. The perimeter is named by the one entry that
 * reduces, which is what keeps the other three unambiguous.
 *
 * **Nothing here narrows anything.** The selection is the ledger's own
 * reduction, carried to the server as the four names the chips hold (`q`,
 * `type`, `account`, `symbol`) and answered there: the importable form belongs
 * to `events/export.py`, and a partial file assembled in TypeScript would be a
 * second spelling of a format written once. What comes back is therefore an
 * ordinary event file — droppable, re-importable — and not an extract that
 * looks like one.
 *
 * It is also read from the **store** and not from the snapshot this page draws.
 * The two hold the same rows on the common path and part exactly where it
 * matters: a snapshot the validator refused leaves the previous one standing,
 * and a backup is of what is stored. The count on the third entry is this
 * page's own — it describes the table the reader is looking at, which is what
 * makes it an honest label for the gesture.
 *
 * **Two files and not one** (#710): a file is an accounts source *or* an event
 * source according to its header, so exporting the events alone would restore a
 * multi-account install into a refusal. That is not an option offered to the
 * reader — it is what the format is — and it is said **in the menu**, where the
 * choice is made. The accounts file appears only where something is declared,
 * the seeded row being no declaration (ADR-0013) and the file it would produce a
 * header with no rows under it, which v4's loader refuses the whole directory
 * over.
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
 * arbitration is beside `EXPORT_FILENAMES` in `web/api.py`, and the date a
 * reader wants is on the import list, in `Importé le`.
 */
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, ROUTES, type ExportFile } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { exportHref, selectionParams, type LedgerFilters } from '@/lib/ledger'
import { problemMessageKey } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'
import { saveFile } from '@/lib/save'

export interface ExportMenuProps {
  /** Which files this install has anything to put in. */
  files: { events: boolean; accounts: boolean }
  /** The reduction in force, as the table holds it at the instant of the click. */
  selection: LedgerFilters
  /** How many rows it retains — the third entry's own label. */
  selected: number
}

export function ExportMenu({ files, selection, selected }: ExportMenuProps) {
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
        <Button type="button" variant="outline">
          {t('data.export.title')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-xs">
        {files.events ? (
          <>
            <DropdownMenuItem onSelect={() => run('events', ROUTES.exportEvents)}>
              {t('data.export.events')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => run('workbook', ROUTES.exportEventsWorkbook)}
            >
              {t('data.export.workbook')}
            </DropdownMenuItem>
            {/* The count is the label: it is what the entry will produce, said
                before the click rather than discovered in a file. With nothing
                pressed the reduction is the whole ledger, which is what the
                chips retain then — and the receipt then says *your events*,
                like the file the server answers under. The kind is read off the
                reduction and never off the entry that was clicked, or the one
                sentence on screen would contradict the name on the disk. */}
            <DropdownMenuItem
              onSelect={() =>
                run(
                  selectionParams(selection).size > 0 ? 'selection' : 'events',
                  exportHref(ROUTES.exportEvents, selection),
                )
              }
            >
              {t('data.export.selection', { count: selected })}
            </DropdownMenuItem>
          </>
        ) : null}
        {files.accounts ? (
          <DropdownMenuItem onSelect={() => run('accounts', ROUTES.exportAccounts)}>
            {t('data.export.accounts')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {/* Not an entry: it is what the files above are, said where they are
            chosen. `DropdownMenuLabel` is not focusable and answers no click. */}
        <DropdownMenuLabel className="font-normal text-xs whitespace-normal text-muted-foreground">
          {t('data.export.two')}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
