/**
 * *Modèle d'imposition* (`TaxSheet-Refonte`): one side panel for a model of the
 * owner's, and for adding one.
 *
 * Editing a model shows its fields, then the accounts that carry it; a
 * correction reaches every one of them. Adding offers two tabs — *Importer pour
 * mon pays*, which lists the wrappers the documentation publishes (the one
 * outbound call, on this click) and imports a write at once; *Écrire le mien*,
 * the same fields, blank. The rates the registry carries are IR and PS apart;
 * the docs stay the source, which is why nothing here is typed in by the app.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { TextTabs } from '@/components/TextTabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  bodyOf,
  draftOf,
  TaxationModelFields,
  type ModelDraft,
} from '@/features/accounts/components/TaxationModelEditor'
import {
  accountsApi,
  type TaxationModel,
  type TaxationRegistryItem,
} from '@/features/accounts/lib/api'
import { TextAction } from '@/features/settings/components/ListSetting'
import { SettingsSheet } from '@/features/settings/components/SettingsSheet'
import { settingsApi } from '@/features/settings/lib/api'
import {
  countryName,
  modelRule,
  ownCountry,
  registryFailure,
} from '@/features/settings/lib/taxation'
import { useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

type Tab = 'import' | 'write'

export function TaxSheet({ model, onClose }: { model: TaxationModel | null; onClose: () => void }) {
  const { t } = useI18n()
  const client = useQueryClient()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const kinds = catalogue.data?.kinds ?? []
  const [tab, setTab] = useState<Tab>('import')
  const [draft, setDraft] = useState<ModelDraft>(() => draftOf(model, kinds))
  const [removing, setRemoving] = useState(false)
  const adding = model === null
  const importing = adding && tab === 'import'

  const carriers = (accounts.data?.accounts ?? []).filter(
    (account) => model !== null && account.taxation_model_id === model.id,
  )

  const write = useMutation({
    mutationFn: () => {
      const body = bodyOf(draft, kinds)
      return model === null
        ? accountsApi.createTaxationModel(body)
        : accountsApi.updateTaxationModel(model.id, body)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['taxation-models'] })
      // A correction reaches every account carrying the model.
      void client.invalidateQueries({ queryKey: ['accounts'] })
      onClose()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeTaxationModel(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['taxation-models'] })
      onClose()
    },
  })

  const footer = importing ? (
    <Button size="sheet" className="ml-auto" onClick={onClose}>
      {t('sheet.close')}
    </Button>
  ) : (
    <>
      {model !== null ? (
        <button
          type="button"
          disabled={carriers.length > 0}
          title={carriers.length > 0 ? t('settings.taxation.remove.inUse') : undefined}
          className="mr-auto text-md text-destructive underline decoration-border underline-offset-3 outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          onClick={() => {
            remove.reset()
            setRemoving(true)
          }}
        >
          {t('settings.taxation.remove.link')}
        </button>
      ) : (
        <span className="mr-auto" />
      )}
      <Button type="button" size="sheet" onClick={onClose}>
        {t('settings.access.cancel')}
      </Button>
      <Button type="submit" size="sheet" variant="primary" disabled={write.isPending}>
        {t('settings.save')}
      </Button>
    </>
  )

  return (
    <SettingsSheet
      open
      onClose={onClose}
      title={model ? model.name : t('settings.taxation.add.title')}
      onSubmit={importing ? undefined : () => write.mutate()}
      footer={footer}
    >
      {adding ? (
        <TextTabs
          size="sheet"
          label={t('settings.taxation.source')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'import', label: t('settings.taxation.import') },
            { value: 'write', label: t('settings.taxation.write') },
          ]}
        />
      ) : null}

      {importing ? (
        <Registry stored={catalogue.data?.models ?? []} />
      ) : (
        <>
          <TaxationModelFields draft={draft} onChange={setDraft} />
          {write.isError ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}
          {model !== null ? <Carriers carriers={carriers} /> : null}
        </>
      )}

      <ConfirmDestructive
        open={removing}
        onOpenChange={(next) => (next ? undefined : setRemoving(false))}
        title={t('settings.taxation.remove.title', { name: model?.name ?? '' })}
        line={t('settings.taxation.remove.line')}
        confirmLabel={t('settings.taxation.remove')}
        pending={remove.isPending}
        error={remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
        onConfirm={() => {
          if (model) remove.mutate(model.id)
        }}
      />
    </SettingsSheet>
  )
}

/** « Comptes qui le portent »: each with its opening date, when it has one. */
function Carriers({
  carriers,
}: {
  carriers: { id: string; label: string | null; opened_on?: string }[]
}) {
  const { t } = useI18n()
  const f = useFormatters()
  return (
    <div className="flex flex-col gap-2 border-t pt-5">
      <p className="label">{t('settings.taxation.carriers')}</p>
      {carriers.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.taxation.carriers.none')}</p>
      ) : (
        carriers.map((account) => (
          <p key={account.id}>
            {account.label ?? account.id}
            {account.opened_on ? (
              <span className="text-muted-foreground">
                {' · '}
                {t('settings.taxation.opened', { date: f.date(account.opened_on) })}
              </span>
            ) : null}
          </p>
        ))
      )}
    </div>
  )
}

/** The documentation's wrappers, searchable, one « Importer » per row. */
function Registry({ stored }: { stored: TaxationModel[] }) {
  const { t, language } = useI18n()
  const client = useQueryClient()
  const own = ownCountry()
  const [query, setQuery] = useState(() => (own ? countryName(language, own) : ''))
  const registry = useQuery({
    queryKey: ['taxation-registry'],
    queryFn: settingsApi.taxationRegistry,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const write = useMutation({
    mutationFn: (id: string) => settingsApi.importTaxationModels([id]),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['taxation-models'] })
      void client.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const names = new Set(stored.map((model) => model.name.trim()))
  const wanted = query.trim().toLowerCase()
  const groups = new Map<string, TaxationRegistryItem[]>()
  for (const item of registry.data?.items ?? []) {
    const country = countryName(language, item.country)
    if (
      wanted &&
      !item.name.toLowerCase().includes(wanted) &&
      !country.toLowerCase().includes(wanted)
    )
      continue
    groups.set(country, [...(groups.get(country) ?? []), item])
  }

  const failure = registry.isError ? registryFailure(t, registry.error).message : null

  return (
    <>
      <Input
        type="search"
        aria-label={t('settings.taxation.import.search')}
        placeholder={t('settings.taxation.import.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {registry.isFetching ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.taxation.import.reading')}
        </p>
      ) : null}
      {failure !== null ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
          <TextAction onClick={() => void registry.refetch()}>
            {t('settings.taxation.import.retry')}
          </TextAction>
        </div>
      ) : null}
      {write.isError ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}
      {[...groups].map(([country, items]) => (
        <div key={country}>
          <p className="label mb-1">{country}</p>
          {items.map((item) => (
            <div
              key={item.id}
              className="grid min-h-13 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b"
            >
              <span className="flex min-w-0 flex-col">
                <span>{item.name}</span>
                <span className="text-xs text-muted-foreground">
                  {item.refused ? item.refused : modelRule(t, item)}
                </span>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                {names.has(item.name.trim()) ? (
                  t('settings.taxation.imported')
                ) : item.refused ? null : (
                  <TextAction
                    disabled={write.isPending}
                    aria-label={`${t('settings.taxation.import.action')} ${item.name}`}
                    onClick={() => write.mutate(item.id)}
                  >
                    {t('settings.taxation.import.action')}
                  </TextAction>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
