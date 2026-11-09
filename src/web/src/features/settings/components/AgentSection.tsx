/**
 * *Agent* on the row pattern. Its switch is its first row, « Agent activé »,
 * saved on change; the providers are a ruled list — name, « Par défaut »,
 * « Modifier » — ending on « Ajouter un fournisseur », each opening
 * `ProviderSheet`; « Réflexion » is a value, saved on change.
 *
 * The agent is off by default, and the server refuses to switch it on before a
 * default provider holds a model: the refusal is said on the switch's row.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Segmented } from '@/components/Segmented'
import { Switch } from '@/components/ui/switch'
import {
  AddRow,
  ListRow,
  ListSetting,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { ProviderSheet, providerName } from '@/features/settings/components/ProviderSheet'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { settingsApi } from '@/features/settings/lib/api'
import { useRowSave } from '@/features/settings/lib/useRowSave'
import type { AgentProvider, AgentSettings } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'

const THINKING_LEVELS: AgentSettings['reasoning'][] = ['low', 'medium', 'high']

const THINKING_LABEL: Record<AgentSettings['reasoning'], MessageKey> = {
  low: 'settings.agent.thinking.low',
  medium: 'settings.agent.thinking.medium',
  high: 'settings.agent.thinking.high',
}

export function AgentSection({
  read,
  settings,
  providers,
}: {
  read: SectionRead
  settings: AgentSettings | undefined
  providers: AgentProvider[] | undefined
}) {
  const { t } = useI18n()
  return (
    <SettingsSection id="agent" title={t('settings.agent.title')} read={read}>
      {settings && providers ? <AgentRows settings={settings} providers={providers} /> : null}
    </SettingsSection>
  )
}

function AgentRows({
  settings,
  providers,
}: {
  settings: AgentSettings
  providers: AgentProvider[]
}) {
  const { t } = useI18n()
  const client = useQueryClient()
  /** `undefined` closed, `null` a new provider, otherwise the one being edited. */
  const [sheet, setSheet] = useState<AgentProvider | null | undefined>(undefined)
  const stored = (answer: AgentSettings) => client.setQueryData(['agent-settings'], answer)

  const toggle = useRowSave({
    send: (enabled: boolean) => settingsApi.saveAgentSettings({ enabled }),
    onAnswer: stored,
  })
  const thinking = useRowSave({
    send: (reasoning: AgentSettings['reasoning']) => settingsApi.saveAgentSettings({ reasoning }),
    onAnswer: stored,
  })

  return (
    <>
      <SettingRow id="agent-enabled" label={t('settings.agent.enabled')} state={toggle.state}>
        <Switch
          id="agent-enabled"
          checked={toggle.chosen?.value ?? settings.enabled}
          onCheckedChange={(on) => toggle.save(on)}
        />
      </SettingRow>

      <ListSetting label={t('settings.agent.providers')}>
        {providers.map((provider) => (
          <ListRow
            key={provider.id}
            name={providerName(t, provider)}
            aside={provider.is_default ? t('settings.provider.isDefault') : undefined}
            actions={
              <TextAction
                aria-label={`${t('settings.provider.edit')} ${providerName(t, provider)}`}
                onClick={() => setSheet(provider)}
              >
                {t('settings.provider.edit')}
              </TextAction>
            }
          />
        ))}
        <AddRow onClick={() => setSheet(null)}>{t('settings.provider.add')}</AddRow>
      </ListSetting>

      <SettingRow label={t('settings.agent.thinking')} state={thinking.state}>
        <Segmented
          mode="radio"
          bordered
          size="compact"
          label={t('settings.agent.thinking')}
          value={thinking.chosen?.value ?? settings.reasoning}
          onChange={(next) => thinking.save(next)}
          options={THINKING_LEVELS.map((level) => ({
            value: level,
            label: t(THINKING_LABEL[level]),
          }))}
        />
      </SettingRow>

      {sheet !== undefined ? (
        <ProviderSheet
          key={sheet?.id ?? 'new'}
          provider={sheet}
          first={providers.length === 0}
          onClose={() => setSheet(undefined)}
        />
      ) : null}
    </>
  )
}
