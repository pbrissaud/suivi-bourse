/**
 * The taxation model on the account's own panel (#752): pick one, or write,
 * correct and remove one without leaving the account. The settings page lists
 * the same models and imports them (#1290).
 *
 * **There is no Save here.** The draft lives in `AccountForm`, and its single
 * submit writes the model first, then the account.
 */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { Refusal } from '@/components/Refusal'
import {
  draftOf,
  type ModelDraft,
  SELECT,
  TaxationModelFields,
} from '@/features/accounts/components/TaxationModelEditor'
import { Button } from '@/components/ui/button'
import { accountsApi } from '@/features/accounts/lib/api'
import { declaredLabel } from '@/features/accounts/lib/accounts'
import { docsPageHref } from '@/lib/docs'
import { useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/** The option that opens the editor on a new model; never a 32-hex id. */
const NEW = '__new__'

/** The model being written (`new`) or corrected (`edit`) with the account, or `null` for none. */
export type ModelEditing = { mode: 'new' | 'edit'; draft: ModelDraft } | null

interface TaxationModelFieldProps {
  /** The account being edited, left out of "also used by"; `null` on a declaration. */
  accountId: string | null
  /** The model the draft carries, or `null` for none. */
  value: string | null
  onChange: (next: string | null) => void
  editing: ModelEditing
  onEditing: (next: ModelEditing) => void
  /** The declaration's write of the model: `error` is what the server refused, if it did. */
  write?: { error: unknown }
}

export function TaxationModelField({
  accountId,
  value,
  onChange,
  editing,
  onEditing,
  write = { error: null },
}: TaxationModelFieldProps) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })

  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeTaxationModel(id),
    onSuccess: (removed) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      if (value === removed.id) onChange(null)
      onEditing(null)
    },
  })

  // The panel is reused across accounts: drop the previous account's state.
  useEffect(() => {
    remove.reset()
  }, [value])

  // A select whose options have not landed would show "no model" wrongly.
  if (catalogue.data === undefined) return null

  const models = catalogue.data.models
  const kinds = catalogue.data.kinds
  const selected = models.find((model) => model.id === value) ?? null
  const others =
    editing?.mode === 'edit' && selected !== null
      ? (accounts.data?.accounts ?? []).filter(
          (account) => account.taxation_model === selected.id && account.id !== accountId,
        )
      : []

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="account-taxation" className="text-sm font-medium">
          {t('accounts.form.taxation')}
        </label>
        <span className="text-xs text-muted-foreground">{t('data.form.optional')}</span>
      </div>

      <select
        id="account-taxation"
        className={SELECT}
        value={editing?.mode === 'new' ? NEW : (value ?? '')}
        onChange={(changed) => {
          const chosen = changed.target.value
          remove.reset()
          if (chosen === NEW) {
            onEditing({ mode: 'new', draft: draftOf(null, kinds) })
            return
          }
          onEditing(null)
          onChange(chosen === '' ? null : chosen)
        }}
      >
        <option value="">{t('accounts.form.taxation.none')}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
        <option value={NEW}>{t('accounts.form.taxation.new')}</option>
      </select>

      <p className="max-w-prose text-xs text-muted-foreground">
        {t('accounts.form.taxation.hint')}
      </p>

      <Link
        to="/settings"
        hash="taxation"
        className="block text-xs font-medium underline underline-offset-4"
      >
        {t('accounts.form.taxation.import')}
      </Link>

      <a
        href={docsPageHref(language, 'taxation-models-in-europe', 'top')}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs font-medium underline underline-offset-4"
      >
        {t('accounts.taxation.regimesLink')}
      </a>

      {editing === null && selected !== null ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onEditing({ mode: 'edit', draft: draftOf(selected, kinds) })}
          >
            {t('accounts.form.taxation.edit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(selected.id)}
          >
            {t('accounts.form.taxation.remove')}
          </Button>
        </div>
      ) : null}

      {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}

      {editing === null ? null : (
        <div className="space-y-3 rounded-md border border-border bg-background p-3">
          {others.length === 0 ? null : (
            <p className="max-w-prose text-xs text-muted-foreground">
              {t('accounts.form.taxation.alsoUsedBy', {
                accounts: others.map((account) => declaredLabel(account) ?? account.id).join(', '),
              })}
            </p>
          )}
          <TaxationModelFields
            draft={editing.draft}
            onChange={(draft) => onEditing({ ...editing, draft })}
            invalid={write.error !== null}
          />
          {write.error ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => onEditing(null)}>
            {t(
              editing.mode === 'edit'
                ? 'accounts.form.taxation.revertEdit'
                : 'accounts.form.taxation.revertNew',
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
