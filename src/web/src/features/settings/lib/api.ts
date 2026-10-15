/**
 * The installation (#724): the dials, the boot variables, and the store.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { get, ROUTES, remove, type StorePersistence, send } from '@/lib/api'

// ------------------------------------------------------------------------- //
// The installation (#724)
//
// That line is why the two halves render as two sections of **one** surface,
// the second a description rather than a form.
// ------------------------------------------------------------------------- //

/**
 * One dial, as the registry describes it — `settings_registry.py` is the single
 * list, and this is that list crossing HTTP.
 */
export interface SettingDescription {
  key: string
  /** The effective value: the row if there is one, the code's default otherwise. */
  value: string | number | null
  default: string | number | null
  type: 'integer' | 'string' | 'currency' | 'symbol'
  minimum: number | null
  maximum: number | null
  /** What changing it triggers, as a token the catalogue turns into a sentence. */
  effect: string
  /** The registry's own English note. Diagnostic, like `problem.detail`. */
  doc: string
  /**
   * Whether the app must be told before it can do its work. The
   * first run is a predicate over **this mark and `stored`** — *a required dial
   * nobody has answered* — which is why the front carries no key of its own:
   * `base_currency` wears it today, and the second one to wear it will not need
   * this decision reopened.
   */
  required: boolean
  /**
   * Whether the store holds an answer. Published rather than derived from
   * `value !== default`: a dial answered *at* its default is answered, and a
   * required one with nothing stored is the question itself.
   */
  stored: boolean
}

/**
 * One boot variable — what the process had to know before it could open the
 * store. **Four and no fifth** (#740).
 *
 * It is a *description*: rendered as greyed-out fields it invites the click and
 * reads as a form that refused, when the honest statement is that nothing here
 * is answerable from in here at all. The section says *changes when the
 * container is recreated* **once**, for all of them.
 */
export interface EnvironmentVariable {
  name: string
  /** What the app is running on — the variable's, or the app's own default. */
  value: string | null
  /** Whether the environment named it at all. */
  set: boolean
  /**
   * Where the value came from, and it is **factual rather than helpful**:
   * reporting a variable as *unset, using the default* because it happens to
   * equal the default would be a guess (#654 trap 2).
   */
  source: 'environment' | 'default'
}

export interface ConfigResponse {
  log_level: string
  settings: SettingDescription[]
  environment: EnvironmentVariable[]
  /** Set in the environment and obeyed by nothing. Computed, so it cannot drift. */
  unread_environment: string[]
}

/** What `PUT /api/settings` answers: the new list, what moved, and what it reached. */
export interface SettingsWriteResponse {
  settings: SettingDescription[]
  changed: string[]
  /**
   * The effect, **quantified**. A portfolio-wide cadence that reaches 3 symbols
   * out of 12 has to say so — the other nine are not misconfigured, they read
   * the new value when their market opens.
   */
  effect: Record<string, unknown>
}

/** One orphan symbol: nothing declares it, and this is the series it holds. */
export interface OrphanSymbol {
  symbol: string
  points: number
}

/**
 * The store's own figures. The path and the persistence are **not** here — they
 * are process memory and ride on `/api/runtime`, which opens nothing and is
 * therefore still answering when this resource is not.
 */
export interface StoreState {
  /** The file and its write-ahead log. `null` — nothing written yet. */
  size_bytes: number | null
  /**
   * The newest import, and never the newest observed price: that second one is
   * liveness, which the bell answers (#829), and here it would make a
   * store whose last import was a year ago read as freshly written.
   */
  ledger_last_write: string | null
  orphans: OrphanSymbol[]
  /** Repeated from the runtime so a report quoting this resource is whole. */
  persistence: StorePersistence
}

/** What the purge answers: rows, and never bytes. */
interface PurgeResult {
  symbols: string[]
  points_removed: number
}

export const settingsApi = {
  config: () => get<ConfigResponse>(ROUTES.config),
  saveSettings: (values: Record<string, string | number>) =>
    send<SettingsWriteResponse>(ROUTES.settings, 'PUT', values),
  store: () => get<StoreState>(ROUTES.store),
  purgeOrphans: () => remove<PurgeResult>(ROUTES.storeOrphans),
}
