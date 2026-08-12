/**
 * The declaration form — **the ledger's form, for an account** (#729, ADR-0013,
 * ADR-0002).
 *
 * Nothing about it is invented: a lateral panel, opened from the row's own name,
 * one field per thing the row carries, a band for what the server refuses. That
 * sameness is the criterion rather than a convenience — the accounts are
 * provisionable by file exactly as the events are, read-only for what came from
 * one and editable for what came from here, and a second shape for the same rule
 * is the defect *individually right, collectively unreadable* by definition.
 *
 * Two decisions of its own:
 *
 *  - **It has no `currency` field.** ADR-0002 deleted `Account.currency` rather
 *    than guarding it: there are two currency levels — the reporting currency,
 *    and the security's own quote — and not three, so *a EUR account holding a
 *    USD security* has no referent to be a bug about. The page built during the
 *    prototype still carried the field, which is why the criterion names it.
 *  - **The identifier is fixed once the row exists.** It is the value events
 *    name, so renaming it would be an edit of every imported row that names it,
 *    and imported rows are read-only. The panel says so where the field would
 *    be, rather than showing a control the server would refuse.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { declaredLabel, declaredType, DEFAULT_ACCOUNT_LABEL } from '@/lib/accounts'
import { api, type Account, type AccountDraft } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

interface Draft {
  id: string
  type: string
  label: string
}

type FieldName = keyof Draft

const EMPTY: Draft = { id: '', type: '', label: '' }

export interface AccountFormProps {
  open: boolean
  /** The row being edited — `null` is a declaration. */
  account: Account | null
  onClose: () => void
}

export function AccountForm({ open, account, onClose }: AccountFormProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setDraft(
      account === null
        ? EMPTY
        : {
            id: account.id,
            // **Both seeded columns open empty.** `Default account` and `OTHER`
            // are what the *server* wrote about a row nobody declared, so
            // neither is a value the reader typed — and handing one back had
            // them typing `PEA` into `OTHER` and saving `OTHERPEA`, the form
            // giving them a value they never gave.
            type: declaredType(account) ?? '',
            label: declaredLabel(account) ?? '',
          },
    )
  }, [open, account])

  const write = useMutation({
    mutationFn: (body: AccountDraft) =>
      account === null ? api.createAccount(body) : api.updateAccount(account.id, body),
    onSuccess: () => {
      // A declaration moves what an event file is allowed to say and what every
      // page groups by, so the whole cache goes rather than a list of keys that
      // would drift from the pages reading them.
      void queryClient.invalidateQueries()
      onClose()
    },
  })

  function set(field: FieldName, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  function submit() {
    const found: Partial<Record<FieldName, MessageKey>> = {}
    const id = draft.id.trim()
    const type = draft.type.trim()

    if (account === null && id === '') found.id = 'data.accounts.form.required'
    // Required on a **declaration** only, which is where the store requires it
    // (`create_account` raises without one). On an edit a blank type is the
    // label's own case: `update_account` keeps what is there, so refusing here
    // would make *renaming* the seeded row — the one gesture this panel exists
    // for at N = 1 — conditional on answering a second question.
    if (account === null && type === '') found.type = 'data.accounts.form.required'

    setErrors(found)
    if (Object.values(found).some(Boolean)) return

    // On a declaration the label falls back to the id, which is the store's own
    // rule for a file's empty cell (`accounts.create_account`) — one rule for
    // the two roads. On an edit a blank is sent as a blank: `update_account`
    // keeps what is there, so clearing the field cannot rewrite the row's name
    // to its own identifier behind the reader's back.
    const label = draft.label.trim()
    write.mutate(account === null ? { id, type, label: label || id } : { type, label })
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {t(
              account === null
                ? 'data.accounts.form.create.title'
                : 'data.accounts.form.edit.title',
            )}
          </SheetTitle>
          <SheetDescription>{t('data.accounts.form.description')}</SheetDescription>
        </SheetHeader>

        <form
          className="space-y-5 px-4 pb-6"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            submit()
          }}
        >
          {account === null ? (
            <Field name="id" label="data.accounts.form.id" error={errors.id}>
              {(id, described) => (
                <Input
                  id={id}
                  value={draft.id}
                  aria-invalid={errors.id !== undefined}
                  aria-describedby={described}
                  onChange={(changed) => set('id', changed.target.value)}
                />
              )}
            </Field>
          ) : (
            // Stated, not disabled: a greyed-out input invites the click and
            // reads as a form that refused, where the honest sentence is that
            // this value is what the ledger names.
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('data.accounts.form.id')}</p>
              <p className="font-mono text-sm">{account.id}</p>
              <p className="max-w-prose text-xs text-muted-foreground">
                {t('data.accounts.form.id.fixed')}
              </p>
            </div>
          )}

          <Field name="type" label="data.accounts.form.type" error={errors.type}>
            {(id, described) => (
              <Input
                id={id}
                value={draft.type}
                aria-invalid={errors.type !== undefined}
                aria-describedby={described}
                onChange={(changed) => set('type', changed.target.value)}
              />
            )}
          </Field>

          <Field name="label" label="data.accounts.form.label" error={errors.label} optional>
            {(id, described) => (
              <Input
                id={id}
                value={draft.label}
                // The catalogue's name as a placeholder on the row that still
                // wears it: what the field would keep saying if nothing is
                // typed, rather than a value pretending to have been given.
                placeholder={
                  account !== null && declaredLabel(account) === null
                    ? t(DEFAULT_ACCOUNT_LABEL)
                    : undefined
                }
                aria-describedby={described}
                onChange={(changed) => set('label', changed.target.value)}
              />
            )}
          </Field>

          {write.error ? <Band>{t(problemMessageKey(write.error))}</Band> : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={write.isPending}>
              {t(account === null ? 'data.accounts.form.submit' : 'data.accounts.form.save')}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('data.accounts.form.cancel')}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** The ledger form's field, to the letter — the refusal bound to its input. */
function Field({
  name,
  label,
  error,
  optional,
  children,
}: {
  name: FieldName
  label: MessageKey
  error?: MessageKey
  optional?: boolean
  children: (id: string, describedBy: string | undefined) => ReactNode
}) {
  const { t } = useI18n()
  const id = `account-${name}`
  const errorId = `${id}-error`

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {t(label)}
        </label>
        {optional ? (
          <span className="text-xs text-muted-foreground">{t('data.form.optional')}</span>
        ) : null}
      </div>
      {children(id, error ? errorId : undefined)}
      {error ? (
        <p id={errorId} className="text-sm text-attention">
          {t(error)}
        </p>
      ) : null}
    </div>
  )
}
