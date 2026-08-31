/**
 * **Ce que cet import ferait** — the modal that collects the three answers
 * (#835, #813, ADR-0006, ADR-0032).
 *
 * The server has served this surface since #813 and the front had never
 * gathered it. `?dry_run=1` judges the file, counts what of it the ledger
 * already holds, reads the reporting currency it declares, and answers the
 * receipt having written nothing at all — no row, no setting, not one lock
 * taken. What was missing was the window that puts the questions.
 *
 * **The correspondence is the new one, and it is a parameter of the gesture.**
 * A line per account the file names, with its volume and its target; the
 * selector offers the declared accounts *plus* the entry that declares this one
 * with the file, which is what repairs the `422` that used to reject the whole
 * file and send the reader off to declare an account by hand — holding a file
 * the app had just refused. It is **consumed at the import and dropped**, and
 * the window says so: it is not the mapping table `reassignment.py` refused,
 * which was a second *persistent* truth about the account an event names
 * (ADR-0006). No `UPDATE`, no window, nothing kept.
 *
 * **An answer costs a fresh forecast, and that is not waste.** The duplicate key
 * carries the account, so rows sent from `TR` into `pea` may be rows the ledger
 * already holds — and the forecast on screen would say otherwise. `reconsider`
 * therefore re-uploads the file, which is the same double upload #813 already
 * pays for: the server remembers no import, ever.
 *
 * **The other two are offers the server already made.** The duplicates, named
 * line by line with the ledger row each repeats, skipped by default and written
 * if the reader says so — and that answer **costs a forecast of its own**, for a
 * harder reason than the correspondence's: writing the rows the ledger already
 * holds is a different ledger to replay, and a file whose `SELL` only replays
 * because its duplicate was skipped stops replaying once it is not. Left to
 * arithmetic here, that is a `409` arriving **after** the button. So the box
 * re-reads the file under `?write_duplicates=1`, the footer states the figure
 * that reading answers, and a refusal lands *at the box*, beside a census the
 * reader can untick against.
 * The currency, offered for adoption where this install has never answered, and
 * **refused in prose** where it contradicts one — which is a `422` at both
 * moments and therefore a window with no forecast in it and a disabled button.
 *
 * **The summary, not the table.** `uploads.receipt` settled the shape long ago:
 * period, accounts and securities as sorted sets, *which and not how many
 * times*. The duplicates are the one thing that details, because a skipped line
 * is argued with one at a time and a count cannot be argued with.
 *
 * **No refusal arrives after the button.** The button is blocked while a line
 * has no target, and it says why in prose rather than being merely grey; what
 * the forecast accepted, the write writes. Which holds only because **every**
 * answer the window collects is sent to the forecast — the correspondence and
 * the duplicates alike: a parameter the preview never carried is a parameter the
 * server judges for the first time under the button.
 *
 * **The simple case renders neither block.** Everything declared and nothing
 * duplicated: the accounts block is one line of affirmation, and the duplicates
 * block does not exist — a block with nothing in it does not exist (#724).
 *
 * **A read in flight is not an absence** (ADR-0026): the window claims nothing
 * about the reader's declaration until the declaration has arrived, so the body
 * waits on both the forecast and the accounts rather than rendering a question
 * against a list nobody has heard from.
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { TYPE_LABEL } from '@/components/data/LedgerTable'
import type { EventUpload } from '@/components/data/UploadZone'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, type DuplicateRow, type ImportReceipt } from '@/lib/api'
import { DEFAULT_ACCOUNT_ID, DEFAULT_ACCOUNT_LABEL, declaredLabel } from '@/lib/accounts'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  accountLines,
  correspondenceOf,
  unanswered,
  type AccountLine,
  type AccountTarget,
} from '@/lib/imports'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

/**
 * What the selector carries for *declare this label*, and it is **not an id**.
 *
 * A leading space, which no account id can hold: `accounts.create_account`
 * strips what it is given, so the store has no row this value could collide
 * with. The two answers travel to the server as two parameters for the same
 * reason — a sentinel written among the targets would be an id somebody could
 * really have declared.
 */
const DECLARE = ' declare'

export function ImportPreview({ upload }: { upload: EventUpload }) {
  const { t } = useI18n()
  const f = useFormatters()
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts })
  // The reporting currency, for the duplicate lines alone and read where the
  // ledger table reads it: it is not on the events resource, and a money figure
  // with no unit renders as a plain number rather than guessing one.
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: api.portfolioTotals })

  // What the reader has answered so far, by the file's own label. Cleared with
  // the file — the next one asks the question again, which is the whole of
  // *consumed at the import and dropped*.
  const [chosen, setChosen] = useState<Record<string, AccountTarget>>({})
  const [writeDuplicates, setWriteDuplicates] = useState(false)
  const [adoptCurrency, setAdoptCurrency] = useState(true)
  const forecast = upload.forecast
  const previewed = forecast?.file.filename
  const [lastFile, setLastFile] = useState<string | undefined>(previewed)
  if (!upload.held && (lastFile !== undefined || Object.keys(chosen).length > 0)) {
    // The file was put down or written: nothing the reader said about it
    // survives into the next one, or a box ticked for one file would write
    // duplicates nobody looked at.
    setLastFile(undefined)
    setChosen({})
    setWriteDuplicates(false)
    setAdoptCurrency(true)
  } else if (upload.held && previewed !== undefined && lastFile === undefined) {
    setLastFile(previewed)
  }

  const declared = accounts.data
  const linesUnder = (picks: Readonly<Record<string, AccountTarget>>) =>
    accountLines(
      forecast?.file.file_accounts ?? [],
      new Set((declared?.accounts ?? []).map((account) => account.id)),
      declared?.declared ?? false,
      picks,
    )
  const lines = linesUnder(chosen)
  const missing = unanswered(lines)
  const ready = forecast !== undefined && declared !== undefined

  const answer = (name: string, target: AccountTarget) => {
    const next = { ...chosen, [name]: target }
    setChosen(next)
    // The forecast is re-read under the new correspondence: the duplicate key
    // carries the account, so what is skipped changes with the answer.
    upload.reconsider({ correspondence: correspondenceOf(linesUnder(next)), writeDuplicates })
  }

  /**
   * **The box is re-read like the selectors are**, and for a harder reason
   * (#835).
   *
   * *Write them anyway* is not a rendering choice the front can settle by
   * arithmetic: writing the rows the ledger already holds is a different ledger
   * to replay, and a file whose `SELL` only replayed because its duplicate was
   * skipped stops replaying once it is not. Judged for the first time under the
   * button, that is a `409` **after** the button — the one thing this window
   * exists to make impossible.
   */
  const decideDuplicates = (value: boolean) => {
    setWriteDuplicates(value)
    upload.reconsider({ correspondence: correspondenceOf(lines), writeDuplicates: value })
  }

  return (
    <Dialog
      open={upload.held}
      onOpenChange={(open) => {
        // Closing is refusing: the window offers no *later*, and there is
        // nothing on the server to come back to.
        if (!open) upload.discard()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('data.import.preview.title')}</DialogTitle>
          {upload.filename ? (
            <span className="font-mono text-sm font-medium">{upload.filename}</span>
          ) : null}
          {forecast ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {covers(t, f, forecast.file)}
            </span>
          ) : null}
          <DialogDescription>{t('data.import.preview.body')}</DialogDescription>
        </DialogHeader>

        {/* **The wait is dressed**, and that is not the spinner rule's
            business: nothing is being claimed about a subject nobody has heard
            from — this is the reader's own act, and the app owes them its end. */}
        {upload.pending && !forecast ? (
          <p role="status" className="text-sm text-muted-foreground">
            {running(t, upload.filename)}
          </p>
        ) : null}

        {/* The refusal, when there is one: it replaces the forecast rather than
            standing beside it, because there is no forecast to stand beside —
            a file the server turned back has no receipt at all. */}
        {upload.error ? (
          <p role="alert" className="text-sm text-attention">
            {problemSentence(t, upload.error)}
          </p>
        ) : null}

        {ready ? (
          <div className="space-y-4">
            <AccountsBlock
              lines={lines}
              declared={declared}
              busy={upload.pending}
              onAnswer={answer}
            />

            {/* Read off the **census** and never off the answer's own forecast:
                under `?write_duplicates=1` the server moves those rows into
                `written` and leaves none to name, so a block mounted on that
                reading would take itself away — box and all — the moment the
                reader ticked it. */}
            {forecast.file.duplicates > 0 ? (
              <DuplicatesBlock
                forecast={forecast.file}
                currency={totals.data?.base_currency ?? null}
                writeDuplicates={writeDuplicates}
                busy={upload.pending}
                onToggle={decideDuplicates}
              />
            ) : null}

            {forecast.file.currency?.adopting ? (
              <CurrencyBlock
                currency={forecast.file.currency.declared}
                adopt={adoptCurrency}
                busy={upload.pending}
                onToggle={setAdoptCurrency}
              />
            ) : null}
          </div>
        ) : null}

        {/* **The footer stands on a refusal too**, and that is the mockup's own
            shape: the button is *disabled beside the sentence* rather than
            absent, so the window says what it would do and why it will not. It
            does **not** stand while the first forecast is merely in flight —
            there is nothing to say yet, and a control that appears before it can
            be used is a control the reader presses for nothing. */}
        {ready || upload.error ? (
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              {/* The figures are the **answer's own forecast**, straight off the
                  server, and they are absent where that answer is refused: a
                  window that goes on stating what it would write while saying it
                  will not is stating a number about a gesture that is not on
                  offer. */}
              {ready && forecast.writing ? (
                <>
                  <span className="text-sm font-medium tabular-nums">
                    {foreseen(t, f, forecast.writing)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('data.import.skipped', { count: forecast.writing.duplicates })}
                  </span>
                </>
              ) : null}
            </span>
            <Button type="button" variant="outline" onClick={() => upload.discard()}>
              {t('data.import.cancel')}
            </Button>
            <Button
              type="button"
              disabled={
                !ready ||
                forecast.writing === undefined ||
                missing.length > 0 ||
                upload.pending
              }
              onClick={() => upload.commit({ declineCurrency: !adoptCurrency })}
            >
              {t('data.import.confirm')}
            </Button>
            {/* **The reason in prose, and not a grey button** (#835): a control
                that refuses without saying why is a control the reader cannot
                act on. */}
            {missing.length > 0 ? (
              <span className="basis-full text-xs text-attention">
                {missing.length === 1
                  ? t('data.import.blocked.one', { count: missing[0].rows })
                  : t('data.import.blocked.many', { count: missing.length })}
              </span>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * **Les comptes** — one line per account the file names, or one line of
 * affirmation where every one of them already lands (#835).
 *
 * The reduced form is the ticket's own: the mockup does not show the simple case
 * because no prop exercises it, and a block that has nothing to ask has nothing
 * to render but the fact that it asked nothing.
 */
function AccountsBlock({
  lines,
  declared,
  busy,
  onAnswer,
}: {
  lines: readonly AccountLine[]
  declared: { accounts: { id: string; label: string | null; type: string | null }[] }
  busy: boolean
  onAnswer: (name: string, target: AccountTarget) => void
}) {
  const { t } = useI18n()
  const settled = lines.every((line) => line.settled)

  if (lines.length === 0) return null

  return (
    <section aria-labelledby="import-accounts" className="space-y-3 rounded-lg border p-4">
      <h3
        id="import-accounts"
        className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
      >
        {t('data.import.accounts.title')}
      </h3>

      {settled ? (
        <p className="text-sm">{t('data.import.accounts.settled', { count: lines.length })}</p>
      ) : (
        <>
          <ul className="space-y-3">
            {lines.map((line) => (
              <AccountRow
                key={line.name}
                line={line}
                declared={declared.accounts}
                busy={busy}
                onAnswer={onAnswer}
              />
            ))}
          </ul>
          {/* ADR-0006, said to the reader rather than only in a record. */}
          <p className="text-xs text-muted-foreground">{t('data.import.accounts.dropped')}</p>
        </>
      )}
    </section>
  )
}

function AccountRow({
  line,
  declared,
  busy,
  onAnswer,
}: {
  line: AccountLine
  declared: readonly { id: string; label: string | null; type: string | null }[]
  busy: boolean
  onAnswer: (name: string, target: AccountTarget) => void
}) {
  const { t } = useI18n()
  const name = line.name === '' ? t('data.import.accounts.blank') : line.name
  const value =
    line.target.kind === 'account'
      ? line.target.id
      : line.target.kind === 'declare'
        ? DECLARE
        : ''

  return (
    <li className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`text-sm font-medium ${line.name === '' ? '' : 'font-mono'}`}>{name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('data.import.accounts.volume', { count: line.rows })}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        {/* A real `<select>`: the target is a choice among a list the app knows,
            and the one control every reader already operates — pointer,
            keyboard and screen reader alike — is the one the platform ships. */}
        <select
          aria-label={t('data.import.accounts.target', { account: name })}
          disabled={busy}
          className={`h-9 w-full rounded-md border bg-background px-2 text-sm ${
            line.target.kind === 'unanswered' ? 'border-attention' : ''
          }`}
          value={value}
          onChange={(event) => {
            const picked = event.target.value
            onAnswer(
              line.name,
              picked === DECLARE
                ? { kind: 'declare' }
                : picked === ''
                  ? { kind: 'unanswered' }
                  : { kind: 'account', id: picked },
            )
          }}
        >
          {line.target.kind === 'unanswered' ? (
            <option value="">{t('data.import.accounts.choose')}</option>
          ) : null}
          {declared.map((account) => (
            <option key={account.id} value={account.id}>
              {account.id === DEFAULT_ACCOUNT_ID
                ? t(DEFAULT_ACCOUNT_LABEL)
                : (declaredLabel(account) ?? account.id)}
            </option>
          ))}
          {/* **The entry that repairs the refusal.** Offered only where there is
              a label to declare: the blank column names no account, so there is
              no id to give one. */}
          {line.name === '' ? null : (
            <option value={DECLARE}>
              {t('data.import.accounts.declare', { account: line.name })}
            </option>
          )}
        </select>
        <span
          className={`text-xs ${
            line.target.kind === 'unanswered' ? 'text-attention' : 'text-muted-foreground'
          }`}
        >
          {why(t, line, declared)}
        </span>
      </span>
    </li>
  )
}

/** What becomes of this account, in one clause under its selector. */
function why(
  t: ReturnType<typeof useI18n>['t'],
  line: AccountLine,
  declared: readonly { id: string; label: string | null; type: string | null }[],
): string {
  if (line.target.kind === 'unanswered') {
    return t('data.import.accounts.why.unanswered', {
      account: line.name === '' ? t('data.import.accounts.blank') : line.name,
    })
  }
  if (line.target.kind === 'declare') {
    return t('data.import.accounts.why.declaring', { account: line.name })
  }
  const id = line.target.id
  if (line.settled && id === (line.name === '' ? DEFAULT_ACCOUNT_ID : line.name)) {
    return t('data.import.accounts.why.declared')
  }
  const target = declared.find((account) => account.id === id)
  return t('data.import.accounts.why.moved', {
    account:
      target === undefined
        ? id
        : target.id === DEFAULT_ACCOUNT_ID
          ? t(DEFAULT_ACCOUNT_LABEL)
          : (declaredLabel(target) ?? target.id),
  })
}

/**
 * **Les doublons** — named line by line, with what each of them repeats (#835).
 *
 * A count is not a sentence the owner can act on; *this 12 August purchase,
 * which you already have* is. They are skipped by default, so the common case —
 * the owner re-uploading their own export — needs no vigilance at all, and the
 * box is the one story #813 wrote for the owner who really did place the same
 * order twice. Nobody else has to be asked.
 */
function DuplicatesBlock({
  forecast,
  currency,
  writeDuplicates,
  busy,
  onToggle,
}: {
  forecast: ImportReceipt
  currency: string | null
  writeDuplicates: boolean
  busy: boolean
  onToggle: (value: boolean) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const box = useId()
  const said = receiptMessage(
    writeDuplicates
      ? { kind: 'import.known.kept', count: forecast.duplicates }
      : { kind: 'import.known.forecast', count: forecast.duplicates },
  )

  return (
    <section aria-labelledby="import-duplicates" className="space-y-3 rounded-lg border p-4">
      <h3
        id="import-duplicates"
        className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
      >
        {t('data.import.duplicates.title')}
      </h3>
      <p className="text-sm">{t(said.message, said.values)}</p>

      {forecast.duplicate_rows.length > 0 ? (
        <ul className="divide-y">
          {forecast.duplicate_rows.map((row, index) => (
            <li
              key={`${row.date}-${row.symbol ?? ''}-${index}`}
              className="flex items-baseline justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">{names(t, f, row, currency)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {row.duplicate_of === null
                  ? t('data.import.duplicates.repeated')
                  : t('data.import.duplicates.held')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* The box is named by the **short** clause and *described* by the long
          one: an accessible name carrying both would read the paragraph out at
          every focus, and the italic sentence is the reason rather than the
          question. */}
      <div className="flex items-start gap-2 text-sm">
        <input
          id={box}
          type="checkbox"
          className="mt-1"
          aria-describedby={`${box}-why`}
          checked={writeDuplicates}
          disabled={busy}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <label htmlFor={box} className="font-medium">
            {t('data.import.duplicates')}
          </label>
          <span id={`${box}-why`} className="text-xs text-muted-foreground italic">
            {t('data.import.duplicates.why')}
          </span>
        </span>
      </div>
    </section>
  )
}

/** One skipped line, in the words the ledger table already uses for a row. */
function names(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  row: DuplicateRow,
  currency: string | null,
): string {
  const figure =
    row.quantity !== null && row.unit_price !== null
      ? `${f.quantity(row.quantity)} × ${f.currency(row.unit_price, currency)}`
      : row.amount !== null
        ? f.currency(row.amount, currency)
        : null
  return [f.date(row.date), t(TYPE_LABEL[row.event_type]), row.symbol, figure]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/**
 * **La devise** — offered, never taken quietly (ADR-0021, #710).
 *
 * The app reads a declaration and never asserts one, and this install has never
 * answered the question: the file's answer is the one that makes the round trip
 * work — upload the export and the install is the install it came from — so the
 * box is ticked, and it is a box because the answer cannot be taken back.
 *
 * The other half of the rule needs no control: a file that **contradicts** the
 * dial is a refusal in prose at both moments, and there is no forecast behind it
 * to render this block over.
 */
function CurrencyBlock({
  currency,
  adopt,
  busy,
  onToggle,
}: {
  currency: string
  adopt: boolean
  busy: boolean
  onToggle: (value: boolean) => void
}) {
  const { t } = useI18n()

  return (
    <section aria-labelledby="import-currency" className="space-y-3 rounded-lg border p-4">
      <h3
        id="import-currency"
        className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
      >
        {t('data.import.currency.title')}
      </h3>
      <p className="text-sm">{t('data.import.currency.offer', { currency })}</p>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={adopt}
          disabled={busy}
          onChange={(event) => onToggle(event.target.checked)}
        />
        {t('data.import.currency.adopt', { currency })}
      </label>
    </section>
  )
}

/** The file on its way in — the running sentence names it. */
function running(t: ReturnType<typeof useI18n>['t'], filename: string | undefined): string {
  const said = receiptMessage({ kind: 'import.running', filename: filename ?? '' })
  return t(said.message, said.values)
}

/** What the file covers — its rows, its period and its securities. */
function covers(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  forecast: ImportReceipt,
): string {
  if (forecast.period === null) return t('data.import.file.rows', { count: forecast.rows })
  return t('data.import.file.covers', {
    count: forecast.rows,
    from: f.date(forecast.period.from),
    to: f.date(forecast.period.to),
    symbols: forecast.symbols.length,
  })
}

/**
 * **What would be written** — `import.written`'s sentence with its tense moved,
 * so the reader recognises afterwards what they read before (#813).
 *
 * The count **follows the reader's choice about the duplicates**, and it is the
 * **server's** count under that choice rather than arithmetic done here: the
 * preview is re-read under the box, so there is a real forecast of the real
 * answer to read the figure off, and a number the front computed would be a
 * second authority on what the button does.
 */
function foreseen(
  t: ReturnType<typeof useI18n>['t'],
  f: ReturnType<typeof useFormatters>,
  writing: ImportReceipt,
): string {
  const said =
    writing.period === null
      ? receiptMessage({ kind: 'import.forecast.empty', filename: writing.filename })
      : receiptMessage({
          kind: 'import.forecast',
          count: writing.written,
          from: f.date(writing.period.from),
          to: f.date(writing.period.to),
          accounts: writing.accounts.length,
          symbols: writing.symbols.length,
        })
  return t(said.message, said.values)
}
