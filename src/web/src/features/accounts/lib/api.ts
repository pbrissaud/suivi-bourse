/**
 * The accounts, their taxation models, and each account's perf series.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES, remove, send } from '@/lib/api'
import type { Account, AccountsPayload as AccountsResponse } from '@/lib/api.gen'

export function accountPath(id: string): string {
  return ROUTES.account.replace(':id', encodeURIComponent(id))
}

export function accountReassignmentPath(id: string): string {
  return ROUTES.accountReassignment.replace(':id', encodeURIComponent(id))
}

export function taxationModelPath(id: string): string {
  return ROUTES.taxationModel.replace(':id', encodeURIComponent(id))
}

// ------------------------------------------------------------------------- //
// Accounts
// ------------------------------------------------------------------------- //

export type { Account, AccountsResponse }

/**
 * What the declaration form sends (#729).
 *
 * A field for it here would put the third level back on the one surface that
 * creates the rows.
 *
 * `id` is sent on a creation and **never on an edit**: it is the value events
 * name, so changing it would rewrite every event that names it. An event is
 * addressed by its own key and never by a column somebody else may rewrite
 * (#816) — the server refuses it for that reason, and the form does not offer
 * it. Reassignment is the gesture that moves events, and it names its subject.
 */
export interface AccountDraft {
  id?: string
  label: string
  /**
   * Move the events still naming the seeded row onto this account, in the same
   * request (#725). Sent on a **declaration** only, where the offer is checked
   * by default; omitted is what a client that never heard of it sends, and the
   * declaration is never refused for want of it.
   */
  reassign?: boolean
  /**
   * The model to attach, `null` to detach — and **absent to leave it alone**
   * (#752).
   *
   * The three are three, and the middle one is why the member is optional: a
   * `PATCH` sent to rename an account must not drop the model it carries, so
   * *say nothing* has to be sayable. The form sends it on every submission all
   * the same, because the select always has an answer.
   */
  taxation_model?: string | null
  /**
   * The opening date, `null` to take it away — and **absent to leave it alone**
   * (#918), on `taxation_model`'s own three-way rule.
   *
   * Sent only where the field was **shown**: it is not asked for when the
   * account's taxation model counts its threshold from anything but the
   * opening, and a client that never asked the question must not answer it.
   */
  opened_on?: string | null
}

// ------------------------------------------------------------------------- //
// The taxation models (#752)
// ------------------------------------------------------------------------- //

/** What a parameter is. The four the server's enumeration knows. */
export type TaxationParameterType = 'rate' | 'years' | 'age_basis' | 'brackets'

export interface TaxationParameter {
  name: string
  type: TaxationParameterType
  required: boolean
}

/** One rung of a `bracketed_realised` ladder; the top one has no ceiling. */
export interface TaxationBracket {
  upper_bound: number | null
  rate: number
}

/**
 * A model's parameters. Typed loosely on purpose: which members are there is
 * decided by the `kind`, and the server is what states the pairing — a union per
 * kind here would be a second declaration of the enumeration, which is the thing
 * {@link ROUTES.taxationModels} exists to serve rather than duplicate.
 */
export type TaxationParameters = Record<string, number | string | TaxationBracket[]>

export interface TaxationModel {
  id: string
  name: string
  kind: string
  parameters: TaxationParameters
}

export interface TaxationModelsResponse {
  kinds: { kind: string; parameters: TaxationParameter[] }[]
  age_bases: string[]
  models: TaxationModel[]
}

/**
 * One wrapper of the registry the docs site publishes (#1290). `refused` is the
 * sentence of the server when this app cannot hold the model, `null` otherwise.
 */
export interface TaxationRegistryItem extends TaxationModelDraft {
  /** `<cc>/<slug>`, the wrapper's id in `website/taxation/<cc>.json`. */
  id: string
  /** ISO 3166-1 alpha-2, upper case. */
  country: string
  refused: string | null
}

export interface TaxationRegistryResponse {
  items: TaxationRegistryItem[]
}

/** What the model form sends. `kind` and `parameters` travel together. */
export interface TaxationModelDraft {
  name: string
  kind: string
  parameters: TaxationParameters
}

/**
 * One day of a perf series, at either level (#721).
 *
 * **One shape for the account and for the portfolio**, deliberately: the
 * accounts page draws N account curves and reads a portfolio scalar off the
 * same rebasing, so two shapes would mean two rebasings and, sooner or later,
 * two answers to *how did this period go*. The five members are the ones
 * `account_metrics` and `portfolio_totals` have in common.
 */
export interface PerfPoint {
  /** The calendar day — a bare `YYYY-MM-DD`, never an instant (the store's rule). */
  t: string | null
  cash_balance: number | null
  holdings_value: number | null
  total_value: number | null
  net_contributed: number | null
  /** Base 100 since the series' own origin. Rebased before it is ever shown. */
  twr_index: number | null
}

export interface AccountHistoryResponse {
  account: string
  from: string
  to: string
  points: PerfPoint[]
}

/**
 * The day a perf series is asked from, and it is the **origin of time** on
 * purpose (#721).
 *
 * `MAX` is not offered as a *range* — a time-weighted index has no bounded
 * amplitude, and one account's spike at +542 % crushes every other curve into
 * the bottom sixth of the plot. But the longest window offered, *since the
 * opening*, is `max` over the accounts' first days, and no payload states an
 * account's first day: the only place it is written is the series itself.
 * Asking the server for a bounded window instead would mean knowing the bound
 * before reading what defines it.
 *
 * The cost is stated rather than hidden: on a 6,8-year account the series is ~2
 * 500 days, dense over calendar days, five numbers each — and it is read
 * **once** for the four presets rather than once per preset, which is the same
 * property that makes the chart and the table's scalar column one announcer
 * instead of two.
 */
export const SERIES_ORIGIN = '1970-01-01'

function accountHistoryPath(account: string, from: string = SERIES_ORIGIN): string {
  return `${ROUTES.accountHistory.replace(':account', encodeURIComponent(account))}?from=${from}`
}

export const accountsApi = {
  accounts: () => get<AccountsResponse>(ROUTES.accounts),
  // The declaration's three gestures (#698, served since that ticket; read by a
  // client since #729). They are the accounts half of the pair
  // `POST`/`PATCH`/`DELETE /api/events` is the ledger half of.
  createAccount: (draft: AccountDraft) => send<Account>(ROUTES.accounts, 'POST', draft),
  updateAccount: (id: string, draft: AccountDraft) =>
    send<Account>(accountPath(id), 'PATCH', draft),
  removeAccount: (id: string) => remove<{ id: string; removed: boolean }>(accountPath(id)),
  // The taxation models (#752). Four gestures on one resource — the catalogue
  // rides on the read, the three writes are the account's own three.
  taxationModels: () => get<TaxationModelsResponse>(ROUTES.taxationModels),
  createTaxationModel: (draft: TaxationModelDraft) =>
    send<TaxationModel>(ROUTES.taxationModels, 'POST', draft),
  updateTaxationModel: (id: string, draft: TaxationModelDraft) =>
    send<TaxationModel>(taxationModelPath(id), 'PATCH', draft),
  taxationRegistry: () => send<TaxationRegistryResponse>(ROUTES.taxationRegistry, 'POST', {}),
  removeTaxationModel: (id: string) =>
    remove<{ id: string; removed: boolean }>(taxationModelPath(id)),
  reassignEvents: (id: string) =>
    send<{ account: string; reassigned: number }>(accountReassignmentPath(id), 'POST', {}),
  accountHistory: (account: string) => get<AccountHistoryResponse>(accountHistoryPath(account)),
}
