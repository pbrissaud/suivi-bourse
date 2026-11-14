/**
 * *Modèles d'imposition*: the owner's models as a ruled list — name, then the
 * rates and the accounts that carry it on the sub-line, « Modifier » — and
 * « Ajouter un modèle », which opens `TaxSheet` on the registry.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { accountsApi, type TaxationModel } from '@/features/accounts/lib/api'
import {
  AddRow,
  ListRow,
  ListSetting,
  TextAction,
} from '@/features/settings/components/ListSetting'
import { TaxSheet } from '@/features/settings/components/TaxSheet'
import { modelRule } from '@/features/settings/lib/taxation'
import { useI18n } from '@/lib/i18n'

export function TaxList() {
  const { t } = useI18n()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  /** `undefined` closed, `null` adding, otherwise the model being corrected. */
  const [sheet, setSheet] = useState<TaxationModel | null | undefined>(undefined)
  const declared = accounts.data?.accounts ?? []

  return (
    <ListSetting id="taxation" label={t('settings.taxation.title')}>
      {catalogue.data?.models.map((model) => {
        const carriers = declared
          .filter((account) => account.taxation_model_id === model.id)
          .map((account) => account.label ?? account.id)
        return (
          <ListRow
            key={model.id}
            name={model.name}
            sub={[modelRule(t, model), carriers.join(', ')].filter(Boolean).join(' · ')}
            actions={
              <TextAction
                aria-label={`${t('settings.taxation.edit')} ${model.name}`}
                onClick={() => setSheet(model)}
              >
                {t('settings.taxation.edit')}
              </TextAction>
            }
          />
        )
      })}
      <AddRow onClick={() => setSheet(null)}>{t('settings.taxation.add')}</AddRow>
      {sheet !== undefined ? (
        <TaxSheet key={sheet?.id ?? 'add'} model={sheet} onClose={() => setSheet(undefined)} />
      ) : null}
    </ListSetting>
  )
}
