/**
 * **Ce que cet import ferait** — the modal that collects the three answers
 * (#835, #813).
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
 * which was a second *persistent* truth about the account an event names.
 *No `UPDATE`, no window, nothing kept.
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
 * **The currency of the amounts is the fourth question** (#1261). No write path
 * converts an amount, so a line quoted in USD in a EUR install was always read
 * as EUR, and the reader learnt it afterwards from a notice. The server now
 * names the foreign-quoted lines in the forecast and the window asks, once for
 * the whole file, which currency their amounts are in. **Nothing is
 * preselected**: *Importer* stays disabled, with the reason written beside it,
 * until the reader answers — a default would be the old silence again. The
 * answer is sent to every forecast, so a rate the server does not have is a
 * refusal at the radio and never after the button.
 *
 * **The simple case renders neither block.** Everything declared and nothing
 * duplicated: the accounts block is one line of affirmation, and the duplicates
 * block does not exist — a block with nothing in it does not exist (#724).
 *
 * **A read in flight is not an absence**: the window claims nothing
 * about the reader's declaration until the declaration has arrived, so the body
 * waits on both the forecast and the accounts rather than rendering a question
 * against a list nobody has heard from.
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import type { EventUpload } from '@/features/data/components/UploadZone'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { accountsApi } from '@/features/accounts/lib/api'
import { dashboardApi } from '@/features/dashboard/lib/api'
import type { AmountsIn, DuplicateRow, ForeignLine, ImportReceipt } from '@/features/data/lib/api'
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_LABEL,
  declaredLabel,
} from '@/features/accounts/lib/accounts'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  accountLines,
  correspondenceOf,
  repeatGroups,
  unanswered,
  type AccountLine,
  type AccountTarget,
} from '@/features/data/lib/imports'
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
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  // The reporting currency, for the duplicate lines alone and read where the
  // ledger table reads it: it is not on the events resource, and a money figure
  // with no unit renders as a plain number rather than guessing one.
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: dashboardApi.portfolioTotals })

  // What the reader has answered so far, by the file's own label. Cleared with
  // the file — the next one asks the question again, which is the whole of
  // *consumed at the import and dropped*.
  const [chosen, setChosen] = useState<Record<string, AccountTarget>>({})
  const [writeDuplicates, setWriteDuplicates] = useState(false)
  // The groups of identical lines the reader keeps one copy of (#1267). Empty:
  // every copy is written until they say otherwise.
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [adoptCurrency, setAdoptCurrency] = useState(true)
  const [amountsIn, setAmountsIn] = useState<AmountsIn | undefined>(undefined)
  const forecast = upload.forecast
  const previewed = forecast?.file.filename
  const [lastFile, setLastFile] = useState<string | undefined>(previewed)
  if (
    !upload.held &&
    (lastFile !== undefined || Object.keys(chosen).length > 0 || amountsIn !== undefined)
  ) {
    // The file was put down or written: nothing the reader said about it
    // survives into the next one, or a box ticked for one file would write
    // duplicates nobody looked at.
    setLastFile(undefined)
    setChosen({})
    setWriteDuplicates(false)
    setCollapsed(new Set())
    setAdoptCurrency(true)
    setAmountsIn(undefined)
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

  // The question about the foreign-quoted amounts (#1261). It needs the base
  // currency to be worded, and a reader who cannot be asked is not blocked: the
  // write then keeps the behaviour of a caller that never heard of it.
  const base = totals.data?.base_currency ?? null
  const foreignLines = forecast?.file.foreign_lines ?? []
  const asking = base !== null && foreignLines.length > 0
  const currencies = [...new Set(foreignLines.map((line) => line.currency))].join(', ')
  const currencyMissing = asking && amountsIn === undefined

  const answer = (name: string, target: AccountTarget) => {
    const next = { ...chosen, [name]: target }
    setChosen(next)
    // The forecast is re-read under the new correspondence: the duplicate key
    // carries the account, so what is skipped changes with the answer.
    upload.reconsider({
      correspondence: correspondenceOf(linesUnder(next)),
      writeDuplicates,
      amountsIn,
      collapsed,
    })
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
    upload.reconsider({
      correspondence: correspondenceOf(lines),
      writeDuplicates: value,
      amountsIn,
      collapsed,
    })
  }

  /** The currency answer is re-read like the others: a missing rate is a refusal here. */
  const decideCurrency = (value: AmountsIn) => {
    setAmountsIn(value)
    upload.reconsider({
      correspondence: correspondenceOf(lines),
      writeDuplicates,
      amountsIn: value,
      collapsed,
    })
  }

  /**
   * **A repeated group answered** (#1267): re-read like the box is, since writing
   * every copy is a different ledger to replay — a file pasted twice oversells
   * under *write all*, and that `409` has to land here and not under the button.
   */
  const decideRepeats = (next: ReadonlySet<number>) => {
    setCollapsed(next)
    upload.reconsider({
      correspondence: correspondenceOf(lines),
      writeDuplicates,
      amountsIn,
      collapsed: next,
    })
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
            {checking(t, upload.filename)}
          </p>
        ) : null}

        {/* The refusal, when there is one: it replaces the forecast rather than
            standing beside it, because there is no forecast to stand beside —
            a file the server turned back has no receipt at all. */}
        {upload.error ? (
          <p role="alert" className="text-sm text-destructive">
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

            {asking ? (
              <ForeignBlock
                lines={foreignLines}
                unverified={forecast.file.unverified}
                base={base}
                currencies={currencies}
                answer={amountsIn}
                busy={upload.pending}
                refused={Boolean(upload.error)}
                onAnswer={decideCurrency}
              />
            ) : null}

            {/* Both read off the **census** and never off the answer's own
                forecast: under `?write_duplicates=1` the server moves those rows
                into `written` and leaves none to name, so a block mounted on that
                reading would take itself away — box and all — the moment the
                reader ticked it. The repeats come first (#1267): they are written
                by default, and the reader is more likely to answer them. */}
            <RepeatsBlock
              rows={forecast.file.duplicate_rows}
              currency={totals.data?.base_currency ?? null}
              collapsed={collapsed}
              busy={upload.pending}
              onChange={decideRepeats}
            />

            <HeldBlock
              rows={forecast.file.duplicate_rows}
              currency={totals.data?.base_currency ?? null}
              writeDuplicates={writeDuplicates}
              busy={upload.pending}
              onToggle={decideDuplicates}
            />

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
                currencyMissing ||
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
            {currencyMissing ? (
              <span className="basis-full text-xs text-attention">
                {t('data.import.blocked.currency', { currencies })}
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
  declared: { accounts: { id: string; label: string | null }[] }
  busy: boolean
  onAnswer: (name: string, target: AccountTarget) => void
}) {
  const { t } = useI18n()
  const settled = lines.every((line) => line.settled)

  if (lines.length === 0) return null

  return (
    <section aria-labelledby="import-accounts" className="space-y-3 rounded-lg border p-4">
      <h3 id="import-accounts" className="label">
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
  declared: readonly { id: string; label: string | null }[]
  busy: boolean
  onAnswer: (name: string, target: AccountTarget) => void
}) {
  const { t } = useI18n()
  const name = line.name === '' ? t('data.import.accounts.blank') : line.name
  const value =
    line.target.kind === 'account' ? line.target.id : line.target.kind === 'declare' ? DECLARE : ''

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
  declared: readonly { id: string; label: string | null }[],
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

/** Past this many securities, the list shows one fewer and counts the rest. */
const MAX_FOREIGN_SHOWN = 6

/**
 * **Les montants en devise** — one question for the whole file (#1261).
 *
 * The group is a native `fieldset` named by its `legend`, which is the question
 * itself, and each radio is described by its own clause. Neither is checked on
 * arrival: an answer the reader did not give is the silence this block replaces.
 * The radios are disabled while a forecast is pending and **stay enabled on a
 * refusal**, so a rate the server does not have is taken back by picking the
 * other answer.
 */
function ForeignBlock({
  lines,
  unverified,
  base,
  currencies,
  answer,
  busy,
  refused,
  onAnswer,
}: {
  lines: readonly ForeignLine[]
  unverified: readonly string[]
  base: string
  currencies: string
  answer: AmountsIn | undefined
  busy: boolean
  /** The standing answer was refused: clicking it again asks once more. */
  refused: boolean
  onAnswer: (value: AmountsIn) => void
}) {
  const { t } = useI18n()
  const group = useId()
  const crowded = lines.length > MAX_FOREIGN_SHOWN
  const shown = crowded ? lines.slice(0, MAX_FOREIGN_SHOWN - 1) : lines

  const choices: { value: AmountsIn; name: string; why: string }[] = [
    {
      value: 'base',
      name: t('data.import.foreign.base', { base }),
      why: t('data.import.foreign.base.why'),
    },
    {
      value: 'quote',
      name: t('data.import.foreign.quote', { currencies }),
      why: t('data.import.foreign.quote.why', { base }),
    },
  ]

  return (
    <section aria-labelledby="import-foreign" className="space-y-3 rounded-lg border p-4">
      <h3 id="import-foreign" className="label">
        {t('data.import.foreign.title')}
      </h3>

      <fieldset className="space-y-3">
        <legend className="text-sm">
          {t('data.import.foreign.lead', { count: lines.length, base })}
        </legend>

        <ul className="divide-y">
          {shown.map((line) => (
            <li key={line.symbol} className="flex items-baseline justify-between gap-3 py-2">
              <span className="font-mono text-xs">{line.symbol}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('data.import.foreign.rows', { currency: line.currency, count: line.rows })}
              </span>
            </li>
          ))}
          {crowded ? (
            <li className="py-2 text-xs text-muted-foreground">
              {t('data.import.foreign.more', { count: lines.length - shown.length })}
            </li>
          ) : null}
        </ul>

        {choices.map((choice) => {
          const id = `${group}-${choice.value}`
          return (
            <div
              key={choice.value}
              className="flex items-start gap-2 text-sm pointer-coarse:min-h-11"
            >
              <input
                id={id}
                type="radio"
                name={group}
                className="mt-1"
                aria-describedby={`${id}-why`}
                checked={answer === choice.value}
                disabled={busy}
                onChange={() => onAnswer(choice.value)}
                // A radio already checked fires no `onChange`: after a refusal
                // ("try again later") the same click is how the reader retries.
                onClick={() => {
                  if (refused && answer === choice.value) onAnswer(choice.value)
                }}
              />
              <span className="flex flex-col gap-0.5">
                <label htmlFor={id} className="font-medium pointer-coarse:py-2">
                  {choice.name}
                </label>
                <span id={`${id}-why`} className="text-xs text-muted-foreground italic">
                  {choice.why}
                </span>
              </span>
            </div>
          )
        })}
      </fieldset>

      {unverified.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('data.import.foreign.unverified', {
            count: unverified.length,
            symbols: unverified.join(', '),
            base,
          })}
        </p>
      ) : null}
    </section>
  )
}

/**
 * **Répétées dans le fichier** — the lines the file carries more than once, one
 * choice per group of identical lines (#1267).
 *
 * Written by default, every copy: two identical dividends on one day are as
 * likely two payments as one pasted twice, and a default that drops one drops a
 * real event in silence. Only the reader knows, so each group asks — and from two
 * groups on, two shortcuts answer them all at once. No "write 2 of 3": a group is
 * written whole or kept once.
 */
function RepeatsBlock({
  rows,
  currency,
  collapsed,
  busy,
  onChange,
}: {
  rows: readonly DuplicateRow[]
  currency: string | null
  collapsed: ReadonlySet<number>
  busy: boolean
  onChange: (collapsed: ReadonlySet<number>) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const groups = repeatGroups(rows)

  if (groups.length === 0) return null

  const set = (first: number, one: boolean) => {
    const next = new Set(collapsed)
    if (one) next.add(first)
    else next.delete(first)
    onChange(next)
  }

  return (
    <section aria-labelledby="import-repeats" className="space-y-3 rounded-lg border p-4">
      <h3 id="import-repeats" className="label">
        {t('data.import.repeats.title')}
      </h3>
      <p className="text-sm">{t('data.import.repeats.body')}</p>
      <p className="text-xs text-muted-foreground italic">{t('data.import.repeats.why')}</p>

      {groups.length >= 2 ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onChange(new Set())}
          >
            {t('data.import.repeats.bulk.all')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onChange(new Set(groups.map((group) => group.first)))}
          >
            {t('data.import.repeats.bulk.one')}
          </Button>
        </div>
      ) : null}

      <div className="max-h-60 divide-y overflow-y-auto">
        {groups.map((group) => (
          <RepeatGroup
            key={group.first}
            line={names(t, f, group.row, currency)}
            copies={group.copies}
            one={collapsed.has(group.first)}
            busy={busy}
            onChange={(one) => set(group.first, one)}
          />
        ))}
      </div>
    </section>
  )
}

/** One group of identical lines: the line, how often, and the pair of radios. */
function RepeatGroup({
  line,
  copies,
  one,
  busy,
  onChange,
}: {
  line: string
  copies: number
  one: boolean
  busy: boolean
  onChange: (one: boolean) => void
}) {
  const { t } = useI18n()
  const name = useId()
  // The label is the click target, and it is tall enough to hit under 768 px.
  const label = 'flex min-h-11 items-center gap-2 text-sm md:min-h-0'

  return (
    <fieldset className="space-y-1 py-2" disabled={busy}>
      <legend className="float-left w-full text-sm">
        {line}
        <span className="ml-2 text-xs text-muted-foreground">
          {t('data.import.repeats.times', { count: copies })}
        </span>
      </legend>
      <div className="clear-both flex flex-wrap gap-x-4">
        <label className={label}>
          <input type="radio" name={name} checked={!one} onChange={() => onChange(false)} />
          {t('data.import.repeats.all', { count: copies })}
        </label>
        <label className={label}>
          <input type="radio" name={name} checked={one} onChange={() => onChange(true)} />
          {t('data.import.repeats.one')}
        </label>
      </div>
    </fieldset>
  )
}

/**
 * **Déjà dans votre grand livre** — the lines the ledger already holds (#835).
 *
 * A count is not a sentence the owner can act on; *this 12 August purchase* is.
 * They are skipped by default, so the common case — the owner re-uploading their
 * own export — needs no vigilance at all, and the box repairs the rest.
 * Every copy is held, including when the file repeats the line (#1267).
 */
function HeldBlock({
  rows,
  currency,
  writeDuplicates,
  busy,
  onToggle,
}: {
  rows: readonly DuplicateRow[]
  currency: string | null
  writeDuplicates: boolean
  busy: boolean
  onToggle: (value: boolean) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const box = useId()
  const held = rows.filter((row) => row.duplicate_of !== null)
  const said = receiptMessage(
    writeDuplicates
      ? { kind: 'import.known.kept', count: held.length }
      : { kind: 'import.known.forecast', count: held.length },
  )

  if (held.length === 0) return null

  return (
    <section aria-labelledby="import-held" className="space-y-3 rounded-lg border p-4">
      <h3 id="import-held" className="label">
        {t('data.import.held.title')}
      </h3>
      <p className="text-sm">{t(said.message, said.values)}</p>

      <ul className="max-h-60 divide-y overflow-y-auto">
        {held.map((row, index) => (
          <li key={`${row.date}-${row.symbol ?? ''}-${index}`} className="py-2 text-sm">
            {names(t, f, row, currency)}
          </li>
        ))}
      </ul>

      <div className="flex items-start gap-2 text-sm">
        <input
          id={box}
          type="checkbox"
          className="mt-1"
          checked={writeDuplicates}
          disabled={busy}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <label htmlFor={box} className="font-medium">
          {t('data.import.duplicates')}
        </label>
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
 * **La devise** — offered, never taken quietly (#710).
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
      <h3 id="import-currency" className="label">
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

/** The file on its way in — the sentence names it, and says its currencies are checked too. */
function checking(t: ReturnType<typeof useI18n>['t'], filename: string | undefined): string {
  const said = receiptMessage({ kind: 'import.checking', filename: filename ?? '' })
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
