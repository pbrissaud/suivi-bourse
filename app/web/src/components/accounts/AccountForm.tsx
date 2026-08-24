/**
 * The declaration form — **the ledger's form, for an account** (#729, ADR-0013,
 * ADR-0002, ADR-0028).
 *
 * Nothing about it is invented: a lateral panel, opened from the account's own
 * name, one field per thing the row carries, a band for what the server refuses.
 * That sameness is the criterion rather than a convenience — the accounts are
 * provisionable by file exactly as the events are, read-only for what came from
 * one and editable for what came from here, and a second shape for the same rule
 * is the defect *individually right, collectively unreadable* by definition.
 *
 * It lives on `/comptes` since ADR-0028, with the page that reads the accounts,
 * and it is where an account is **removed** as well as declared and renamed.
 * That move is the point of the removal rather than a side effect of it: the
 * three refusals are **prose** — the account every install owns, the *n* events
 * that name it, the imported file that declares it — and prose in a table cell
 * is a sentence nobody has room to read. Here it has a paragraph.
 *
 * Three decisions of its own:
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
 *  - **The first declaration carries the reassignment** (#725). It is one box,
 *    checked by default, and it is here rather than beside the panel because
 *    *dans le même geste* is the criterion: at that instant there is no list of
 *    accounts to assign to, the one being declared is the only possible answer,
 *    and the request that declares is the request that moves. Unchecking it —
 *    or shutting the panel — declares the account all the same: the declaration
 *    is **never** refused because events are unassigned, which is the trap this
 *    ticket is named after.
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
import {
  declaredLabel,
  declaredType,
  DEFAULT_ACCOUNT_LABEL,
  type Reassignment,
  type Removal,
} from '@/lib/accounts'
import { api, type Account, type AccountDraft } from '@/lib/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey, problemSentence } from '@/lib/problem'

/**
 * The three refusals, in `accounts.delete_account`'s own order.
 *
 * `fromFile` is unreachable **by construction and not by accident**: this panel
 * only opens from an editable account's name, and `removalOf` answers `fromFile`
 * only where `editable` is false. It stays in the map all the same — the map
 * mirrors the server's classification, and a record of three answers with two
 * entries is a record that has stopped being one. The reason a file's account
 * has no panel at all is said on its detail instead.
 */
const REFUSALS: Record<Exclude<Removal['kind'], 'offered'>, MessageKey> = {
  seeded: 'accounts.remove.seeded',
  namedByEvents: 'accounts.remove.namedByEvents',
  fromFile: 'accounts.remove.fromFile',
}

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
  /**
   * The reassignment as the page reads it, or **`null` while the ledger has not
   * landed** (ADR-0026).
   *
   * The offer rides on the declaration rather than beside it because *in the
   * same gesture* is the criterion: at this instant there is no list to pick
   * from, and the account the reader is in the middle of creating is the only
   * answer the question can have.
   *
   * `null` is not *nothing to move*, and the difference is the whole promise
   * #725 is named after: the accounts payload is small and the ledger is the
   * big one, so a reader who opens this panel in between saw **no box** and
   * declared without it — the two gestures the flag exists to make one. So a
   * declaration waits for the answer, exactly as the removal below does.
   */
  offer: Reassignment | null
  /**
   * Whether this account may be removed, and the reason it may not — the
   * module's own classification, in `accounts.delete_account`'s order.
   *
   * **`null` is the ledger read still in flight** (ADR-0026), never *no reason*:
   * the count a refusal is made of comes off the ledger, and a removal offered
   * before it lands would offer a gesture the server is about to refuse. The
   * block renders nothing at all until then, title included.
   */
  removal: Removal | null
  onClose: () => void
}

export function AccountForm({
  open,
  account,
  offer,
  removal,
  onClose,
}: AccountFormProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FieldName, MessageKey>>>({})
  // **Checked by default**, which is the ticket's own word. What it proposes is
  // the repair of a state the app created, so the reader unchecks it rather than
  // having to discover it — and unchecking it declares the account all the same:
  // the declaration is *never* refused because events are unassigned.
  const [reassign, setReassign] = useState(true)


  const remove = useMutation({
    mutationFn: (id: string) => api.removeAccount(id),
    onSuccess: () => {
      // The whole cache: an account that is gone changes what every page groups
      // by, not only the list this panel was opened from.
      void queryClient.invalidateQueries()
      onClose()
    },
  })

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

  useEffect(() => {
    if (!open) return
    setErrors({})
    setReassign(true)
    // **The mutations are reset with the panel.** It is mounted once for the
    // page and reused for every account, so a `409` earned declaring `delta`
    // was still on screen when the next account's name opened it — and a
    // removal that failed on Gamma rendered its band under Alpha's refusal,
    // attributing one account's failure to another.
    write.reset()
    remove.reset()
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

  function set(field: FieldName, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setErrors((previous) => ({ ...previous, [field]: undefined }))
  }

  // The offer exists on a declaration alone, and only where there is something
  // to move: a box proposing to reassign nothing is a question with no subject.
  const unassigned = offer?.kind === 'firstDeclaration' ? offer.count : null
  const offered = account === null && unassigned !== null
  /** A declaration cannot be submitted before the offer is known. See {@link AccountFormProps.offer}. */
  const waiting = account === null && offer === null

  function submit() {
    const found: Partial<Record<FieldName, MessageKey>> = {}
    const id = draft.id.trim()
    const type = draft.type.trim()

    if (account === null && id === '') found.id = 'accounts.form.required'
    // Required on a **declaration** only, which is where the store requires it
    // (`create_account` raises without one). On an edit a blank type is the
    // label's own case: `update_account` keeps what is there, so refusing here
    // would make *renaming* the seeded row — the one gesture this panel exists
    // for at N = 1 — conditional on answering a second question.
    if (account === null && type === '') found.type = 'accounts.form.required'

    setErrors(found)
    if (Object.values(found).some(Boolean)) return

    // On a declaration the label falls back to the id, which is the store's own
    // rule for a file's empty cell (`accounts.create_account`) — one rule for
    // the two roads. On an edit a blank is sent as a blank: `update_account`
    // keeps what is there, so clearing the field cannot rewrite the row's name
    // to its own identifier behind the reader's back.
    const label = draft.label.trim()
    write.mutate(
      account === null
        ? {
            id,
            type,
            label: label || id,
            // Sent only where the box was shown **and** left ticked: `reassign`
            // is a request, and a client that never asks must never perform one.
            ...(offered && reassign ? { reassign: true } : {}),
          }
        : { type, label },
    )
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full gap-6 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {t(
              account === null
                ? 'accounts.form.create.title'
                : 'accounts.form.edit.title',
            )}
          </SheetTitle>
          <SheetDescription>{t('accounts.form.description')}</SheetDescription>
        </SheetHeader>

        <form
          className="space-y-5 px-4 pb-6"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            submit()
          }}
        >
          {account === null ? (
            <Field name="id" label="accounts.form.id" error={errors.id}>
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
              <p className="text-sm font-medium">{t('accounts.form.id')}</p>
              <p className="font-mono text-sm">{account.id}</p>
              <p className="max-w-prose text-xs text-muted-foreground">
                {t('accounts.form.id.fixed')}
              </p>
            </div>
          )}

          <Field name="type" label="accounts.form.type" error={errors.type}>
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

          <Field name="label" label="accounts.form.label" error={errors.label} optional>
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
              <p className="max-w-prose text-xs text-muted-foreground">
                {t('accounts.form.reassign.hint')}
              </p>
            </div>
          ) : null}

          {write.error ? <Band>{problemSentence(t, write.error)}</Band> : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={write.isPending || waiting}>
              {t(account === null ? 'accounts.form.submit' : 'accounts.form.save')}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('accounts.form.cancel')}
            </Button>
          </div>
        </form>

        {/* The removal, and it is **outside the form**: submitting the panel
            saves the account, and a destructive control inside a form is one
            Enter key away from being the thing that submits. Nothing at all on
            a declaration — there is no row yet to remove — and nothing while
            the ledger has not landed. */}
        {account === null || removal === null ? null : (
          <section
            aria-labelledby="account-removal"
            className="space-y-2 border-t px-4 pb-8 pt-6"
          >
            <h3 id="account-removal" className="text-sm font-medium">
              {t('accounts.remove.title')}
            </h3>
            {removal.kind === 'offered' ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">
                  {t('accounts.remove.offered')}
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(account.id)}
                >
                  {t('accounts.remove')}
                </Button>
              </>
            ) : (
              /* **Absent and naming its reason**, never present and refusing: a
                 control the app knows will be refused teaches nothing by being
                 there, while the sentence is the exact thing its owner has to
                 act on. */
              <p className="max-w-prose text-sm text-muted-foreground">
                {t(REFUSALS[removal.kind], removal.kind === 'namedByEvents' ? removal : undefined)}
              </p>
            )}
            {/* A refusal the reader could not foresee — the declaration moved
                under them between the render and the click. */}
            {remove.error ? <Band>{t(problemMessageKey(remove.error))}</Band> : null}
          </section>
        )}
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
