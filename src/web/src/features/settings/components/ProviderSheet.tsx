/**
 * *Fournisseur de l'agent* (`ProviderSheet-Refonte`): a provider's label, its
 * kind as sheet tabs, its key or its address, the sentence that says what is
 * sent to it, an optional test that lists its models, and whether it is the
 * default.
 *
 * **A provider need not pass a test to be saved.** The test lists the models
 * the provider serves (`POST /api/agent/providers/<id>/test`, `new` for one not
 * saved yet) and preselects one, which *Enregistrer* stores as its default
 * model. The key is typed here and never read back: the server answers its last
 * four characters and nothing else (#1114); left empty on an edit, the stored
 * one is kept.
 */
import { rememberModels } from '@/features/agent/lib/modelNames'
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { TextTabs } from '@/components/TextTabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { RefusalNotice } from '@/features/agent/components/RefusalNotice'
import { SettingsSheet, SheetField } from '@/features/settings/components/SettingsSheet'
import {
  api,
  type AgentProvider,
  type AgentProviderBody,
  type AgentProviderKind,
  type AgentProviderTest,
} from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, problemSentence, providerRefusal } from '@/lib/problem'

export const PROVIDER_KINDS: readonly AgentProviderKind[] = [
  'anthropic',
  'openai',
  'openai_compatible',
  'ollama',
]

export const KIND_LABEL: Record<AgentProviderKind, MessageKey> = {
  anthropic: 'settings.agent.provider.anthropic',
  openai: 'settings.agent.provider.openai',
  openai_compatible: 'settings.agent.provider.openai_compatible',
  ollama: 'settings.agent.provider.ollama',
}

/** The address Ollama listens on, on the machine it runs on. */
const OLLAMA_ADDRESS = 'http://localhost:11434'
const keyShown = (kind: AgentProviderKind) => kind !== 'ollama'
const addressShown = (kind: AgentProviderKind) => kind === 'openai_compatible' || kind === 'ollama'

const HOSTED_HOSTS: Partial<Record<AgentProviderKind, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
}

/**
 * Where the requests go, read off the address the reader typed — before the
 * server has seen it. A browser cannot resolve a name, so a name counts as this
 * network only when it says so (`localhost`, `.local`, `.lan`, `.internal`, no
 * dot at all) or is a private literal address; anything else is remote.
 */
function destination(kind: AgentProviderKind, address: string): { host: string; local: boolean } {
  const host = URL.parse(address)?.hostname.replace(/^\[|\]$/g, '') ?? ''
  if (host === '') return { host: HOSTED_HOSTS[kind] ?? address, local: false }
  return { host, local: LOCAL_HOST.test(host) }
}

/** A loopback, private or link-local literal, or a name that says it is local. */
const LOCAL_HOST =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{0,2}:|fe80:)|^[^.:]+$|\.(localhost|local|lan|internal|home\.arpa)$/i

/** What a provider is called in the list: its label, else its kind. */
export function providerName(t: (key: MessageKey) => string, provider: AgentProvider): string {
  return provider.label?.trim() || t(KIND_LABEL[provider.kind])
}

export function ProviderSheet({
  provider,
  first,
  onClose,
}: {
  /** The provider being edited, or `null` for a new one. */
  provider: AgentProvider | null
  /** Nothing is configured yet: the first provider is the default. */
  first: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const f = useFormatters()
  const client = useQueryClient()
  const labelId = useId()
  const addressId = useId()
  const keyId = useId()
  const [label, setLabel] = useState(provider?.label ?? '')
  const [kind, setKind] = useState<AgentProviderKind>(provider?.kind ?? 'anthropic')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [key, setKey] = useState('')
  const [model, setModel] = useState(provider?.default_model ?? '')
  const [isDefault, setIsDefault] = useState(provider?.is_default ?? first)
  const [tested, setTested] = useState<AgentProviderTest | null>(null)
  const [removing, setRemoving] = useState(false)

  const address = addressShown(kind) ? baseUrl.trim() : ''
  // A key belongs to the kind and the address it was typed for.
  const storedKey = provider?.key.set && provider.kind === kind && kind !== 'ollama'
  // The server resolves the host; before a write, the typed address is read as it stands.
  const unchanged = provider && provider.kind === kind && (provider.base_url ?? '') === address
  const where = unchanged
    ? { host: provider.privacy.host, local: provider.privacy.local }
    : destination(kind, address)

  const candidate = (): Pick<AgentProviderBody, 'kind' | 'base_url' | 'key'> => ({
    kind,
    base_url: address === '' ? null : address,
    ...(key.trim() !== '' ? { key: key.trim() } : {}),
  })

  const edit = (change: () => void) => {
    change()
    setTested(null)
    test.reset()
  }

  const test = useMutation({
    mutationFn: () => api.testAgentProvider(provider?.id ?? 'new', candidate()),
    onSuccess: (answer) => {
      rememberModels(answer.models)
      setTested(answer)
      setModel(answer.preselected ?? answer.models[0]?.id ?? '')
      void client.invalidateQueries({ queryKey: ['agent-providers'] })
    },
  })

  const write = useMutation({
    mutationFn: async () => {
      const body: AgentProviderBody = {
        ...candidate(),
        label: label.trim() === '' ? null : label.trim(),
        default_model: model === '' ? null : model,
      }
      const saved = provider
        ? await api.updateAgentProvider(provider.id, body)
        : await api.createAgentProvider(body)
      if (isDefault && !saved.is_default) await api.makeAgentProviderDefault(saved.id)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agent-providers'] })
      void client.invalidateQueries({ queryKey: ['agent-settings'] })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteAgentProvider(provider?.id ?? ''),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agent-providers'] })
      void client.invalidateQueries({ queryKey: ['agent-settings'] })
      onClose()
    },
  })

  const refusal = providerRefusal(test.error)
  const models = tested?.models ?? []
  const listed = models.some((one) => one.id === model)
  const options = listed || model === '' ? models : [{ id: model, name: model }, ...models]
  const valid = !addressShown(kind) || /^https?:\/\/\S+$/.test(address)

  return (
    <SettingsSheet
      open
      onClose={onClose}
      title={provider ? providerName(t, provider) : t('settings.provider.add')}
      onSubmit={() => {
        if (valid && !write.isPending) write.mutate()
      }}
      footer={
        <>
          {provider ? (
            <button
              type="button"
              className="mr-auto text-md text-destructive underline decoration-border underline-offset-3 outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => {
                remove.reset()
                setRemoving(true)
              }}
            >
              {t('settings.provider.remove.link')}
            </button>
          ) : (
            <span className="mr-auto" />
          )}
          <Button type="button" size="sheet" onClick={onClose}>
            {t('settings.access.cancel')}
          </Button>
          <Button type="submit" size="sheet" variant="primary" disabled={!valid || write.isPending}>
            {t('settings.save')}
          </Button>
        </>
      }
    >
      <SheetField
        id={labelId}
        label={t('settings.provider.label')}
        optional={t('data.form.optional')}
      >
        <Input
          id={labelId}
          value={label}
          placeholder={t('settings.provider.label.placeholder')}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
      </SheetField>

      <div className="flex flex-col gap-3.5">
        <TextTabs
          size="sheet"
          label={t('settings.provider.kind')}
          value={kind}
          onChange={(next) =>
            edit(() => {
              setKind(next)
              setKey('')
              setBaseUrl(
                next === provider?.kind
                  ? (provider.base_url ?? '')
                  : next === 'ollama'
                    ? OLLAMA_ADDRESS
                    : '',
              )
            })
          }
          tabs={PROVIDER_KINDS.map((one) => ({ value: one, label: t(KIND_LABEL[one]) }))}
        />
        {addressShown(kind) ? (
          <SheetField id={addressId} label={t('settings.agent.address')}>
            <Input
              id={addressId}
              type="url"
              className="fig"
              value={baseUrl}
              placeholder="https://"
              onChange={(event) => edit(() => setBaseUrl(event.target.value))}
            />
          </SheetField>
        ) : null}
        {keyShown(kind) ? (
          <SheetField id={keyId} label={t('settings.agent.key')}>
            <Input
              id={keyId}
              type="password"
              className="fig"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={
                storedKey && provider?.key.last4
                  ? `…${provider.key.last4}`
                  : kind === 'openai_compatible'
                    ? t('settings.provider.key.optional')
                    : undefined
              }
              onChange={(event) => edit(() => setKey(event.target.value))}
            />
          </SheetField>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {t(where.local ? 'settings.provider.privacy.local' : 'settings.provider.privacy.remote', {
            host: where.host,
          })}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <p className="label">
          {t('settings.provider.test')}{' '}
          <span className="font-normal">· {t('data.form.optional')}</span>
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
          <SheetField id="provider-model" label={t('settings.agent.model')}>
            <select
              id="provider-model"
              value={model}
              disabled={options.length === 0}
              onChange={(event) => setModel(event.target.value)}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 fig text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {options.length === 0 ? (
                <option value="">{t('settings.provider.model.afterTest')}</option>
              ) : (
                options.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name === one.id ? one.id : `${one.name} (${one.id})`}
                  </option>
                ))
              )}
            </select>
          </SheetField>
          <Button
            type="button"
            size="sheet"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {t('settings.agent.test')}
          </Button>
        </div>
        {test.isError ? (
          refusal ? (
            <RefusalNotice
              provider={t(KIND_LABEL[kind])}
              reason={refusal.reason}
              said={refusal.said}
            />
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {t(problemMessageKey(test.error))}
            </p>
          )
        ) : tested ? (
          <p role="status" className="text-sm">
            {t('settings.provider.test.passed', {
              seconds: tested.elapsed_ms / 1000,
              count: tested.models.length,
            })}
          </p>
        ) : provider?.last_test_at ? (
          <p className="text-sm text-muted-foreground">
            {t('settings.provider.test.last', { date: f.date(provider.last_test_at) })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('settings.provider.test.idle')}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t pt-5">
        <label htmlFor="provider-default">{t('settings.provider.default')}</label>
        <Switch
          id="provider-default"
          checked={isDefault}
          // The default is changed by making another one the default.
          disabled={provider?.is_default === true || first}
          onCheckedChange={setIsDefault}
        />
      </div>

      {write.isError ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}

      <ConfirmDestructive
        open={removing}
        onOpenChange={(next) => (next ? undefined : setRemoving(false))}
        title={t('settings.provider.remove.title', {
          name: provider ? providerName(t, provider) : '',
        })}
        line={t('settings.provider.remove.line')}
        confirmLabel={t('settings.provider.remove')}
        pending={remove.isPending}
        error={remove.isError ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
        onConfirm={() => remove.mutate()}
      />
    </SettingsSheet>
  )
}
