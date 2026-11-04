/**
 * *Fournisseur* — **the agent's connection, in a Sheet** (#1279), for a reader
 * who has never configured a model (#1115, design review 6A).
 *
 * 1. **The provider**, each with the one sentence that tells them apart;
 * 2. **its key**, with where to find one, or the address of a gateway or of
 *    Ollama; left empty, the stored one is kept, shown by its last four;
 * 3. **Tester la connexion**: the form goes to the server as one candidate,
 *    which lists the provider's models with it and preselects one, and keeps
 *    the candidate only on a pass (#1269). A failure is said in a sentence of
 *    ours, the provider's own words folded behind it;
 * 4. **Enregistrer** stores the model chosen, and stays disabled until step 3
 *    has passed **for what is on screen**: any edit to steps 1 and 2 takes the
 *    pass back.
 *
 * A passed test that changes the provider, its key or its address switches the
 * agent off on the server; *Enregistrer* switches it back on when it was on as
 * the sheet opened, and on for the first time when nothing was configured.
 * The key is typed here and never read back: the server answers its last four
 * characters and nothing else (#1114).
 */
import { type RefObject, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { RefusalNotice } from '@/features/agent/components/RefusalNotice'
import {
  agentApi,
  type AgentConfig,
  type AgentProvider,
  type AgentTestResult,
} from '@/features/agent/lib/api'
import {
  AGENT_PROVIDERS,
  addressRequired,
  canActivate,
  candidateOf,
  canTest,
  draftOf,
  KEY_PAGE,
  keyRefused,
  keyRequired,
  OLLAMA_ADDRESS,
  storedKeyApplies,
  type AgentDraft,
} from '@/features/settings/lib/agentSetup'
import { ApiProblem } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessageKey, providerRefusal } from '@/lib/problem'

/** The `<select>` skin the forms share (`TaxationModelField`, `EventForm`). */
const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

export const PROVIDER_LABEL: Record<AgentProvider, MessageKey> = {
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

export function AgentProviderSheet({
  open,
  onClose,
  config,
  opener,
}: {
  open: boolean
  onClose: () => void
  config: AgentConfig
  /** Gets the focus back on close: Radix gives it to a `SheetTrigger` only. */
  opener: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useI18n()
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-[420px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          opener.current?.focus()
        }}
      >
        <SheetHeader>
          <SheetTitle className="text-lg">{t('settings.agent.sheet.title')}</SheetTitle>
          <SheetDescription>{t('settings.agent.key.note')}</SheetDescription>
        </SheetHeader>
        {/* Mounted while open only, so every opening starts from the store. */}
        {open ? <ProviderForm config={config} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function ProviderForm({ config, onClose }: { config: AgentConfig; onClose: () => void }) {
  const { t } = useI18n()
  const client = useQueryClient()
  // What the sheet opened on: whether *Enregistrer* puts the agent (back) on.
  const [opened] = useState(config)
  // Seeded once from the store: a refetch after a write must not wipe what
  // the reader is typing, nor the test that just passed.
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(config))
  const [tested, setTested] = useState<AgentTestResult | null>(null)
  const [model, setModel] = useState('')
  // Counts the edits: a test that answers after one is about a form no longer on screen.
  const edits = useRef(0)

  const stored = (answer: AgentConfig) => client.setQueryData(['agent-config'], answer)

  const edit = (change: Partial<AgentDraft>) => {
    edits.current += 1
    setDraft((current) => ({ ...current, ...change }))
    // What was tested is no longer what is on screen.
    setTested(null)
    setModel('')
    test.reset()
  }

  const test = useMutation({
    mutationFn: (_started: number) => agentApi.testAgent(candidateOf(draft)),
    onSuccess: (answer, started) => {
      // Stored by the pass, and only by it: a refusal changes nothing.
      stored(answer.config)
      // The model list the row offers belongs to what was just stored.
      void client.invalidateQueries({ queryKey: ['agent-models'] })
      if (started !== edits.current) return
      setTested(answer)
      setModel(answer.preselected ?? '')
      // Stored now: the field goes back to saying so by its last four.
      setDraft((current) => ({ ...current, key: '' }))
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['agent-config'] }),
  })

  const save = useMutation({
    mutationFn: () => {
      // The name the listing gave the model travels with its id (#1269).
      const name = tested?.models.find((one) => one.id === model)?.name ?? null
      const on = opened.enabled || opened.model === null
      return agentApi.saveAgentConfig({
        model,
        model_name: name,
        ...(on ? { enabled: true } : {}),
      })
    },
    onSuccess: (answer) => {
      stored(answer)
      toast.success(
        t('settings.agent.receipt.saved', { model: answer.model_name ?? answer.model ?? '' }),
      )
      onClose()
    },
  })

  const provider = draft.provider
  const providerName = provider ? t(PROVIDER_LABEL[provider]) : ''
  const testable = canTest(config, draft)
  const keyShown = provider !== null && !keyRefused(provider)
  const addressShown = provider !== null && addressRequired(provider)
  const keyLast4 = storedKeyApplies(config, draft) ? config.key.last4 : null
  const keyPage = provider ? KEY_PAGE[provider] : undefined
  const refusal = providerRefusal(test.error)
  const savable = tested !== null && canActivate(true, model)

  return (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (savable) save.mutate()
      }}
    >
      <div className="flex-1 space-y-6 px-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('settings.agent.step.provider')}</legend>
          <div className="grid grid-cols-1 gap-2">
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
                      className="text-xs text-primary underline underline-offset-4"
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
                {keyLast4 ? (
                  <p className="text-2xs leading-relaxed text-muted-foreground">
                    {t('settings.agent.key.keep', { last4: keyLast4 })}
                  </p>
                ) : null}
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
              onClick={() => test.mutate(edits.current)}
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
                  <label htmlFor="agent-sheet-model" className="block text-sm">
                    {t('settings.agent.model')}
                  </label>
                  <select
                    id="agent-sheet-model"
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
            refusal && provider ? (
              <RefusalNotice
                provider={t(`agent.provider.${provider}`)}
                reason={refusal.reason}
                said={refusal.said}
              />
            ) : (
              <p role="alert" className="text-sm text-destructive">
                {test.error instanceof ApiProblem && test.error.type === PROBLEM_TYPES.conflict
                  ? t('settings.agent.test.changed')
                  : t(problemMessageKey(test.error))}
              </p>
            )
          ) : null}
        </section>
      </div>

      <SheetFooter className="border-t">
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t(problemMessageKey(save.error))}
          </p>
        ) : !savable ? (
          <p className="text-xs text-muted-foreground">{t('settings.agent.save.why')}</p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="max-md:h-11" onClick={onClose}>
            {t('settings.access.cancel')}
          </Button>
          <Button type="submit" className="max-md:h-11" disabled={!savable || save.isPending}>
            {t('settings.agent.save')}
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}
