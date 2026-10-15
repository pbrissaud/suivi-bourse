/**
 * The accounts, their taxation models, and each account's perf series.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES, remove, send } from '@/lib/api'

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

export interface Account {
  /** The id events carry. `default` is the bucket of the unassigned. */
  id: string
  /**
   * What the owner called it — **except on `default` while it still wears the
   * name the schema seeded**, where the interface reads its own catalogue
   * (#745). That row is `NOT NULL` in the store, so it always arrives named, but
   * what it arrives with is documentation for whoever opens the file: it is the
   * one row *every* install owns, headless ones included, and a value seeded
   * once will never follow the reader's language. Every other account — and that
   * one from the moment #729's block relabels it — shows what it declares.
   *
   * Nullable on the wire because `AccountSummary` publishes it so: the store's
   * own column is, and the declaration falls back to the id where a file left it
   * empty. The fold lives in `features/accounts/lib/accounts.ts` rather than in each cell.
   */
  label: string | null
  /**
   * The account's **newest** `account_metrics` row, ridden on this resource
   * rather than on a second one — one accounts resource with two consumers, the
   * shares filter reading `id`/`label` and the comparison table reading the
   * rest. Every member below is nullable *by field* since #708: `holdings_value`
   * and `gain_absolu` are written always, the four cash-derived ones need a cash
   * event and `xirr` an external flow. That is what makes *five dashes out of
   * eight* a shape the page has to render rather than a fault.
   *
   * `as_of` is the day they describe — a **day**, never an instant — and `null`
   * on an account for which no cycle has written anything at all, which is the
   * other degraded shape: *eight* dashes, and a different sentence.
   */
  as_of?: string | null
  cash_balance?: number | null
  holdings_value?: number | null
  total_value?: number | null
  net_contributed?: number | null
  gain_absolu?: number | null
  /** Money-weighted, annualised **since the origin**: it has no window to narrow. */
  xirr?: number | null
  /**
   * Time-weighted, base 100 since the account's own first day — and the
   * comparison table **never renders it**. Two indices counted from
   * two origins share a unit without being a comparison: `pea 171,5` against
   * `TR 115,0` puts 6,8 years beside 2,4. What the `perf` column shows is the
   * series rebased to 100 at the start of the visible window, computed in
   * `features/accounts/lib/accounts.ts` from {@link AccountHistoryResponse}.
   */
  twr_index?: number | null
  /**
   * The day the index counts from. Served for the agent; the table rebases.
   *
   * Optional and never `| null`, unlike its namesake on `PortfolioTotals`
   * (`features/dashboard/lib/api.ts`): this one goes out through
   * `declared_only`, so absent is the only absence.
   */
  twr_since?: string
  /**
   * It is the one member of this row that is not a column of `account_metrics`:
   * it belongs to no position, so the account's panel could not read it off
   * `/api/positions` with the other three, and the server derives it from
   * `event` bounded by this row's own day, exactly as `/api/portfolio-totals`
   * derives the global one.
   *
   * `null` where no cycle has written this account a day: there is nothing to
   * bound the fees by, and a term measured over another period does not belong
   * in a sum with the figures beside it. Zero is a **figure** and means the
   * broker moved the money for free — the panel then shows three terms and
   * never learns the fourth exists.
   */
  transfer_fees?: number | null
  /**
   * The id of the taxation model this account carries (#752), and **absent
   * where it carries none** — never `null`, never an empty string.
   *
   * An account with no model is ordinary: every store that predates this, the
   * seeded `default` row, and anyone who declined the question. The absence
   * reaches the reader as an absence (#845) and #919 is what publishes
   * nothing rather than a zero for it.
   */
  taxation_model?: string
  /**
   * The day the wrapper was opened, **as its owner declared it** (#918) — and
   * absent where they declared none, which is ordinary.
   *
   * It cannot be derived, which is the whole reason it is typed: a PEA opened
   * in 2015 and transferred to a broker whose ledger only starts in 2022
   * derives three years of seniority instead of ten, and the date its owner
   * cares about is exactly the one no event carries.
   */
  opened_on?: string
  /**
   * This account's **earliest declared payment** — a `DEPOSIT`, derived on
   * every read and stored nowhere.
   *
   * It is here for one consumer: the form offers it as the opening date it
   * pre-fills, where the account has declared none. A *suggestion made by the
   * interface* — accepted it becomes a declaration and stops moving, and
   * nothing re-derives it afterwards.
   */
  first_payment?: string
  /**
   * What this account would owe if everything in it were sold today, at the
   * rates its model declares (#919) — and **absent** wherever there is no
   * figure to state.
   *
   * Absent covers four cases and they reach the reader as one member's
   * absence, not four: no model carried, a model of a kind with no realised
   * gain (`none`, `withholding_income`), an aged wrapper with no date to age it
   * from, and an assiette one unvalued line makes unknown. The panel tells them
   * apart by the **model**, which it already holds — never by this member's
   * value, because a projected zero and a zero nobody could compute are two
   * different sentences.
   *
   * Optional and never `| null`: `buildAccountRows` must not map it `?? null`
   * like its neighbours. That idiom collapses *absent* into *null* and erases
   * the distinction the server exists to preserve.
   */
  projected_tax?: number
  /**
   * The `kind` of the model this account carries — **the words, not the
   * arithmetic** (#919).
   *
   * It rides beside the figure so the panel can tell a declared exemption
   * (`none`, worth `0 €` because the model says so) from a measured zero and
   * from a model that taxes something else entirely (`withholding_income`),
   * without a second read of the model catalogue. Absent exactly where
   * `taxation_model` is.
   */
  taxation_kind?: string
  /**
   * The gain `projected_tax` was computed on — the latent gain of the lines the
   * account still holds, and **absent wherever the figure is**.
   *
   * It rides because the panel states a `Gain` of its own four paces up, and it
   * is a different quantity: the head's is latent *plus* realised, dividends
   * and fees, while the projection reads the latent term alone. Without this,
   * applying the rate this card names to the gain the head names misses by a
   * factor of three on a real account, and nothing on screen closes the gap.
   */
  projected_base?: number
  /**
   * The rate or rates that produced `projected_tax`, as fractions — one for the
   * two flat families, one per rung for a ladder.
   *
   * Published rather than derived here: the rule is *which side of the
   * threshold, levy folded in*, and a second reading of it in TypeScript drifts
   * on exactly the accounts nobody tests — the card would name a rate the
   * figure beside it contradicts, and neither would look wrong.
   */
  projected_rates?: number[]
  /**
   * The day the rate changes, where an age threshold is still ahead. Absent
   * where the model is not aged, has no date to age from, or is already past
   * its threshold — three cases, one absence.
   */
  projected_rate_changes_on?: string
}

export interface AccountsResponse {
  /**
   * **Mandatory in the client contract** (#745). `false` is a *designed* state
   * — the install that has declared nothing, which every default produces — and
   * it is not an empty array: the seeded `default` row is always there. A client
   * that drops this member cannot tell *you have declared no accounts* from
   * *your accounts have no figures*.
   */
  declared: boolean
  accounts: Account[]
}

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
  removeTaxationModel: (id: string) =>
    remove<{ id: string; removed: boolean }>(taxationModelPath(id)),
  reassignEvents: (id: string) =>
    send<{ account: string; reassigned: number }>(accountReassignmentPath(id), 'POST', {}),
  accountHistory: (account: string) => get<AccountHistoryResponse>(accountHistoryPath(account)),
}
