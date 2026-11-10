/**
 * The account panel — « Ajouter un compte » and « Modifier le compte »
 * (`AccountSheet-Refonte.dc.html`).
 *
 * Four fields: Identifiant · Libellé (optional) · Ouvert le (optional) ·
 * Modèle d'imposition. The identifiant is what the owner's files name, so it is
 * chosen once and read-only afterwards; the server answers a duplicate with a
 * 409, which is said under the field that earned it. The tax models are the
 * owner's own, imported at first run or from Réglages: this panel only picks
 * one. In edition the body ends on what the account carries, and the footer
 * holds the removal as a text link, through `ConfirmDestructive`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { ConfirmDestructive } from '@/components/ConfirmDestructive'
import { Refusal } from '@/components/Refusal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  declaredLabel,
  isAddressableAccountId,
  type Reassignment,
  type Removal,
} from '@/features/accounts/lib/accounts'
import { type Account, type AccountDraft, accountsApi } from '@/features/accounts/lib/api'
import { ApiProblem } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { PROBLEM_TYPES, problemMessageKey, problemSentence } from '@/lib/problem'

const REFUSALS: Record<Exclude<Removal['kind'], 'offered'>, MessageKey> = {
  seeded: 'accounts.remove.seeded',
  namedByEvents: 'accounts.remove.namedByEvents',
}

const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-md shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

interface Draft {
  id: string
  label: string
  openedOn: string
  model: string
}

type FieldName = 'id' | 'label' | 'openedOn' | 'model'

const EMPTY: Draft = { id: '', label: '', openedOn: '', model: '' }

/** What an account carries, for the edition panel's last block. */
export interface Carried {
  events: number
  since: string | null
  lines: number | null
  value: number | null
}

interface AccountFormProps {
  open: boolean
  account: Account | null
  offer: Reassignment | null
  removal: Removal | null
  carried: Carried | null
  currency: string | null
  onClose: () => void
}

export function AccountForm({
  open,
  account,
  offer,
  removal,
  carried,
  currency,
  onClose,
}: AccountFormProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({})
  const [reassign, setReassign] = useState(true)
  const [confirming, setConfirming] = useState(false)

  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })
  const models = catalogue.data?.models ?? []

  const remove = useMutation({
    mutationFn: (id: string) => accountsApi.removeAccount(id),
    onSuccess: () => {
      setConfirming(false)
      void queryClient.invalidateQueries()
      onClose()
    },
  })

  const write = useMutation({
    mutationFn: (body: AccountDraft) =>
      account === null
        ? accountsApi.createAccount(body)
        : accountsApi.updateAccount(account.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onClose()
    },
  })

  // Re-armed on every opening: the panel is mounted once for the page.
  useEffect(() => {
    if (!open) return
    setErrors({})
    setReassign(true)
    write.reset()
    remove.reset()
    setDraft(
      account === null
        ? EMPTY
        : {
            id: account.id,
            label: declaredLabel(account) ?? '',
            openedOn: account.opened_on ?? account.first_payment ?? '',
            model: account.taxation_model_id ?? '',
          },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account])

  function set(field: FieldName, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  // The first declaration offers to take the events nobody assigned. It waits
  // for the ledger: the flag and the declaration are one gesture.
  const unassigned = offer?.kind === 'firstDeclaration' ? offer.count : null
  const offered = account === null && unassigned !== null
  const waiting = account === null && offer === null

  // A 409 on a creation is a duplicate identifiant, and it is said under it.
  const taken =
    account === null &&
    write.error instanceof ApiProblem &&
    write.error.type === PROBLEM_TYPES.conflict

  function submit() {
    const found: Partial<Record<FieldName, MessageKey>> = {}
    const id = draft.id.trim()
    if (account === null && id === '') found.id = 'accounts.form.required'
    else if (account === null && !isAddressableAccountId(id)) found.id = 'accounts.form.id.shape'
    setErrors(found)
    if (Object.values(found).some(Boolean)) return

    const label = draft.label.trim()
    if (account === null) {
      write.mutate({
        id,
        label,
        ...(draft.model === '' ? {} : { taxation_model_id: draft.model }),
        ...(draft.openedOn === '' ? {} : { opened_on: draft.openedOn }),
        ...(offered && reassign ? { reassign: true } : {}),
      })
      return
    }
    // Sent when the reader moved it, `null` included: detaching is a gesture.
    write.mutate({
      label,
      ...(draft.model === (account.taxation_model_id ?? '')
        ? {}
        : { taxation_model_id: draft.model === '' ? null : draft.model }),
      ...(draft.openedOn === (account.opened_on ?? account.first_payment ?? '')
        ? {}
        : { opened_on: draft.openedOn === '' ? null : draft.openedOn }),
    })
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="w-full gap-0 shadow-none sm:max-w-115"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            submit()
          }}
        >
          <header className="flex items-start justify-between gap-3 px-6 pt-5">
            <SheetTitle className="text-2xl leading-7">
              {t(account === null ? 'accounts.form.create.title' : 'accounts.form.edit.title')}
            </SheetTitle>
            <SheetClose
              aria-label={t('sheet.close')}
              className="-mt-1.5 -mr-1.5 rounded-md p-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <X aria-hidden className="size-4" />
            </SheetClose>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-5 pb-6">
            <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
              <Field name="id" label="accounts.form.id" error={errors.id} taken={taken}>
                {(id, described) => (
                  <>
                    <Input
                      id={id}
                      className="fig md:text-md"
                      value={draft.id}
                      readOnly={account !== null}
                      aria-invalid={errors.id !== undefined || taken}
                      aria-describedby={
                        [described, account === null ? `${id}-hint` : null]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onChange={(changed) => set('id', changed.target.value)}
                    />
                    {account === null ? (
                      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                        {t('accounts.form.id.hint')}
                      </p>
                    ) : null}
                  </>
                )}
              </Field>
              <Field name="label" label="accounts.form.label" optional>
                {(id) => (
                  <Input
                    id={id}
                    value={draft.label}
                    onChange={(changed) => set('label', changed.target.value)}
                  />
                )}
              </Field>
              <Field name="openedOn" label="accounts.form.openedOn" full optional>
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    className="fig md:text-md"
                    value={draft.openedOn}
                    onChange={(changed) => set('openedOn', changed.target.value)}
                  />
                )}
              </Field>
              <Field name="model" label="accounts.form.taxation" full>
                {(id) => (
                  <select
                    id={id}
                    className={SELECT}
                    value={draft.model}
                    onChange={(changed) => set('model', changed.target.value)}
                  >
                    <option value="">{t('accounts.form.taxation.none')}</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>

            {offered ? (
              <div className="space-y-1 rounded-md border border-border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={reassign}
                    onChange={(changed) => setReassign(changed.target.checked)}
                  />
                  <span>{t('accounts.form.reassign', { count: unassigned })}</span>
                </label>
              </div>
            ) : null}

            {account === null || carried === null ? null : (
              <div className="flex flex-col gap-2 pt-1">
                <span className="label">{t('accounts.form.carries')}</span>
                <CarriedRow name={t('accounts.form.carries.events')}>
                  {carried.since === null
                    ? String(carried.events)
                    : t('accounts.form.carries.since', {
                        count: carried.events,
                        year: carried.since.slice(0, 4),
                      })}
                </CarriedRow>
                {carried.lines === null ? null : (
                  <CarriedRow name={t('accounts.form.carries.lines')}>{carried.lines}</CarriedRow>
                )}
                {carried.value === null ? null : (
                  <CarriedRow name={t('accounts.form.carries.value')}>
                    {f.currency(carried.value, currency)}
                  </CarriedRow>
                )}
              </div>
            )}

            {account === null || removal === null || removal.kind === 'offered' ? null : (
              <p className="max-w-prose text-sm text-muted-foreground">
                {t(REFUSALS[removal.kind], removal.kind === 'namedByEvents' ? removal : undefined)}
              </p>
            )}

            {write.error && !taken ? <Refusal>{problemSentence(t, write.error)}</Refusal> : null}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t px-6 py-4">
            {account !== null && removal?.kind === 'offered' ? (
              <button
                type="button"
                className="mr-auto text-md text-destructive underline decoration-border underline-offset-3 outline-none focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => setConfirming(true)}
              >
                {t('accounts.remove.title')}
              </button>
            ) : null}
            <Button type="button" size="sheet" onClick={onClose}>
              {t('accounts.form.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sheet"
              type="submit"
              disabled={write.isPending || waiting}
            >
              {t(account === null ? 'accounts.form.submit' : 'accounts.form.save')}
            </Button>
          </footer>
        </form>

        {account === null ? null : (
          <ConfirmDestructive
            open={confirming}
            onOpenChange={setConfirming}
            title={t('confirm.account.title', { name: declaredLabel(account) ?? account.id })}
            items={[{ key: declaredLabel(account) ?? account.id, value: account.id }]}
            line={t('confirm.account.line')}
            confirmLabel={t('confirm.account.cta')}
            pending={remove.isPending}
            error={remove.error ? <Refusal>{t(problemMessageKey(remove.error))}</Refusal> : null}
            onConfirm={() => remove.mutate(account.id)}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function CarriedRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 border-b text-sm">
      <span>{name}</span>
      <span className="fig">{children}</span>
    </div>
  )
}

function Field({
  name,
  label,
  error,
  taken = false,
  optional,
  full,
  children,
}: {
  name: FieldName
  label: MessageKey
  error?: MessageKey
  /** The server refused the identifiant: it is already an account's. */
  taken?: boolean
  optional?: boolean
  full?: boolean
  children: (id: string, describedBy: string | undefined) => ReactNode
}) {
  const { t } = useI18n()
  const id = `account-${name}`
  const errorId = `${id}-error`
  const sentence = error ? t(error) : taken ? t('accounts.form.id.taken') : null

  return (
    <div className={full ? 'col-span-2 flex flex-col gap-1.5' : 'flex flex-col gap-1.5'}>
      <div className="label flex items-baseline whitespace-pre">
        <label htmlFor={id}>{t(label)}</label>
        {optional ? <span className="font-normal">{` · ${t('data.form.optional')}`}</span> : null}
      </div>
      {children(id, sentence ? errorId : undefined)}
      {sentence ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {sentence}
        </p>
      ) : null}
    </div>
  )
}
