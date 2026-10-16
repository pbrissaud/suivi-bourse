import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { CurrencyField } from '@/components/CurrencyField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import {
  type ConfigResponse,
  type SettingDescription,
  settingsApi,
  type SettingsWriteResponse,
} from '@/features/settings/lib/api'
import type { RuntimeState } from '@/lib/api'
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
} from '@/features/settings/lib/installation'

const UPDATE_CHECK = 'update_check'

/**
 * Registry dials this form leaves out. The benchmark is chosen on the
 * comparison page, which says what fetching its history costs (#760); the
 * release check is a switch that saves at once (#1237).
 */
const NOT_A_DIAL = new Set(['benchmark_symbol', UPDATE_CHECK])

/** An unknown dial falls back to its key and the registry's own doc. */
const DIAL_LABEL: Record<string, MessageKey> = {
  regular_interval: 'settings.regular_interval',
  backfill_interval: 'settings.backfill_interval',
  backfill_delay: 'settings.backfill_delay',
  backfill_chunk_days: 'settings.backfill_chunk_days',
  staleness_horizon: 'settings.staleness_horizon',
  base_currency: 'settings.base_currency',
}

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

interface DialsBlockProps {
  config: ConfigResponse
  runtime: RuntimeState | undefined
}

export function DialsBlock({ config, runtime }: DialsBlockProps) {
  const { t } = useI18n()
  const client = useQueryClient()
  const dials = config.settings.filter((setting) => !NOT_A_DIAL.has(setting.key))
  const [draft, setDraft] = useState<Record<string, string>>(() => draftFrom(dials))
  const [receipt, setReceipt] = useState<SettingsWriteResponse | null>(null)

  // Reset on the drawn dials only: toggling the switch, or choosing the
  // benchmark, refetches the config and must not wipe an unsaved edit.
  const drawn = JSON.stringify(dials.map((setting) => [setting.key, setting.value]))
  const [seen, setSeen] = useState(drawn)
  if (seen !== drawn) {
    setSeen(drawn)
    setDraft(draftFrom(dials))
  }

  const fixed = currencyFixed(config.settings)

  const save = useMutation({
    // Only what moved: rescheduling resets a job's timer.
    mutationFn: () => settingsApi.saveSettings(changedValues(dials, draft)),
    onSuccess: (answer) => {
      setReceipt(answer)
      if (answer.changed.includes(CURRENCY_KEY)) {
        const currency = String(draft[CURRENCY_KEY] ?? '')
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
  const pending = Object.keys(changedValues(dials, draft)).length

  return (
    <Section title={t('installation.settings.editable')}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 2xl:grid-cols-3">
          {dials.map((setting) => (
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
                : t('installation.settings.saved', { count: receipt.changed.length })}
            </p>
          ) : null}
        </div>
      </form>
      <UpdateCheckSwitch
        setting={config.settings.find((setting) => setting.key === UPDATE_CHECK)}
      />
    </Section>
  )
}

/** On or off, saved at once: no draft, no Save button (#1237). */
function UpdateCheckSwitch({ setting }: { setting: SettingDescription | undefined }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const toggle = useMutation({
    mutationFn: (on: boolean) => settingsApi.saveSettings({ [UPDATE_CHECK]: on }),
    onSuccess: (answer) => {
      // The switch moves with the answer, not one round trip late.
      client.setQueryData<ConfigResponse>(['config'], (previous) =>
        previous ? { ...previous, settings: answer.settings } : previous,
      )
      client.invalidateQueries({ queryKey: ['config'] })
      client.invalidateQueries({ queryKey: ['release'] })
    },
  })
  if (!setting) return null
  return (
    <div className="mt-6 flex items-start justify-between gap-4 border-t pt-5">
      <div className="space-y-1">
        <label htmlFor={settingFieldId(UPDATE_CHECK)} className="block text-sm">
          {t('settings.update_check')}
        </label>
        <p className="max-w-prose text-xs text-muted-foreground">
          {t('settings.update_check.hint')}
        </p>
        {toggle.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {t('installation.settings.refused')}
          </p>
        ) : null}
      </div>
      <Switch
        id={settingFieldId(UPDATE_CHECK)}
        checked={setting.value === true}
        disabled={toggle.isPending}
        onCheckedChange={(on) => toggle.mutate(on)}
      />
    </div>
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
  fixed: boolean | undefined
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  const id = settingFieldId(setting.key)
  const label = DIAL_LABEL[setting.key]
  const hint = DIAL_HINT[setting.key]
  const unit = DIAL_UNIT[setting.key]
  // A fixed currency is shown as text, so there is no field to label.
  const drawn = !(setting.type === 'currency' && fixed === true)
  const retroactive = setting.key === RETROACTIVE_DIAL

  return (
    <div className="space-y-1.5">
      {drawn ? (
        <label htmlFor={id} className="block text-sm">
          {label ? t(label) : setting.key}
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">{label ? t(label) : setting.key}</p>
      )}
      {setting.type === 'currency' ? (
        <CurrencyField id={id} value={value} onChange={onChange} fixed={fixed} />
      ) : (
        <div className="flex items-center gap-2.5">
          <Input
            id={id}
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
      {drawn ? (
        <p className="text-xs text-muted-foreground">{hint ? t(hint) : setting.doc}</p>
      ) : null}
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
