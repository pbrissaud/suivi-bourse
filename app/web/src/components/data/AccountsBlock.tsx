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
 *    first run included**: the accounts *page* leaves the navigation at one
 *    account because a comparison of one term is not a comparison, while the
 *    declaration is the only place `default` can be renamed or replaced, and the
 *    only place a first account can be declared without writing a file. Removing
 *    it at N = 1 locked in precisely the owner the reassignment exists to free.
 */
import { useState } from 'react'
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
}

export function AccountsBlock({ accounts, events }: AccountsBlockProps) {
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

  const rows = declarationRows(accounts, events)
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
