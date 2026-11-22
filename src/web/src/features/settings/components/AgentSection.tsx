/**
 * *Agent* on the row pattern. Its switch is its first row, « Agent activé »,
 * saved on change; the providers are a ruled list — name, « Par défaut »,
 * « Modifier » — ending on « Ajouter un fournisseur », each opening
 * `ProviderSheet`; « Réflexion » is a value, saved on change; « Recherche web
 * (SearXNG) » is an address, saved when the field is left or on Enter.
 *
 * The agent is off by default, and the server refuses to switch it on before a
 * default provider holds a model: the refusal is said on the switch's row.
 */
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { Segmented } from '@/components/Segmented'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  AddRow,
  ListRow,
  ListSetting,
  TEXT_ACTION,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { ProviderSheet, providerName } from '@/features/settings/components/ProviderSheet'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { settingsApi } from '@/features/settings/lib/api'
import { useRowSave } from '@/features/settings/lib/useRowSave'
import type { AgentProvider, AgentSettings } from '@/lib/api'
import { useDocs } from '@/lib/docs'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { settingRefusal } from '@/lib/problem'

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
      <SettingRow
        id="agent-enabled"
        label={t('settings.agent.enabled')}
        description={providers.length === 0 ? t('settings.agent.enabled.needsProvider') : undefined}
        state={toggle.state}
      >
        <Switch
          id="agent-enabled"
          checked={toggle.chosen?.value ?? settings.enabled}
          onCheckedChange={(on) => toggle.save(on)}
          disabled={providers.length === 0}
          aria-describedby={providers.length === 0 ? 'agent-enabled-description' : undefined}
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

      <SearchRow settings={settings} onAnswer={stored} />

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

/**
 * The owner's SearXNG: empty is off, and clearing the field saves `null`. The
 * server asks the address before storing it (up to 5 s), so a refusal is the
 * instance's own answer and is said as such; the refused text stays in the
 * field. Leaving the field saves what was edited, Enter also asks again an
 * address that was just refused, Escape gives back the stored one.
 */
function SearchRow({
  settings,
  onAnswer,
}: {
  settings: AgentSettings
  onAnswer: (answer: AgentSettings) => void
}) {
  const { t, language } = useI18n()
  const { docsPageHref } = useDocs()
  const held = settings.search_url ?? null
  /** `null` shows what the server holds. */
  const [typed, setTyped] = useState<string | null>(null)
  // Edited since the last save: leaving the field must not ask the same address twice.
  const edited = useRef(false)
  const search = useRowSave({
    send: (search_url: string | null) => settingsApi.saveAgentSettings({ search_url }),
    onAnswer: (answer) => {
      onAnswer(answer)
      // What was typed while the address was asked is kept.
      setTyped((now) =>
        now !== null && (now.trim() || null) === (answer.search_url ?? null) ? null : now,
      )
    },
    said: (error) => settingRefusal(error, 'search_url'),
  })
  // A refusal is about the text in the field; once the stored one is back, it is not.
  const state =
    typed === null && search.state.kind === 'failed' ? ({ kind: 'idle' } as const) : search.state
  const privacy = settings.search_privacy?.[language === 'en' ? 'en' : 'fr']

  function commit(again: boolean) {
    if (typed === null) return
    const next = typed.trim() || null
    if (!again && !edited.current) return
    edited.current = false
    if (next === held) setTyped(null)
    else search.save(next)
  }

  return (
    <SettingRow
      id="agent-search"
      label={t('settings.agent.search')}
      description={
        <>
          {t('settings.agent.search.description')}{' '}
          <a
            href={docsPageHref(language, 'set-up-the-agent', 'web-search')}
            target="_blank"
            rel="noreferrer"
            className={TEXT_ACTION}
          >
            {t('settings.agent.search.docs')}
          </a>
        </>
      }
      state={state}
      wide
    >
      <Input
        id="agent-search"
        type="url"
        className="fig h-8 w-full rounded-md bg-background px-2.5 text-sm sm:w-72"
        spellCheck={false}
        placeholder="https://"
        value={typed ?? held ?? ''}
        aria-invalid={state.kind === 'failed' || undefined}
        aria-describedby={`agent-search-description${privacy ? ' agent-search-privacy' : ''}`}
        onChange={(event) => {
          edited.current = true
          setTyped(event.target.value)
        }}
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(true)
          if (event.key === 'Escape') setTyped(null)
        }}
      />
      {privacy ? (
        <p id="agent-search-privacy" className="max-w-72 text-right text-xs text-muted-foreground">
          {privacy}
        </p>
      ) : null}
    </SettingRow>
  )
}
