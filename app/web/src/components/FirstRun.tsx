/**
 * The first run — **one question, three passages, and it opens on a predicate**
 * (#726, #823, ADR-0021, ADR-0035, ADR-0005, ADR-0015).
 *
 * It is mounted by the shell rather than by a route, because *first run* is not
 * a place: the predicate is `lib/firstRun.ts`'s, a **required** dial being
 * unanswered, and it is as true on `/shares` as on `/`. No launch counter, no
 * redirection, and `/` stays the dashboard unconditionally.
 *
 * **What it walks** (ADR-0035): the required settings, the accounts, the first
 * events — in that order, the last one opening by either of two doors. What it
 * asks is still **one thing**, and the two passages after the question ask for
 * nothing at all: a bare `docker run` is a trial run by design, and a screen
 * that will not release somebody without a CSV in hand turns the trial into a
 * wall. *Mandatory* here means **traversed, never answered**.
 *
 * **The drawing was read again** (`docs/design-revamp-v2-onboarding.html`), and
 * what it decided that this screen did not do is four things:
 *
 *  - **the walk is drawn, not merely counted.** `Passage 2 sur 3` states the
 *    fact and states it only to whoever reads that one line; the rail states it
 *    as a shape — three marks on one rule, each one filling as it is crossed —
 *    so a reader who opens the modal knows before reading a word how long this
 *    is and where they are in it. Numbered markers are the one structural device
 *    that has to earn itself, and here they do: the passages **are** a sequence,
 *    walked in order, and the order is what the reader needs. The sentence stays
 *    underneath as the eyebrow, because a shape is not something a screen reader
 *    can be given (`aria-current` says *which*, the eyebrow says *how far*);
 *  - **the way out is spelt** — `Échap pour fermer`, beside the control that
 *    walks on, and on the first passage alone. The three ways out were always
 *    there and none of them was written down: a reader looking for a *Later*
 *    button found the cross only by not finding anything else;
 *  - **the body holds one height.** Three passages of three different lengths
 *    made the footer jump under the cursor between one `Continuer` and the next;
 *  - **the accounts passage offers what it was only naming.** It comes second so
 *    the notion exists *before* a file naming accounts is handed over — and a
 *    reader who already knows how their holdings are split had, until here, to
 *    take that knowledge to another page and come back. The offer is an offer:
 *    the button opens a form, and the passage is satisfied without it.
 *
 * Six things about it are decisions:
 *
 *  - **It closes without a button.** The cross, `Escape` and the click outside
 *    *are* the *later*. A `Later` button beside `Save` would give the way out
 *    the same visual weight as the answer, and the answer is the one thing this
 *    surface exists for. That is also why the control that walks the passages
 *    carries no colour and the answer does: continuing is the walk, never a
 *    second spelling of the escape hatch, and on the one passage that carries an
 *    answer it must not weigh what the answer weighs. It is `secondary` and not
 *    `ghost` since the drawing was read: a ghost control at the one corner every
 *    reader is looking for reads as nothing at all, and *quieter than the
 *    answer* is what the argument asks for — not *invisible*. Closing leaves an
 *    app that **works**: the scrape runs and stores the quote in its own
 *    currency, and the ledger is writable — what waits is the conversion and the
 *    performance series, which the notifications panel's pinned card and each
 *    valued page's empty state then say (#829, ADR-0037).
 *  - **Three sentences on what the app *is*, and no rule of calculation.**
 *    Explaining the weighted average cost here is exactly what ADR-0016 gives
 *    the convention bubble for: a rule is read beside the figure it governs, not
 *    in a modal read once before any figure exists. They are the frame of the
 *    whole walk and not of its first passage, so they stay put while the body
 *    underneath changes. The third one is about **the walk** rather than about
 *    the currency: the currency is now said where it is asked, one block down,
 *    and what a reader needs at the top is how long this is and that it releases
 *    them.
 *  - **The ephemeral-store warning is here**, and it is the only surface *every*
 *    trial user meets: the installation tab is two clicks down, and the boot
 *    lines are at a terminal nobody watching a browser is reading. It does not
 *    leave the tab either — the ceiling loses nothing (#724).
 *  - **The accounts passage demands nothing.** It is satisfied by the seeded row
 *    every install owns — a declaration the owner may decline to add to — and
 *    its whole job is that the notion exists *before* a file naming accounts is
 *    handed over. It reads them to name them, and while that read is in flight
 *    it says nothing at all about them (ADR-0026): neither the rows, nor the
 *    offer to add one, a form opening onto a list nobody can see being a way of
 *    asking for a name against nothing.
 *  - **The last passage is the ledger's own pair of entrances**, the same
 *    component at equal weight and with no primary action (`EntryPair`), and it
 *    is named for the **events** rather than for the import: naming it *first
 *    import* would tell a reader with no file that they cannot come in, and
 *    ADR-0005 decided the opposite when it removed manual mode — typing a
 *    position *is* creating dated events. Each door is a way through: taking one
 *    ends the walk and lands the reader where that gesture is made. The marker
 *    that says *this reader has recorded nothing* stays with the ledger's mount
 *    and not with this one: here the pair states no emptiness, it offers two
 *    doors.
 *  - **The memory of the traversal is the browser's alone.** The predicate stays
 *    derived server-side and reads no data this screen is about to collect, so a
 *    second browser sees the walk again and an emptied ledger reopens nothing.
 *    What `localStorage` holds is *been through, and this is what was still
 *    unanswered when I left* — the second half being what makes a **wiped
 *    volume ask again** in the browser that answered, rather than only in some
 *    other one. No `onboarding_done` row anywhere.
 */
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, CreditCard, Plus, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { EntryPair } from '@/components/EntryPair'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, type AccountDraft, type ConfigResponse } from '@/lib/api'
import {
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  declaredLabel,
  declaredType,
} from '@/lib/accounts'
import { suggestedCurrency } from '@/lib/currencies'
import {
  CURRENCY_KEY,
  PASSAGES,
  currencyFixed,
  firstRunStands,
  nextPassage,
  passageNumber,
  previousPassage,
  readFirstRunMark,
  rememberFirstRunWalked,
  requiredUnanswered,
  type FirstRunMark,
  type Passage,
} from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'
import { cn } from '@/lib/utils'

const FIELD_ID = 'first-run-currency'

/**
 * What each passage is called **on the rail**, which is not what its heading
 * says: a heading has the width of the modal and a mark on a rail has a third
 * of it, so `Votre devise de base` is `Devise` there. One noun each, and the
 * three of them name the three nouns of the product.
 */
const RAIL: Record<Passage, MessageKey> = {
  settings: 'firstRun.rail.settings',
  accounts: 'firstRun.rail.accounts',
  events: 'firstRun.rail.events',
}

export function FirstRun() {
  const { t } = useI18n()
  const client = useQueryClient()
  const [mark, setMark] = useState<FirstRunMark | null>(() => readFirstRunMark())
  const [passage, setPassage] = useState<Passage>(PASSAGES[0])

  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const stands = firstRunStands({ settings: config.data?.settings, mark })

  // **The walk is latched, and it has to be.** The predicate is what *arms* the
  // modal; it is not what keeps it open, because answering the question makes it
  // false — and the answer is the first passage, not the last. Without the latch
  // the two passages after it would be unreachable to anybody who answers.
  const [walking, setWalking] = useState(false)
  const open = stands || walking

  // The two reads are **armed by the walk**, so an install that has answered the
  // question pays for neither on any page. The runtime is the shell's own read
  // under the same key — the shell asks for it on every route —
  // so arming it here costs nothing and takes nothing away; the accounts are
  // read from the top of the walk rather than on arrival at their own passage,
  // which is what makes them there to be named when the reader gets to them.
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime, enabled: open })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled: open })

  // A suggestion, never a default: the field opens on it, the question is still
  // unanswered, and what it buys is one click instead of a scroll. The
  // reservation is `lib/currencies.ts`'s and it is real — a locale gives the
  // currency of a country, not of a portfolio.
  const suggestion = suggestedCurrency(navigator.languages)
  const [choice, setChoice] = useState<string>(() => suggestion ?? '')

  /**
   * Leave, however: the cross, `Escape`, a door taken, or the last passage.
   *
   * What is written is the walk **and the state of the question when it ended**
   * — only a positive observation of *answered* writes that half, so a config
   * read that is not in hand leaves the reader alone rather than re-arming the
   * modal on their next page load.
   */
  const leave = () => {
    const left: FirstRunMark =
      requiredUnanswered(config.data?.settings) === false ? 'answered' : 'unanswered'
    rememberFirstRunWalked(left)
    setMark(left)
    setWalking(false)
    // The walk is rewound as it is left, so a re-arming inside the same mount
    // reopens it on its first passage rather than on ‘Terminer’.
    setPassage(PASSAGES[0])
  }

  /** The next passage, or the end of the walk — one control, two meanings. */
  const forward = () => {
    const next = nextPassage(passage)
    if (next === null) leave()
    else setPassage(next)
  }

  const save = useMutation({
    mutationFn: (currency: string) => api.saveSettings({ [CURRENCY_KEY]: currency }),
    onSuccess: (answer, currency) => {
      const { message, values } = receiptMessage({ kind: 'currency.saved', currency })
      toast.success(t(message, values))
      // Written into the cache here so what the rest of the app draws changes at
      // once rather than one round trip late. It no longer closes anything: the
      // answer is the **first** passage, and what follows it is the walk.
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous ? { ...previous, settings: answer.settings } : previous,
      )
      client.invalidateQueries({ queryKey: ['config'] })
      // Answering is retroactive (#704): every stored quote becomes
      // convertible, so the figures the rest of the app draws change.
      client.invalidateQueries({ queryKey: ['positions'] })
      client.invalidateQueries({ queryKey: ['portfolio-totals'] })
      forward()
    },
  })

  const back = previousPassage(passage)

  if (stands && !walking) setWalking(true)
  if (!walking) return null

  const ephemeral = runtime.data?.store.persistence === 'ephemeral'
  const last = nextPassage(passage) === null

  return (
    <Dialog open onOpenChange={(shown) => (shown ? undefined : leave())}>
      <DialogContent
        aria-labelledby="first-run-title"
        aria-describedby="first-run-what"
        className="gap-5 sm:max-w-xl"
      >
        <DialogHeader className="gap-2.5 pr-8">
          <DialogTitle id="first-run-title" className="text-xl tracking-tight">
            {t('firstRun.title')}
          </DialogTitle>
          {/* Three sentences on what the app *is*, and not one rule of
              calculation: the rules are read beside the figures they govern. */}
          <DialogDescription id="first-run-what" className="space-y-1 leading-relaxed text-pretty">
            <span className="block">{t('firstRun.what.ledger')}</span>
            <span className="block">{t('firstRun.what.quotes')}</span>
            <span className="block">{t('firstRun.what.walk')}</span>
          </DialogDescription>
        </DialogHeader>

        {ephemeral ? (
          <p className="flex gap-2.5 rounded-lg border border-attention/40 bg-attention/10 p-3 text-sm leading-relaxed text-attention text-pretty">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('firstRun.ephemeral')}</span>
          </p>
        ) : null}

        <PassageRail current={passage} />

        {/* **One height for three passages.** The rail is above and the footer
            below, and both of them moved under the cursor when the body was as
            tall as whichever passage happened to be showing. */}
        <div className="min-h-56 space-y-3">
          <p className="eyebrow font-mono">
            {t('firstRun.step', { step: passageNumber(passage), total: PASSAGES.length })}
          </p>

          {/* Passage one — the one question, and a reader who may walk past it. */}
          {passage === 'settings' ? (
            <>
              <h3 className="text-lg font-semibold tracking-tight">
                {t('firstRun.pass.settings.title')}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                {t('firstRun.pass.settings.body')}
              </p>
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (choice) save.mutate(choice)
                }}
              >
                <label htmlFor={FIELD_ID} className="block text-xs font-semibold">
                  {t('settings.base_currency')}
                </label>
                {/* **The question is one row**: the field and the gesture that
                    answers it, side by side. Stacked, the button sat under two
                    lines of reservation and read as belonging to them. */}
                <div className="flex flex-wrap items-start gap-2.5">
                  <div className="min-w-50 flex-1">
                    <CurrencyField
                      id={FIELD_ID}
                      value={choice}
                      onChange={(value) => {
                        // A refusal is about the value that was sent. Left
                        // standing, it reads as this app having refused the code
                        // just picked.
                        if (save.isError) save.reset()
                        setChoice(value)
                      }}
                      // The dial's rule, read off the dial. Here it settles
                      // itself — the modal only stands on an unanswered one —
                      // and it is passed rather than assumed, so the field
                      // states one rule on both of its mounts.
                      fixed={currencyFixed(config.data?.settings)}
                      // The note is about **this value**: a reader who overrode
                      // the suggestion is no longer reading a pre-filled field,
                      // and the reservation would then be about a code the
                      // browser never named.
                      suggested={suggestion !== null && choice === suggestion}
                    />
                  </div>
                  {currencyFixed(config.data?.settings) === true ? null : (
                    <Button type="submit" disabled={!choice || save.isPending}>
                      {t('firstRun.save')}
                    </Button>
                  )}
                </div>
                {save.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {t('firstRun.refused')}
                  </p>
                ) : null}
              </form>
            </>
          ) : null}

          {/* Passage two — **satisfied by the seeded row**, and demanding
              nothing. The list is the install's own accounts, named through
              `declaredLabel` so the seeded one reads its catalogue entry rather
              than the words the schema wrote for whoever opens the file, and
              carrying on its right the identifier **events actually name** —
              which is the whole reason this passage comes before the file.
              Nothing at all is rendered about them while the read is in flight:
              *this is what you own* is a claim about the reader's own
              installation, and a read that has not landed is not an absence
              (ADR-0026). */}
          {passage === 'accounts' ? (
            <>
              <h3 className="text-lg font-semibold tracking-tight">
                {t('firstRun.pass.accounts.title')}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                {t('firstRun.pass.accounts.body')}
              </p>
              {accounts.data ? (
                <div className="space-y-3">
                  <div className="rounded-xl border bg-muted/30 px-4 py-3.5">
                    <p className="text-xs font-semibold">{t('firstRun.pass.accounts.yours')}</p>
                    <ul className="mt-2.5 space-y-1.5">
                      {accounts.data.accounts.map((account) => (
                        <li
                          key={account.id}
                          className="flex items-center gap-2.5 text-sm text-muted-foreground"
                        >
                          <CreditCard aria-hidden className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL)}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-2xs">
                            {account.id} · {declaredType(account) ?? t(DEFAULT_ACCOUNT_TYPE)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <DeclareAccount />
                </div>
              ) : null}
            </>
          ) : null}

          {/* Passage three — the two doors, at equal weight and with no primary
              action. Both are **available on every install** (ADR-0032): a file
              is handed to the app by a gesture, so there is no mount left whose
              absence could take an entrance away, and the sentence names no
              folder there being none left to name. Taking either one ends the
              walk and lands the reader where that gesture is made — the upload
              zone for the file, the create form for the event
              (`?open=event`, the gesture the palette already arms).
              Taking neither ends it too, one control down. */}
          {passage === 'events' ? (
            <>
              <h3 className="text-lg font-semibold tracking-tight">
                {t('firstRun.pass.events.title')}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                {t('firstRun.pass.events.body')}
              </p>
              <EntryPair
                entries={[
                  {
                    title: t('data.empty.file.title'),
                    body: t('data.empty.file.body'),
                    action: (
                      <Button asChild type="button" variant="outline">
                        <Link to="/ledger" onClick={leave}>
                          {t('firstRun.pass.events.file')}
                        </Link>
                      </Button>
                    ),
                  },
                  {
                    title: t('data.empty.manual.title'),
                    body: t('data.empty.manual.body'),
                    action: (
                      <Button asChild type="button" variant="outline">
                        <Link to="/ledger" search={{ open: 'event' }} onClick={leave}>
                          {t('data.new')}
                        </Link>
                      </Button>
                    ),
                  },
                ]}
              />
            </>
          ) : null}
        </div>

        {/* The walk itself, and never the answer: quieter than the filled
            answer on the one passage that carries one, and never a second
            spelling of the escape hatch (ADR-0021's argument, one control
            over). The way out is **written** beside it, on the passage where a
            reader is still deciding whether to be here at all. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3.5">
          {back === null ? (
            <span />
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setPassage(back)}
            >
              {t('firstRun.back')}
            </Button>
          )}
          <div className="flex items-center gap-2.5">
            {back === null ? (
              <span className="text-xs text-muted-foreground">{t('firstRun.escape')}</span>
            ) : null}
            <Button type="button" variant="secondary" onClick={forward}>
              {last ? t('firstRun.finish') : t('firstRun.next')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * **The walk, drawn.** Three marks on one rule, joined by segments that fill as
 * they are crossed — the modal's one piece of ornament, and it is ornament that
 * carries a fact: how long this is, and where the reader is inside it.
 *
 * It is the one place a numbered marker is *earned*. `01 / 02 / 03` down a page
 * of unordered cards is decoration; here the passages are a sequence, walked in
 * order, and the number is the reader's position in it. A crossed mark drops its
 * number for a tick, because at that point *which one it was* has stopped being
 * the news and *it is behind you* has started.
 *
 * **It is not the accessible statement of the same thing, and does not try to
 * be.** A rule filling with colour is not something a screen reader can be
 * handed: `aria-current="step"` says which passage is standing, the tick's own
 * word says which are behind, and the eyebrow under the rail — `Passage 2 sur
 * 3` — says the whole of it in one sentence. The segments are hidden outright.
 *
 * It lives here rather than in `components/` because nothing else mounts it:
 * it is the walk's own furniture, exactly as `Field` below is the declaration's.
 */
function PassageRail({ current }: { current: Passage }) {
  const { t } = useI18n()
  const here = PASSAGES.indexOf(current)

  return (
    <nav aria-label={t('firstRun.rail')} className="flex items-center border-y py-3.5">
      {PASSAGES.map((passage, index) => {
        const walked = index < here
        const standing = index === here

        return (
          <div
            key={passage}
            aria-current={standing ? 'step' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5"
          >
            <span
              className={cn(
                'inline-flex size-5.5 shrink-0 items-center justify-center rounded-full border font-mono text-2xs font-semibold',
                walked && 'border-primary bg-primary text-primary-foreground',
                standing && 'border-primary/60 bg-primary/15 text-foreground',
                !walked && !standing && 'border-border text-muted-foreground',
              )}
            >
              {walked ? (
                <>
                  <Check aria-hidden className="size-3" strokeWidth={3} />
                  <span className="sr-only">{t('firstRun.rail.walked')}</span>
                </>
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                'min-w-0 truncate text-xs',
                // The three states are told apart by the **mark**, never by
                // fading the word: an opacity invented for the dark ground put
                // the two passages ahead at 2,2:1 on the light one.
                standing ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(RAIL[passage])}
            </span>
            {index < PASSAGES.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  'h-px min-w-2.5 flex-1',
                  walked ? 'bg-primary/45' : 'bg-border',
                )}
              />
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}

/**
 * **Declaring an account from inside the walk** — an offer, and never a demand.
 *
 * The passage exists so the notion of an account is there *before* a file naming
 * accounts is handed over, and until the drawing was read it stopped at naming
 * them: a reader who already knew their holdings were split across a PEA and a
 * brokerage account had to leave the walk, find the accounts page, declare, and
 * come back. The button repairs that and nothing more — it is closed by default,
 * the passage is satisfied without it, and `Continuer` never waits on it.
 *
 * **It is not `AccountForm`, and the difference is the reason.** That panel is
 * the accounts page's, and two of the three things it carries have no referent
 * here: a removal, of a row that does not exist yet, and #725's reassignment
 * offer — a box that says *move the N events naming no account onto this one*,
 * whose N comes off the ledger. This walk does not read the ledger, deliberately
 * (`lib/firstRun.ts`: nothing about the modal is derived from the data it is
 * about to collect), so the count is not in hand and ADR-0026 forbids stating
 * it. What is left of that panel once both are gone is these three fields, and
 * they are the store's own: the identifier events name, the type, the name. The
 * catalogue is shared with it down to the key, so the two forms cannot drift
 * into saying two different things about one rule.
 *
 * The label falls back to the identifier, which is `accounts.create_account`'s
 * own rule for a file's empty cell — one rule for the two roads in.
 */
function DeclareAccount() {
  const { t } = useI18n()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ id: '', type: '', label: '' })
  const [errors, setErrors] = useState<Partial<Record<'id' | 'type', MessageKey>>>({})

  const write = useMutation({
    mutationFn: (body: AccountDraft) => api.createAccount(body),
    onSuccess: () => {
      // A declaration moves what an event file is allowed to say and what every
      // page groups by, so the whole cache goes rather than a list of keys that
      // would drift from the pages reading them — `AccountForm`'s rule, for the
      // same reason.
      void client.invalidateQueries()
      close()
    },
  })

  function close() {
    setOpen(false)
    setDraft({ id: '', type: '', label: '' })
    setErrors({})
    write.reset()
  }

  function set(field: 'id' | 'type' | 'label', value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  function submit() {
    const id = draft.id.trim()
    const type = draft.type.trim()
    const found: Partial<Record<'id' | 'type', MessageKey>> = {}
    if (id === '') found.id = 'accounts.form.required'
    if (type === '') found.type = 'accounts.form.required'

    setErrors(found)
    if (Object.values(found).some(Boolean)) return

    const label = draft.label.trim()
    write.mutate({ id, type, label: label || id })
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-dashed bg-transparent dark:bg-transparent dark:border-border"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden />
        {t('firstRun.pass.accounts.declare')}
      </Button>
    )
  }

  return (
    <form
      className="space-y-3 rounded-xl border bg-muted/30 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-xs font-semibold">{t('accounts.form.create.title')}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field name="id" label="accounts.form.id" hint="accounts.form.id.hint" error={errors.id}>
          {(id, described) => (
            <Input
              id={id}
              value={draft.id}
              autoComplete="off"
              placeholder="pea"
              className="font-mono"
              aria-invalid={errors.id !== undefined}
              aria-describedby={described}
              onChange={(changed) => set('id', changed.target.value)}
            />
          )}
        </Field>
        <Field
          name="type"
          label="accounts.form.type"
          hint="accounts.form.type.hint"
          error={errors.type}
        >
          {(id, described) => (
            <Input
              id={id}
              value={draft.type}
              autoComplete="off"
              placeholder="PEA"
              aria-invalid={errors.type !== undefined}
              aria-describedby={described}
              onChange={(changed) => set('type', changed.target.value)}
            />
          )}
        </Field>
      </div>

      <Field name="label" label="accounts.form.label" optional>
        {(id, described) => (
          <Input
            id={id}
            value={draft.label}
            autoComplete="off"
            aria-describedby={described}
            onChange={(changed) => set('label', changed.target.value)}
          />
        )}
      </Field>

      {write.error ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={write.isPending}>
          {t('accounts.form.submit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          {t('accounts.form.cancel')}
        </Button>
      </div>
    </form>
  )
}

/**
 * The declaration's field — the ledger form's, at the modal's measure.
 *
 * The identifiers are prefixed `first-run-`: this modal is mounted by the shell
 * on **every** route, `/accounts` included, so an unprefixed `account-id` would
 * be the same `id` twice in one document the moment a reader opened the walk
 * over the page that owns the panel.
 */
function Field({
  name,
  label,
  hint,
  error,
  optional,
  children,
}: {
  name: 'id' | 'type' | 'label'
  label: MessageKey
  /** What the value is for, under the control — never a second label. */
  hint?: MessageKey
  error?: MessageKey
  optional?: boolean
  children: (id: string, describedBy: string | undefined) => ReactNode
}) {
  const { t } = useI18n()
  const id = `first-run-account-${name}`
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-xs font-medium">
          {t(label)}
        </label>
        {optional ? (
          <span className="text-2xs text-muted-foreground">— {t('data.form.optional')}</span>
        ) : null}
      </div>
      {children(id, error ? errorId : hint ? hintId : undefined)}
      {error ? (
        <p id={errorId} className="text-xs text-attention">
          {t(error)}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-2xs leading-relaxed text-muted-foreground text-pretty">
          {t(hint)}
        </p>
      ) : null}
    </div>
  )
}
