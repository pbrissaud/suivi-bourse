/**
 * *L’agent* — **switching it on, in four guided steps** (#1115, design
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
 * characters and nothing else (#1114). The agent is off by default.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
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
} from '@/features/settings/lib/agentSetup'
import {
  agentApi,
  type AgentConfig,
  type AgentProvider,
  type AgentTestResult,
} from '@/features/agent/lib/api'
import { docsPageHref } from '@/lib/docs'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, providerRefusal } from '@/lib/problem'

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
  const { t, language } = useI18n()
  const client = useQueryClient()
  // Seeded once from the store: a refetch after a write must not wipe what
  // the reader is typing, nor the test that just passed.
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(config))
  const [tested, setTested] = useState<AgentTestResult | null>(null)
  const [model, setModel] = useState('')
  // Steps 1 and 2 edited since the last passed test: the stored model no longer
  // answers for them, even once a failed test has written them to the store.
  const [untested, setUntested] = useState(false)

  const edit = (change: Partial<AgentDraft>) => {
    setDraft((current) => ({ ...current, ...change }))
    setUntested(true)
    // What was tested is no longer what is on screen.
    setTested(null)
    setModel('')
    test.reset()
  }

  const stored = (answer: AgentConfig) => client.setQueryData(['agent-config'], answer)

  const test = useMutation({
    mutationFn: async () => {
      for (const write of setupWrites(config, draft)) {
        if (write.kind === 'config') stored(await agentApi.saveAgentConfig(write.body))
        else stored(await agentApi.saveAgentKey(write.key))
      }
      return agentApi.testAgent()
    },
    onSuccess: (answer) => {
      setTested(answer)
      setUntested(false)
      setModel(answer.preselected ?? '')
      // Stored now: the field goes back to saying so by its last four.
      setDraft((current) => ({ ...current, key: '' }))
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-config'] }),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      agentApi.saveAgentConfig(
        enabled ? { model: model || (config.model ?? ''), enabled: true } : { enabled: false },
      ),
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
  // A test this session decides; without one, the stored model can be switched back on.
  const activatable =
    tested !== null ? canActivate(true, model) : !untested && config.model !== null

  return (
    <Section
      title={t('settings.agent.title')}
      aside={
        <span className="flex items-center gap-3">
          {config.enabled && config.provider && config.model ? (
            <span role="status" className="text-sm text-muted-foreground">
              {t('settings.agent.on', {
                provider: t(PROVIDER_LABEL[config.provider]),
                model: config.model,
              })}
            </span>
          ) : null}
          <Switch
            aria-label={t('settings.agent.switch')}
            checked={config.enabled}
            // On needs a model: the one the test just picked, or the one stored.
            disabled={toggle.isPending || (!config.enabled && !activatable)}
            onCheckedChange={(on) => toggle.mutate(on)}
          />
        </span>
      }
    >
      <div className="space-y-6">
        <p className="max-w-prose text-xs text-muted-foreground">{t('settings.agent.note')}</p>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('settings.agent.step.provider')}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AGENT_PROVIDERS.map((one) => (
              <label
                key={one}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-card p-3 has-checked:border-primary"
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
                  {/* While on, the switch has nothing to flip: a new model is saved here. */}
                  {config.enabled && model !== '' && model !== config.model ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(true)}
                    >
                      {t('settings.agent.model.use')}
                    </Button>
                  ) : null}
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

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {config.enabled ? null : (
            <p>
              {t(activatable ? 'settings.agent.activate.ready' : 'settings.agent.activate.why')}
            </p>
          )}
          <a
            href={docsPageHref(language, 'settings', 'agent')}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('settings.agent.contract')}
          </a>
        </div>
        {toggle.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t(problemMessageKey(toggle.error))}
          </p>
        ) : null}
      </div>
    </Section>
  )
}
