# Implementing the « Relevé » redesign

This document tells a coding agent how to take the app from the 5.3 interface to the
redesign validated in November 2026. It complements `DESIGN.md` (the rules) with the
**what and where** of each change, including the backend work the screens need.

Read in this order: `CLAUDE.md`, `DESIGN.md` (whole file; the Decisions Log of 7–8 Nov.
2026 explains every reversal), this document, then the mockup of the screen you are about
to build. The whole redesign ships as **one pull request**, built by one orchestrator and
Sonnet subagents working in parallel chantiers (§ 4), one signed commit per chantier, the
tree green after every merge. Do not open intermediate PRs.

## 1. Sources of truth

- **`DESIGN.md`** — tokens, typography rungs, layout, components, vocabulary. When this
  document and `DESIGN.md` disagree, `DESIGN.md` wins.
- **`docs/refonte/mockups/*.dc.html`** — the validated mockups, one file per screen or
  panel. They are Design-canvas templates: the CSS is in `<helmet><style>`, the markup uses
  `{{holes}}`, `sc-for` (repeat a row per list item) and `sc-if` (conditional), and the
  `renderVals()` script at the bottom holds every text and figure shown. `<dc-import
  name="Nav">` and `name="Header">` are the shared shell. Read the markup for structure and
  copy, the script for the data each screen needs. A file ending in `-Refonte` with a
  `mode` prop (`creation` / `edition`, `ok` / `attention`, `form`…) carries several states.
- The design system components live in `src/web/src/components/ui` (shadcn) and the app's
  own in `src/web/src/components`. Reuse them; add classes to `index.css`, never literal
  sizes in a page.

| Screen | Mockup | App file(s) today |
|---|---|---|
| Tableau de bord | `Dashboard-Releve-C.dc.html` | `pages/DashboardPage.tsx`, `features/dashboard` |
| Titres | `Titres-T5-Simple.dc.html` | `pages/SharesPage.tsx`, `features/shares` |
| Fiche d'un titre | `Titre-Fiche.dc.html` | `features/shares/components` (the share sheet) |
| Comptes · panneau compte | `Comptes-Refonte.dc.html`, `AccountSheet-Refonte.dc.html` | `pages/AccountsPage.tsx`, `features/accounts` |
| Grand livre · panneau événement · import | `GrandLivre-Refonte.dc.html`, `EventSheet-Refonte.dc.html`, `GrandLivre-Import-Refonte.dc.html` | `pages/DataPage.tsx`, `features/data` |
| Comparaison · choix du fonds | `Reference-Refonte.dc.html`, `Reference-Choix.dc.html` | `pages/BenchmarkPage.tsx`, `features/benchmark` |
| Agent · écritures · vide · statistiques | `Agent-*.dc.html` | `pages/AgentPage.tsx`, `features/agent` |
| Réglages · thème · panneaux | `Reglages-Refonte.dc.html`, `Reglages-Theme-Refonte.dc.html`, `ProviderSheet-`, `TokenSheet-`, `TokenCreated-`, `TaxSheet-Refonte.dc.html` | `pages/SettingsPage.tsx`, `features/settings` |
| Système · journal · confirmation | `Systeme-Refonte.dc.html`, `Journal-Refonte.dc.html`, `Confirm-Refonte.dc.html` | `pages/SystemPage.tsx`, `features/system` |
| Notifications · palette · premier lancement · code | `Notifications-Refonte.dc.html`, `Palette-Refonte.dc.html`, `Bienvenue-Refonte.dc.html`, `Code-Refonte.dc.html` | `components/Notifications.tsx`, `Palette.tsx`, `FirstRun.tsx`, `features/auth` |

## 2. Cross-cutting changes (do these first)

### 2.1 Shell and styles
- `index.css`: a `.fig` utility — `font-family: var(--font-mono); font-variant-numeric:
  tabular-nums; word-spacing: -0.32em; white-space: nowrap` — applied to **every** figure
  (amounts, %, quantities, dates, times, versions, identifiers). Remove the Geist-tabular
  figure rule of #1281 and the `ticker` 11 px rung.
- Page envelope `32px 32px 56px`; remove `max-w-column` from pages that are not a form.
- Buttons: page variant 32 px / 13 px / padding 0 12; sheet variant 36 px / 14 px / padding
  0 14. Outline everywhere but one `primary` per screen. Remove `ghost` from pages.
- Text tabs component (`TextTabs`): 15/22/500, gap 24, 2 px underline on the active tab,
  on a 1 px `border` container line; a `size="sheet"` variant 14/20, gap 18.
- Filter button component (`FilterButton`): 13 px muted text + ChevronDown 14 px; chosen
  value in `foreground`; opens a popover listbox (radius 14, no shadow, search when > 8
  items).
- Table primitives on the ground: header row in Label, `border-b` on every row, 40 px /
  48 px rows, right-aligned `.fig` columns, sortable header = `foreground` 500 +
  `aria-sort`, no glyph.
- Floating surfaces (Dialog, Popover, Palette, Notifications): radius 14, `border`, no
  shadow in Atelier.
- Header: the subtitle is a dated fact or empty; remove every other subtitle. Nav label
  « Référence » → « Comparaison » (route stays `/benchmark`, nav key `benchmark`).
- Remove pills/chips (`Badge`, `chip`) from pages: a type or a status is a word in
  `muted-foreground`.
- Dates: one medium-form formatter in `lib/format.ts` used everywhere (`6 nov. 2026`, `1ᵉʳ oct. 2026`); drop the
  `02/03/2026` table form; date-time as `6 nov. 2026, 09:14`.
- i18n: new keys in French first, English mirrors. The glossary of `DESIGN.md › Content`
  is binding (ligne / titre / compte / identifiant / libellé / prix moyen d'achat /
  Comparaison / Ajouter un compte / Mise à jour des cours / Relecture du grand livre /
  jeton d'accès vs tokens).

### 2.2 Confirmation dialog
One `ConfirmDestructive` component (mockup `Confirm-Refonte.dc.html`): title question,
ruled list of what goes, one line (« Irréversible. … » / « Immédiat. … »), Annuler + filled
`destructive`. Use it for: purge orphan histories, delete a thread, delete an event, delete
an account, revoke a token. Replace every existing `alertdialog`.

## 3. Backend changes

The frontend consumes `src/web/src/lib/api.gen.ts` generated from the OpenAPI schema
(`packages/app/src/application/api_schema.py`); every change below updates the schema,
the generated client and its tests.

### 3.1 Accounts have no type
- `Account` model: remove the wrapper/type field; fields are `id` (the owner's short
  identifiant, unique, shown in the ledger and imports), `label` (optional), `opened_on`,
  `taxation_model_id` (nullable). Migration (`schema_steps.py`): keep the old type only
  to pick a default `taxation_model_id` when one of the registry matches, then drop it.
- `POST /api/accounts`, `PATCH /api/accounts/<id>`: accept `label`, `taxation_model_id`;
  reject a duplicate identifiant with a 409 problem (`problem.py`).
- The agent's tools, the exports and the MCP server read `label ?? id`.

### 3.2 Portfolio figures the dashboard needs (`GET /api/portfolio-totals`)
Add to the payload, all computed server-side in `portfolio_facts.py` / `portfolio_view.py`:
- `variation`: for each range (`1M`, `YTD`, `1Y`, `MAX`) the amount and percentage of the
  value change over the range, and the start date, so the hero line reads « +5 021,10 €
  (+11,6 %) depuis un an ». Percentage base = value at the start of the range.
- `cash`: total cash held (sum of the accounts' cash ledgers).
- `net_if_sold_today`: Σ over accounts of (value − projected tax) using
  `taxation_projection.py`; an account without a model counts gross; the payload says
  which accounts were estimated (`estimated_accounts`) so the UI can write « impôt estimé
  sur le PEA seul » in the tooltip.
- `gain_total` is the official gain: latent + realised + dividends − fees, over the net
  contribution. `GET /api/positions` keeps `latent_gain` and now also returns
  `latent_gain_pct` **on the securities' cost only**, labelled as such; no endpoint returns
  a second « total » gain.
- **Remove the dashboard customisation entirely.** The dashboard is fixed (DESIGN.md,
  decision of 7 Nov. 2026): no widgets to arrange, no half/full widths, no edit mode, no
  hidden cards, no « Nouveau » badge, no « Place libre », no reset. Delete, backend:
  `GET/PUT/DELETE /api/dashboard/layout` and `packages/app/src/application/dashboard_layout.py`,
  the layout rows of the store (a migration drops the table or key; a one-release tolerant
  read that ignores a stored layout is enough). Delete, frontend:
  `features/dashboard/components/DashboardGrid.tsx`, `features/dashboard/lib/dashboardLayout.ts`,
  the layout part of `lib/dashboardBlocks.ts`, the `dashboard/layout` client in `lib/api.ts`,
  the tests `dashboardLayout.test.ts` / `dashboardGrid.test.tsx` and the layout cases of
  `dashboard.test.tsx`, the `fr.json` / `en.json` keys of the edit mode (« Modifier le
  tableau de bord », « Cartes masquées », « Place libre », « Réinitialiser », « Terminé »,
  « Monter », « Descendre »), the drag handle and the ⋯ menu. The movers section
  (*Mouvements*) goes with it. What remains is `DashboardPage.tsx` rendering, in order: the
  hero, the chart, *Rythme d'investissement* and *Valeur des titres* side by side.

### 3.3 Tax models and rates
- `taxation_registry.py`: version the catalog by effective date; France 2026 entries: PEA
  and PEA-PME (12,8 % then 0 % after 5 years, PS 18,6 %), CTO (flat 31,4 % = 12,8 % + PS
  18,6 %), assurance-vie (12,8 % then 7,5 % after 8 years, PS 17,2 %), PER (barème at
  exit). Each entry carries `source` (url) and `effective_from`. The projection reports IR
  and PS separately (`taxation_projection.py` returns both).
- `POST /api/taxation-models/registry` accepts a list of registry ids (first-run step 2
  imports several at once) and a `country`.
- The agent's prompt gets the rates from the registry, never hard-coded (the mockup's
  « barème coûterait environ 120 € » must be computed: IR at TMI + PS, CSG deductibility
  ignored, say so in the answer).

### 3.4 Import preview (`POST /api/events/import`)
- Split into two steps: `POST /api/events/import/preview` (multipart file, `account_id`,
  optional `format`) returning rows with `status` ∈ {`new`, `duplicate`, `unknown_security`,
  `unreadable`}, the parsed fields, and for a duplicate the `matched_event_id` and the
  `matched_on` criteria (`isin`, `date`, `quantity`, `price` or `date`, `amount` for
  deposits); then `POST /api/events/import/commit` with the preview token and the
  user's resolutions (`associate: {row: n, security: symbol}`), importing only `new` rows.
- Matching rule: same account, same ISIN or symbol, same date, same quantity and unit
  price (±0,01), or for deposits/withdrawals same date and amount. An ISIN already known
  to the store is never `unknown_security`.
- Keep the fee column of the file when the format has one.
- Format: only the app's own layout (`.csv`, or `.xlsx` via openpyxl), with its `account`
  column: a row naming an account keeps it, the picked account fills the others. The broker
  profiles first written here were dropped on 9 Nov 2026 (no real statement to check them on).

### 3.5 Event write effect (`POST /api/events/preview`)
A dry-run endpoint returning the effect sentence's data for a candidate event: the
account's cash after the write, the amount debited or credited, the fees. The sheet calls
it on each change (debounced) to render the effect line. The sheet never computes it
client-side.

### 3.6 Notifications in two registers
- `advisories.py`: add a `register` field ∈ {`user`, `system`}. `user` = late price (a
  symbol whose last quote is older than the stale threshold while the market is open),
  import finished, update installed / available. `system` = series rebuilt, orphans,
  tokens, job failures. `GET /api/advisories` takes `?register=user` (the bell) and the
  System page reads both.
- Texts are built server-side in French and English with the security's **name** (« Le
  cours d'Amundi PEA Nasdaq-100 n'a pas bougé depuis 16:25 »), never the raw symbol alone.
- Outbound channels (new): `notification_channels` table (`kind` ∈ ntfy, email, webhook,
  apprise; `target`; `scopes` = list of advisory kinds; `enabled`), routes
  `GET/POST/PATCH/DELETE /api/notification-channels`, `POST /api/notification-channels/<id>/test`.
  A sender per kind in `packages/core`; dispatched when a `user` advisory is raised or a job
  fails. Secrets (SMTP password, webhook token) stored like the agent key.

### 3.7 Journal (`GET /api/logs`)
- A ring buffer handler on the root logger (last 5 000 records) plus the file log already
  written. Endpoint `GET /api/logs?level=&job=&since=&q=&cursor=` returning rows
  `{time, level, job, message, detail}` where `job` is the task name derived from the
  logger name (`suivi_bourse.scrape` → « Mise à jour des cours », `backfill`, `performance`,
  `ingestion`, else « Système ») and `detail` the traceback if any. A retried-and-recovered
  HTTP 429 is logged at WARNING, not ERROR.
- `GET /api/logs/download` streams the file log (last 7 days).
- `GET /api/logs/stream` (SSE) for « En direct » — optional; polling every 5 s is
  acceptable for a first version.

### 3.8 Access tokens with scopes (`auth_rules.py`, `api/settings.py`)
- Replace the single token by an `access_tokens` table: `id`, `label`, `scopes` ⊆ {`api`,
  `mcp`}, `expires_at` (90 days / 1 year / never), `created_at`, `last_used_at`,
  `prefix` (a **public** 8-char id shown in the list, distinct from the secret), hash of
  the secret. Routes `GET/POST /api/tokens`, `POST /api/tokens/<id>/regenerate`,
  `DELETE /api/tokens/<id>`. The secret is returned once, on create/regenerate.
- The auth gate checks the scope against the mount (`/api` vs `/mcp`).
- Rename « Code redemandé après » to « Verrouillage automatique » with values 15 min, 1 h,
  1 day, 7 days, 30 days.
- Keep `SB_RESET_AUTH`; the lock screen's reset hint names it.

### 3.9 Several LLM providers
- Replace the single agent config by a `providers` table: `id`, `label` (optional),
  `kind` ∈ {anthropic, openai, openai_compatible, ollama}, `base_url`, key (encrypted as
  today), `default_model`, `is_default`, `last_test_at`. Routes `GET/POST/PATCH/DELETE
  /api/agent/providers`, `POST /api/agent/providers/<id>/test` (lists models),
  `PUT /api/agent/providers/<id>/default`.
- A thread stores the provider and model it runs on; the composer's picker switches them
  per thread. `GET /api/agent/config` keeps `enabled` and `reasoning` only.
- The privacy sentence is computed from the provider: « Vos chiffres sont envoyés à
  {label or kind} » ; « restent sur ce serveur » only when `base_url` resolves to
  localhost or a private address.

### 3.10 Agent usage statistics (`GET /api/agent/stats`)
- Persist per `ModelResponse` the pydantic-ai usage (`input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_write_tokens`, `requests`, `tool_calls`, `model_name`,
  `timestamp`) in the thread store (it is already in the message JSON; index it).
- Endpoint returns totals since 1 January, the cache / new / output split, per-week
  series, per-model and per-thread tables. No price.

### 3.11 System page data (`GET /api/runtime`, `/api/jobs`, `/api/store`)
- `GET /api/jobs/history` keeps the 24 hourly buckets; the UI draws a tick per hour.
- `GET /api/jobs` adds per job: `state` (short French), `last_run_at`, `next_run_at`,
  `cadence` (« à chaque écriture », « après le relevé », or the interval). Remove the
  pause endpoints if any; `POST /api/jobs/<name>/run` stays (« Lancer »).
- `GET /api/runtime` adds the followed securities with `{symbol, name, state ∈ {ok,
  stale}, stale_since, stale_passes}`, the database size in bytes, the quote source and
  its last response time.
- `GET /api/store` keeps the orphan histories; `DELETE /api/store/orphans` stays.
- Remove any backup-related UI; the app has no backup feature.

### 3.12 First run
- A `first_run` sequence endpoint is not needed; the four steps call existing routes:
  `PUT /api/settings` (currency), `POST /api/taxation-models/registry` (list), `POST
  /api/accounts`, then the import preview or the event sheet. Guard: the app serves the
  first run until a currency is stored.

## 4. How to run the work: one orchestrator, Sonnet subagents, parallel « chantiers »

The redesign is too large for one agent in one pass. The agent that reads this document is
the **orchestrator**: it owns the branch, the integration order and the final PR; it never
implements a chantier itself. It launches **Sonnet subagents**, one per chantier below,
with a self-contained brief (the chantier's section of this document, the mockup files it
needs, the files it owns, what it must not touch) and merges their work in the order of the
dependency graph. Each subagent works in its own git worktree on a branch off the
orchestrator's, keeps the tests green, and hands back a summary of the files changed and
the API it exposes or consumes.

Rules for the orchestrator:
- Launch in waves: everything in a wave is independent and runs in parallel; a wave starts
  when the wave it depends on is merged into the integration branch and the full test suite
  passes.
- A frontend chantier that needs a backend chantier of the same wave codes against the API
  contract written in § 3 (field names and shapes) and a stubbed `api.gen.ts`; the
  orchestrator regenerates the client once the backend lands and fixes the seams.
- Two subagents never own the same file. Shared files (`index.css`, `router.tsx`,
  `api_schema.py`, `fr.json` / `en.json`, `api.gen.ts`) are edited by the orchestrator from
  the subagents' hand-backs, or by exactly one named subagent per wave.
- After each wave the orchestrator runs the acceptance checks of § 5 that apply, and a
  short visual check of staging; it does not wait for the end to find a drift from the
  mockups.
- Commits: one per chantier, signed, message in English, conventional type.

### Wave 0 — foundations (sequential, one subagent, then merge)
- **F0 Shell & primitives**: § 2.1 and § 2.2 — `.fig`, button sizes, `TextTabs`,
  `FilterButton`, table primitives, floating-surface radius/shadow, Header subtitle rule,
  Nav label « Comparaison », `ConfirmDestructive`, date formatter, the i18n glossary keys.
  Nothing else starts before this is merged, because every page uses it.

### Wave 1 — backend chantiers (parallel) and frontend chantiers that need no new backend
Backend (one Sonnet subagent each, each owning its modules, schema fragment and tests):
- **B1 Accounts without type** (§ 3.1) + **tax registry and rates** (§ 3.3) — same
  subagent, they share `taxation_*` and the account model.
- **B2 Portfolio figures** (§ 3.2): variation per range, cash, net-if-sold, official gain,
  and the removal of the dashboard layout backend.
- **B3 Import preview/commit** (§ 3.4) + **event dry-run** (§ 3.5).
- **B4 Advisories in two registers + notification channels** (§ 3.6).
- **B5 Journal endpoints** (§ 3.7) + **System page data** (§ 3.11).
- **B6 Access tokens with scopes** (§ 3.8).
- **B7 Multiple providers** (§ 3.9) + **agent usage stats** (§ 3.10).

Frontend, no new backend needed (parallel with the above):
- **W1 Titres + fiche** (step 3 below) — reads existing `/api/positions`, `/api/prices`.
- **W2 Comparaison** (step 6) — existing `/api/benchmark`; the per-account cash fix is a
  small backend touch the subagent owns in `benchmark_view.py`.
- **W3 Grand livre table + event sheet** (step 5 without the import page and with the
  effect line wired to a stub until B3 lands).
- **W4 ⌘K palette, PIN screen, Notifications popover shell** (step 10, the popover reading
  `?register=user` against a stub until B4 lands).

### Wave 2 — frontend chantiers that need wave 1 (parallel)
- **W5 Tableau de bord** (step 2) ← B2.
- **W6 Comptes + account panel + first run** (steps 4 and the first run of 10) ← B1.
- **W7 Import page** (rest of step 5) ← B3.
- **W8 Agent + Statistiques** (step 7) ← B7.
- **W9 Réglages + its panels + Thème page** (step 8) ← B1, B4, B6, B7.
- **W10 Système + Journal** (step 9) ← B5.

### Wave 3 — integration (orchestrator)
Regenerate `api.gen.ts`, remove every stub, run the whole suite, light and dark
screenshots of each page at 1 440 px, the acceptance list of § 5, then open the PR.

The step numbers below are the page specifications the chantiers refer to.

1. **Shell + tokens** (§ 2.1, § 2.2, Nav rename, Header subtitle rule, `.fig`).
2. **Tableau de bord** — fixed layout; hero per `DESIGN.md › The hero`; period segmented
   in words drives both the chart and the variation line; *Valeur des titres* replaces
   *Répartition*; delete the edit mode, the movers, the layout store (§ 3.2).
3. **Titres + fiche** — table alone, columns per mockup, « Détenu · prix moyen », the day's
   move under the price, totals row; « Plus-value des titres … · hors dividendes et
   liquidités » in the summary line; the share sheet becomes the page `/shares/<symbol>`
   (`Titre-Fiche.dc.html`, route to add in `router.tsx`).
4. **Comptes + panneau** — account bar, head like the dashboard's, sections; the panel
   with Identifiant · Libellé · Ouvert le · Modèle d'imposition; « Ajouter un compte »;
   delete via `ConfirmDestructive` (§ 3.1). Tax section shows IR and PS separately.
5. **Grand livre + panneau événement + import** — flat table, actions on the filter line,
   infinite scroll; event sheet with text-tab types and the effect line (§ 3.5); the import
   page (§ 3.4) with « Importer dans », the *Issue* column and « Associer ».
6. **Comparaison** — sentence hero, fund picker popover, Écart / Montants tabs, per-account
   section; fix the cash attribution per account in `benchmark_view.py`.
7. **Agent + statistiques** — rail, composer with provider · model picker, proposals as
   ruled rows with duplicates pre-detected against the ledger (same security, date, amount),
   privacy sentence from the provider (§ 3.9, § 3.10).
8. **Réglages + panneaux** — six sections on planes; tokens (§ 3.8), providers (§ 3.9),
   notification channels (§ 3.6), tax models catalog (§ 3.3), Avancé rows with one-clause
   descriptions and defaults; Thème page with the side preview (render the real Dashboard,
   Titres, Comptes and Grand livre components inside a scoped-variables wrapper,
   `pointer-events: none`).
9. **Système + Journal** — fixed title; jobs with one « Lancer »; followed titles in two
   columns; Données / Installation; `ConfirmDestructive` for the purge; the Journal page
   (§ 3.7, § 3.11).
10. **Notifications, ⌘K, premier lancement, code d'accès** — bell in the `user` register
    (§ 3.6); palette groups per mockup; four-step first run (§ 3.12); PIN screen per mockup.

## 5. Acceptance (for the PR)

- The dashboard has no customisation left: no layout endpoint, no edit mode, no hidden
  cards, no movers; `grep -rn "dashboard/layout\|Cartes masquées\|Place libre" src packages`
  returns nothing.
- Every page matches its mockup at 1 440 px: same rows, same copy, same figures' alignment.
  The PR description carries one screenshot of staging per page, in the order of § 4.
- Every figure renders in Geist Mono with tabular numerals (`stylesheet.test.ts` gets a
  rule for `.fig`); no `02/03/2026` date remains; no pill/chip, no ⓘ, no `▾`/`↓` glyph.
- Exactly one `primary` button per screen (add a `src/web/lint/one-primary-per-page.grit` rule, in the style of `card-for-decisions.grit`).
- No page subtitle but a dated one; no help sentence outside the four exceptions of
  `DESIGN.md › Content`.
- Light and dark both pass the existing contrast tests; the three states (in flight,
  empty, failed) of every block exist.
- One PR, titled with the conventional type (`feat(web): …`), labelled `feat`, commits signed
  (`-s`); release-please owns the version (`CLAUDE.md`). The description lists the backend
  migrations it ships and the routes it removes.
- Backend: schema, generated client, migration and tests updated; `GET /api/portfolio-totals`
  figures reconcile: `value = securities + cash`, `gain_total` = the four terms, and the
  Titres summary's latent gain = Σ of the rows.
- i18n: French and English keys present; the glossary respected (grep for « position »,
  « PRU », « registre », « Déclarer », « Référence » must return nothing user-facing).

## 6. Out of scope (open as issues, do not build here)

Backups and restore; SSO / proxy-header / OIDC auth; `/healthz` `/readyz` `/metrics`;
IFU / 2074 exports; multi-currency lines and FX; fees of custody / TTF / corporate actions
as event kinds; assurance-vie and PER manual valuation; PEA ceiling gauge; TRI traceability
(cash-flow list + XIRR export); time-weighted *Performance* curve rework; « Annuler » after
an import or an agent merge; notes de version and schema version in Installation; YAML
config export. The personas' reports (`docs/refonte/` has none; see the project's
`personas-retours-refonte.md`) list the rationale for each.
