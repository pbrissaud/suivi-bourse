/**
 * The first run — **one question, one modal, and it opens on a predicate**
 * (#726, ADR-0021, ADR-0005, ADR-0015).
 *
 * It is mounted by the shell rather than by a route, because *first run* is not
 * a place: the predicate is `lib/firstRun.ts`'s, the reporting currency being
 * unanswered, and it is as true on `/titres` as on `/`. No launch counter, no
 * redirection, and `/` stays the dashboard unconditionally.
 *
 * Five things about it are decisions:
 *
 *  - **It closes without a button.** The cross, `Escape` and the click outside
 *    *are* the *later*. A `Later` button beside `Save` would give the way out
 *    the same visual weight as the answer, and the answer is the one thing this
 *    surface exists for. Closing leaves an app that **works**: the scrape runs
 *    and stores the quote in its own currency, and the ledger is writable — what
 *    waits is the conversion and the performance series, which the band then
 *    says.
 *  - **Three sentences on what the app *is*, and no rule of calculation.**
 *    Explaining the weighted average cost here is exactly what ADR-0016 gives
 *    the convention bubble for: a rule is read beside the figure it governs, not
 *    in a modal read once before any figure exists.
 *  - **The ephemeral-store warning is here**, and it is the only surface *every*
 *    trial user meets: the installation tab is two clicks down, and the boot
 *    lines are at a terminal nobody watching a browser is reading. It does not
 *    leave the tab either — the ceiling loses nothing (#724).
 *  - **The last step is the ledger's own pair of entrances**, the same
 *    component at equal weight and with no primary action (`EntryPair`). The
 *    marker that says *this reader has recorded nothing* stays with that mount
 *    and not with this one: here the pair states no emptiness, it offers two
 *    doors.
 *  - **The memory of the closing is the browser's alone.** The predicate stays
 *    derived server-side, so a wiped volume re-arms the question and a second
 *    browser sees it again.
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
import { suggestedCurrency } from '@/lib/currencies'
import {
  CURRENCY_KEY,
  currencyMutable,
  currencyUnanswered,
  firstRunDismissed,
  firstRunStands,
  rememberFirstRunDismissed,
} from '@/lib/firstRun'
import { useI18n } from '@/lib/i18n'
import { receiptMessage } from '@/lib/receipts'

const FIELD_ID = 'first-run-currency'

/** `undefined` in, `undefined` out: a silence stays a silence (ADR-0026). */
function negate(value: boolean | undefined): boolean | undefined {
  return value === undefined ? undefined : !value
}

export function FirstRun() {
  const { t } = useI18n()
  const client = useQueryClient()
  const [dismissed, setDismissed] = useState(() => firstRunDismissed())

  const config = useQuery({ queryKey: ['config'], queryFn: api.config })
  const stands = firstRunStands({ settings: config.data?.settings, dismissed })

  // The ledger read is **armed by the predicate**, so an install that has
  // answered the question does not pay for it on any page. The runtime is the
  // shell's own read under the same key — the banner and the status dot ask for
  // it everywhere — so arming it here costs nothing and takes nothing away.
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime, enabled: stands })
  const events = useQuery({ queryKey: ['events'], queryFn: api.events, enabled: stands })

  // A suggestion, never a default: the field opens on it, the question is still
  // unanswered, and what it buys is one click instead of a scroll. The
  // reservation is `lib/currencies.ts`'s and it is real — a locale gives the
  // currency of a country, not of a portfolio.
  const suggestion = suggestedCurrency(navigator.languages)
  const [choice, setChoice] = useState<string>(() => suggestion ?? '')

  const save = useMutation({
    mutationFn: (currency: string) => api.saveSettings({ [CURRENCY_KEY]: currency }),
    onSuccess: (answer, currency) => {
      const { message, values } = receiptMessage({ kind: 'currency.saved', currency })
      toast.success(t(message, values))
      // The modal is a function of the predicate, so the answer closes it by
      // making that predicate false — written into the cache here so the
      // closing is immediate rather than one round trip late.
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous ? { ...previous, settings: answer.settings } : previous,
      )
      client.invalidateQueries({ queryKey: ['config'] })
      // Answering is retroactive (#704): every stored quote becomes
      // convertible, so the figures the rest of the app draws change.
      client.invalidateQueries({ queryKey: ['positions'] })
      client.invalidateQueries({ queryKey: ['portfolio-totals'] })
    },
  })

  const close = () => {
    rememberFirstRunDismissed()
    setDismissed(true)
  }

  if (!stands) return null

  const ephemeral = runtime.data?.store.persistence === 'ephemeral'
  const dropFolder =
    config.data?.environment.find((variable) => variable.name === 'SB_IMPORT_DIR')?.value ?? null

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
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
              // A refusal is about the value that was sent. Left standing, it
              // reads as this app having refused the code just picked.
              if (save.isError) save.reset()
              setChoice(value)
            }}
            // Both clauses of the dial's rule. Here the first one settles it —
            // the modal only stands on an unanswered dial — and it is passed
            // rather than assumed, so the field states one rule on both mounts.
            mutable={currencyMutable({
              events: events.data,
              answered: negate(currencyUnanswered(config.data?.settings)),
            })}
            // The note is about **this value**: a reader who overrode the
            // suggestion is no longer reading a pre-filled field, and the
            // reservation would then be about a code the browser never named.
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

        {/* The ledger's own two entrances, the same component and no primary
            action. The drop folder is named rather than observed: whether the
            bind is mounted is not published anywhere, and this ticket adds no
            API state — an absent `/import` is an ordinary state (ADR-0015), so
            the entry keeps its place and says so instead of disappearing, which
            would read as a breakage. */}
        <EntryPair
          entries={[
            {
              title: t('data.empty.file.title'),
              body: dropFolder
                ? t('firstRun.entry.file.body', { path: dropFolder })
                : t('data.empty.file.body'),
            },
            {
              title: t('data.empty.manual.title'),
              body: t('data.empty.manual.body'),
              action: (
                <Button asChild type="button" variant="outline">
                  <Link to="/donnees" onClick={close}>
                    {t('data.new')}
                  </Link>
                </Button>
              ),
            },
          ]}
        />
      </DialogContent>
    </Dialog>
  )
}
