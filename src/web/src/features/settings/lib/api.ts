/**
 * The installation (#724): the dials, the boot variables, and the store.
 *
 * The types are the contract of #712 §11 for this domain, and the calls go
 * through the transport of `lib/api.ts`, which also holds every path in
 * `ROUTES`: a route renamed still changes that file and the test harness, and
 * no page test.
 */

import { forget, get, ROUTES, remove, send } from '@/lib/api'

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
  value: string | number | boolean | string[] | null
  default: string | number | boolean | string[] | null
  type: 'integer' | 'string' | 'currency' | 'symbol' | 'symbols' | 'boolean'
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

export interface ConfigResponse {
  log_level: string
  settings: SettingDescription[]
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
 * The store's own figures. The path is **not** here — they
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
}

/** How one pass went: `idle` is a backfill cycle with nothing to do. */
export type PassOutcome = 'ok' | 'attention' | 'error' | 'idle'

/** One hour of a job, counted. */
export interface JobSlot {
  hour: string
  passes: number
  errors: number
  attentions: number
  idles: number
  /** Summed over the hour's passes, in seconds. */
  duration: number
  last_error: string | null
  last_error_at: string | null
}

/** A WARNING-or-above line one pass logged, cut at 300 characters. */
export interface JobLogLine {
  level: string
  logger: string
  message: string
}

/** One of the 20 most recent passes, kept whole. */
export interface JobPass {
  at: string
  duration: number
  outcome: PassOutcome
  error: string | null
  lines: JobLogLine[]
  /** The lines past the tenth, counted and dropped. */
  overflow: number
  /** Set on `scrape_recent`, which mixes symbols. */
  symbol?: string
}

/** One job's last 24 hours: 24 slots, the oldest first, and its newest passes first. */
export interface JobTrack {
  slots: JobSlot[]
  passes: JobPass[]
  /** The newest pass, even older than the window. */
  last: JobPass | null
}

/** `GET /api/jobs/history` — process memory, lost at every restart (#1236). */
export interface JobsHistory {
  now: string
  /** When this process started: the hours before it have no pass to show. */
  started: string
  jobs: { backfill: JobTrack; performance: JobTrack; ingestion: JobTrack }
  /**
   * One track per symbol scraped since start: a held symbol with no pass yet is
   * absent. Its passes come **without** their log lines, which ride on
   * `scrape_recent` only.
   */
  scrape: Record<string, JobTrack>
  /** The scrape's 20 newest passes, all symbols mixed, with their lines. */
  scrape_recent: JobPass[]
}

/** What the purge answers: rows, and never bytes. */
interface PurgeResult {
  symbols: string[]
  points_removed: number
}

/** A stored theme: tweakcn's `cssVars`, cleaned by the server (#1248). */
export interface ThemeVars {
  theme: Record<string, string>
  light: Record<string, string>
  dark: Record<string, string>
}

export const settingsApi = {
  config: () => get<ConfigResponse>(ROUTES.config),
  saveSettings: (values: Record<string, string | number | boolean | string[]>) =>
    send<SettingsWriteResponse>(ROUTES.settings, 'PUT', values),
  store: () => get<StoreState>(ROUTES.store),
  jobsHistory: () => get<JobsHistory>(ROUTES.jobsHistory),
  purgeOrphans: () => remove<PurgeResult>(ROUTES.storeOrphans),
  theme: () => get<ThemeVars | null>(ROUTES.theme),
  /** A bare theme is checked strictly; a pasted registry entry (`cssVars`) is cleaned. */
  saveTheme: (body: unknown) => send<ThemeVars>(ROUTES.theme, 'PUT', body),
  importTheme: (id: string) => send<ThemeVars>(ROUTES.themeImport, 'POST', { id }),
  resetTheme: () => forget(ROUTES.theme),
}
