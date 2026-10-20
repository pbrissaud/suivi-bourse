import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'

import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Section } from '@/components/ui/section'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { TaxationModelEditor } from '@/features/accounts/components/TaxationModelEditor'
import { accountsApi, type TaxationModel } from '@/features/accounts/lib/api'
import { TaxationImport } from '@/features/settings/components/TaxationImport'
import { docsPageHref } from '@/lib/docs'
import { useI18n, type MessageKey, type MessageValues } from '@/lib/i18n'
import { problemSentence } from '@/lib/problem'

/** The taxation models, and which accounts carry each one (#752). */
export function TaxationBlock() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  /** `undefined` closed, `null` a new model, otherwise the model being corrected. */
  const [editing, setEditing] = useState<TaxationModel | null | undefined>(undefined)
  const [removing, setRemoving] = useState<TaxationModel | null>(null)
  /** The wrapper (`<cc>/<slug>`) the model being shown was just imported from. */
  const [imported, setImported] = useState<string | null>(null)

  // `/settings#taxation`, from the account form: the section is drawn only once
  // its read lands, so the router's own hash scroll finds nothing.
  const hash = useLocation({ select: (location) => location.hash })
  const drawn = catalogue.data !== undefined
  useEffect(() => {
    if (hash === 'taxation' && drawn) document.getElementById('taxation')?.scrollIntoView()
  }, [hash, drawn])

  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeTaxationModel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['taxation-models'] })
      setRemoving(null)
    },
  })

  if (catalogue.data === undefined) return null
  const models = catalogue.data.models
  const declared = accounts.data?.accounts ?? []
  const close = () => {
    setEditing(undefined)
    setImported(null)
  }

  return (
    <Section
      id="taxation"
      className="scroll-mt-20"
      title={t('settings.taxation')}
      aside={
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>
          {t('settings.taxation.new')}
        </Button>
      }
    >
      <TaxationImport
        catalogue={catalogue.data}
        accounts={declared}
        onImported={(model, wrapper) => {
          setImported(wrapper)
          setEditing(model)
        }}
      />

      {models.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.taxation.empty')}</p>
      ) : (
        <ul className="divide-y text-sm">
          {models.map((model) => {
            const carriers = declared.filter((account) => account.taxation_model === model.id)
            return (
              <li key={model.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{model.name}</span>
                  <span className="text-xs text-muted-foreground">{summary(t, model)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('settings.taxation.accounts', { count: carriers.length })}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`${t('settings.taxation.edit')} ${model.name}`}
                      onClick={() => setEditing(model)}
                    >
                      {t('settings.taxation.edit')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`${t('settings.taxation.remove')} ${model.name}`}
                      // A model an account carries cannot go; the line below says which.
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
                </div>
              </li>
            )
          })}
        </ul>
      )}

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
    </Section>
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
