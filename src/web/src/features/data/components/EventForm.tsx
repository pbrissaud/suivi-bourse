/**
 * The event sheet, **which is the onboarding** (#723, « Relevé », mockup
 * `EventSheet-Refonte.dc.html`).
 *
 * Manual mode died with v5: a position with no history cannot carry a realised
 * gain or a historical weighted average cost, so typing a position *is*
 * creating dated events. That promotes this sheet from a convenience to the
 * first thing a new owner does, and four decisions follow from it:
 *
 *  - **The type is a row of text tabs**, six words that state their **effect** —
 *    `Achat`, `Vente`, `Attribution`, `Dividende`, `Versement`, `Retrait` — and
 *    never the six codes. A creation opens on *Achat*.
 *  - **Then only the fields of that type.** `BUY`/`SELL` take a quantity, a
 *    unit price and a fee; `GRANT` a quantity and an **optional** price;
 *    `DIVIDEND` an amount and a fee; `DEPOSIT`/`WITHDRAWAL` an amount and a fee
 *    and **no security at all** — a transfer names none.
 *  - **A lateral panel, not a modal and not an editable row.** The form
 *    *changes shape* with the type, and a row edited in place cannot.
 *  - **The body ends on the effect line**: what the write would do to the
 *    account's cash, asked of the server (`POST /api/events/preview`, debounced
 *    on every change) and never computed here.
 *
 * **And `<input type="date">` stops silently discarding what it cannot parse.**
 * The browser hands back an empty string for a date it does not understand,
 * which reads as *the reader left it blank* one line later; here every value is
 * parsed by `features/data/lib/ledger.ts` and a refusal is **named** beside its
 * field. The same is true of the numbers, which is why they are text inputs with
 * a decimal input mode: `<input type="number">` discards a decimal comma exactly
 * as silently, in a form whose French reader types one.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { Refusal } from '@/components/Refusal'
import { TextTabs } from '@/components/TextTabs'
import { TYPE_LABEL } from '@/features/data/components/LedgerTable'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import type { AccountsResponse } from '@/features/accounts/lib/api'
import {
  dataApi,
  EVENT_TYPES,
  type EventDraft,
  type LedgerEvent,
  type LedgerEventType,
} from '@/features/data/lib/api'
import { sharesApi } from '@/features/shares/lib/api'
import { useAccountNames } from '@/hooks/use-account-names'
import {
  accountChoice,
  declaredLabel,
  DEFAULT_ACCOUNT_LABEL,
  submittedAccount,
} from '@/features/accounts/lib/accounts'
import { currencyInput, useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import {
  accountOf,
  FIELDS,
  fold,
  isEditable,
  parseDay,
  parseDecimal,
  startsWithQuery,
  titlesFor,
  type Title,
} from '@/features/data/lib/ledger'
import { entryGone, problemSentence, refusedKey } from '@/lib/problem'
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
 * The fields in the order they are drawn, which is the order a refused submit
 * walks to find the one that takes the focus (#1268).
 */
const DISPLAY_ORDER = [
  'date',
  'account',
  'symbol',
  'quantity',
  'unitPrice',
  'amount',
  'fee',
] as const satisfies readonly FieldName[]

/**
 * The field a server refusal names (#1395), by its `key` — `unit_price` is the
 * one spelled differently — or `null` when it names none this form draws.
 */
function refusedField(error: unknown): FieldName | null {
  const key = refusedKey(error)
  const name = key === 'unit_price' ? 'unitPrice' : key
  return DISPLAY_ORDER.find((field) => field === name) ?? null
}

/** The sentence under Ticker for a free ticker nobody has confirmed (#1268). */
const UNKNOWN_SYMBOL = 'data.form.symbol.unknown' satisfies MessageKey

/** Yahoo answers once the reader pauses, and from two characters (#1268). */
const SEARCH_PAUSE_MS = 300
const SEARCH_MIN = 2
/** The server refuses a longer query; no ticker is longer. */
const SEARCH_MAX = 64
const SEARCH_STALE_MS = 5 * 60_000
/** The effect line asks once the reader pauses. */
const PREVIEW_PAUSE_MS = 300

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

/** Today in the reader's own calendar, as the date field writes it. */
function today(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

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

/**
 * A stored row, back in the fields it was typed in.
 *
 * **Nothing is rounded here, and that is the difference with the suggestion
 * below** (#1033). `unit_price` is a `DOUBLE` holding what somebody declared —
 * typed in this form, or read out of a mounted file, where a price at four
 * decimals is a price and not an artefact. A figure trimmed on open is a figure
 * the next save rewrites, without the reader having touched the field.
 */
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

interface EventFormProps {
  open: boolean
  /** The row being edited — `null` is a creation. */
  event: LedgerEvent | null
  /** What `/api/accounts` served. `undefined` — in flight, or failed. */
  accounts: AccountsResponse | undefined
  /** Whether that read **failed**, which is not the same absence (#729). */
  accountsFailed: boolean
  /**
   * Every title the ledger names, or `null` while the ledger has not answered
   * (#1036). It is the page's read, folded there: the events carry the symbol
   * and the name, so the suggestion costs no request of its own.
   */
  titles: readonly Title[] | null
  /** The ledger's reporting currency, `null` until the totals have answered. */
  currency: string | null
  onClose: () => void
  /** Hands the focus back to the row the panel was opened on, when it closes. */
  onRestoreFocus?: () => void
  /** Asks for the row being edited to be removed — the confirmation is the caller's (#1264). */
  onDelete: () => void
}

export function EventForm({
  open,
  event,
  accounts,
  accountsFailed,
  titles,
  currency,
  onClose,
  onRestoreFocus,
  onDelete,
}: EventFormProps) {
  const { t, language } = useI18n()
  const format = useFormatters()
  const queryClient = useQueryClient()

  // A creation opens on *Achat*, the event most ledgers are made of.
  const [type, setType] = useState<LedgerEventType>('BUY')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({})
  /** What the grant-price suggestion last put in the field — see below. */
  const offered = useRef('')
  /**
   * The panel itself, which the suggestion list is drawn **inside** (#1036):
   * a modal sheet cancels the wheel everywhere but its own content, so a list
   * portalled to the body would have a scrollbar answering no mouse.
   *
   * It is **state and not a ref**, because a ref read during render is `null`
   * on the render that mounts the panel and nothing re-renders when it fills.
   * A callback ref makes the fill a state change, which is the only version of
   * this that is correct rather than accidentally correct.
   */
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  /** The refusal the server last gave, which takes the focus when it lands (#1268). */
  const refusal = useRef<HTMLDivElement>(null)
  /** The Yahoo line the reader picked. Typing forgets it; "Use «typed»" is not one. */
  const [picked, setPicked] = useState<{ symbol: string; name: string | null } | null>(null)
  /** The free ticker the reader agreed to record with no known quote. */
  const [confirmed, setConfirmed] = useState<string | null>(null)
  /** What the field held when the reader last paused. */
  const [asked, setAsked] = useState('')
  /** The effect line's request as it stood when the reader last paused. */
  const [settled, setSettled] = useState<string | null>(null)

  // Opening on a row fills the form; opening on nothing empties it. Keyed on the
  // row's own id so reopening on another row does not inherit the last one.
  useEffect(() => {
    if (!open) return
    setErrors({})
    // The refusal of an earlier gesture is not about this row. Closing by the
    // cancel button resets it; the removal closes the panel from outside, so the
    // reset is also made here, where *every* way in passes.
    write.reset()
    setType(event?.event_type ?? 'BUY')
    setDraft(event === null ? { ...EMPTY, date: today() } : draftOf(event))
    setSettled(null)
    offered.current = ''
    setPicked(null)
    setConfirmed(null)
  }, [open, event])

  const write = useMutation({
    // A row is edited only where it has a key, which `isEditable` is the guard
    // for: the panel is never opened on an imported row.
    mutationFn: (body: EventDraft) =>
      event?.id ? dataApi.updateEvent(event.id, body) : dataApi.createEvent(body),
    onSuccess: () => {
      // An event moves every figure in the product — positions, totals, the
      // ledger itself — so the whole cache goes rather than a list of keys that
      // would drift from the pages reading them.
      void queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => {
      // The row being corrected left the ledger somewhere else (#785): the
      // panel stays open holding what was typed, and the one list that went
      // stale is re-read so the row it is about stops being displayed.
      if (entryGone(error)) void queryClient.invalidateQueries({ queryKey: ['events'] })
      // A value the server refused is marked on its field, like one this form
      // could not read (#1395).
      const field = refusedField(error)
      if (field !== null) setErrors({ [field]: 'data.form.refused' })
    },
  })

  // Keyed on the error object, so a second refusal with the same text focuses
  // again. The native `focus()` scrolls the panel to it and a screen reader
  // reads it (#1268).
  useEffect(() => {
    if (!write.error) return
    const field = refusedField(write.error)
    ;(field === null ? refusal.current : document.getElementById(`event-${field}`))?.focus()
  }, [write.error])

  /**
   * **Every way out of the panel, and there are three**: the cancel button, the
   * sheet's own close, and the write that succeeded. The refusal is forgotten
   * with the gesture that carried it — the panel is mounted once for all the
   * rows, so a sentence left standing is read as being about the next row
   * opened, and *this event is no longer in the ledger* over a row that is
   * perfectly alive is a precise untruth.
   */
  function close() {
    write.reset()
    onClose()
  }

  const fields = FIELDS[type]

  /**
   * **The grant's price is suggested, and never imposed** (#1007).
   *
   * An empty `unit_price` on a grant is a *declaration* — `_process_grant`
   * writes it into the cost basis, so a server filling it in would move the
   * real portfolio's contributions, its XIRR and its tax assiette, not just a
   * comparison's. But typing it blind is what took a whole account out of the
   * benchmark five years after the event was recorded. So the closest known
   * close arrives **in the field**, says which day it came from — a grant
   * dated a Friday nobody quoted is priced off the Thursday — and the first
   * keystroke owns it from there.
   *
   * `optional` is the grant and only the grant: a purchase's price is the
   * amount that left the account, which no close can stand in for.
   */
  const pricedDay = fields.unitPrice === 'optional' ? parseDay(draft.date.trim()) : null
  const pricedSymbol = draft.symbol.trim()
  const { data: suggestion } = useQuery({
    queryKey: ['price-at', pricedSymbol, pricedDay],
    queryFn: () => sharesApi.priceAt(pricedSymbol, pricedDay as string),
    enabled: pricedDay !== null && pricedSymbol !== '',
    // A close in the past is settled: nothing about it changes while a panel is
    // open, and a refetch would re-offer a suggestion the reader cleared.
    staleTime: Infinity,
    retry: false,
  })
  /**
   * Three states and not two, which is what keeps a figure from outliving its
   * question: `undefined` is *no answer yet* and touches nothing, `null` is
   * *answered, and there is nothing to suggest* — a symbol nobody scraped, a
   * day before the store's first point — and a string is the close. Folded
   * together, the second would leave the previous symbol's price sitting under
   * the new one's ticker.
   */
  const suggested =
    suggestion === undefined
      ? undefined
      : suggestion.price == null
        ? null
        : currencyInput(suggestion.price, suggestion.base_currency)
  // **The day is shown only while it is a claim about what is in the field.**
  // Over a figure the reader typed it would be a precise untruth.
  const suggesting = typeof suggested === 'string' && draft.unitPrice === suggested

  // Keyed on the suggestion rather than on the field being empty: a reader who
  // clears the field has answered the question, and an effect watching the
  // draft would walk the figure straight back in. What the suggestion itself
  // put there is its own to replace when the question changes; anything else in
  // the field belongs to the reader.
  useEffect(() => {
    if (suggested === undefined) return
    setDraft((previous) => {
      if (previous.unitPrice !== '' && previous.unitPrice !== offered.current) return previous
      offered.current = suggested ?? ''
      return { ...previous, unitPrice: offered.current }
    })
  }, [suggested])

  /**
   * **The suggestions, and the one sentence they cannot say** (#1036).
   *
   * Three states and not two, on the same rule as the price above: `null` is
   * *the ledger has not answered*, and it opens nothing and says nothing — a
   * list offering to record a new title would be claiming the portfolio holds
   * no such ticker, over a read that has not landed. An empty match on a ledger
   * that **has** answered is the normal case of this field, and it is the one
   * that offers what was typed.
   *
   * **And the `null` branch is reached, not merely guarded.** The bar carrying
   * *Saisir un événement* waits on `events.data`, but it is not the only door:
   * `?open=event` opens this panel on mount — armed by the ⌘K palette's own
   * action (`Palette.tsx`) and by the first-run card (`FirstRun.tsx`) — and
   * `Ledger.tsx` mounts the form outside the block that waits for the read. So
   * a reader who asks for the form from the palette while the ledger is still
   * in flight lands here with `titles === null`, and what the field owes them
   * is silence.
   */
  const typed = draft.symbol.trim()

  useEffect(() => {
    const pause = setTimeout(() => setAsked(typed), SEARCH_PAUSE_MS)
    return () => clearTimeout(pause)
  }, [typed])

  /**
   * **Yahoo's lines, after the ledger's** (#1268). The ledger read has to have
   * landed first: while `titles` is `null` the field says nothing, and a search
   * would be offering titles the ledger may already name.
   *
   * `securities` is a list, `[]` or `null` (Yahoo did not answer). `data` stays
   * `undefined` while the request is in flight, which is why the offline
   * sentence below cannot be said early.
   */
  const searching =
    open &&
    fields.security &&
    titles !== null &&
    typed.length >= SEARCH_MIN &&
    typed.length <= SEARCH_MAX &&
    asked.length >= SEARCH_MIN
  const { data: searched } = useQuery({
    queryKey: ['securities', asked],
    queryFn: () => dataApi.searchSecurities(asked),
    enabled: searching,
    staleTime: SEARCH_STALE_MS,
    retry: false,
  })
  const yahooAnswered = searching ? searched?.securities : undefined

  /**
   * The ticker the save will fold what was typed into.
   *
   * The writer stores every symbol in one spelling (#1068) — `mc.pa` lands on
   * the `MC.PA` the ledger already names, on both roads — so this sentence no
   * longer warns of a second position: it says, before the save, which line
   * the event joins. *Names*, and not *holds*: the perimeter keeps the titles
   * sold out of, and a dividend corrected on a closed line is an ordinary
   * gesture. A lookalike letter (a Cyrillic `С`) folds to nothing here and is
   * the server's refusal, on this field.
   */
  /**
   * The comparison is `fold` **plus compatibility**, and only here.
   *
   * `fold` is the ledger's search rule and stays what it is. A ticker is not
   * prose: pasted from a broker's page it carries fullwidth forms (`ＭＣ.ＰＡ`)
   * or a zero-width space, and the store folds both (`canonical_symbol`).
   * `NFKC` folds the first, the property escape drops the second, so the
   * sentence names the line the server will put the event on.
   */
  const near = (value: string) =>
    fold(value.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}]/gu, ''))
  const ledgerNames = (symbol: string) =>
    titles?.some((title) => near(title.symbol) === near(symbol)) ?? false
  const collision =
    typed === ''
      ? null
      : (titles?.find((title) => title.symbol !== typed && near(title.symbol) === near(typed))
          ?.symbol ?? null)

  const suggestions = titles === null ? [] : titlesFor(titles, draft.symbol)
  const yahooLines = (yahooAnswered ?? []).filter((line) => !ledgerNames(line.symbol))
  // "Use «typed»" is the line of last resort: it re-states what was typed and
  // never counts as a pick.
  const creating =
    titles !== null && typed !== '' && suggestions.length === 0 && yahooLines.length === 0
  const items: ComboboxItem[] = creating
    ? [{ value: typed, label: t('data.form.symbol.use', { typed }), hint: null }]
    : [
        ...suggestions.map((title) => ({
          value: title.symbol,
          label: title.symbol,
          hint: title.name,
          mono: true,
        })),
        ...yahooLines.map((line) => ({
          value: line.symbol,
          label: line.symbol,
          hint: [line.name, line.exchange].filter(Boolean).join(' · ') || null,
          mono: true,
        })),
      ]
  const offline = yahooAnswered === null

  /**
   * **A free ticker is confirmed, never refused** (#1268). A security with no
   * quote is a legitimate entry — unlisted ISINs exist in real ledgers — so the
   * submit stops once and asks. A ticker is *known* when the ledger names it or
   * the reader picked it from a Yahoo line: Yahoo knowing `SAN` does not mean
   * the reader meant Santander, so a lookup at submit would not catch it.
   *
   * While `titles` is `null` the gate does not fire, which keeps the #775
   * silence. That is a known ceiling: a free ticker typed while the ledger read
   * is still in flight is saved as before.
   */
  const free =
    fields.security &&
    typed !== '' &&
    titles !== null &&
    !ledgerNames(typed) &&
    picked?.symbol !== typed
  const gated = free && (errors.symbol === UNKNOWN_SYMBOL || confirmed === typed)
  const didYouMean =
    titles === null
      ? undefined
      : titlesFor(titles, typed).find((title) => startsWithQuery(typed, [title.symbol]))

  const choice = accountChoice(accounts, accountsFailed)
  // The two states nothing in this panel can repair: the declaration is not
  // there to be read, so the save is withheld and the field says why.
  const blocked = choice.kind === 'pending' || choice.kind === 'failed'

  // The currency's symbol, at the right edge of the money fields.
  const unit = (() => {
    if (currency === null) return ''
    try {
      return (
        new Intl.NumberFormat(language, { style: 'currency', currency })
          .formatToParts(0)
          .find((part) => part.type === 'currency')?.value ?? ''
      )
    } catch {
      return ''
    }
  })()

  /**
   * **The write, as far as it can be read** — the effect line's question. It is
   * the draft the save would send, or `null` while a figure the type needs is
   * missing or unreadable: the line then says nothing rather than guess. The
   * refusals are `submit()`'s to name; this only decides whether to ask.
   */
  const asking: (EventDraft & { id?: string }) | null = (() => {
    const day = parseDay(draft.date.trim())
    const submitted = submittedAccount(choice, draft.account)
    if (day === null || 'error' in submitted) return null
    const symbol = draft.symbol.trim()
    if (fields.security && symbol === '') return null
    const read = (value: string) => parseDecimal(value.trim())
    const quantity = fields.quantity ? read(draft.quantity) : null
    if (fields.quantity && (quantity === null || quantity <= 0)) return null
    const unitPrice = fields.unitPrice === 'none' ? null : read(draft.unitPrice)
    if (fields.unitPrice === 'required' && (unitPrice === null || unitPrice <= 0)) return null
    const amount = fields.amount ? read(draft.amount) : null
    if (fields.amount && (amount === null || amount <= 0)) return null
    const fee = fields.fee ? read(draft.fee) : null
    if (fee !== null && fee < 0) return null
    return {
      date: day,
      event_type: type,
      account: submitted.account,
      symbol: fields.security ? symbol : null,
      name: null,
      notes: null,
      quantity,
      unit_price: unitPrice,
      fee,
      amount,
      ...(event?.id ? { id: event.id } : {}),
    }
  })()
  const previewKey = asking === null ? null : JSON.stringify(asking)
  useEffect(() => {
    if (!open || previewKey === null) {
      setSettled(null)
      return
    }
    const pause = setTimeout(() => setSettled(previewKey), PREVIEW_PAUSE_MS)
    return () => clearTimeout(pause)
  }, [open, previewKey])
  const previewed = useQuery({
    queryKey: ['event-preview', settled],
    queryFn: () => {
      const { id, ...draft } = JSON.parse(settled as string) as EventDraft & { id?: string }
      return dataApi.previewEvent(draft, id)
    },
    enabled: open && settled !== null,
    retry: false,
    // The line holds its last words while the next ones are on their way.
    placeholderData: (previous) => (settled === null ? undefined : previous),
  })
  /** An account as the reader knows it: its libellé, the identifier only where it is edited. */
  const nameOf = useAccountNames()
  const effect =
    asking === null || previewed.data === undefined
      ? undefined
      : {
          // The server answers a magnitude and a direction; the line reads a sign.
          amount:
            previewed.data.direction === 'debit' ? -previewed.data.amount : previewed.data.amount,
          fees: previewed.data.fee,
          cashAfter: previewed.data.cash_after,
          account: nameOf(asking.account ?? ''),
          realised: previewed.data.realised_gain ?? null,
        }
  // **A refusal the server would give is said before « Enregistrer »**: a sale
  // of shares the account does not hold, a withdrawal larger than its cash. The
  // line holds the last answer while a new one is on its way, so it is the
  // error of *this* question that counts.
  const refused =
    asking !== null && previewed.isError && !previewed.isFetching ? previewed.error : null

  // **What can be said about the figures before the server is asked.** A value
  // that is not a number, or not above zero, is named under its field as it is
  // typed; a date that is odd is *warned about*, never refused, because an
  // owner may pre-record a movement and an account may be opened after the fact.
  const unreadable = (field: FieldName, allowZero = false): MessageKey | undefined => {
    const raw = draft[field].trim()
    if (raw === '') return undefined
    const parsed = parseDecimal(raw)
    if (parsed === null) return 'data.form.number.invalid'
    if (field === 'fee') return parsed < 0 ? 'data.form.fee.negative' : undefined
    return parsed < 0 || (parsed === 0 && !allowZero) ? 'data.form.number.positive' : undefined
  }
  const live: Partial<Record<FieldName, MessageKey>> = {
    ...(fields.quantity ? { quantity: unreadable('quantity') } : {}),
    ...(fields.unitPrice === 'none' ? {} : { unitPrice: unreadable('unitPrice') }),
    ...(fields.amount ? { amount: unreadable('amount') } : {}),
    ...(fields.fee ? { fee: unreadable('fee') } : {}),
  }
  const typedDay = parseDay(draft.date.trim())
  const accountOpened = accounts?.accounts.find(
    (account) =>
      account.id === (draft.account || (choice.kind === 'single' ? choice.account.id : '')),
  )?.opened_on
  const dateWarning: { key: MessageKey; values?: Record<string, string> } | null =
    typedDay === null
      ? null
      : typedDay > today()
        ? { key: 'data.form.date.future' }
        : accountOpened && typedDay < accountOpened
          ? {
              key: 'data.form.date.beforeOpening',
              values: { date: format.date(accountOpened) },
            }
          : null

  function set(field: FieldName, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  function submit() {
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

    // The blank travels as a blank: the server resolves it at the write, where
    // the file road resolves its own empty cell, so the two roads keep one rule
    // and this one cannot grow the phantom account the other refuses.
    const submitted = submittedAccount(choice, draft.account)
    if ('error' in submitted) found.account = submitted.error

    const symbol = draft.symbol.trim()
    if (fields.security && symbol === '') found.symbol = 'data.form.required'
    else if (free && confirmed !== symbol) found.symbol = UNKNOWN_SYMBOL

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
    const unitPrice = number(
      'unitPrice',
      fields.unitPrice === 'required',
      fields.unitPrice !== 'none',
    )
    const fee = number('fee', false, fields.fee)
    const amount = number('amount', true, fields.amount)

    // **The server's rules, said on the field before the round trip** (#1395):
    // the direction is the type's, never the sign, so these are above zero.
    function positive(field: FieldName, value: number | null) {
      if (value !== null && value <= 0) found[field] = 'data.form.number.positive'
    }
    positive('quantity', quantity)
    if (fields.unitPrice === 'required') positive('unitPrice', unitPrice)
    positive('amount', amount)
    if (fee !== null && fee < 0) found.fee = 'data.form.fee.negative'
    else if (type === 'DIVIDEND' && fee !== null && amount !== null && amount > 0 && fee > amount)
      found.fee = 'data.form.fee.overAmount'

    setErrors(found)
    if (Object.values(found).some(Boolean)) {
      // The first field that could not be read, in the order they are drawn.
      const first = DISPLAY_ORDER.find((name) => found[name])
      document.getElementById(`event-${first}`)?.focus()
      return
    }

    // The security's name: the picked Yahoo line's, else the edited row's own
    // while its ticker is unchanged (a save used to wipe it), else none.
    const name = !fields.security
      ? null
      : picked?.symbol === symbol
        ? picked.name
        : event?.symbol != null && near(event.symbol) === near(symbol)
          ? event.name
          : null

    write.mutate({
      date: day as string,
      event_type: type,
      account: 'account' in submitted ? submitted.account : '',
      symbol: fields.security ? symbol : null,
      name,
      notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      quantity,
      unit_price: unitPrice,
      fee,
      amount,
    })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) return
        close()
      }}
    >
      <SheetContent
        ref={setPanel}
        // The panel has no trigger to give the focus back to: the page says
        // which row it was opened on.
        onCloseAutoFocus={(closed) => {
          if (!onRestoreFocus) return
          closed.preventDefault()
          onRestoreFocus()
        }}
        // The subtitle is a plain dated line, not a description of the control.
        aria-describedby={undefined}
        showCloseButton={false}
        className="w-full gap-0 shadow-none sm:max-w-115"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            submit()
          }}
        >
          <header className="flex items-start justify-between gap-3 px-6 pt-5">
            <div>
              <SheetTitle className="text-2xl leading-7">
                {t(event === null ? 'data.form.create.title' : 'data.form.edit.title')}
              </SheetTitle>
              {event === null ? null : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t('data.form.edit.subtitle', {
                    type: t(TYPE_LABEL[event.event_type]),
                    date: format.date(event.date),
                    account: nameOf(accountOf(event)),
                  })}
                </p>
              )}
            </div>
            <SheetClose
              aria-label={t('sheet.close')}
              className="-mt-1.5 -mr-1.5 rounded-md p-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <X aria-hidden className="size-4" />
            </SheetClose>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-5 pb-6">
            {/* The type: text tabs, as the chart's readings are. */}
            <TextTabs
              size="sheet"
              label={t('data.form.type')}
              tabs={EVENT_TYPES.map((candidate) => ({
                value: candidate,
                label: t(TYPE_LABEL[candidate]),
              }))}
              value={type}
              onChange={setType}
              className="flex-wrap"
            />

            <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
              <Field name="date" label="data.form.date" error={errors.date} warning={dateWarning}>
                {(id, described) => (
                  <Input
                    id={id}
                    type="date"
                    className="fig md:text-md"
                    value={draft.date}
                    aria-invalid={errors.date !== undefined}
                    aria-describedby={described}
                    onChange={(changed) => set('date', changed.target.value)}
                  />
                )}
              </Field>

              {/* **Four renderings and not one control**, because the four are four
              different repairs and exactly one of them is the reader's (#729,
              #764's deferral):

              - a single declared account answers itself, and a select of one
                entry is a question whose answer is known — the field is not
                shown and `submit()` fills it in;
              - **nothing declared at all** is #698's rule, not a missing
                answer: the event lands on the seeded row, the panel says which
                one, and the save goes through.
              - the read **in flight** and the read **failed** say nothing about
                a declaration either way, so neither is allowed to claim the
                first state; the field names what is going on and withholds the
                save with that same sentence — never with *this kind of event
                needs this field*, which sends the reader looking for a control
                that is empty for reasons of its own. */}
              {choice.kind === 'single' ? null : choice.kind === 'choose' ? (
                <Field name="account" label="data.form.account" error={errors.account}>
                  {(id, described) => (
                    <select
                      id={id}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-md shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                      value={draft.account}
                      aria-invalid={errors.account !== undefined}
                      aria-describedby={described}
                      onChange={(changed) => set('account', changed.target.value)}
                    >
                      <option value="">{t('data.form.account.choose')}</option>
                      {/* The seeded row is in this list whenever an event names
                          it, so the same rule as the declaration table applies:
                          `Default account` is the server's English and is never
                          rendered, and the two surfaces have to name
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
                  <p className="label">{t('data.form.account')}</p>
                  {choice.kind === 'unassigned' ? (
                    /* The **same rule as the `choose` branch above**, and it has
                       to be: the declaration table names the row from the store,
                       so naming it from the catalogue here would print two names
                       for one account. */
                    <p className="text-md">
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
                <Field
                  name="symbol"
                  label="data.form.symbol"
                  error={errors.symbol}
                  full
                  below={
                    gated ? (
                      <div className="space-y-2">
                        {errors.symbol === UNKNOWN_SYMBOL && didYouMean ? (
                          <p className="text-sm">
                            <Button
                              type="button"
                              variant="link"
                              className="h-auto p-0"
                              onClick={() => {
                                set('symbol', didYouMean.symbol)
                                setPicked(null)
                                setConfirmed(null)
                                document.getElementById('event-symbol')?.focus()
                              }}
                            >
                              {t('data.form.symbol.didYouMean', { symbol: didYouMean.symbol })}
                            </Button>{' '}
                            {didYouMean.name === null ? null : (
                              <bdi className="text-muted-foreground">{didYouMean.name}</bdi>
                            )}
                          </p>
                        ) : null}
                        <label className="flex min-h-8 items-center gap-2 text-sm pointer-coarse:min-h-11">
                          <Checkbox
                            checked={confirmed === typed}
                            onCheckedChange={(on) => {
                              setConfirmed(on === true ? typed : null)
                              setErrors((previous) => ({
                                ...previous,
                                symbol: on === true ? undefined : UNKNOWN_SYMBOL,
                              }))
                            }}
                          />
                          {t('data.form.symbol.confirm', { symbol: typed })}
                        </label>
                      </div>
                    ) : undefined
                  }
                >
                  {(id, described) => (
                    <>
                      <Combobox
                        id={id}
                        value={draft.symbol}
                        items={items}
                        // Drawn inside the panel and not on the body: the modal
                        // sheet cancels the wheel everywhere else (#1036).
                        container={panel}
                        listLabel={t('data.form.symbol.suggestions')}
                        aria-invalid={errors.symbol !== undefined}
                        aria-describedby={
                          [
                            described,
                            collision === null ? null : `${id}-collision`,
                            offline ? `${id}-offline` : null,
                          ]
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                        onValueChange={(next, chosen) => {
                          set('symbol', next)
                          setConfirmed(null)
                          const line = chosen
                            ? yahooLines.find((candidate) => candidate.symbol === next)
                            : undefined
                          setPicked(line ? { symbol: line.symbol, name: line.name } : null)
                        }}
                      />
                      {offline ? (
                        <p id={`${id}-offline`} className="text-xs text-muted-foreground">
                          {t('data.form.symbol.offline')}
                        </p>
                      ) : null}
                      {collision === null ? null : (
                        <p id={`${id}-collision`} className="text-xs text-muted-foreground">
                          {t('data.form.symbol.collision', { symbol: collision })}
                        </p>
                      )}
                    </>
                  )}
                </Field>
              ) : null}

              {fields.quantity ? (
                <Field
                  name="quantity"
                  label="data.form.quantity"
                  error={errors.quantity ?? live.quantity}
                >
                  {(id, described) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      className="fig md:text-md"
                      value={draft.quantity}
                      aria-invalid={(errors.quantity ?? live.quantity) !== undefined}
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
                  error={errors.unitPrice ?? live.unitPrice}
                  optional={fields.unitPrice === 'optional'}
                >
                  {(id, described) => (
                    <>
                      <Money
                        id={id}
                        unit={unit}
                        value={draft.unitPrice}
                        invalid={(errors.unitPrice ?? live.unitPrice) !== undefined}
                        // The source is bound to the field rather than left
                        // floating beside it: a figure that arrived on its own
                        // has to say so to the reader who cannot see it appear.
                        describedBy={
                          [described, suggesting ? `${id}-source` : null]
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                        onChange={(next) => set('unitPrice', next)}
                      />
                      {suggesting ? (
                        <p id={`${id}-source`} className="text-xs text-muted-foreground">
                          {t('data.form.grantPrice.suggested', {
                            day: format.date(suggestion?.day),
                          })}
                        </p>
                      ) : null}
                    </>
                  )}
                </Field>
              )}

              {fields.amount ? (
                <Field name="amount" label="data.form.amount" error={errors.amount ?? live.amount}>
                  {(id, described) => (
                    <Money
                      id={id}
                      unit={unit}
                      value={draft.amount}
                      invalid={(errors.amount ?? live.amount) !== undefined}
                      describedBy={described}
                      onChange={(next) => set('amount', next)}
                    />
                  )}
                </Field>
              ) : null}

              {fields.fee ? (
                <Field name="fee" label="data.form.fee" error={errors.fee ?? live.fee}>
                  {(id, described) => (
                    <Money
                      id={id}
                      unit={unit}
                      value={draft.fee}
                      invalid={(errors.fee ?? live.fee) !== undefined}
                      describedBy={described}
                      onChange={(next) => set('fee', next)}
                    />
                  )}
                </Field>
              ) : null}

              {/* The label, and it is not decoration: on a cash movement it is
                  the whole identity the ledger will show. */}
              <Field name="notes" label="data.form.notes" error={errors.notes} optional full>
                {(id, described) => (
                  <Input
                    id={id}
                    className="md:text-md"
                    value={draft.notes}
                    aria-describedby={described}
                    onChange={(changed) => set('notes', changed.target.value)}
                  />
                )}
              </Field>
            </div>

            {write.error && refusedField(write.error) === null ? (
              <Refusal ref={refusal}>{problemSentence(t, write.error)}</Refusal>
            ) : null}

            {/* **The effect line**, the one sentence the sheet says about what
                will happen (DESIGN.md › Content): what the write does to the
                account's cash, as the server computed it. Nothing is said while
                the server has not answered, and it is not announced: it moves
                with every figure typed (#1461). */}
            {refused !== null ? (
              <p className="text-sm text-destructive">{problemSentence(t, refused)}</p>
            ) : effect === undefined ? null : (
              <p className="text-sm text-muted-foreground">
                {type === 'GRANT' && asking?.quantity != null ? (
                  <>
                    <span className="fig text-foreground">
                      {t('event.effect.grant', {
                        quantity: asking.quantity,
                        symbol: asking.symbol ?? '',
                        account: effect.account,
                      })}
                    </span>
                    {' · '}
                  </>
                ) : null}
                {Math.abs(effect.amount) < 0.005 ? null : (
                  <>
                    <span className="fig text-foreground">
                      {format.currency(Math.abs(effect.amount), currency)}
                    </span>{' '}
                    {t(effect.amount > 0 ? 'event.effect.in' : 'event.effect.out', {
                      account: effect.account,
                    })}
                    {effect.fees > 0 ? (
                      <>
                        {', '}
                        {t('event.effect.fees.before')}{' '}
                        <span className="fig text-foreground">
                          {format.currency(effect.fees, currency)}
                        </span>{' '}
                        {t('event.effect.fees.after')}
                      </>
                    ) : null}
                    {' · '}
                  </>
                )}
                {effect.realised === null || Math.abs(effect.realised) < 0.005 ? null : (
                  <>
                    {t(effect.realised < 0 ? 'event.effect.loss' : 'event.effect.gain')}{' '}
                    <span className="fig text-foreground">
                      {format.currency(Math.abs(effect.realised), currency)}
                    </span>
                    {' · '}
                  </>
                )}
                {t('event.effect.cash')}{' '}
                <span className="fig text-foreground">
                  {format.currency(effect.cashAfter, currency)}
                </span>
              </p>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t px-6 py-4">
            {/* The row's removal lives here and not in the table (#1264): a
                button on all 285 rows said the same thing 285 times. */}
            {event !== null && isEditable(event) ? (
              <button
                type="button"
                className="mr-auto text-md text-destructive underline decoration-border underline-offset-3 outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={onDelete}
              >
                {t('data.row.delete')}
              </button>
            ) : null}
            <Button type="button" size="sheet" onClick={close}>
              {t('data.form.cancel')}
            </Button>
            {/* Withheld rather than offered and refused — the same rule the
                accounts block applies to a removal it knows will fail. Neither
                of the two states is repairable from inside this panel, and a
                save that did nothing and said nothing is the failure this
                ticket inherited (#764). */}
            <Button
              variant="primary"
              size="sheet"
              type="submit"
              disabled={write.isPending || blocked}
            >
              {t('data.form.submit')}
            </Button>
          </footer>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** A money field: the figure in `.fig`, the currency's symbol at its right edge. */
function Money({
  id,
  unit,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string
  unit: string
  value: string
  invalid: boolean
  describedBy: string | undefined
  onChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        className="fig pr-8 md:text-md"
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(changed) => onChange(changed.target.value)}
      />
      {unit === '' ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
        >
          {unit}
        </span>
      )}
    </div>
  )
}

/**
 * One field, its label, its optional marker and — when it has one — the
 * sentence that says what was not understood. The refusal is bound to the input
 * with `aria-describedby` rather than left floating, so it is read where it
 * applies rather than announced once at the top of a form.
 */
function Field({
  name,
  label,
  error,
  optional,
  full,
  below,
  warning,
  children,
}: {
  name: FieldName
  label: MessageKey
  error?: MessageKey
  /** Said under the field, and never a reason to refuse it. */
  warning?: { key: MessageKey; values?: Record<string, string> } | null
  optional?: boolean
  /** Takes the whole row of the two-column grid. */
  full?: boolean
  /** What goes under the sentence — the controls that repair it. */
  below?: ReactNode
  children: (id: string, describedBy: string | undefined) => ReactNode
}) {
  const { t } = useI18n()
  const id = `event-${name}`
  const errorId = `${id}-error`

  return (
    <div className={cn('flex flex-col gap-1.5', full && 'col-span-2')}>
      <div className="label flex items-baseline whitespace-pre">
        <label htmlFor={id}>{t(label)}</label>
        {optional ? <span className="font-normal">{` · ${t('data.form.optional')}`}</span> : null}
      </div>
      {children(id, error ? errorId : warning ? `${id}-warning` : undefined)}
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {t(error)}
        </p>
      ) : warning ? (
        <p id={`${id}-warning`} className="text-sm text-attention">
          {t(warning.key, warning.values)}
        </p>
      ) : null}
      {below}
    </div>
  )
}
