import { useQuery } from '@tanstack/react-query'

import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { type SettingDescription, settingsApi } from '@/features/settings/lib/api'
import {
  cadenceReach,
  RETROACTIVE_DIAL,
  settingFieldId,
} from '@/features/settings/lib/installation'
import { useDial } from '@/features/settings/lib/useDial'
import type { RuntimeState } from '@/lib/api'
import { CURRENCY_KEY } from '@/lib/firstRun'
import { useI18n, type MessageKey } from '@/lib/i18n'

const UPDATE_CHECK = 'update_check'

/**
 * Registry dials this section leaves out. The currency has its own row in
 * Portfolio; the benchmark is chosen on the comparison page and the followed
 * ones in Portfolio (#1312); the release check is a switch (#1237).
 */
const NOT_A_DIAL = new Set(['benchmark_symbol', 'benchmark_symbols', UPDATE_CHECK, CURRENCY_KEY])

/**
 * What each known dial is called, how it is explained and in what unit. An unknown one falls back to its key and the registry's own doc.
 * A dial whose label already says what it does carries no hint (#1412).
 */
const DIALS: Record<string, { label: MessageKey; hint?: MessageKey; unit: MessageKey }> = {
  regular_interval: {
    label: 'settings.regular_interval',
    hint: 'settings.regular_interval.hint',
    unit: 'settings.unit.seconds',
  },
  backfill_interval: {
    label: 'settings.backfill_interval',
    unit: 'settings.unit.seconds',
  },
  backfill_delay: {
    label: 'settings.backfill_delay',
    unit: 'settings.unit.seconds',
  },
  backfill_chunk_days: {
    label: 'settings.backfill_chunk_days',
    unit: 'settings.unit.days',
  },
  staleness_horizon: {
    label: 'settings.staleness_horizon',
    hint: 'settings.staleness_horizon.hint',
    unit: 'settings.unit.seconds',
  },
}

/** The five scraping dials, then the release switch: the expert ones, last. */
export function AdvancedSection({
  runtime,
  read,
}: {
  runtime: RuntimeState | undefined
  read: SectionRead
}) {
  const { t } = useI18n()
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  return (
    <SettingsSection
      id="advanced"
      title={t('settings.advanced.title')}
      summary={t('settings.advanced.summary')}
      read={read}
    >
      {config.data?.settings
        .filter((setting) => !NOT_A_DIAL.has(setting.key))
        .map((setting) => (
          <DialRow key={setting.key} setting={setting} runtime={runtime} />
        ))}
      <ReleaseRow />
    </SettingsSection>
  )
}

function DialRow({
  setting,
  runtime,
}: {
  setting: SettingDescription
  runtime: RuntimeState | undefined
}) {
  const { t } = useI18n()
  const dial = useDial(setting.key)
  const id = settingFieldId(setting.key)
  const known = DIALS[setting.key]
  const reach = setting.key === RETROACTIVE_DIAL ? cadenceReach(runtime) : null

  return (
    <SettingRow
      id={id}
      label={known ? t(known.label) : setting.key}
      state={dial.state}
      description={
        <>
          {known ? known.hint ? <p>{t(known.hint)}</p> : null : <p>{setting.doc}</p>}
          {reach ? (
            <p>{t('settings.cadence.reach', { now: reach.now, later: reach.atMarketOpen })}</p>
          ) : null}
          {setting.key === RETROACTIVE_DIAL ? <p>{t('settings.backoff.retroactive')}</p> : null}
        </>
      }
    >
      <div className="flex items-center gap-2.5">
        <Input
          id={id}
          type={setting.type === 'integer' ? 'number' : 'text'}
          inputMode={setting.type === 'integer' ? 'numeric' : undefined}
          min={setting.minimum ?? undefined}
          max={setting.maximum ?? undefined}
          aria-describedby={`${id}-description`}
          className="tabular h-9.5 w-27 rounded-lg bg-background max-md:h-11"
          {...dial.field}
        />
        {/* One width for every unit, so the inputs line up whatever theirs (#1359). */}
        <span className="w-16 text-xs text-muted-foreground">{known ? t(known.unit) : null}</span>
      </div>
    </SettingRow>
  )
}

/** On or off, saved at once: no draft to hold, and a second click waits its turn. */
function ReleaseRow() {
  const { t } = useI18n()
  const dial = useDial(UPDATE_CHECK)
  if (!dial.setting) return null
  const id = settingFieldId(UPDATE_CHECK)
  return (
    <SettingRow
      id={id}
      label={t('settings.update_check')}
      description={t('settings.update_check.hint')}
      state={dial.state}
    >
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        // The hit area grows to 44 px under 768 px, the track stays 18 px.
        className="max-md:after:-inset-3.5"
        checked={dial.draft === 'true'}
        onCheckedChange={(on) => dial.set(String(on))}
      />
    </SettingRow>
  )
}
