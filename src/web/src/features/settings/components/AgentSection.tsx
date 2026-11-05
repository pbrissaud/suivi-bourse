/**
 * *L’agent* on the row pattern (#1279). Its switch is its first row, « Agent
 * activé », saved on change; the connection is a procedure, so « Fournisseur »
 * opens it in a Sheet (`AgentProviderSheet`); the model and the thinking level
 * are values, saved on change, **without the key asked again**.
 *
 * The model list is asked for on demand: the Select's first opening sends an
 * empty `POST /agent/test`, which lists the stored provider's models with the
 * stored key; loading `/settings` asks the provider nothing.
 *
 * The agent is off by default, and cannot be switched on before a connection
 * has passed its test and a model is stored.
 */
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { RefusalNotice } from '@/features/agent/components/RefusalNotice'
import { agentApi, type AgentConfig, type AgentThinking } from '@/features/agent/lib/api'
import {
  AgentProviderSheet,
  PROVIDER_LABEL,
} from '@/features/settings/components/AgentProviderSheet'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { addressRequired } from '@/features/settings/lib/agentSetup'
import { useRowSave } from '@/features/settings/lib/useRowSave'
import { useDocs } from '@/lib/docs'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, providerRefusal } from '@/lib/problem'

const THINKING_LEVELS: AgentThinking[] = ['low', 'medium', 'high']

const THINKING_LABEL: Record<AgentThinking, MessageKey> = {
  low: 'settings.agent.thinking.low',
  medium: 'settings.agent.thinking.medium',
  high: 'settings.agent.thinking.high',
}

/** A provider's model list, asked once in a while: it costs the provider a call. */
const MODELS_STALE_MS = 10 * 60 * 1000

export function AgentSection({
  read,
  config,
}: {
  read: SectionRead
  config: AgentConfig | undefined
}) {
  const { t } = useI18n()
  return (
    <SettingsSection id="agent" title={t('settings.agent.title')} read={read}>
      {config ? <AgentRows config={config} /> : null}
    </SettingsSection>
  )
}

function AgentRows({ config }: { config: AgentConfig }) {
  const { t, language } = useI18n()
  const { docsPageHref } = useDocs()
  const client = useQueryClient()
  const [sheet, setSheet] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const stored = (answer: AgentConfig) => client.setQueryData(['agent-config'], answer)

  const configured = config.provider !== null && config.model !== null

  const toggle = useRowSave({
    send: (enabled: boolean) => agentApi.saveAgentConfig({ enabled }),
    onAnswer: stored,
  })

  const provider = config.provider
  const summary = provider
    ? [
        t(PROVIDER_LABEL[provider]),
        config.key.set && config.key.last4
          ? t('settings.agent.key.last4', { last4: config.key.last4 })
          : addressRequired(provider)
            ? config.base_url
            : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('settings.agent.notConfigured')

  return (
    <>
      <SettingRow
        id="agent-enabled"
        label={t('settings.agent.enabled')}
        description={configured ? undefined : t('settings.agent.activate.why')}
        state={toggle.state}
      >
        <Switch
          id="agent-enabled"
          aria-describedby={configured ? undefined : 'agent-enabled-description'}
          className="pointer-coarse:after:-inset-3.5"
          checked={toggle.chosen?.value ?? config.enabled}
          // On needs a model: the one a passed test stored.
          disabled={!configured && !config.enabled}
          onCheckedChange={(on) => toggle.save(on)}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.agent.providerRow')}
        description={
          <>
            <p>{summary}</p>
            <p>
              <a
                href={docsPageHref(language, 'settings', 'agent')}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-4"
              >
                {t('settings.agent.contract')}
              </a>
            </p>
          </>
        }
      >
        <Button
          ref={opener}
          variant={configured ? 'outline' : 'default'}
          className="max-md:h-11"
          onClick={() => setSheet(true)}
        >
          {t(configured ? 'settings.agent.change' : 'settings.agent.configure')}
        </Button>
        <AgentProviderSheet
          open={sheet}
          onClose={() => setSheet(false)}
          config={config}
          opener={opener}
        />
      </SettingRow>

      {configured ? <ModelRow config={config} /> : null}
      {configured ? <ThinkingRow config={config} /> : null}
    </>
  )
}

/** The model, chosen among what the stored provider lists, saved on change. */
function ModelRow({ config }: { config: AgentConfig }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const [asked, setAsked] = useState(false)
  const id = 'agent-model'

  const models = useQuery({
    queryKey: ['agent-models', config.provider, config.base_url],
    queryFn: async () => {
      // An empty candidate: the stored provider, address and key.
      const answer = await agentApi.testAgent({})
      client.setQueryData(['agent-config'], answer.config)
      return answer.models
    },
    enabled: asked,
    staleTime: MODELS_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  })

  const save = useRowSave({
    send: (model: { id: string; name: string | null }) =>
      agentApi.saveAgentConfig({ model: model.id, model_name: model.name }),
    onAnswer: (answer: AgentConfig) => client.setQueryData(['agent-config'], answer),
  })

  const current = save.chosen?.value.id ?? config.model ?? ''
  const listed = models.data ?? []
  // The stored model stays offered while the list is on its way, or if the
  // provider no longer lists it.
  const options = listed.some((one) => one.id === config.model)
    ? listed
    : [{ id: config.model ?? '', name: config.model_name ?? config.model ?? '' }, ...listed]
  const refusal = providerRefusal(models.error)

  return (
    <SettingRow id={id} label={t('settings.agent.model')} state={save.state}>
      <Select
        value={current}
        onOpenChange={(open) => {
          if (!open) return
          // A list that failed is asked again at the next opening.
          if (asked && models.isError) void models.refetch()
          setAsked(true)
        }}
        onValueChange={(next) => {
          const name = options.find((one) => one.id === next)?.name ?? null
          save.save({ id: next, name })
        }}
      >
        <SelectTrigger id={id} className="w-60 max-md:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((one) => (
            <SelectItem key={one.id} value={one.id}>
              {one.name && one.name !== one.id ? one.name : one.id}
            </SelectItem>
          ))}
          {models.isFetching ? (
            <SelectItem value="__loading" disabled>
              {t('settings.agent.models.loading')}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {models.isError ? (
        <div className="max-w-72">
          {refusal && config.provider ? (
            <RefusalNotice
              provider={t(`agent.provider.${config.provider}`)}
              reason={refusal.reason}
              said={refusal.said}
            />
          ) : (
            <p role="alert" className="text-right text-xs text-destructive">
              {t(problemMessageKey(models.error))}
            </p>
          )}
        </div>
      ) : null}
    </SettingRow>
  )
}

/** Written at once, with nothing else: not a field of the connection, so no test (#1191). */
function ThinkingRow({ config }: { config: AgentConfig }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const id = 'agent-thinking'
  const save = useRowSave({
    send: (thinking: AgentThinking) => agentApi.saveAgentConfig({ thinking }),
    onAnswer: (answer: AgentConfig) => client.setQueryData(['agent-config'], answer),
  })

  return (
    <SettingRow
      id={id}
      label={t('settings.agent.thinking')}
      description={t('settings.agent.thinking.help')}
      state={save.state}
    >
      <Select
        value={save.chosen?.value ?? config.thinking}
        onValueChange={(next) => save.save(next as AgentThinking)}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-description`} className="w-44 max-md:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {THINKING_LEVELS.map((level) => (
            <SelectItem key={level} value={level}>
              {t(THINKING_LABEL[level])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
}
