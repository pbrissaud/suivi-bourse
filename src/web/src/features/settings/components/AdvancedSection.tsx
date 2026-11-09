import { useQuery } from '@tanstack/react-query'

import { Input } from '@/components/ui/input'
import { TextAction } from '@/features/settings/components/ListSetting'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { type SettingDescription, settingsApi } from '@/features/settings/lib/api'
import { settingFieldId } from '@/features/settings/lib/installation'
import { useDial } from '@/features/settings/lib/useDial'
import { CURRENCY_KEY } from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'

/**
 * Registry dials this section leaves out. The currency has its own row in
 * Portfolio; the benchmark is chosen on the comparison page and the followed
 * ones in Portfolio (#1312); the release check is a switch on Système.
 */
const NOT_A_DIAL = new Set(['benchmark_symbol', 'benchmark_symbols', 'update_check', CURRENCY_KEY])

/**
 * What each known dial is called, how it is said in one clause, and the unit
 * the field speaks. `scale` is how many of the registry's units one of the
 * field's is worth: the cadences are stored in seconds and shown in minutes.
 * An unknown dial falls back to its key and the registry's own doc.
 */
const DIALS: Record<
  string,
  { label: MessageKey; hint: MessageKey; unit: MessageKey; scale: number }
> = {
  regular_interval: {
    label: 'settings.regular_interval',
    hint: 'settings.regular_interval.hint',
    unit: 'settings.unit.minutes',
    scale: 60,
  },
  backfill_interval: {
    label: 'settings.backfill_interval',
    hint: 'settings.backfill_interval.hint',
    unit: 'settings.unit.minutes',
    scale: 60,
  },
  backfill_delay: {
    label: 'settings.backfill_delay',
    hint: 'settings.backfill_delay.hint',
    unit: 'settings.unit.seconds',
    scale: 1,
  },
  backfill_chunk_days: {
    label: 'settings.backfill_chunk_days',
    hint: 'settings.backfill_chunk_days.hint',
    unit: 'settings.unit.days',
    scale: 1,
  },
  staleness_horizon: {
    label: 'settings.staleness_horizon',
    hint: 'settings.staleness_horizon.hint',
    unit: 'settings.unit.minutes',
    scale: 60,
  },
}

/** The five scraping dials, the expert ones, last. */
export function AdvancedSection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  return (
    <SettingsSection id="advanced" title={t('settings.advanced.title')} read={read}>
      {config.data?.settings
        .filter((setting) => !NOT_A_DIAL.has(setting.key))
        .map((setting) => (
          <DialRow key={setting.key} setting={setting} />
        ))}
    </SettingsSection>
  )
}

function DialRow({ setting }: { setting: SettingDescription }) {
  const { t } = useI18n()
  const known = DIALS[setting.key]
  const dial = useDial(setting.key, known?.scale ?? 1)
  const id = settingFieldId(setting.key)
  const unit = known ? t(known.unit) : ''
  const fallback = setting.default === null ? null : Number(setting.default) / (known?.scale ?? 1)
  const modified = fallback !== null && Number(setting.value) !== Number(setting.default)

  return (
    <SettingRow
      id={id}
      label={known ? t(known.label) : setting.key}
      state={dial.state}
      description={
        <>
          {known ? t(known.hint) : setting.doc}
          {fallback !== null ? (
            <>
              {' '}
              {t('settings.default')}{' '}
              <span className="fig text-foreground">{`${Math.round(fallback * 100) / 100}${unit ? ` ${unit}` : ''}`}</span>
              {modified ? (
                <>
                  {' · '}
                  <TextAction onClick={() => dial.set(String(Math.round(fallback * 100) / 100))}>
                    {t('settings.reset')}
                  </TextAction>
                </>
              ) : null}
            </>
          ) : null}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={setting.type === 'integer' ? 'number' : 'text'}
          inputMode={setting.type === 'integer' ? 'decimal' : undefined}
          min={setting.minimum === null ? undefined : setting.minimum / (known?.scale ?? 1)}
          max={setting.maximum === null ? undefined : setting.maximum / (known?.scale ?? 1)}
          step={known?.scale === 60 ? 'any' : undefined}
          aria-describedby={`${id}-description`}
          className="fig h-8 w-18 rounded-md bg-background px-2.5 text-right text-sm"
          {...dial.field}
        />
        <span className="w-9 text-sm text-muted-foreground">{unit}</span>
      </div>
    </SettingRow>
  )
}
