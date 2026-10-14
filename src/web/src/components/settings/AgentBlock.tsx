/**
 * *L’analyste* — **switching it on, in four guided steps** (#1115, design
 * review 6A), for a reader who has never configured a model.
 *
 * 1. **The provider**, each with the one sentence that tells them apart;
 * 2. **its key**, with where to find one, or Ollama's address;
 * 3. **Tester la connexion**: the form is written to the store, then the server
 *    lists the provider's models with what it stored, and preselects one. A
 *    failure is said in the provider's own words;
 * 4. **the outbound contract** — what leaves for the provider and what never
 *    does — and *Activer*, which stays disabled until step 3 has passed **for
 *    what is on screen**: any edit to steps 1 and 2 takes the pass back.
 *
 * The key is typed here and never read back: the server answers its last four
 * characters and nothing else (#1114). The analyst is off by default.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  AGENT_PROVIDERS,
  addressRequired,
  canActivate,
  canTest,
  draftOf,
  KEY_PAGE,
  keyRefused,
  keyRequired,
  OLLAMA_ADDRESS,
  setupWrites,
  storedKeyApplies,
  type AgentDraft,
} from '@/lib/agentSetup'
import { api, type AgentConfig, type AgentProvider, type AgentTestResult } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, providerRefusal } from '@/lib/problem'

const AGENT_HEADING = 'settings-agent'

/** The `<select>` skin the forms share (`TaxationModelField`, `EventForm`). */
const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

const PROVIDER_LABEL: Record<AgentProvider, MessageKey> = {
  anthropic: 'settings.agent.provider.anthropic',
  openai: 'settings.agent.provider.openai',
  openai_compatible: 'settings.agent.provider.openai_compatible',
  ollama: 'settings.agent.provider.ollama',
}

const PROVIDER_HINT: Record<AgentProvider, MessageKey> = {
  anthropic: 'settings.agent.provider.anthropic.hint',
  openai: 'settings.agent.provider.openai.hint',
  openai_compatible: 'settings.agent.provider.openai_compatible.hint',
  ollama: 'settings.agent.provider.ollama.hint',
}

const FAILURE: Record<string, MessageKey> = {
  refused: 'settings.agent.test.refused',
  unreachable: 'settings.agent.test.unreachable',
  unreadable: 'settings.agent.test.unreadable',
}

export function AgentBlock({ config }: { config: AgentConfig }) {
  const { t } = useI18n()
  const client = useQueryClient()
  // Seeded once from the store: a refetch after a write must not wipe what
  // the reader is typing, nor the test that just passed.
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(config))
  const [tested, setTested] = useState<AgentTestResult | null>(null)
  const [model, setModel] = useState('')

  const edit = (change: Partial<AgentDraft>) => {
    setDraft((current) => ({ ...current, ...change }))
    // What was tested is no longer what is on screen.
    setTested(null)
    setModel('')
    test.reset()
  }

  const stored = (answer: AgentConfig) => client.setQueryData(['agent-config'], answer)

  const test = useMutation({
    mutationFn: async () => {
      for (const write of setupWrites(config, draft)) {
        if (write.kind === 'config') stored(await api.saveAgentConfig(write.body))
        else stored(await api.saveAgentKey(write.key))
      }
      return api.testAgent()
    },
    onSuccess: (answer) => {
      setTested(answer)
      setModel(answer.preselected ?? '')
      // Stored now: the field goes back to saying so by its last four.
      setDraft((current) => ({ ...current, key: '' }))
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-config'] }),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.saveAgentConfig(enabled ? { model, enabled: true } : { enabled: false }),
    onSuccess: stored,
  })

  const provider = draft.provider
  const providerName = provider ? t(PROVIDER_LABEL[provider]) : ''
  const testable = canTest(config, draft)
  const keyShown = provider !== null && !keyRefused(provider)
  const addressShown = provider !== null && addressRequired(provider)
  const keyLast4 = storedKeyApplies(config, draft) ? config.key.last4 : null
  const keyPage = provider ? KEY_PAGE[provider] : undefined
  const refusal = providerRefusal(test.error)

  return (
    <Card role="region" aria-labelledby={AGENT_HEADING}>
      <CardHeader>
        <h2 id={AGENT_HEADING} className="label">
          {t('settings.agent.title')}
        </h2>
        <p className="max-w-prose text-xs text-muted-foreground">{t('settings.agent.note')}</p>
        {config.enabled && config.provider && config.model ? (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <p role="status" className="text-sm">
              {t('settings.agent.on', {
                provider: t(PROVIDER_LABEL[config.provider]),
                model: config.model,
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              {t('settings.agent.disable')}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('settings.agent.step.provider')}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AGENT_PROVIDERS.map((one) => (
              <label
                key={one}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 has-checked:border-primary"
              >
                <input
                  type="radio"
                  name="agent-provider"
                  value={one}
                  checked={provider === one}
                  onChange={() =>
                    edit({
                      provider: one,
                      key: '',
                      baseUrl:
                        one === config.provider
                          ? (config.base_url ?? '')
                          : one === 'ollama'
                            ? OLLAMA_ADDRESS
                            : '',
                    })
                  }
                  className="mt-0.5 accent-primary"
                />
                <span className="space-y-0.5">
                  <span className="block text-sm">{t(PROVIDER_LABEL[one])}</span>
                  <span className="block text-2xs leading-relaxed text-muted-foreground">
                    {t(PROVIDER_HINT[one])}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {provider !== null ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">
              {t(keyRequired(provider) ? 'settings.agent.step.key' : 'settings.agent.step.address')}
            </h3>
            {addressShown ? (
              <div className="space-y-1.5">
                <label htmlFor="agent-address" className="block text-sm">
                  {t('settings.agent.address')}
                </label>
                <Input
                  id="agent-address"
                  type="url"
                  value={draft.baseUrl}
                  onChange={(event) => edit({ baseUrl: event.target.value })}
                  className="font-mono"
                />
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t(
                    provider === 'ollama'
                      ? 'settings.agent.address.ollama.hint'
                      : 'settings.agent.address.gateway.hint',
                  )}
                </p>
              </div>
            ) : null}
            {keyShown ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <label htmlFor="agent-key" className="block text-sm">
                    {t(
                      keyRequired(provider) ? 'settings.agent.key' : 'settings.agent.key.optional',
                    )}
                  </label>
                  {keyPage ? (
                    <a
                      href={keyPage}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      {t('settings.agent.key.where')}
                    </a>
                  ) : null}
                </div>
                <Input
                  id="agent-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.key}
                  placeholder={keyLast4 ? `…${keyLast4}` : undefined}
                  onChange={(event) => edit({ key: event.target.value })}
                  className="font-mono"
                />
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {keyLast4
                    ? t('settings.agent.key.stored', { last4: keyLast4 })
                    : t('settings.agent.key.note')}
                </p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('settings.agent.step.test')}</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={!testable || test.isPending}
              onClick={() => test.mutate()}
            >
              {t('settings.agent.test')}
            </Button>
            {!testable ? (
              <p className="text-xs text-muted-foreground">{t('settings.agent.test.why')}</p>
            ) : null}
          </div>
          {tested ? (
            <div className="space-y-2">
              <p role="status" className="text-sm">
                {tested.models.length === 0
                  ? t('settings.agent.test.empty', { provider: providerName })
                  : t('settings.agent.test.passed', {
                      provider: providerName,
                      count: tested.models.length,
                    })}
              </p>
              {tested.models.length > 0 ? (
                <div className="space-y-1.5">
                  <label htmlFor="agent-model" className="block text-sm">
                    {t('settings.agent.model')}
                  </label>
                  <select
                    id="agent-model"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    className={SELECT}
                  >
                    {tested.models.map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.name === one.id ? one.id : `${one.name} (${one.id})`}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}
          {test.isError ? (
            refusal ? (
              <div role="alert" className="space-y-1">
                <p className="text-sm text-destructive">
                  {t(FAILURE[refusal.reason] ?? FAILURE.refused, { provider: providerName })}
                </p>
                <p className="font-mono text-xs break-words">{refusal.said}</p>
              </div>
            ) : (
              <p role="alert" className="text-sm text-destructive">
                {t(problemMessageKey(test.error))}
              </p>
            )
          ) : null}
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('settings.agent.step.contract')}</h3>
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <p className="label">{t('settings.agent.contract.sent')}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                <li>{t('settings.agent.contract.sent.tools')}</li>
                <li>{t('settings.agent.contract.sent.facts')}</li>
                <li>{t('settings.agent.contract.sent.conversation')}</li>
                <li>{t('settings.agent.contract.sent.statements')}</li>
              </ul>
            </div>
            <div>
              <p className="label">{t('settings.agent.contract.kept')}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                <li>{t('settings.agent.contract.kept.key')}</li>
                <li>{t('settings.agent.contract.kept.income')}</li>
                <li>{t('settings.agent.contract.kept.install')}</li>
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={!canActivate(tested !== null, model) || toggle.isPending}
              onClick={() => toggle.mutate(true)}
            >
              {t('settings.agent.activate')}
            </Button>
            {tested === null ? (
              <p className="text-xs text-muted-foreground">{t('settings.agent.activate.why')}</p>
            ) : null}
            {toggle.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(problemMessageKey(toggle.error))}
              </p>
            ) : null}
          </div>
        </section>
      </CardContent>
    </Card>
  )
}
