/**
 * The accounts page — **a line of accounts over one account's detail**
 * (« Relevé », `Comptes-Refonte.dc.html`).
 *
 *  - **The accounts are text tabs** carrying each one's value, with the page's
 *    two actions on the same line: « Modifier le compte » and « Ajouter un
 *    compte ». Which account is open is a URL (`?account=`), so it survives a
 *    reload and the browser's back button is the way out; an id naming nothing
 *    falls back to the first declared account and the URL is rewritten to it.
 *  - **One mention of the date**, at the level of the page: the header's
 *    « Cours au … », as on the dashboard and the shares page.
 *  - **A failed read is said where its content would have been.** The
 *    declaration is what the page is made of, so a refusal on it empties the
 *    page; the other reads compose the detail, so a refusal on one of those
 *    leaves the tabs standing and says why the detail is not there.
 *  - **The declaration lives here**: added from the tabs' line, edited and
 *    removed from one panel the page owns, so that it is mounted once.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { AccountDetail } from '@/features/accounts/components/AccountDetail'
import { AccountForm } from '@/features/accounts/components/AccountForm'
import { StaleFigures } from '@/components/StaleFigures'
import { TextTabs } from '@/components/TextTabs'
import { Unreadable } from '@/components/Unreadable'
import { EmptyState } from '@/components/EmptyState'
import { NoBaseCurrency } from '@/components/NoBaseCurrency'
import { Button } from '@/components/ui/button'
import {
  accountPositions,
  accountWeights,
  accountWorth,
  buildAccountRows,
  chooseAccount,
  declaredLabel,
  distinctSymbols,
  reassignmentOf,
  removalOf,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_ACCOUNT_LABEL,
  isSeededOnly,
} from '@/features/accounts/lib/accounts'
import { accountOf } from '@/features/data/lib/ledger'
import { type Account, accountsApi, type PerfPoint } from '@/features/accounts/lib/api'
import { accountReading } from '@/features/dashboard/lib/dashboard'
import { dashboardApi } from '@/features/dashboard/lib/api'
import { dataApi, type LedgerEvent } from '@/features/data/lib/api'
import { settingsApi } from '@/features/settings/lib/api'
import { type Position, sharesApi } from '@/features/shares/lib/api'
import { api } from '@/lib/api'
import { currencyUnanswered } from '@/lib/firstRun'
import { ABSENT, useFormatters } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { usePageHeading } from '@/lib/pageHeading'
import { useIsMobile } from '@/hooks/use-mobile'
import { SELECT } from '@/features/accounts/components/TaxationModelEditor'
import { cn } from '@/lib/utils'
import { oneFailure, readConditions, stalePerfPass } from '@/lib/status'

export default function AccountsPage() {
  const { t } = useI18n()
  const f = useFormatters()
  const { account, open } = useSearch({ from: '/accounts' })
  const navigate = useNavigate()
  const phone = useIsMobile()
  // `undefined` is *the panel is shut*; `null` is *open on a declaration*; an
  // account is *open on that account*.
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)

  // The declaration armed from the ⌘K palette is spent on arrival: a gesture is
  // not an address, so a reload must not make it again.
  useEffect(() => {
    if (open !== 'account') return
    setEditing(null)
    void navigate({ to: '/accounts', search: { account }, replace: true })
  }, [open, account, navigate])

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: accountsApi.accounts })
  const totals = useQuery({ queryKey: ['portfolio-totals'], queryFn: dashboardApi.portfolioTotals })
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime })
  const positions = useQuery({ queryKey: ['positions'], queryFn: sharesApi.positions })
  const events = useQuery({ queryKey: ['events'], queryFn: dataApi.events })
  const config = useQuery({ queryKey: ['config'], queryFn: settingsApi.config })
  const catalogue = useQuery({ queryKey: ['taxation-models'], queryFn: accountsApi.taxationModels })

  const declared = accounts.data?.accounts ?? []
  const rows = buildAccountRows(declared)
  const opened = chooseAccount(rows, account)

  // An id naming nothing is rewritten to the account shown.
  const openedId = opened?.id
  useEffect(() => {
    if (account == null || openedId === undefined || openedId === account) return
    void navigate({ to: '/accounts', search: { account: openedId }, replace: true })
  }, [account, openedId, navigate])

  // One read per opened account, and only for the one that is open.
  const history = useQuery({
    queryKey: ['account-history', opened?.id],
    queryFn: () => accountsApi.accountHistory(opened!.id),
    // Not while the declaration is being re-read: an account just removed is
    // still `opened` until it lands, and its history is a 404.
    enabled: opened !== null && !accounts.isFetching,
  })

  const pageFailure = oneFailure(readConditions({ queries: [accounts] }))
  const detailFailures = {
    positions: oneFailure(readConditions({ queries: [positions, totals] })),
    points: oneFailure(readConditions({ queries: [history] })),
    events: oneFailure(readConditions({ queries: [events] })),
  }

  const currency = totals.data?.base_currency ?? null
  // `?? null` and never `?? []`: an empty payload is a fact about the reader's
  // data and a request in flight is not one.
  const heldPositions: readonly Position[] | null = positions.data?.positions ?? null
  const ledger: readonly LedgerEvent[] | null = events.data ?? null
  const series: readonly PerfPoint[] | null = history.data?.points ?? null

  const offer = reassignmentOf(accounts.data, ledger ?? [])

  // Nothing declared and nothing recorded: the seeded row alone is an
  // implementation detail, so the page says it is empty. `null` while the
  // ledger is in flight.
  const untouched = !declared.every(isSeededOnly)
    ? false
    : ledger !== null
      ? ledger.length === 0
      : events.isError
        ? false
        : null

  // The instant the quotes are of, as on the dashboard.
  const pricedAt = (heldPositions ?? []).reduce<string | null>(
    (newest, position) =>
      position.price?.at != null && (newest === null || position.price.at > newest)
        ? position.price.at
        : newest,
    null,
  )
  usePageHeading(
    t('page.accounts'),
    pricedAt === null ? null : t('shares.pricedAt', { date: f.dateTime(pricedAt) }),
  )

  // With no reporting currency nothing is converted: the page says why.
  if (currencyUnanswered(config.data?.settings) === true) {
    return <NoBaseCurrency />
  }

  if (pageFailure !== null) {
    return <Unreadable failure={pageFailure} />
  }

  const now = new Date()
  const weights = accountWeights(rows)
  const allValued = rows.every((row) => accountReading(row, runtime.data, now) === 'valued')
  const named = (id: string) => (ledger ?? []).filter((event) => accountOf(event) === id)
  const onDeclared = declared.find((one) => one.id === opened?.id) ?? null

  const addAccount = (
    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>
      {t('accounts.new')}
    </Button>
  )

  return (
    <div className="space-y-6">
      <StaleFigures at={stalePerfPass(runtime.data)} />

      {!accounts.data ? null : opened === null ? (
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.body')}
          action={addAccount}
        />
      ) : untouched === null ? null : untouched ? (
        <EmptyState
          title={t('accounts.empty.title')}
          description={t('accounts.empty.none')}
          action={addAccount}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b">
            {phone ? (
              // **A select on a phone**: every account is reachable and none
              // hides behind the buttons beside it.
              <select
                aria-label={t('accounts.rail.label')}
                className={cn(SELECT, 'mb-2 text-md')}
                value={opened.id}
                onChange={(change) =>
                  void navigate({ to: '/accounts', search: { account: change.target.value } })
                }
              >
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
                    {accountReading(row, runtime.data, now) === 'valued'
                      ? ` · ${f.currency(accountWorth(row), currency)}`
                      : ''}
                  </option>
                ))}
              </select>
            ) : (
              <TextTabs
                label={t('accounts.rail.label')}
                // pb-px/-mb-px: room for the active tab's 1 px overlap, or `overflow-x-auto` grows a vertical scrollbar.
                className="-mb-px min-w-0 flex-1 overflow-x-auto border-b-0 pb-px"
                value={opened.id}
                onChange={(id) => void navigate({ to: '/accounts', search: { account: id } })}
                tabs={rows.map((row) => ({
                  value: row.id,
                  label: (
                    <span className="inline-flex items-baseline gap-2.5">
                      {declaredLabel(row) ?? t(DEFAULT_ACCOUNT_LABEL)}
                      <span className="fig text-sm font-normal text-muted-foreground">
                        {accountReading(row, runtime.data, now) === 'valued'
                          ? f.currency(accountWorth(row), currency)
                          : ABSENT}
                      </span>
                    </span>
                  ),
                }))}
              />
            )}
            <div className="flex items-center gap-2 pb-2">
              {/* The one population the declared accounts do not cover, and
                  the way to repair it: it leads to the seeded account's own
                  detail, where the offer stands. */}
              {offer.kind === 'standing' ? (
                <Link
                  to="/accounts"
                  search={{ account: DEFAULT_ACCOUNT_ID }}
                  className="text-sm underline underline-offset-4"
                >
                  {t('accounts.default.reassign')}
                </Link>
              ) : offer.kind === 'none' ? null : (
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="text-sm underline underline-offset-4"
                >
                  {t('accounts.default.reassign')}
                </button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(onDeclared)}
                disabled={onDeclared === null}
              >
                {t('accounts.detail.edit')}
              </Button>
              {addAccount}
            </div>
          </div>
          <AccountDetail
            row={opened}
            share={allValued ? (weights.get(opened.id) ?? null) : null}
            modelName={
              catalogue.data?.models.find((model) => model.id === opened.taxation_model_id)?.name ??
              null
            }
            positions={heldPositions}
            events={ledger}
            points={series}
            currency={currency}
            runtime={runtime.data}
            reassignment={opened.id === DEFAULT_ACCOUNT_ID ? offer : { kind: 'none' }}
            failures={detailFailures}
            onEdit={() => setEditing(onDeclared)}
            key={opened.id}
          />
        </>
      )}

      {/* One panel for the page, mounted outside the branch above so that
          shutting it cannot depend on what is on screen behind it. */}
      <AccountForm
        open={editing !== undefined}
        account={editing ?? null}
        // `null` while the ledger has not landed: the panel waits for the
        // answer before it lets a declaration go.
        offer={ledger === null ? null : offer}
        removal={
          editing == null || ledger === null ? null : removalOf(editing, named(editing.id).length)
        }
        carried={
          editing == null || ledger === null
            ? null
            : {
                events: named(editing.id).length,
                since:
                  named(editing.id)
                    .map((event) => event.date)
                    .sort()[0] ?? null,
                lines:
                  heldPositions === null
                    ? null
                    : distinctSymbols(accountPositions(heldPositions, editing.id)),
                value: rows.find((row) => row.id === editing.id)?.total_value ?? null,
              }
        }
        currency={currency}
        onClose={() => setEditing(undefined)}
      />
    </div>
  )
}
