/**
 * The create form, **which is the onboarding** (#723, ADR-0005, ADR-0016).
 *
 * Manual mode died with v5: a position with no history cannot carry a realised
 * gain or a historical weighted average cost, so typing a position *is* creating
 * dated events. That promotes this form from a convenience to the first thing a
 * new owner does, and four decisions follow from it:
 *
 *  - **The type comes first, and nothing else is on screen until it is chosen.**
 *    Six labels that state their **effect** — `Achat`, `Vente`, `Attribution`,
 *    `Dividende`, `Versement`, `Retrait` — and never the six codes, which are a
 *    decoding exercise at the exact moment the reader has nothing to decode them
 *    against.
 *  - **Then only the fields of that type.** `BUY`/`SELL` take a quantity, a unit
 *    price and a fee; `GRANT` a quantity and an **optional** price; `DIVIDEND`
 *    an amount and a fee; `DEPOSIT`/`WITHDRAWAL` an amount and a fee and **no
 *    security at all** — a transfer names none, and an empty ticker field on a
 *    transfer is a question the event does not raise.
 *  - **A lateral panel, not a modal and not an editable row.** The form *changes
 *    shape* after the first choice, and a row edited in place cannot: it has the
 *    columns of the table it sits in, which is the shape of every type at once.
 *  - **Two explanation icons, and the page's only two.** One on the `date`
 *    label, because extending ADR-0016's instrument from *the figure displayed*
 *    to *the entry that produces it* is the single place where *returns are
 *    computed from the dates of your events* arrives while it can still change a
 *    behaviour; one on a grant's unit price, where **leaving the field empty is
 *    a statement** — empty is a dilution, filled feeds the contribution and the
 *    cost basis together.
 *
 * **And `<input type="date">` stops silently discarding what it cannot parse.**
 * The browser hands back an empty string for a date it does not understand, which
 * reads as *the reader left it blank* one line later; here every value is parsed
 * by `lib/ledger.ts` and a refusal is **named** beside its field. The same is
 * true of the numbers, which is why they are text inputs with a decimal input
 * mode: `<input type="number">` discards a decimal comma exactly as silently, in
 * a form whose French reader types one.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { Explain } from '@/components/Explain'
import { TYPE_LABEL } from '@/components/data/LedgerTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  api,
  EVENT_TYPES,
  type AccountsResponse,
  type EventDraft,
  type LedgerEvent,
  type LedgerEventType,
} from '@/lib/api'
import {
  accountChoice,
  declaredLabel,
  DEFAULT_ACCOUNT_LABEL,
  submittedAccount,
} from '@/lib/accounts'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { accountOf, FIELDS, parseDay, parseDecimal } from '@/lib/ledger'
import { problemMessageKey } from '@/lib/problem'
import { cn } from '@/lib/utils'

/** Everything the reader typed, as typed — parsing happens once, on submit. */
interface Draft {
  date: string
  account: string
  symbol: string
  notes: string
  quantity: string
  unitPrice: string
  fee: string
  amount: string
}

type FieldName = keyof Draft

/**
 * The sentence each state of the account field says for itself. Three states
 * and three sentences, because the three have three different repairs and only
 * one of them belongs to the reader (#764's deferral, taken up by #729).
 */
const ACCOUNT_STATE = {
  unassigned: 'data.form.account.unassigned',
  pending: 'data.form.account.pending',
  failed: 'data.form.account.failed',
} as const satisfies Record<string, MessageKey>

const EMPTY: Draft = {
  date: '',
  account: '',
  symbol: '',
  notes: '',
  quantity: '',
  unitPrice: '',
  fee: '',
  amount: '',
}

function draftOf(event: LedgerEvent): Draft {
  const text = (value: number | null) => (value === null ? '' : String(value))
  return {
    date: event.date ?? '',
    account: accountOf(event),
    symbol: event.symbol ?? '',
    notes: event.notes ?? '',
    quantity: text(event.quantity),
    unitPrice: text(event.unit_price),
    fee: text(event.fee),
    amount: text(event.amount),
  }
}

export interface EventFormProps {
  open: boolean
  /** The row being edited — `null` is a creation. */
  event: LedgerEvent | null
  /** What `/api/accounts` served. `undefined` — in flight, or failed. */
  accounts: AccountsResponse | undefined
  /** Whether that read **failed**, which is not the same absence (#729). */
  accountsFailed: boolean
  onClose: () => void
}

export function EventForm({ open, event, accounts, accountsFailed, onClose }: EventFormProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // `null` is *no type chosen yet*, and it is the state the form opens in: the
  // question comes before the fields, so it cannot be answered by default.
  const [type, setType] = useState<LedgerEventType | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({})

  // Opening on a row fills the form; opening on nothing empties it. Keyed on the
  // row's own id so reopening on another row does not inherit the last one.
  useEffect(() => {
    if (!open) return
    setErrors({})
    setType(event?.event_type ?? null)
    setDraft(event === null ? EMPTY : draftOf(event))
  }, [open, event])

  const write = useMutation({
    // A row is edited only where it has a key, which `isEditable` is the guard
    // for: the panel is never opened on an imported row.
    mutationFn: (body: EventDraft) =>
      event?.id ? api.updateEvent(event.id, body) : api.createEvent(body),
    onSuccess: () => {
      // An event moves every figure in the product — positions, totals, the
      // ledger itself — so the whole cache goes rather than a list of keys that
      // would drift from the pages reading them.
      void queryClient.invalidateQueries()
      onClose()
    },
  })

  const fields = type === null ? null : FIELDS[type]
  const choice = accountChoice(accounts, accountsFailed)
  // The two states nothing in this panel can repair: the declaration is not
  // there to be read, so the save is withheld and the field says why.
  const blocked = choice.kind === 'pending' || choice.kind === 'failed'

  function set(field: FieldName, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  function submit() {
    if (type === null || fields === null) return
    const found: Partial<Record<FieldName, MessageKey>> = {}

    // **One message for the two states, because they are one state here.** A
    // date input hands back an empty string both for what the reader never
    // typed and for what it could not parse — the value is destroyed before any
    // code sees it, and `validity.badInput` is not answered everywhere. So the
    // sentence covers both and *names the trap* rather than guessing which of
    // the two happened, which is the whole of the criterion: what the field
    // could not read no longer leaves silently.
    const day = parseDay(draft.date.trim())
    if (day === null) found.date = 'data.form.date.unreadable'

    // **A blank account means `default` until something is declared** (#698),
    // and the form reflects that rule instead of demanding a choice from an
    // empty list — which is what made the onboarding form unusable on exactly
    // the install ADR-0005 wrote it for. The blank travels as a blank: the
    // server resolves it at the write, where the file road resolves its own
    // empty cell, so the two roads keep one rule and this one cannot grow the
    // phantom account the other refuses.
    const submitted = submittedAccount(choice, draft.account)
    if ('error' in submitted) found.account = submitted.error

    const symbol = draft.symbol.trim()
    if (fields.security && symbol === '') found.symbol = 'data.form.required'

    /** A required number, an optional one, or a field this type does not have. */
    function number(field: FieldName, required: boolean, present: boolean): number | null {
      if (!present) return null
      const raw = draft[field].trim()
      if (raw === '') {
        if (required) found[field] = 'data.form.required'
        return null
      }
      const parsed = parseDecimal(raw)
      if (parsed === null) found[field] = 'data.form.number.invalid'
      return parsed
    }

    const quantity = number('quantity', true, fields.quantity)
    const unitPrice = number('unitPrice', fields.unitPrice === 'required', fields.unitPrice !== 'none')
    const fee = number('fee', false, fields.fee)
    const amount = number('amount', true, fields.amount)

    setErrors(found)
    if (Object.values(found).some(Boolean)) return

    write.mutate({
      date: day as string,
      event_type: type,
      account: 'account' in submitted ? submitted.account : '',
      symbol: fields.security ? symbol : null,
      notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      quantity,
      unit_price: unitPrice,
      fee,
      amount,
    })
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {t(event === null ? 'data.form.create.title' : 'data.form.edit.title')}
          </SheetTitle>
          <SheetDescription>{t('data.form.description')}</SheetDescription>
        </SheetHeader>

        <form
          className="space-y-5 px-4 pb-6"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            submit()
          }}
        >
          {/* The first question, and the only one on screen until it is answered. */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('data.form.type')}</legend>
            <div role="radiogroup" aria-label={t('data.form.type')} className="grid grid-cols-2 gap-2">
              {EVENT_TYPES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  aria-checked={candidate === type}
                  onClick={() => setType(candidate)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    candidate === type ? 'border-ring bg-secondary font-medium' : 'text-foreground',
                  )}
                >
                  {t(TYPE_LABEL[candidate])}
                </button>
              ))}
            </div>
          </fieldset>

          {fields === null ? null : (
            <>
              <Field
                name="date"
                label="data.form.date"
                error={errors.date}
                explain={
                  <Explain
                    figure={t('data.form.date')}
                    body="data.form.date.explain"
                    anchor="xirr"
                  />
                }
              >
                {(id, described) => (
                  <Input
                    id={id}
                    type="date"
                    value={draft.date}
                    aria-invalid={errors.date !== undefined}
                    aria-describedby={described}
                    onChange={(changed) => set('date', changed.target.value)}
                  />
                )}
              </Field>

              {/* **Four renderings and not one control**, because the four are
                  four different repairs and exactly one of them is the
                  reader's (#729, #764's deferral):

                    - a single declared account answers itself, and a select of
                      one entry is a question whose answer is known — the field
                      is not shown and `submit()` fills it in;
                    - **nothing declared at all** is #698's rule, not a missing
                      answer: the event lands on the seeded row, the panel says
                      which one, and the save goes through. Rendered as an empty
                      `<select>` under a required-field refusal, this state made
                      the onboarding form refuse before a request ever left, on
                      exactly the install ADR-0005 wrote it for;
                    - the read **in flight** and the read **failed** say nothing
                      about a declaration either way, so neither is allowed to
                      claim the first state; the field names what is going on
                      and withholds the save with that same sentence — never
                      with *this kind of event needs this field*, which sends
                      the reader looking for a control that is empty for reasons
                      of its own. */}
              {choice.kind === 'single' ? null : choice.kind === 'choose' ? (
                <Field name="account" label="data.form.account" error={errors.account}>
                  {(id, described) => (
                    <select
                      id={id}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                      value={draft.account}
                      aria-invalid={errors.account !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('account', changed.target.value)}
                    >
                      <option value="">{t('data.form.account.choose')}</option>
                      {/* The seeded row is in this list whenever an event names
                          it, so the same rule as the declaration table applies:
                          `Default account` is the server's English and is never
                          rendered (ADR-0024), and the two surfaces have to name
                          one account one way. */}
                      {choice.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('data.form.account')}</p>
                  {choice.kind === 'unassigned' ? (
                    /* The **same rule as the `choose` branch above**, and it has
                       to be: this form sits on the tab the declaration table is
                       on, so naming the row from the catalogue here while the
                       table named it from the store printed two names for one
                       account, one gesture after the rename this page exists to
                       make reachable. */
                    <p className="text-sm">
                      {(choice.account ? declaredLabel(choice.account) : null) ??
                        t(DEFAULT_ACCOUNT_LABEL)}
                    </p>
                  ) : null}
                  <p
                    className={cn(
                      'max-w-prose text-xs',
                      choice.kind === 'unassigned' ? 'text-muted-foreground' : 'text-attention',
                    )}
                  >
                    {t(ACCOUNT_STATE[choice.kind])}
                  </p>
                </div>
              )}

              {fields.security ? (
                <Field name="symbol" label="data.form.symbol" error={errors.symbol}>
                  {(id, described) => (
                    <Input
                      id={id}
                      value={draft.symbol}
                      aria-invalid={errors.symbol !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('symbol', changed.target.value)}
                    />
                  )}
                </Field>
              ) : null}

              {fields.quantity ? (
                <Field name="quantity" label="data.form.quantity" error={errors.quantity}>
                  {(id, described) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={draft.quantity}
                      aria-invalid={errors.quantity !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('quantity', changed.target.value)}
                    />
                  )}
                </Field>
              ) : null}

              {fields.unitPrice === 'none' ? null : (
                <Field
                  name="unitPrice"
                  label="data.form.unitPrice"
                  error={errors.unitPrice}
                  optional={fields.unitPrice === 'optional'}
                  explain={
                    // A grant's is the one field whose **emptiness is a
                    // statement**, so the sentence arrives where the reader is
                    // about to leave it empty.
                    fields.unitPrice === 'optional' ? (
                      <Explain
                        figure={t('data.form.unitPrice')}
                        body="data.form.grantPrice.explain"
                        anchor="net-contributed"
                      />
                    ) : undefined
                  }
                >
                  {(id, described) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={draft.unitPrice}
                      aria-invalid={errors.unitPrice !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('unitPrice', changed.target.value)}
                    />
                  )}
                </Field>
              )}

              {fields.amount ? (
                <Field name="amount" label="data.form.amount" error={errors.amount}>
                  {(id, described) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={draft.amount}
                      aria-invalid={errors.amount !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('amount', changed.target.value)}
                    />
                  )}
                </Field>
              ) : null}

              {fields.fee ? (
                <Field name="fee" label="data.form.fee" error={errors.fee} optional>
                  {(id, described) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      value={draft.fee}
                      aria-invalid={errors.fee !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('fee', changed.target.value)}
                    />
                  )}
                </Field>
              ) : null}

              {/* The label, and it is not decoration: on a cash movement it is
                  the whole identity the ledger will show (ADR-0020). */}
              <Field name="notes" label="data.form.notes" error={errors.notes} optional>
                {(id, described) => (
                  <Input
                    id={id}
                    value={draft.notes}
                    aria-describedby={described}
                    onChange={(changed) => set('notes', changed.target.value)}
                  />
                )}
              </Field>

              {write.error ? <Band>{t(problemMessageKey(write.error))}</Band> : null}

              <div className="flex gap-2">
                {/* Withheld rather than offered and refused — the same rule the
                    accounts block applies to a removal it knows will fail.
                    Neither of the two states is repairable from inside this
                    panel, and a save that did nothing and said nothing is the
                    failure this ticket inherited (#764). */}
                <Button type="submit" disabled={write.isPending || blocked}>
                  {t('data.form.submit')}
                </Button>
                <Button type="button" variant="outline" onClick={onClose}>
                  {t('data.form.cancel')}
                </Button>
              </div>
            </>
          )}
        </form>
      </SheetContent>
    </Sheet>
  )
}

/**
 * One field, its label, its optional explanation and — when it has one — the
 * sentence that says what was not understood. The refusal is bound to the input
 * with `aria-describedby` rather than left floating, so it is read where it
 * applies rather than announced once at the top of a form.
 */
function Field({
  name,
  label,
  error,
  optional,
  explain,
  children,
}: {
  name: FieldName
  label: MessageKey
  error?: MessageKey
  optional?: boolean
  explain?: ReactNode
  children: (id: string, describedBy: string | undefined) => ReactNode
}) {
  const { t } = useI18n()
  const id = `event-${name}`
  const errorId = `${id}-error`

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {t(label)}
        </label>
        {optional ? (
          <span className="text-xs text-muted-foreground">{t('data.form.optional')}</span>
        ) : null}
        {explain}
      </div>
      {children(id, error ? errorId : undefined)}
      {error ? (
        <p id={errorId} className="text-sm text-attention">
          {t(error)}
        </p>
      ) : null}
    </div>
  )
}
