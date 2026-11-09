/**
 * Import a taxation model from the documentation site (#1290), the way a
 * tweakcn theme is imported: on a click, from a JSON the docs publish, copied
 * into a model the owner can edit.
 *
 * Nothing is read until the owner reaches for the control, and the answer is
 * kept for the page's session (`staleTime: Infinity`, `retry: false` so the
 * five seconds of a failure are not tripled). A pick **stores at once** through
 * the one write path there is, `POST /api/taxation-models`. A name that is
 * already stored is replaced after a confirmation that names the accounts
 * carrying it: nothing records where a model came from (#1162), so the name is
 * the only match, and the carriers are what makes the replacement a decision,
 * asked in a Dialog (#1279).
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxItem } from '@/components/ui/combobox'
import {
  type Account,
  accountsApi,
  type TaxationModel,
  type TaxationModelsResponse,
  type TaxationRegistryItem,
} from '@/features/accounts/lib/api'
import { declaredLabel } from '@/features/accounts/lib/accounts'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { useDocs } from '@/lib/docs'
import { useI18n } from '@/lib/i18n'
import { problemMessageKey, problemSentence, providerRefusal } from '@/lib/problem'

interface TaxationImportProps {
  catalogue: TaxationModelsResponse
  accounts: Account[]
  /** A model was stored from the wrapper `wrapper` (`<cc>/<slug>`): open it. */
  onImported: (model: TaxationModel, wrapper: string) => void
}

/** The region of the browser's language (`fr-FR` is `FR`), or `null`. */
function ownCountry(): string | null {
  try {
    return new Intl.Locale(navigator.language).region ?? null
  } catch {
    return null
  }
}

/** The import row: the registry's wrappers in a combobox, a pick stored at once. */
export function TaxationImport({ catalogue, accounts, onImported }: TaxationImportProps) {
  const { t, language } = useI18n()
  const { docsPageHref } = useDocs()
  const queryClient = useQueryClient()
  const [asked, setAsked] = useState(false)
  const [query, setQuery] = useState('')
  /** The wrapper whose name matches a stored model, waiting for a yes. */
  const [replacing, setReplacing] = useState<{
    item: TaxationRegistryItem
    model: TaxationModel
  } | null>(null)
  const focusField = () => document.getElementById('taxation-import')?.focus()

  const registry = useQuery({
    queryKey: ['taxation-registry'],
    queryFn: accountsApi.taxationRegistry,
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

  const stored = useMutation({
    mutationFn: ({ item, model }: { item: TaxationRegistryItem; model: TaxationModel | null }) => {
      const body = { name: model?.name ?? item.name, kind: item.kind, parameters: item.parameters }
      return model === null
        ? accountsApi.createTaxationModel(body)
        : accountsApi.updateTaxationModel(model.id, body)
    },
    onSuccess: (saved, { item }) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      // A replacement reaches every account carrying the model.
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setReplacing(null)
      onImported(saved, item.id)
    },
    onError: () => setReplacing(null),
  })
  // The field is disabled while the write is pending, so focus comes back once
  // the failure has been drawn and the field is enabled again.
  useEffect(() => {
    if (stored.isError) focusField()
  }, [stored.isError])

  const known = useMemo(() => new Set(catalogue.kinds.map((entry) => entry.kind)), [catalogue])
  const items = useMemo<ComboboxItem[]>(() => {
    const wanted = query.trim().toLowerCase()
    const names = new Intl.DisplayNames([language], { type: 'region' })
    const country = (code: string) => {
      try {
        return names.of(code.toUpperCase()) ?? code
      } catch {
        // `of` throws on a code that is not a region; the file is ours, but a name is not worth a blank list.
        return code
      }
    }
    const own = ownCountry()?.toUpperCase()
    return (registry.data?.items ?? [])
      .filter(
        (item) =>
          item.name.toLowerCase().includes(wanted) ||
          country(item.country).toLowerCase().includes(wanted),
      )
      .map((item) => ({ item, group: country(item.country) }))
      .sort(
        (a, b) =>
          Number(b.item.country.toUpperCase() === own) -
            Number(a.item.country.toUpperCase() === own) ||
          a.group.localeCompare(b.group, language),
      )
      .map(({ item, group }) => ({
        value: item.id,
        label: item.name,
        hint: null,
        group,
        disabledReason: item.refused
          ? known.has(item.kind)
            ? item.refused
            : t('settings.taxation.import.newer')
          : null,
      }))
  }, [registry.data, query, language, known, t])

  function pick(id: string) {
    const item = registry.data?.items.find((entry) => entry.id === id)
    if (item === undefined) return
    setQuery('')
    stored.reset()
    const model = catalogue.models.find((entry) => entry.name.trim() === item.name.trim()) ?? null
    if (model === null) stored.mutate({ item, model })
    else setReplacing({ item, model })
  }

  const failure = registry.isError ? registry.error : stored.isError ? stored.error : null
  const registryRefusal = registry.isError ? providerRefusal(registry.error) : null
  const failureSaid =
    failure === null
      ? null
      : registry.isError
        ? registryRefusal === null
          ? t(problemMessageKey(failure))
          : registryRefusal.reason === 'unpublished'
            ? t('settings.taxation.import.unpublished')
            : registryRefusal.said === ''
              ? t('settings.taxation.import.refused')
              : t('settings.taxation.import.failed', { reason: registryRefusal.said })
        : problemSentence(t, failure)
  const carriers =
    replacing === null
      ? []
      : accounts.filter((account) => account.taxation_model_id === replacing.model.id)

  const closeReplace = () => setReplacing(null)

  return (
    <SettingRow
      id="taxation-import"
      label={t('settings.taxation.import')}
      description={
        <>
          {t('settings.taxation.import.hint')}{' '}
          <a
            href={docsPageHref(language, 'taxation-models-in-europe', 'top')}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-4"
          >
            {t('accounts.taxation.regimesLink')}
          </a>
        </>
      }
    >
      <div className="w-72 max-w-full">
        <Combobox
          id="taxation-import"
          value={query}
          onValueChange={(value, chosen) => (chosen ? pick(value) : setQuery(value))}
          items={items}
          listLabel={t('settings.taxation.import.list')}
          placeholder={t('settings.taxation.import.search')}
          disabled={stored.isPending}
          aria-describedby={
            failure === null ? 'taxation-import-description' : 'taxation-import-error'
          }
          openOnFocus
          onFocus={() => setAsked(true)}
          onClick={() => setAsked(true)}
        />
      </div>

      {registry.isFetching ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('settings.taxation.import.reading')}
        </p>
      ) : null}
      {stored.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('settings.taxation.import.adding')}
        </p>
      ) : null}

      {failureSaid === null ? null : (
        <div className="flex max-w-72 flex-col items-end gap-2 text-right">
          <p id="taxation-import-error" role="alert" className="text-xs text-destructive">
            {failureSaid}
          </p>
          {registry.isError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:h-11"
              // The refetch unmounts this button (the error is cleared while
              // it reads), so focus goes back to the field once it settles:
              // onto the open list, or onto the field the error describes.
              onClick={() => void registry.refetch().then(focusField)}
            >
              {t('settings.taxation.import.retry')}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {t('settings.taxation.import.fallback')}
          </span>
        </div>
      )}

      <ConfirmDestructive
        open={replacing !== null}
        onOpenChange={(open) => (open ? undefined : closeReplace())}
        title={
          replacing === null
            ? ''
            : t('settings.taxation.import.replace.title', { name: replacing.model.name })
        }
        items={carriers.map((account) => ({ key: declaredLabel(account) ?? account.id }))}
        line={t('settings.taxation.import.replace.line')}
        confirmLabel={t('settings.taxation.import.replace')}
        pending={stored.isPending}
        onConfirm={() => {
          if (replacing !== null) stored.mutate({ item: replacing.item, model: replacing.model })
        }}
        // It gives the field back on close, unless the replacement went through:
        // then the model's Sheet has opened, and its exit animation ends after
        // the Sheet took focus.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!stored.isSuccess) focusField()
        }}
      />
    </SettingRow>
  )
}
