/**
 * *Settings* — **one surface, two sections** (#724, ADR-0014, ADR-0020).
 *
 * The line between the two is ADR-0014's boot test transposed to the render:
 * what the process had to know before it could open the store can never be a
 * dial, and what lives in the store can never need a restart. So the tab shows
 * *what you can change* beside *what the container imposes*, and the
 * **effective-configuration card disappears as an object** — it was drawn twice
 * from the same source on the same page, and it answered a precedence problem
 * that no longer exists: there is one place that says what a setting is worth.
 *
 * Four things here are decisions rather than layout:
 *
 *  - **The form is drawn by the registry.** `settings_registry.py` is the single
 *    list — key, type, bounds, effect — and this component iterates what the API
 *    hands over. The catalogue supplies one sentence per key and nothing else;
 *    a hard-written list of six fields would be the fourth list ADR-0014 exists
 *    against, and the first to fall out of step.
 *  - **The environment half is a description, not a form.** Rendered as greyed
 *    fields it invites the click and reads as a form that refused. It is a
 *    key/value list, nothing in it is focusable, and *changes when the container
 *    is recreated* is written **once for the section** rather than under each of
 *    six rows.
 *  - **The cadence says who it reaches.** A portfolio-wide dial that reaches
 *    three symbols out of twelve has to say so, or the reader concludes the
 *    other nine are misconfigured. The count comes from `/api/runtime` and it is
 *    the same split the write path applies (`lib/installation.ts`).
 *  - **The trap is stated, because no interface can hide it.** The dead-ticker
 *    back-off waits `regular_interval × 2^(n−3)`; no absolute delay is stored
 *    anywhere, so changing this number **rescales retroactively** the wait of a
 *    symbol that has been failing since this morning. The number in the form is
 *    the number in the formula.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  api,
  type ConfigResponse,
  type RuntimeState,
  type SettingDescription,
  type SettingsWriteResponse,
} from '@/lib/api'
import { currencyMutable, currencyUnanswered, CURRENCY_KEY } from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { receiptMessage } from '@/lib/receipts'
import {
  cadenceReach,
  changedValues,
  draftFrom,
  RETROACTIVE_DIAL,
  settingFieldId,
  type CadenceReach,
} from '@/lib/installation'

/**
 * The dial the first-run modal asks about, and the one the closed list is for.
 * Named from `lib/firstRun.ts` rather than spelled again: the modal and this
 * form are two mounts of one field (#726).
 */
const CURRENCY = CURRENCY_KEY

/**
 * One sentence per dial, in the reader's language. The **list** is the
 * registry's; only the words are here, exactly as the six event types are named
 * by the catalogue and enumerated by the API. A dial the catalogue does not
 * know yet renders under its key with the registry's own note beside it, which
 * is the honest degradation and not a hole.
 */
const DIAL_LABEL: Record<string, MessageKey> = {
  regular_interval: 'settings.regular_interval',
  backfill_interval: 'settings.backfill_interval',
  backfill_delay: 'settings.backfill_delay',
  backfill_chunk_days: 'settings.backfill_chunk_days',
  staleness_horizon: 'settings.staleness_horizon',
  base_currency: 'settings.base_currency',
}

const DIAL_HINT: Record<string, MessageKey> = {
  regular_interval: 'settings.regular_interval.hint',
  backfill_interval: 'settings.backfill_interval.hint',
  backfill_delay: 'settings.backfill_delay.hint',
  backfill_chunk_days: 'settings.backfill_chunk_days.hint',
  staleness_horizon: 'settings.staleness_horizon.hint',
  base_currency: 'settings.base_currency.hint',
}

export interface SettingsBlockProps {
  config: ConfigResponse
  runtime: RuntimeState | undefined
}

export function SettingsBlock({ config, runtime }: SettingsBlockProps) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>(() => draftFrom(config.settings))
  const [receipt, setReceipt] = useState<SettingsWriteResponse | null>(null)

  // The store is the authority, so the fields follow what came back from it —
  // including after a save, where the answer carries the new list.
  useEffect(() => {
    setDraft(draftFrom(config.settings))
  }, [config.settings])

  // The ledger, for one sentence and one only: how long the reporting currency
  // stays changeable, said **where it is chosen** (#726). A read that has not
  // landed writes neither half (ADR-0026).
  const events = useQuery({ queryKey: ['events'], queryFn: api.events })
  // Both clauses of the dial's rule: a dial nobody has ever answered has
  // interpreted nothing, so it stays free whatever the ledger holds.
  const unanswered = currencyUnanswered(config.settings)
  const mutable = currencyMutable({
    events: events.data,
    answered: unanswered === undefined ? undefined : !unanswered,
  })

  const save = useMutation({
    mutationFn: () => api.saveSettings(changedValues(config.settings, draft)),
    onSuccess: (answer) => {
      setReceipt(answer)
      // The one dial with a receipt of its own: it is the app's single
      // question, and answering it is retroactive over every stored quote
      // (#704). The other five are described by the sentence under the form.
      if (answer.changed.includes(CURRENCY)) {
        const currency = String(draft[CURRENCY] ?? '')
        const { message, values } = receiptMessage({ kind: 'currency.saved', currency })
        toast.success(t(message, values))
      }
      client.invalidateQueries({ queryKey: ['config'] })
      client.invalidateQueries({ queryKey: ['runtime'] })
      client.invalidateQueries({ queryKey: ['positions'] })
      client.invalidateQueries({ queryKey: ['portfolio-totals'] })
    },
  })

  const reach = cadenceReach(runtime)
  const pending = Object.keys(changedValues(config.settings, draft)).length

  return (
    <section aria-labelledby="installation-settings" className="space-y-6">
      <h2 id="installation-settings" className="text-lg font-semibold tracking-tight">
        {t('installation.settings')}
      </h2>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <h3 className="text-sm font-medium">{t('installation.settings.editable')}</h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {config.settings.map((setting) => (
            <Dial
              key={setting.key}
              setting={setting}
              value={draft[setting.key] ?? ''}
              reach={reach}
              mutable={mutable}
              onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending === 0 || save.isPending}>
            {t('installation.settings.save')}
          </Button>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('installation.settings.refused')}
            </p>
          ) : null}
          {receipt && !save.isError ? (
            <p role="status" className="text-sm text-muted-foreground">
              {receipt.changed.length === 0
                ? t('installation.settings.unchanged')
                : t('installation.settings.saved', {
                    count: receipt.changed.length,
                    now: Number(receipt.effect?.symbols_rescheduled ?? 0),
                    later: Number(receipt.effect?.symbols_at_market_open ?? 0),
                  })}
            </p>
          ) : null}
        </div>
      </form>

      <Environment config={config} />
    </section>
  )
}

function Dial({
  setting,
  value,
  reach,
  mutable,
  onChange,
}: {
  setting: SettingDescription
  value: string
  reach: CadenceReach | null
  /** Whether the ledger is still empty — the currency's own rule, and only its. */
  mutable: boolean | undefined
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const id = settingFieldId(setting.key)
  const label = DIAL_LABEL[setting.key]
  const hint = DIAL_HINT[setting.key]
  // Both sentences are about **this** dial, so they live under it rather than
  // under the section: read at the bottom of a form they would be about the
  // save, and only one of the six dials rescales anything retroactively.
  const retroactive = setting.key === RETROACTIVE_DIAL

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {label ? t(label) : setting.key}
      </label>
      {/* The currency is the one dial whose *values* are a closed list, and the
          registry says so with its own type — so the field follows the registry
          here as everywhere else, and it is the same component the first-run
          modal mounts (#726). */}
      {setting.type === 'currency' ? (
        <CurrencyField id={id} value={value} onChange={onChange} mutable={mutable} />
      ) : (
        <Input
          id={id}
          // The type comes from the registry, so a dial added there renders with
          // its own bounds without a line changing here.
          type={setting.type === 'integer' ? 'number' : 'text'}
          inputMode={setting.type === 'integer' ? 'numeric' : undefined}
          min={setting.minimum ?? undefined}
          max={setting.maximum ?? undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <p className="text-xs text-muted-foreground">{hint ? t(hint) : setting.doc}</p>
      {retroactive && reach ? (
        <p className="text-xs text-muted-foreground">
          {t('settings.cadence.reach', { now: reach.now, later: reach.atMarketOpen })}
        </p>
      ) : null}
      {retroactive ? (
        <p className="text-xs text-muted-foreground">{t('settings.backoff.retroactive')}</p>
      ) : null}
    </div>
  )
}

/**
 * The second section: a **description**, and the test of that is mechanical —
 * nothing in it is an `input`, and nothing in it can be focused.
 */
function Environment({ config }: { config: ConfigResponse }) {
  const { t } = useI18n()

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{t('installation.settings.imposed')}</h3>
      {/* Written once for the section, never under each of six rows. */}
      <p className="text-sm text-muted-foreground">{t('installation.settings.imposed.note')}</p>

      <dl className="divide-y rounded-lg border text-sm">
        {config.environment.map((variable) => (
          <div key={variable.name} className="flex flex-wrap gap-2 px-4 py-2">
            <dt className="font-mono text-xs text-muted-foreground">{variable.name}</dt>
            <dd className="tabular ml-auto font-mono text-xs">
              {variable.value ?? ''}
              {variable.set ? null : (
                <span className="ml-2 font-sans text-muted-foreground">
                  {t('installation.settings.imposed.default')}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {/* `unread_environment` is deliberately **not** repeated here: it is one of
          the five notices, the block above says it with the names it found, and
          two announcers on one fact is the defect this page was rebuilt to
          remove. */}
    </div>
  )
}
