/**
 * The first run — **four centred steps, served until a currency is stored**
 * (« Relevé », `Bienvenue-Refonte.dc.html`, `IMPLEMENTATION.md` § 3.12).
 *
 * It is mounted by the shell rather than by a route, because *first run* is not
 * a place: the predicate is `lib/firstRun.ts`'s, a **required** dial being
 * unanswered, and it is as true on `/shares` as on `/`. There is no way to put
 * it off: until the currency is stored the app serves this screen and nothing
 * else, since nothing can be converted or computed without it.
 *
 * The four steps call routes that already exist — no sequence endpoint:
 *
 *  1. **the currency** — `PUT /api/settings`, « Ne se change plus ensuite » ;
 *  2. **the tax models of a country** — `POST /api/taxation-models/registry`
 *     with the ticked ids, all or nothing ;
 *  3. **the first account** — `POST /api/accounts` (a blank identifiant writes
 *     nothing, a duplicate is a 409 said under the field) ;
 *  4. **where the first events come from** — three ruled doors: the import, the
 *     event sheet, « Plus tard ».
 *
 * Once the currency is stored the screen stays open until the walk ends: the
 * predicate going false must not take the next steps away from the reader who
 * is in the middle of them. The same screen is reopened by a gesture
 * (`/?open=first-run`, from the palette), starting past the currency.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { accountsApi } from '@/features/accounts/lib/api'
import { isAddressableAccountId, ruleOf } from '@/features/accounts/lib/accounts'
import { type ConfigResponse, settingsApi } from '@/features/settings/lib/api'
import { ApiProblem } from '@/lib/api'
import { suggestedCurrency } from '@/lib/currencies'
import {
  CURRENCY_KEY,
  PASSAGES,
  baseCurrency,
  currencyFixed,
  firstRunStands,
  nextPassage,
  passageNumber,
  previousPassage,
  reopenedPassage,
  type Passage,
} from '@/lib/firstRun'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessageKey } from '@/lib/problem'
import { receiptMessage } from '@/lib/receipts'

const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-md shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

const TITLES: Record<Passage, MessageKey> = {
  currency: 'firstRun.currency.title',
  models: 'firstRun.models.title',
  account: 'firstRun.account.title',
  events: 'firstRun.events.title',
}

/** A ruled row of the lists below. */
const ROW = 'flex min-h-13 items-center justify-between gap-4 border-b px-0.5'

export function FirstRun() {
  const { t } = useI18n()
  const client = useQueryClient()
  const [passage, setPassage] = useState<Passage>(PASSAGES[0])
  const [walking, setWalking] = useState(false)

  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const settings = config.data?.settings
  const stands = firstRunStands(settings)

  // A gesture, not an address: spent on arrival.
  const gesture = useSearch({ strict: false }).open === 'first-run'
  const navigate = useNavigate()
  useEffect(() => {
    if (!gesture || !settings) return
    setPassage(reopenedPassage(settings))
    setWalking(true)
    void navigate({ to: '/', search: {}, replace: true })
  }, [gesture, settings, navigate])

  if (stands && !walking) setWalking(true)

  // The step's title takes the focus when the step changes.
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (walking) title.current?.focus()
  }, [walking, passage])

  const leave = () => {
    setWalking(false)
    setPassage(PASSAGES[0])
  }
  const forward = () => {
    const next = nextPassage(passage)
    if (next === null) leave()
    else setPassage(next)
  }
  const back = previousPassage(passage)

  // The three writes of the walk are one mutation: a step is saved, then walked
  // past, and the one refusal on screen is the current step's.
  const suggestion = suggestedCurrency(navigator.languages)
  const [choice, setChoice] = useState<string>(() => suggestion ?? '')
  const fixed = currencyFixed(settings) === true
  const [country, setCountry] = useState<string | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [account, setAccount] = useState({ id: '', label: '', model: '' })
  const [idError, setIdError] = useState<MessageKey | null>(null)

  const write = useMutation({
    mutationFn: async (step: Passage) => {
      if (step === 'currency') {
        const answer = await settingsApi.saveSettings({ [CURRENCY_KEY]: choice })
        const { message, values } = receiptMessage({ kind: 'currency.saved', currency: choice })
        toast.success(t(message, values))
        client.setQueryData<ConfigResponse>(['config'], (previous) =>
          previous ? { ...previous, settings: answer.settings } : previous,
        )
        void client.invalidateQueries({ queryKey: ['config'] })
        void client.invalidateQueries({ queryKey: ['positions'] })
        void client.invalidateQueries({ queryKey: ['portfolio-totals'] })
      } else if (step === 'models') {
        await accountsApi.importTaxationModels([...ticked])
        void client.invalidateQueries({ queryKey: ['taxation-models'] })
      } else {
        await accountsApi.createAccount({
          id: account.id.trim(),
          label: account.label.trim(),
          ...(account.model === '' ? {} : { taxation_model_id: account.model }),
        })
        void client.invalidateQueries()
      }
    },
    onSuccess: forward,
  })
  const taken = write.error instanceof ApiProblem && write.error.type === PROBLEM_TYPES.conflict

  // Step 2 — the catalogue, all countries, filtered here.
  const registry = useQuery({
    queryKey: ['taxation-registry'],
    queryFn: accountsApi.taxationRegistry,
    enabled: walking && passage === 'models',
    retry: false,
  })
  const listed = (registry.data?.items ?? []).filter((item) => item.refused === null)
  const countries = [...new Set(listed.map((item) => item.country))].sort()
  const chosenCountry = country ?? (countries.includes('FR') ? 'FR' : (countries[0] ?? null))
  const shown = listed.filter((item) => item.country === chosenCountry)

  // Step 3 — the models to choose from, once step 2 has imported some.
  const catalogue = useQuery({
    queryKey: ['taxation-models'],
    queryFn: accountsApi.taxationModels,
    enabled: walking && passage === 'account',
  })

  if (!walking) return null

  const step = passageNumber(passage)

  function onContinue() {
    if (passage === 'currency') {
      if (fixed) forward()
      else if (choice) write.mutate('currency')
    } else if (passage === 'models') {
      if (ticked.size === 0) forward()
      else write.mutate('models')
    } else if (passage === 'account') {
      const id = account.id.trim()
      // A blank identifiant writes nothing: the step is traversed, not answered.
      if (id === '') forward()
      else if (!isAddressableAccountId(id)) setIdError('accounts.form.id.shape')
      else write.mutate('account')
    }
  }

  return (
    // Not dismissable: no cross, no Escape, no click outside. The app is not
    // usable until a currency is stored, and the walk past it is the reader's.
    <Dialog open>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="top-0 left-0 block h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 shadow-none"
      >
        <div className="flex min-h-full items-center justify-center px-6 py-12">
          <form
            className="flex w-full max-w-130 flex-col gap-7"
            onSubmit={(event) => {
              event.preventDefault()
              onContinue()
            }}
          >
            <header className="flex items-center justify-between gap-4">
              <span className="font-semibold">SuiviBourse</span>
              <span className="fig text-sm text-muted-foreground">
                {t('firstRun.step', { step, total: PASSAGES.length })}
              </span>
            </header>

            <DialogTitle asChild>
              <h1 ref={title} tabIndex={-1} className="statement outline-none">
                {t(TITLES[passage])}
              </h1>
            </DialogTitle>

            {passage === 'currency' ? (
              <div className="flex flex-col gap-3">
                <div className="flex max-w-65 flex-col gap-1.5">
                  <label htmlFor="first-run-currency" className="label">
                    {t('firstRun.currency.label')}
                  </label>
                  <CurrencyField
                    id="first-run-currency"
                    value={(fixed ? baseCurrency(settings) : null) ?? choice}
                    onChange={(value) => {
                      if (write.isError) write.reset()
                      setChoice(value)
                    }}
                    fixed={fixed}
                    suggested={suggestion !== null && choice === suggestion}
                    finality={false}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{t('firstRun.currency.final')}</p>
                {write.error && passage === 'currency' ? (
                  <Refusal>{write.error ? t('firstRun.refused') : null}</Refusal>
                ) : null}
              </div>
            ) : null}

            {passage === 'models' ? (
              <div className="flex flex-col gap-3">
                {registry.isError ? (
                  <div className="flex flex-col items-start gap-3">
                    <p role="alert" className="text-sm text-destructive">
                      {t(problemMessageKey(registry.error))}
                    </p>
                    <Button type="button" size="sheet" onClick={() => void registry.refetch()}>
                      {t('firstRun.models.retry')}
                    </Button>
                  </div>
                ) : registry.data === undefined ? null : (
                  <>
                    <CountryField
                      countries={countries}
                      value={chosenCountry}
                      onChange={(next) => {
                        setCountry(next)
                        setTicked(new Set())
                      }}
                    />
                    <ModelList
                      items={shown}
                      ticked={ticked}
                      onToggle={(id) =>
                        setTicked((previous) => {
                          const next = new Set(previous)
                          if (!next.delete(id)) next.add(id)
                          return next
                        })
                      }
                    />
                  </>
                )}
                {write.isError && passage === 'models' ? (
                  <Refusal>{t(problemMessageKey(write.error))}</Refusal>
                ) : null}
                <p className="text-sm">
                  <Link
                    to="/settings"
                    onClick={leave}
                    className="text-muted-foreground underline decoration-border underline-offset-3"
                  >
                    {t('firstRun.models.own')}
                  </Link>
                </p>
              </div>
            ) : null}

            {passage === 'account' ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="first-run-account-id" className="label">
                    {t('accounts.form.id')}
                  </label>
                  <Input
                    id="first-run-account-id"
                    autoComplete="off"
                    className="fig md:text-md"
                    value={account.id}
                    aria-invalid={idError !== null || taken}
                    aria-describedby={
                      idError !== null || taken ? 'first-run-account-error' : undefined
                    }
                    onChange={(event) => {
                      setIdError(null)
                      if (write.isError) write.reset()
                      setAccount({ ...account, id: event.target.value })
                    }}
                  />
                  {idError !== null || taken ? (
                    <p
                      id="first-run-account-error"
                      role="alert"
                      className="text-sm text-destructive"
                    >
                      {t(idError ?? 'accounts.form.id.taken')}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="first-run-account-label" className="label whitespace-pre">
                    {t('accounts.form.label')}
                    <span className="font-normal">{` · ${t('data.form.optional')}`}</span>
                  </label>
                  <Input
                    id="first-run-account-label"
                    value={account.label}
                    onChange={(event) => setAccount({ ...account, label: event.target.value })}
                  />
                </div>
                <div className="col-span-2 flex flex-col gap-1.5">
                  <label htmlFor="first-run-account-model" className="label">
                    {t('accounts.form.taxation')}
                  </label>
                  <select
                    id="first-run-account-model"
                    className={SELECT}
                    value={account.model}
                    onChange={(event) => setAccount({ ...account, model: event.target.value })}
                  >
                    <option value="">{t('accounts.form.taxation.none')}</option>
                    {(catalogue.data?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>
                {write.isError && passage === 'account' && !taken ? (
                  <div className="col-span-2">
                    <Refusal>{t(problemMessageKey(write.error))}</Refusal>
                  </div>
                ) : null}
              </div>
            ) : null}

            {passage === 'events' ? (
              <div className="flex flex-col border-t">
                <Door
                  to="/ledger/import"
                  name={t('firstRun.events.import')}
                  hint={t('firstRun.events.import.hint')}
                  onGo={leave}
                />
                <Door
                  to="/ledger"
                  search={{ open: 'event' }}
                  name={t('firstRun.events.manual')}
                  hint={t('firstRun.events.manual.hint')}
                  onGo={leave}
                />
                <Door
                  to="/"
                  name={t('firstRun.events.later')}
                  hint={t('firstRun.events.later.hint')}
                  muted
                  onGo={leave}
                />
              </div>
            ) : null}

            <footer className="flex items-center justify-between gap-2 pt-1">
              {back === null ? (
                <span />
              ) : (
                <Button
                  type="button"
                  size="sheet"
                  className="border-transparent pl-0"
                  onClick={() => setPassage(back)}
                >
                  {t('firstRun.back')}
                </Button>
              )}
              {passage === 'events' ? null : (
                <Button
                  variant="primary"
                  size="sheet"
                  type="submit"
                  disabled={write.isPending || (passage === 'currency' && !fixed && !choice)}
                >
                  {t('firstRun.next')}
                </Button>
              )}
            </footer>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The country of the models listed, named in the reader's language. */
function CountryField({
  countries,
  value,
  onChange,
}: {
  countries: readonly string[]
  value: string | null
  onChange: (country: string) => void
}) {
  const { t, locale } = useI18n()
  const names = new Intl.DisplayNames([locale], { type: 'region' })
  if (countries.length === 0) return null

  return (
    <div className="flex max-w-65 flex-col gap-1.5">
      <label htmlFor="first-run-country" className="label">
        {t('firstRun.models.country')}
      </label>
      <select
        id="first-run-country"
        className={SELECT}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {countries.map((code) => (
          <option key={code} value={code}>
            {names.of(code) ?? code}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The catalogue's models of one country, as checkboxes with their rule. */
function ModelList({
  items,
  ticked,
  onToggle,
}: {
  items: readonly {
    id: string
    name: string
    kind: string
    parameters: Record<string, unknown>
  }[]
  ticked: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  if (items.length === 0) return null

  return (
    <div className="flex flex-col border-t">
      {items.map((item) => (
        <label key={item.id} className={`${ROW} cursor-pointer justify-start gap-3`}>
          <input
            type="checkbox"
            checked={ticked.has(item.id)}
            onChange={() => onToggle(item.id)}
            className="size-4"
          />
          <span className="flex min-w-0 flex-col">
            <span>{item.name}</span>
            <span className="text-sm text-muted-foreground">
              {ruleOf(item, t, (ratio) => f.percentPoints(ratio * 100, 1))}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** One ruled door of the last step. */
function Door({
  to,
  search,
  name,
  hint,
  muted = false,
  onGo,
}: {
  to: '/' | '/ledger' | '/ledger/import'
  search?: { open: 'event' }
  name: string
  hint: string
  muted?: boolean
  onGo: () => void
}) {
  return (
    <Link to={to} search={search} onClick={onGo} className={`${ROW} group`}>
      <span className="flex flex-col">
        <span
          className={`group-hover:underline group-hover:underline-offset-4 ${muted ? 'text-muted-foreground' : 'font-medium'}`}
        >
          {name}
        </span>
        <span className="text-sm text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
    </Link>
  )
}
