/**
 * The accounts, **declared exactly as the ledger is** (#729, ADR-0013,
 * ADR-0002, ADR-0020).
 *
 * The block sits under the first tab, beside the ledger, because it is the same
 * thing said about another table: *what the user declared*. And it is the ledger
 * table's own shape, deliberately —
 *
 *  - **no padlock column.** Read-only-per-row rendered 285 identical locks on
 *    285 rows in the ledger; here it would render one per file-declared account.
 *    A row that carries a provenance came from a file, a row that carries none
 *    was declared here, and the affordance is the row's **own name**, a button
 *    exactly where the row may be edited and plain text everywhere else;
 *  - **a lateral panel**, never an editable row;
 *  - **a provenance column** saying where the declaration came from.
 *
 * Three things are this block's own, and each is a criterion:
 *
 *  - **The form loses `currency`.** ADR-0002 deleted `Account.currency` rather
 *    than converting it — two currency levels and not three — and the page built
 *    during the prototype still carried the field. It is `AccountForm`'s
 *    absence, and the column is not here either.
 *  - **A removal that cannot happen is absent and names its reason** —
 *    *« 71 événements nomment ce compte »* — never present and refused. That
 *    generalises *a row with no figures names its reason* one notch: a control
 *    the app knows will be refused teaches nothing by being there, while the
 *    count is the exact thing the owner has to act on. `lib/accounts.ts` holds
 *    the classification, in `accounts.delete_account`'s own order.
 *  - **`default` is in this table as soon as an event names it** — and always
 *    while nothing else is declared, which is the same rule read from the other
 *    end — under the name `Non affecté`, the **same** `lib/accounts.ts` function
 *    the accounts page reads, so two pages cannot name one thing two ways. Both
 *    halves are the *server*'s (`list_accounts`), so the row carries the label a
 *    rename wrote. And the block exists **at every N, N = 1 included, the true
 *    first run included**: the declaration is the only place `default` can be
 *    renamed or replaced, and the only place a first account can be declared
 *    without writing a file. Removing it at N = 1 locked in precisely the owner
 *    the reassignment exists to free.
 *  - **And the reassignment is that owner's way out** (#725). Running a month
 *    before declaring anything puts the whole ledger under the seeded row — the
 *    rule of #698 doing exactly what it says — and the seeded row then becomes
 *    undeletable the moment an event names it. *Réaffecter, jamais refuser*: the
 *    offer rides **inside** the first declaration, and stands on its own
 *    afterwards, because the same instant is reachable with no gesture in this
 *    app at all (an accounts file declares as much as the form does). No
 *    correspondence layer is built anywhere: what crosses the wire is one target
 *    id, a `default → pea` map beside the events being a second truth about the
 *    account an event names (ADR-0006).
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Band } from '@/components/Band'
import { AccountForm } from '@/components/data/AccountForm'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  declarationRows,
  declaredLabel,
  declaredType,
  DEFAULT_ACCOUNT_LABEL,
  DEFAULT_ACCOUNT_TYPE,
  isDefaultAccount,
  originOf,
  reassignmentOf,
  type DeclarationRow,
  type Origin,
} from '@/lib/accounts'
import { api, type Account, type AccountsResponse, type LedgerEvent } from '@/lib/api'
import { useFormatters } from '@/lib/format'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { problemMessageKey } from '@/lib/problem'

/** One key per origin, so the catalogue is reached by a name and not by a fold. */
const ORIGIN_KEYS: Record<Origin, MessageKey> = {
  file: 'data.accounts.origin.file',
  app: 'data.accounts.origin.app',
  seed: 'data.accounts.origin.seed',
}

export interface AccountsBlockProps {
  /** What `/api/accounts` served. `undefined` — it has not landed. */
  accounts: AccountsResponse | undefined
  /** The ledger, already read by this tab: the count a refusal is made of. */
  events: readonly LedgerEvent[]
  /**
   * The reader arrived by the link the accounts page's `Non affecté` row
   * carries (#725). That link owes them **the gesture**, not the page — so the
   * offer is scrolled to where it stands on its own, and the declaration panel
   * is opened where the gesture *is* the first declaration.
   */
  focusReassignment?: boolean
  /** Spends that signal, once the offer has actually been reached. */
  onReassignmentShown?: () => void
}

export function AccountsBlock({
  accounts,
  events,
  focusReassignment,
  onReassignmentShown,
}: AccountsBlockProps) {
  const { t } = useI18n()
  const f = useFormatters()
  const queryClient = useQueryClient()
  // `undefined` is *the panel is shut*; `null` is *open on a new declaration*; a
  // row is *open on that row*. Three states, the ledger's three.
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)

  const remove = useMutation({
    mutationFn: (id: string) => api.removeAccount(id),
    onSuccess: () => void queryClient.invalidateQueries(),
  })
  const reassign = useMutation({
    mutationFn: (id: string) => api.reassignEvents(id),
    // The whole cache, like every write here: what account an event names moves
    // every page's grouping, not just this table's count.
    onSuccess: () => void queryClient.invalidateQueries(),
  })

  const rows = declarationRows(accounts, events)
  const offer = reassignmentOf(accounts, events)
  // A select of one entry is a question whose answer is already known — the rule
  // `accountChoice` states for the event form, applied to the one control here.
  const only = offer.kind === 'standing' && offer.targets.length === 1
    ? offer.targets[0].id
    : ''
  const [target, setTarget] = useState('')
  const chosen = target || only

  useEffect(() => {
    if (!focusReassignment) return
    // The two renderings of one condition, and the link lands on whichever is on
    // screen: the standing offer is scrolled to, and where the gesture *is* the
    // first declaration the panel that carries it opens.
    if (offer.kind === 'firstDeclaration') setEditing(null)
    if (offer.kind === 'standing') {
      document.getElementById('reassignment')?.scrollIntoView({ block: 'center' })
    }
    // Spent where it was acted on, and **only** there: `none` is the accounts
    // read still in flight as often as it is nothing to move, and spending it
    // then would drop a reader on the page they were sent past.
    if (offer.kind !== 'none') onReassignmentShown?.()
    // `offer.kind` is a dependency and has to be: the accounts read has usually
    // **not landed** at the mount, so the offer is `none` then and an effect
    // keyed on the signal alone would fire before there was anything to land
    // on. `editing` is deliberately not one — the panel is opened, never
    // reopened under a reader who has just shut it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReassignment, offer.kind])
  // **Empty means the read has not landed, and nothing else.** `/api/accounts`
  // never serves an empty list — ADR-0013 gives every install one account, and
  // the resource publishes the seeded row while nothing else is declared — so
  // there is no *nothing to show* state to render here. Which is also why the
  // true first run is **not** a screen where this block is absent: N = 1 there,
  // the one row is `default`, and it carries the only *« Déclarer un compte »*
  // in the product. Rendering `null` locked the owner into the account nothing
  // can reassign, on the install with a page and no file — the one #698's app
  // half exists for.
  if (rows.length === 0) return null

  return (
    <section aria-labelledby="data-accounts" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="data-accounts" className="text-lg font-semibold tracking-tight">
            {t('data.accounts.title')}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t('data.accounts.description')}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setEditing(null)}>
          {t('data.accounts.new')}
        </Button>
      </div>

      {/* A refusal the reader could not foresee — the declaration moved under
          them between the render and the click. One band, in place. */}
      {remove.error ? <Band>{t(problemMessageKey(remove.error))}</Band> : null}

      {offer.kind === 'standing' ? (
        <section
          id="reassignment"
          aria-labelledby="data-reassignment"
          className="space-y-3 rounded-md border border-border p-4"
        >
          <h3 id="data-reassignment" className="text-sm font-medium">
            {t('data.accounts.reassign.title')}
          </h3>
          <p className="max-w-prose text-sm text-muted-foreground">
            {t('data.accounts.reassign.body', { count: offer.count })}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="reassign-target" className="text-sm font-medium">
                {t('data.accounts.reassign.target')}
              </label>
              <select
                id="reassign-target"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                value={chosen}
                onChange={(changed) => setTarget(changed.target.value)}
              >
                {/* Absent where there is one account: the empty entry is what
                    makes a choice a choice, and there is none to make. */}
                {offer.targets.length === 1 ? null : (
                  <option value="">{t('data.accounts.reassign.choose')}</option>
                )}
                {offer.targets.map((account) => (
                  <option key={account.id} value={account.id}>
                    {declaredLabel(account) ?? account.id}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              disabled={chosen === '' || reassign.isPending}
              onClick={() => reassign.mutate(chosen)}
            >
              {t('data.accounts.reassign.submit')}
            </Button>
          </div>
          {reassign.error ? <Band>{t(problemMessageKey(reassign.error))}</Band> : null}
        </section>
      ) : null}

      <Table>
        <caption className="sr-only">{t('data.accounts.title')}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t('data.accounts.column.account')}</TableHead>
            <TableHead>{t('data.accounts.column.type')}</TableHead>
            <TableHead className="text-right">{t('data.accounts.column.events')}</TableHead>
            <TableHead>{t('data.accounts.column.origin')}</TableHead>
            <TableHead>{t('data.accounts.column.removal')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.account.id}>
              <TableCell>
                <Name row={row} onEdit={setEditing} />
              </TableCell>
              {/* The seeded `OTHER` is the server's own English about a row
                  nobody declared, so it reads off the catalogue — the same
                  entry the accounts page reads for the same cell. */}
              <TableCell>{declaredType(row.account) ?? t(DEFAULT_ACCOUNT_TYPE)}</TableCell>
              {/* The bare count, under a column that already says what it
                  counts. The sentence — *« 4 événements nomment ce compte »* —
                  belongs to the refusal and to it alone: written here too, the
                  same words would appear twice on one row. */}
              <TableCell className="text-right tabular">{f.quantity(row.events)}</TableCell>
              {/* Three answers and not two: the seeded row carries no
                  `source_id` either, and read as a pair this column said *« Dans
                  l'application »* about the one row nobody has declared — on the
                  first-run screen, where it is the only row there is. */}
              <TableCell className="text-xs text-muted-foreground">
                {t(ORIGIN_KEYS[originOf(row.account)])}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <Removal
                  row={row}
                  onRemove={(id) => remove.mutate(id)}
                  pending={remove.isPending}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AccountForm
        open={editing !== undefined}
        account={editing ?? null}
        unassigned={offer.kind === 'firstDeclaration' ? offer.count : null}
        onClose={() => setEditing(undefined)}
      />
    </section>
  )
}

/**
 * The row's own name, and the **only** editing affordance — the ledger's rule,
 * to the letter. A declaration that came from a file has nothing to press: the
 * file is corrected and dropped again, or its import is forgotten.
 *
 * The seeded row is named by the catalogue while it still wears the name the
 * product gave it, and it *is* editable: `source_id` is `NULL` on the seed, so
 * relabelling it is an ordinary `PATCH` — which is the whole reason this block
 * exists at N = 1.
 */
function Name({
  row,
  onEdit,
}: {
  row: DeclarationRow
  onEdit: (account: Account) => void
}) {
  const { t } = useI18n()
  const given = declaredLabel(row.account)
  const name = given ?? t(DEFAULT_ACCOUNT_LABEL)

  return (
    <>
      {row.account.editable === false ? (
        <span className="font-medium">{name}</span>
      ) : (
        <button
          type="button"
          className="font-medium underline-offset-4 hover:underline"
          onClick={() => onEdit(row.account)}
        >
          {name}
        </button>
      )}
      {/* The id is what every event names and what a file's `account` column has
          to spell, so it is on screen wherever it is not the name itself. */}
      {isDefaultAccount(row.account.id) || name !== row.account.id ? (
        <span className="block font-mono text-xs text-muted-foreground">{row.account.id}</span>
      ) : null}
    </>
  )
}

/** The gesture, or the sentence that stands in its place. Never both, never a refusal. */
function Removal({
  row,
  onRemove,
  pending,
}: {
  row: DeclarationRow
  onRemove: (id: string) => void
  pending: boolean
}) {
  const { t } = useI18n()

  switch (row.removal.kind) {
    case 'offered':
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onRemove(row.account.id)}
        >
          {t('data.accounts.remove')}
        </Button>
      )
    case 'seeded':
      return <>{t('data.accounts.remove.seeded')}</>
    case 'namedByEvents':
      return <>{t('data.accounts.remove.namedByEvents', { count: row.removal.count })}</>
    case 'fromFile':
      return <>{t('data.accounts.remove.fromFile')}</>
  }
}
