/**
 * The first run — **one question, three passages, and it opens on a predicate**
 * (#726, #823, ADR-0021, ADR-0035, ADR-0005, ADR-0015).
 *
 * It is mounted by the shell rather than by a route, because *first run* is not
 * a place: the predicate is `lib/firstRun.ts`'s, a **required** dial being
 * unanswered, and it is as true on `/titres` as on `/`. No launch counter, no
 * redirection, and `/` stays the dashboard unconditionally.
 *
 * **What it walks** (ADR-0035): the required settings, the accounts, the first
 * events — in that order, the last one opening by either of two doors. What it
 * asks is still **one thing**, and the two passages after the question ask for
 * nothing at all: a bare `docker run` is a trial run by design, and a screen
 * that will not release somebody without a CSV in hand turns the trial into a
 * wall. *Mandatory* here means **traversed, never answered**.
 *
 * Six things about it are decisions:
 *
 *  - **It closes without a button.** The cross, `Escape` and the click outside
 *    *are* the *later*. A `Later` button beside `Save` would give the way out
 *    the same visual weight as the answer, and the answer is the one thing this
 *    surface exists for. That is also why the control that walks the passages is
 *    a **ghost** and the answer is filled: continuing is the walk, never a
 *    second spelling of the escape hatch, and on the one passage that carries an
 *    answer it must not weigh what the answer weighs. Closing leaves an app that
 *    **works**: the scrape runs and stores the quote in its own currency, and
 *    the ledger is writable — what waits is the conversion and the performance
 *    series, which the notifications panel's pinned card and each valued page's
 *    empty state then say (#829, ADR-0037).
 *  - **Three sentences on what the app *is*, and no rule of calculation.**
 *    Explaining the weighted average cost here is exactly what ADR-0016 gives
 *    the convention bubble for: a rule is read beside the figure it governs, not
 *    in a modal read once before any figure exists. They are the frame of the
 *    whole walk and not of its first passage, so they stay put while the body
 *    underneath changes.
 *  - **The ephemeral-store warning is here**, and it is the only surface *every*
 *    trial user meets: the installation tab is two clicks down, and the boot
 *    lines are at a terminal nobody watching a browser is reading. It does not
 *    leave the tab either — the ceiling loses nothing (#724).
 *  - **The accounts passage shows and demands nothing.** It is satisfied by the
 *    seeded row every install owns — a declaration the owner may decline to add
 *    to — and its whole job is that the notion exists *before* a file naming
 *    accounts is handed over. It reads them to name them, and while that read is
 *    in flight it says nothing at all about them (ADR-0026).
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
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { EntryPair } from '@/components/EntryPair'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, type ConfigResponse } from '@/lib/api'
import { DEFAULT_ACCOUNT_LABEL, declaredLabel } from '@/lib/accounts'
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
import { useI18n } from '@/lib/i18n'
import { receiptMessage } from '@/lib/receipts'

const FIELD_ID = 'first-run-currency'

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
      <DialogContent aria-labelledby="first-run-title" aria-describedby="first-run-what">
        <DialogHeader>
          <DialogTitle id="first-run-title">{t('firstRun.title')}</DialogTitle>
          {/* Three sentences on what the app *is*, and not one rule of
              calculation: the rules are read beside the figures they govern. */}
          <DialogDescription id="first-run-what" className="space-y-2">
            <span className="block">{t('firstRun.what.ledger')}</span>
            <span className="block">{t('firstRun.what.quotes')}</span>
            <span className="block">{t('firstRun.what.currency')}</span>
          </DialogDescription>
        </DialogHeader>

        {ephemeral ? (
          <p className="rounded-md border border-attention/40 bg-attention/10 p-3 text-sm text-attention">
            {t('firstRun.ephemeral')}
          </p>
        ) : null}

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('firstRun.step', { step: passageNumber(passage), total: PASSAGES.length })}
          </p>

          {/* Passage one — the one question, and a reader who may walk past it. */}
          {passage === 'settings' ? (
            <>
              <h3 className="font-medium">{t('firstRun.pass.settings.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('firstRun.pass.settings.body')}</p>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (choice) save.mutate(choice)
                }}
              >
                <label htmlFor={FIELD_ID} className="text-sm font-medium">
                  {t('settings.base_currency')}
                </label>
                <CurrencyField
                  id={FIELD_ID}
                  value={choice}
                  onChange={(value) => {
                    // A refusal is about the value that was sent. Left standing,
                    // it reads as this app having refused the code just picked.
                    if (save.isError) save.reset()
                    setChoice(value)
                  }}
                  // The dial's rule, read off the dial. Here it settles itself —
                  // the modal only stands on an unanswered one — and it is
                  // passed rather than assumed, so the field states one rule on
                  // both of its mounts.
                  fixed={currencyFixed(config.data?.settings)}
                  // The note is about **this value**: a reader who overrode the
                  // suggestion is no longer reading a pre-filled field, and the
                  // reservation would then be about a code the browser never
                  // named.
                  suggested={suggestion !== null && choice === suggestion}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={!choice || save.isPending}>
                    {t('firstRun.save')}
                  </Button>
                  {save.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {t('firstRun.refused')}
                    </p>
                  ) : null}
                </div>
              </form>
            </>
          ) : null}

          {/* Passage two — **satisfied by the seeded row**, and asking nothing.
              The list is the install's own accounts, named through
              `declaredLabel` so the seeded one reads its catalogue entry rather
              than the words the schema wrote for whoever opens the file. Nothing
              at all is rendered about them while the read is in flight: *this is
              what you own* is a claim about the reader's own installation, and a
              read that has not landed is not an absence (ADR-0026). */}
          {passage === 'accounts' ? (
            <>
              <h3 className="font-medium">{t('firstRun.pass.accounts.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('firstRun.pass.accounts.body')}</p>
              {accounts.data ? (
                <div className="rounded-lg border p-4">
                  <p className="text-sm font-medium">{t('firstRun.pass.accounts.yours')}</p>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {accounts.data.accounts.map((account) => (
                      <li key={account.id}>
                        {declaredLabel(account) ?? t(DEFAULT_ACCOUNT_LABEL)}
                      </li>
                    ))}
                  </ul>
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
              (`?ouvrir=evenement`, the gesture the palette already arms).
              Taking neither ends it too, one control down. */}
          {passage === 'events' ? (
            <>
              <h3 className="font-medium">{t('firstRun.pass.events.title')}</h3>
              <p className="text-sm text-muted-foreground">{t('firstRun.pass.events.body')}</p>
              <EntryPair
                entries={[
                  {
                    title: t('data.empty.file.title'),
                    body: t('data.empty.file.body'),
                    action: (
                      <Button asChild type="button" variant="outline">
                        <Link to="/donnees" onClick={leave}>
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
                        <Link to="/donnees" search={{ ouvrir: 'evenement' }} onClick={leave}>
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

        {/* The walk itself, and never the answer: ghost on both, so that on the
            one passage carrying a filled button the way forward does not weigh
            what answering weighs (ADR-0021's argument, one control over). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {back === null ? (
            <span />
          ) : (
            <Button type="button" variant="ghost" onClick={() => setPassage(back)}>
              {t('firstRun.back')}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={forward}>
            {last ? t('firstRun.finish') : t('firstRun.next')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
