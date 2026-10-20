/**
 * The taxation model on the account's own panel (#752): pick one, or write,
 * correct and remove one without leaving the account. The settings page lists
 * the same models with the same editor.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Refusal } from '@/components/Refusal'
import { SELECT, TaxationModelEditor } from '@/features/accounts/components/TaxationModelEditor'
import { Button } from '@/components/ui/button'
import { accountsApi } from '@/features/accounts/lib/api'
import { docsPageHref } from '@/lib/docs'
import { useI18n } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/** The option that opens the editor on a new model; never a 32-hex id. */
const NEW = '__new__'

interface TaxationModelFieldProps {
  /** The model the draft carries, or `null` for none. */
  value: string | null
  onChange: (next: string | null) => void
}

export function TaxationModelField({ value, onChange }: TaxationModelFieldProps) {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  /** `null` closed, `'new'` writing one, `'edit'` correcting the selected one. */
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)

  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeTaxationModel(id),
    onSuccess: (removed) => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      if (value === removed.id) onChange(null)
      setEditing(null)
    },
  })

  // The panel is reused across accounts: drop the previous account's state.
  useEffect(() => {
    setEditing(null)
    remove.reset()
  }, [value])

  // A select whose options have not landed would show "no model" wrongly.
  if (catalogue.data === undefined) return null

  const models = catalogue.data.models
  const selected = models.find((model) => model.id === value) ?? null

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
        value={editing === 'new' ? NEW : (value ?? '')}
        onChange={(changed) => {
          const chosen = changed.target.value
          remove.reset()
          if (chosen === NEW) {
            setEditing('new')
            return
          }
          setEditing(null)
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
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing('edit')}>
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
        <TaxationModelEditor
          key={editing === 'edit' ? selected?.id : NEW}
          model={editing === 'edit' ? selected : null}
          onSaved={(model) => {
            onChange(model.id)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
