/**
 * The provider · model picker of the composer (« Relevé », DESIGN.md › Agent
 * page): the model the thread runs on as a text action with a chevron, opening
 * a listbox of every configured provider and the models it lists. The choice is
 * the thread's: it travels with the next question, and the server stores it.
 *
 * A provider's models are asked of it when the list opens (it is the connection
 * test, read for its list), never on mount: a page that only reads must not
 * call a provider. One that cannot be reached still offers its default model.
 */
import { useQueries } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { type ConfiguredProvider, agentApi, PROVIDER_NAME } from '@/features/agent/lib/api'
import { modelName } from '@/features/agent/lib/modelNames'
import { ACT } from '@/features/agent/lib/styles'
import { type MessageKey, useI18n } from '@/lib/i18n'

/** What a thread runs on: one of the providers, and one of its models. */
export interface Runner {
  provider_id: string
  model: string | null
}

export function providerName(provider: ConfiguredProvider, t: (key: MessageKey) => string): string {
  return provider.label ?? t(PROVIDER_NAME[provider.kind])
}

/** The runner a thread starts on: the default provider, with its default model. */
export function defaultRunner(providers: readonly ConfiguredProvider[]): Runner | null {
  const one = providers.find((p) => p.is_default) ?? providers[0]
  return one === undefined ? null : { provider_id: one.id, model: one.default_model }
}

export function ModelPicker({
  providers,
  value,
  onChange,
  disabled = false,
}: {
  providers: readonly ConfiguredProvider[]
  value: Runner
  onChange: (next: Runner) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const current = providers.find((p) => p.id === value.provider_id) ?? providers[0]
  const listed = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ['agent-models', provider.id],
      queryFn: () => agentApi.models(provider.id),
      enabled: open,
      staleTime: 60_000,
      retry: false,
    })),
  })
  if (current === undefined) return null
  const model = value.model ?? current.default_model
  const shown = model ? modelName(model) : providerName(current, t)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={ACT}
          disabled={disabled}
          aria-label={t('agent.picker.label', { model: shown })}
        >
          {shown}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-80 w-72 flex-col gap-2 overflow-y-auto p-2">
        {providers.map((provider, index) => {
          const ids = new Set<string>()
          // The default model first: it is offered even when the provider is out of reach.
          if (provider.default_model) ids.add(provider.default_model)
          for (const model of listed[index]?.data?.models ?? []) ids.add(model.id)
          const names = new Map((listed[index]?.data?.models ?? []).map((m) => [m.id, m.name]))
          return (
            <div key={provider.id} role="group" aria-label={providerName(provider, t)}>
              <p className="label px-2 pb-1">{providerName(provider, t)}</p>
              <ul role="listbox" aria-label={providerName(provider, t)}>
                {[...ids].map((id) => {
                  const selected = provider.id === current.id && id === value.model
                  return (
                    <li key={id} role="presentation">
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-md hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:font-medium"
                        onClick={() => {
                          onChange({ provider_id: provider.id, model: id })
                          setOpen(false)
                        }}
                      >
                        <span className="min-w-0 truncate">{names.get(id) ?? id}</span>
                        {selected ? <Check className="size-4" aria-hidden="true" /> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
