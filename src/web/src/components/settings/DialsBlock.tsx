/**
 * *What you can change* — **the dials, and only the dials** (#724, #830,
 * ADR-0014, ADR-0020, ADR-0038).
 *
 * The line between this card and `EnvironmentBlock` is ADR-0014's boot test
 * transposed to the render: what the process had to know before it could open
 * the store can never be a dial, and what lives in the store can never need a
 * restart. The **effective-configuration card disappears as an object** — it was
 * drawn twice from the same source on the same page, and it answered a
 * precedence problem that no longer exists: there is one place that says what a
 * setting is worth.
 *
 * **The two halves are two cards now** (#830). They were one `<section>` headed
 * *Réglages*, which is the name of the page they sit on: a page whose `<h1>` and
 * whose first `<h2>` read the same word says its title twice and names nothing.
 * What they are called is what each one is — *what you can change* against *what
 * the container imposes* — and the sentence ADR-0020 defends is untouched: one
 * place says what a setting is worth, and the other card is a description.
 *
 * Three things here are decisions rather than layout:
 *
 *  - **The form is drawn by the registry.** `settings_registry.py` is the single
 *    list — key, type, bounds, effect — and this component iterates what the API
 *    hands over. The catalogue supplies one sentence per key and nothing else;
 *    a hard-written list of six fields would be the fourth list ADR-0014 exists
 *    against, and the first to fall out of step. **`staleness_horizon` is on
 *    this page because it is in that list** and for no other reason, which is
 *    the whole of what makes it impossible for the redesign to drop it again.
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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  api,
  type ConfigResponse,
  type RuntimeState,
  type SettingDescription,
  type SettingsWriteResponse,
} from '@/lib/api'
import { currencyFixed, CURRENCY_KEY } from '@/lib/firstRun'
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

/** The id the card's landmark is named by — one constant, two readers. */
const DIALS_HEADING = 'settings-dials'

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

/**
 * The unit a dial is counted in, **beside the field and not inside its label**
 * (#838). The drawing sets a short field and the word next to it — which is how
 * a form reads a quantity — where the label carried `(secondes)` in brackets.
 * The currency has none: its value *is* the unit.
 */
const DIAL_UNIT: Record<string, MessageKey> = {
  regular_interval: 'settings.unit.seconds',
  backfill_interval: 'settings.unit.seconds',
  backfill_delay: 'settings.unit.seconds',
  backfill_chunk_days: 'settings.unit.days',
  staleness_horizon: 'settings.unit.seconds',
}

const DIAL_HINT: Record<string, MessageKey> = {
  regular_interval: 'settings.regular_interval.hint',
  backfill_interval: 'settings.backfill_interval.hint',
  backfill_delay: 'settings.backfill_delay.hint',
  backfill_chunk_days: 'settings.backfill_chunk_days.hint',
  staleness_horizon: 'settings.staleness_horizon.hint',
  base_currency: 'settings.base_currency.hint',
}

export interface DialsBlockProps {
  config: ConfigResponse
  runtime: RuntimeState | undefined
}

export function DialsBlock({ config, runtime }: DialsBlockProps) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Record<string, string>>(() => draftFrom(config.settings))
  const [receipt, setReceipt] = useState<SettingsWriteResponse | null>(null)

  // The store is the authority, so the fields follow what came back from it —
  // including after a save, where the answer carries the new list.
  useEffect(() => {
    setDraft(draftFrom(config.settings))
  }, [config.settings])

  // Whether the one dial with no default has been answered — which is what
  // decides both the sentence under it and whether it is drawn as a field at
  // all (#794). It is read off the settings this block already has, so the
  // ledger read this block used to make for it went with the rule that needed
  // it.
  const fixed = currencyFixed(config.settings)

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
    // `Card` ships a `div`, so the landmark's role is stated rather than
    // inherited from a `<section>` — the shape one page over (`AccountDetail`).
    <Card role="region" aria-labelledby={DIALS_HEADING}>
      <CardHeader>
        <h2 id={DIALS_HEADING} className="eyebrow">
          {t('installation.settings.editable')}
        </h2>
        {/* The counterpart of the environment card's own note, and the reason
            the two are told apart at a glance: nothing here needs a restart. */}
        <p className="max-w-prose text-xs text-muted-foreground">
          {t('installation.settings.editable.note')}
        </p>
      </CardHeader>
      <CardContent>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          {config.settings.map((setting) => (
            <Dial
              key={setting.key}
              setting={setting}
              value={draft[setting.key] ?? ''}
              reach={reach}
              fixed={fixed}
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
      </CardContent>
    </Card>
  )
}

function Dial({
  setting,
  value,
  reach,
  fixed,
  onChange,
}: {
  setting: SettingDescription
  value: string
  reach: CadenceReach | null
  /** Whether the currency is answered — the currency's own rule, and only its. */
  fixed: boolean | undefined
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const id = settingFieldId(setting.key)
  const label = DIAL_LABEL[setting.key]
  const hint = DIAL_HINT[setting.key]
  // A fixed currency is not drawn as a field, so nothing here is labellable:
  // a `<label for>` pointing at a paragraph names something a reader cannot
  // reach, and the name belongs to the value all the same.
  const drawn = !(setting.type === 'currency' && fixed === true)
  // Both sentences are about **this** dial, so they live under it rather than
  // under the section: read at the bottom of a form they would be about the
  // save, and only one of the six dials rescales anything retroactively.
  const retroactive = setting.key === RETROACTIVE_DIAL
  const unit = DIAL_UNIT[setting.key]

  return (
    <div className="space-y-1.5">
      {drawn ? (
        <label htmlFor={id} className="block text-sm">
          {label ? t(label) : setting.key}
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">{label ? t(label) : setting.key}</p>
      )}
      {/* The currency is the one dial whose *values* are a closed list, and the
          registry says so with its own type — so the field follows the registry
          here as everywhere else, and it is the same component the first-run
          modal mounts (#726). */}
      {setting.type === 'currency' ? (
        <CurrencyField id={id} value={value} onChange={onChange} fixed={fixed} />
      ) : (
        // **A quantity gets the width of a quantity, and its unit beside it**
        // (#838): an integer of at most four digits in a field as wide as the
        // card is a field that reads as free text, and `(secondes)` in the
        // label was the unit written where the eye does not look for it.
        <div className="flex items-center gap-2.5">
          <Input
            id={id}
            // The type comes from the registry, so a dial added there renders
            // with its own bounds without a line changing here.
            type={setting.type === 'integer' ? 'number' : 'text'}
            inputMode={setting.type === 'integer' ? 'numeric' : undefined}
            min={setting.minimum ?? undefined}
            max={setting.maximum ?? undefined}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="tabular h-9.5 w-27 rounded-lg bg-background font-mono"
          />
          {unit ? <span className="text-xs text-muted-foreground">{t(unit)}</span> : null}
        </div>
      )}
      <p className="text-2xs leading-relaxed text-muted-foreground">
        {hint ? t(hint) : setting.doc}
      </p>
      {retroactive && reach ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t('settings.cadence.reach', { now: reach.now, later: reach.atMarketOpen })}
        </p>
      ) : null}
      {retroactive ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t('settings.backoff.retroactive')}
        </p>
      ) : null}
    </div>
  )
}

