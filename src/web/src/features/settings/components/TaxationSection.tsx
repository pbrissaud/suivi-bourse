import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { TaxationModelEditor } from '@/features/accounts/components/TaxationModelEditor'
import {
  accountsApi,
  type TaxationModel,
  type TaxationModelsResponse,
} from '@/features/accounts/lib/api'
import { SettingRow } from '@/features/settings/components/SettingRow'
import { SettingsSection, type SectionRead } from '@/features/settings/components/SettingsSection'
import { TaxationImport } from '@/features/settings/components/TaxationImport'
import { useDocs } from '@/lib/docs'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/**
 * *Fiscalité* on the row pattern (#1279): one row to import a model for the
 * owner's country, one row per stored model (its rates, the accounts carrying
 * it, « Corriger » and « Supprimer »), and an add row last, primary while the
 * list is empty. A model opens in a Sheet, a removal in a Dialog.
 */
export function TaxationSection({ read }: { read: SectionRead }) {
  const { t } = useI18n()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  return (
    <SettingsSection id="taxation" title={t('settings.taxation.title')} read={read}>
      {catalogue.data ? <TaxationRows catalogue={catalogue.data} /> : null}
    </SettingsSection>
  )
}

/** The section's rows, once the catalogue is read: they hold the Sheet and the removal Dialog. */
function TaxationRows({ catalogue }: { catalogue: TaxationModelsResponse }) {
  const { t, language } = useI18n()
  const { docsPageHref } = useDocs()
  const queryClient = useQueryClient()
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  /** `undefined` closed, `null` a new model, otherwise the model being corrected. */
  const [editing, setEditing] = useState<TaxationModel | null | undefined>(undefined)
  const [removing, setRemoving] = useState<TaxationModel | null>(null)
  /** The wrapper (`<cc>/<slug>`) the model being shown was just imported from. */
  const [imported, setImported] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeTaxationModel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      setRemoving(null)
    },
  })

  const models = catalogue.models
  const declared = accounts.data?.accounts ?? []
  const close = () => {
    setEditing(undefined)
    setImported(null)
  }

  return (
    <>
      <TaxationImport
        catalogue={catalogue}
        accounts={declared}
        onImported={(model, wrapper) => {
          setImported(wrapper)
          setEditing(model)
        }}
      />

      {models.map((model) => {
        const carriers = declared.filter((account) => account.taxation_model === model.id)
        return (
          <SettingRow
            key={model.id}
            label={model.name}
            description={`${summary(t, model)} · ${t('settings.taxation.accounts', { count: carriers.length })}`}
          >
            <span className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                className="max-md:h-11"
                aria-label={`${t('settings.taxation.edit')} ${model.name}`}
                onClick={() => setEditing(model)}
              >
                {t('settings.taxation.edit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="max-md:h-11"
                aria-label={`${t('settings.taxation.remove')} ${model.name}`}
                // A model an account carries cannot go; the title says why.
                disabled={carriers.length > 0}
                title={carriers.length > 0 ? t('settings.taxation.remove.inUse') : undefined}
                onClick={() => {
                  remove.reset()
                  setRemoving(model)
                }}
              >
                {t('settings.taxation.remove')}
              </Button>
            </span>
          </SettingRow>
        )
      })}

      <SettingRow
        label={t('settings.taxation.own')}
        description={
          models.length === 0 ? t('settings.taxation.empty') : t('settings.taxation.sheet')
        }
      >
        <Button
          type="button"
          // The empty list has one way forward that needs nothing from outside.
          variant={models.length === 0 ? 'default' : 'outline'}
          className="max-md:h-11"
          onClick={() => setEditing(null)}
        >
          <PlusIcon aria-hidden />
          {t('settings.taxation.new')}
        </Button>
      </SettingRow>

      <Sheet open={editing !== undefined} onOpenChange={(open) => (open ? undefined : close())}>
        <SheetContent
          className="w-full gap-6 overflow-y-auto sm:max-w-md"
          // After an import the name is what the owner checks first.
          onOpenAutoFocus={(event) => {
            if (imported === null) return
            event.preventDefault()
            document.getElementById('taxation-name')?.focus()
          }}
        >
          <SheetHeader>
            <SheetTitle>{editing ? editing.name : t('settings.taxation.new')}</SheetTitle>
            <SheetDescription>{t('settings.taxation.sheet')}</SheetDescription>
            {imported === null ? null : (
              <p className="text-xs text-muted-foreground">
                {t('settings.taxation.imported')}{' '}
                <a
                  href={docsPageHref(
                    language,
                    'taxation-models-in-europe',
                    imported.replace('/', '-'),
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline underline-offset-4"
                >
                  {t('settings.taxation.imported.check')}
                </a>
              </p>
            )}
          </SheetHeader>
          {editing !== undefined ? (
            <div className="px-4 pb-6">
              <TaxationModelEditor
                key={editing?.id ?? 'new'}
                model={editing}
                onSaved={close}
                onCancel={close}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <DialogContent>
          {removing === null ? null : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('settings.taxation.remove.title', { name: removing.name })}
                </DialogTitle>
                <DialogDescription>{t('settings.taxation.remove.body')}</DialogDescription>
              </DialogHeader>
              {remove.error ? <Refusal>{problemSentence(t, remove.error)}</Refusal> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
                  {t('settings.taxation.remove.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(removing.id)}
                >
                  {t('settings.taxation.remove')}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** The model's rates in one line: "12,8 %, puis 0 % après 5 ans · prélèvements sociaux 17,2 %". */
function summary(t: (key: MessageKey, values?: MessageValues) => string, model: TaxationModel) {
  const values: MessageValues = {}
  for (const [name, value] of Object.entries(model.parameters)) {
    if (typeof value === 'number' || typeof value === 'string') values[name] = value
    else values.count = value.length
  }
  const main = t(`settings.taxation.summary.${model.kind}` as MessageKey, values)
  return typeof values.social_rate === 'number'
    ? `${main} · ${t('settings.taxation.summary.social', values)}`
    : main
}
