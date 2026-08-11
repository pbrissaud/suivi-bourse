# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuiviBourse is a Python application that monitors stock shares using yfinance for real-time pricing and stores everything — the ledger, the positions, the prices and the performance series — in **one embedded DuckDB store** (ADR-0001). It supports historical data backfill for viewing past price evolution.

## Commands

### Python App (in `app/` directory)

```bash
# Dependencies are managed with uv (app/pyproject.toml + app/uv.lock).
# Install runtime + dev deps into a uv-managed .venv:
cd app && uv sync

# Run the app locally (requires an events folder at ~/.config/SuiviBourse/events/)
# gunicorn is the only boot path: the web API and the scheduler share one
# process (issue #651), and src/gunicorn.conf.py holds the boot sequence.
# `main.py` has no __main__ block.
cd app && uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
# On macOS this crashes as soon as a symbol is scraped — gunicorn forks its
# worker and libcurl's macOS-only Curl_macos_init (reached from curl_easy_init
# in yfinance's HTTP backend) reads the system proxy config through
# CoreFoundation, which is unsafe after a fork without exec. Linux has no such
# init and is unaffected; on a Mac use docker-compose.dev.yaml instead.

# Lint
cd app && uv run flake8 src/ --ignore=E501

# Run tests (unit + E2E, all network-mocked; no config or network required)
cd app && uv run pytest tests/            # add --cov=src for coverage
```

The v5 seam is **a real store in `tmp_path` with a faked yfinance** (spec #695):
the `store` fixture opens a genuine DuckDB *file* — never `:memory:`, since
DuckDB refuses a second process and persistence is part of what is asserted —
with the DDL applied and the seed in place. Assertions go on the store's
contents or on the API's JSON, never on the fact that a method was called; the
`mock_influx` fixture was the counter-example and left with `influxdb_writer.py`
at #700; `shares_validator` went with `schema.yaml`. **There is one faked edge
left in the whole suite, and it is yfinance.**

### Web UI (in `app/web/` directory)

The front is a packaged SPA (issue #659). It lives under `app/` because the
Docker build context is `./app`; it is **not** a pnpm workspace with `website/`.

```bash
cd app/web
pnpm install
pnpm lint      # tsc -b --noEmit
pnpm test      # vitest, no network and no configuration required
pnpm build     # → app/src/static/, which Flask serves. Git-ignored.
pnpm dev       # Vite on :5173, proxying /api to http://localhost:8080

# `pnpm dev` needs the API running. On a Mac that means the container, not a
# local process — #657: gunicorn forks and libcurl's Curl_macos_init then dies
# in CoreFoundation. Point it elsewhere with SB_API_URL if needed.
cd docker-compose && SB_UID=$(id -u) SB_GID=$(id -g) docker compose -f docker-compose.dev.yaml up -d
```

The image builds the bundle itself in a first `node` stage and `COPY --from`s
`dist/`; the runtime image stays Python-only. `app/.dockerignore` keeps the
host's `node_modules` and a locally built `src/static` out of the context — the
latter would otherwise shadow the image's own build. The install layer copies
`package.json`, `pnpm-lock.yaml` **and `pnpm-workspace.yaml`**: pnpm 11 reads
its `allowBuilds` verdicts from the workspace file and `pnpm install` is what
asks for them, so leaving it out fails the build on `ERR_PNPM_IGNORED_BUILDS`
while every gate run *from* `app/web` stays green. A pull request touching
`app/**` now builds the image for that reason — it is the only gate that reads
the Dockerfile, which was otherwise built by the release workflow alone, i.e.
after the merge.

**The v5 front is a walking skeleton** (issue #713, spec #712): the harness, the
theme, the two catalogues and the shell, with the four routes reachable and the
four pages still placeholders — they are **redesigned, not ported**, one ticket
each. Four things about it are decisions, not defaults:

- **One test seam, the outermost.** The real router, the real pages, the real
  catalogues, the real theme and a real `QueryClient` mount in jsdom; **HTTP is
  the only faked edge** (MSW), which is the exact parallel of `tests/test_e2e.py`
  (real runtime, faked yfinance). `src/test/factories.ts` is one *parameterised*
  factory in the taste of `conftest.py`'s `fake_ticker`, and it covers the three
  shapes the real portfolio cannot show — N ≥ 3 accounts, a held position in a
  foreign currency, a held position with no price. No fixture carries a real
  symbol, amount or label. Assertions are on the accessible rendering — never a
  class, a component name, or a DOM snapshot.
- **`index.css` has exactly three blocks** (ADR-0023): the tweakcn `Vercel`
  primitives, **never hand-edited** and regenerated with `pnpm dlx shadcn@latest
  add https://tweakcn.com/r/themes/vercel.json`; the domain layer, which holds
  only what the preset cannot say (`--price` = `--chart-2` and `--grant` =
  `--chart-1` verbatim, `--dividend` and `--attention` added, `--loss` distinct
  from `--destructive` and lower in chroma); and an `@theme inline` bridge, so
  `text-gain` is written like `bg-card`. The twelve `--alloc-*` are **generated**
  in `lib/alloc.ts` and written onto the root element by `ThemeProvider` — rank 1
  is the most contrasted on **both** grounds, which is why the lightness ramp
  reverses between them.
- **The theme and the language are the reader's two preferences, one mechanism**
  (ADR-0024): three states each (`light|dark|auto`, `fr|en|auto`), absence
  meaning `auto`, two `localStorage` keys of identical shape, and **no dial in
  the store** — the app asks one question at first run, and that one is not it.
  The catalogues are ICU, one JSON per language, keyed semantically, English the
  source. Numbers and dates follow the **language**, not the currency: `LOCALE`
  is gone and the eight `Intl` sites take a locale. The front branches on
  `problem.type` and renders `detail` nowhere.
- **The shell is shadcn's `Sidebar`** (ADR-0022) — `collapsible="icon"` wide, a
  drawer under 768 px, nothing hand-written for the narrow case — plus the
  **content header bar** carrying four objects on all four pages (collapse,
  status dot, language, theme), and a banner that lives *in the content column*
  and shows **one band or none**. `lib/api.ts` is the only module that knows a
  URL, and the paths it exports are what the test handlers fake.

### Documentation Website (in `website/` directory)

Dependencies are managed with pnpm. The docs are versioned and **every version
has an address, the current one included** (ADR-0025, issue #733): `docs/` holds
**v5** at `/docs/v5`, `versioned_docs/version-4.x/` and
`versioned_docs/version-3.x/` hold the frozen **v4** and **v3** at `/docs/v4`
and `/docs/v3`. `lastVersion` is still `current` — v5 is the default version, it
simply no longer sits at the bare root. Use the navbar version selector to
switch. Snapshot a new version with `pnpm docusaurus docs:version <name>`.

The scheme is uniform rather than *everything is versioned except the newest*,
which is the rule that made ADR-0016's in-app convention bubble impossible: with
`/docs` meaning *latest*, a link a v5 install emits serves v6's page the day v6
ships — a correct page about another product. **The link contract the product
consumes** (issue #712) is therefore:

```
https://pbrissaud.github.io/suivi-bourse/{locale}/docs/v5/<page>#<anchor>
```

locale segment absent for the default locale (English), `fr/` for French, and
the version frozen at the **major** (a 5.1 install still reads `/docs/v5`).

`/docs` is kept alive by `@docusaurus/plugin-client-redirects`, which points it
at `/docs/v5/`. That redirect is **client-side and only exists in the built
output** — under `pnpm start` `/docs` 404s, so a manual check in development
concludes the opposite of the truth; verify it on `build/docs/index.html`.

**The site is bilingual through Crowdin, scoped to the v5 corpus** (issue #739,
ADR-0024). `i18n.locales` is `['en', 'fr']` with English the **source**, so
`pnpm build` builds both and `/fr/` is published — the locale half of the link
contract above. `crowdin.yml` sits at the **repository root** and covers the
whole product in **one** project (ADR-0024, amended by #739): the site *and*
`app/web/src/i18n/en.json`. Two projects were specified and the reason —
"different formats" — is refuted by the file itself, which already mixes
Markdown and ICU JSON; what settles it is that a translation memory is
per-project by default, so *plus-value latente* translated in the interface
would never suggest itself in the page that explains it. Its sources are
`website/docs/` plus the theme catalogues under `website/i18n/en/` (generated by
`pnpm write-translations`, committed) and the front's hand-written catalogue;
the frozen versions never enter it, neither their pages nor their sidebar
catalogues, which `.gitignore` keeps out of the repository as well. `editUrl`
splits by locale — GitHub for English, Crowdin otherwise — since a pull request
on a French file is lost at the next import.

Two gates guard it, and neither is `pnpm build` — which opens neither file:

- **The CI lints `crowdin.yml` with the tool that consumes it** — from the
  repository root, `npx @crowdin/cli config lint`, no network and no secret. The CLI
  compiles each `source:` into a regex, so `'/docs/**/*.{md,mdx}'` — valid YAML,
  valid shell — is refused with `Illegal repetition` (`{` opens a quantifier);
  Crowdin has no brace expansion, hence **one extension per entry**. Checking
  the file with a YAML parser passes it, and the symptom is an upload that
  carries nothing.
- **`pnpm write-translations --override` must leave `i18n/en/` unchanged.** The
  committed English catalogues **win over `docusaurus.config.js` at build time,
  for English too**, so a theme string edited in the config and not regenerated
  is ignored with every check green. `--override` is what makes the check real:
  plain `write-translations` only adds missing keys. It is also why the footer
  copyright carries no year — a `new Date().getFullYear()` frozen into a
  catalogue goes on reading 2026 into 2027 with nobody having edited anything.

The cost no configuration removes: Docusaurus falls back to the source for an
**untranslated** string, never for a translated one whose source moved, so a
superseded French rule can be served. It is written in `website/README.md`
because it decides a rhythm — translate after the English text settles, never
during.

```bash
cd website
pnpm install
pnpm start    # Development server (no /docs redirect — see above)
pnpm build    # Production build, every locale (fails on broken links)
pnpm build --locale fr   # French alone — still builds with no translation file
pnpm write-translations --override  # Refresh the English sources Crowdin uploads

# The Crowdin config is at the repository root and covers both halves:
cd .. && CROWDIN_PROJECT_ID=0 CROWDIN_PERSONAL_TOKEN=config-lint-only \
  npx @crowdin/cli@4.15.0 config lint
```

### Docker Compose (in `docker-compose/` directory)

```bash
cd docker-compose
make init                         # .env from .env.example, data/ from data.example/
docker compose up -d              # Full stack: app + InfluxDB + Grafana
docker compose -f docker-compose.dev.yaml up -d  # Development mode (uses data.example/)

# A portfolio is a ledger: drop a .csv/.xlsx into the config dir's events/
# folder and it is loaded. There is no mode to choose (issue #711).
```

**The stack still starts InfluxDB and Grafana, and the app no longer speaks to
either** (issue #700). That is a deliberate seam, not an oversight: the price
path moved into the store here, while retiring the two containers is #679/#680's
packaging work. Until then a `docker compose up` runs two services that receive
nothing, and the boot names the three `INFLUXDB_*` variables it found and does
not read — which is what stops *"my token must be wrong"* being the conclusion.
Grafana's dashboards stop advancing at the upgrade instant for the same reason.

The stack owns exactly two user-writable things, both git-ignored: `.env` (every
setting, names identical to the app's own env vars) and the **config directory**
(`SB_CONFIG_DIR`, default `./data`) mounted as a single volume at
`/home/appuser/.config/SuiviBourse`. That mount is **writable**, for two
independent reasons since #696: the app no longer writes the *event files*
(#711 removed `config_writer.py`), but it does write **in** that directory —
`SB_STORE_DIR` defaults to it, and `suivi-bourse.duckdb` is created and written
there from the first boot on (#679 is what moves the store to a volume of its
own). The human who edits the event files by hand must own them all the same —
so the service runs
as `user: "${SB_UID:-1000}:${SB_GID:-1000}"` and `make init` records the
invoking `id -u`/`id -g` in `.env`. The image sets `ENV HOME=/home/appuser` for the same
reason: a uid absent from `/etc/passwd` (501 on macOS) gets `HOME=/` from
Docker, which would send `Path('~/.config/SuiviBourse').expanduser()` away from
the mount. `docker-compose.yaml` is never edited by
users: the image tag is `${SB_VERSION:-4}`, ports and container-name prefix are
variables, and the InfluxDB admin token has one source (`INFLUXDB_TOKEN` in
`.env`) that `influxdb3-init.sh` materialises into a token file and Grafana's
datasource reads via `$__env{}`.

**Port publishing is an overlay.** `docker-compose.yaml` declares no `ports:`
— the services reach each other over the compose network — and
`docker-compose.expose.yaml` holds the three blocks. `.env.example` chains them
with `COMPOSE_FILE=docker-compose.yaml:docker-compose.expose.yaml`, so local use
is unchanged; `GRAFANA_PORT`/`INFLUXDB_PORT`/`SB_WEB_PORT`/`SB_METRICS_PORT` are
read by the overlay. PaaS platforms that regenerate from `docker-compose.yaml` alone and
write their own env (Coolify, Dokploy) never load the overlay and get the
unpublished stack, which is what a reverse proxy in front of Grafana wants.
`docker-compose.dev.yaml` is standalone and keeps its own `ports:` (an explicit
`-f` overrides `COMPOSE_FILE`). Existing `.env` files predate the line — `make
init` warns when it is missing, since the stack would otherwise come up with
nothing published.

## Architecture

**Entry point**: `app/src/gunicorn.conf.py` (the container `ENTRYPOINT` is
`gunicorn --config gunicorn.conf.py 'web:create_app()'`).

**Process shape** (issue #651): the web API lives *inside* the scraper process —
one container, one process, one scheduler. gunicorn is not just a server here,
it is the boot sequence, split either side of its `fork()`:

- **master, under `preload_app`** — `main.build_runtime()`: **the store**
  (issue #696), then `ConfigurationManager`, the **first publication** of the
  config snapshot, and the `PrometheusExporter` registry. Pure work only: no
  thread, no socket, no fd survives a fork. Opening the store here is what keeps
  an unreadable one a single clean exit — same place #658 gave the Cerberus
  validation, different cause — and publishing the config here does the same for
  a broken ledger; the arbiter has not forked yet, so there is nothing to
  respawn, and the worker inherits the published snapshot through the fork, so
  `post_fork`'s `ingest()` is a cache hit that only arms the jobs.
- **`post_fork`** — `main.start_runtime()`: the **store connection**,
  `BackgroundScheduler` (not Blocking — the worker owns the foreground),
  `start_watcher()`, and the first `ingest()` that arms the per-symbol scrape
  jobs.
- **`worker_exit`** — `main.shutdown_runtime()`, the heir of the old `finally`,
  closing the store last.

**The store connection does not cross the fork.** The master opens the file,
applies the DDL, seeds it and **closes it again**; the worker opens its own.
Keeping the master's open would leave the file locked by the parent while the
child used buffers it no longer owns — and DuckDB refuses a second process
precisely because that is not survivable. What crosses the fork is
`Runtime.store_path`, never `Runtime.store`.

The two failure paths differ on purpose: the master calls `sys.exit(1)`, while
`post_fork` **re-raises**, because gunicorn reads an exception there as
`WORKER_BOOT_ERROR` and halts the arbiter, whereas an exit code would read as an
ordinary worker death and be respawned forever.

**`workers = 1` is a property of the design, not a tuning default**, and it is
guarded twice: `on_starting` refuses to boot with more (checked there, not in the
config body, because the command line is applied last), and the gunicorn control
socket is disabled so `gunicornc -c "worker add 2"` cannot raise it on a running
arbiter. N workers would be N schedulers: duplicate points on the same series
identity, N× yfinance pressure, and #617/#618/#628's in-memory state split N
ways — all of it silent. Concurrency comes from `threads` instead.

One gunicorn master binds **two sockets** (`bind` takes a list): `SB_WEB_PORT`
serves the app, `SB_METRICS_PORT` keeps `/metrics` exactly where scrapers expect
it. `PrometheusExporter` no longer runs an HTTP server of its own; the endpoint
is a `DispatcherMiddleware` mount on the Flask app, fed the exporter's dedicated
registry.

**One embedded store, and the app does not boot without it** (issue #696, spec
#695, ADR-0001). `store.py` owns the file: the connection, the DDL of the
**twelve** tables, and the seed. It is the socle of v5, and every ticket that
follows branches off it: the configuration path fills `import_source`/`account`/
`symbol`/`event` (#697, #698) and the **replay fills `position`/`account_state`**
(#699, `positions.py`).

Five things about it are decisions rather than defaults:

- **One thread is inside the connection at a time, and a transaction is the
  unit** (issue #700). `Store` holds a reentrant lock: every statement takes it,
  and `Store.transaction()` — the only way to open one — holds it from `BEGIN`
  to `COMMIT`. Both halves earn it. A DuckDB connection carries **one** pending
  result, so two threads doing `execute`/`fetchall` can hand each other the
  wrong rows; and a transaction on one connection is **visible to every thread
  using it**, so a reader landing between a `DELETE` and its `INSERT` reads the
  hole — a chart losing a year while a backward chunk is rewritten, and the perf
  job computing `holdings_value` from a half-deleted series and *persisting* the
  wrong daily total. In v4 the readers were a second process against another
  database and the problem had no expression; it appears the moment one store
  holds both halves. `ConfigurationManager.writing()` is a **different** lock and
  survives: it groups gestures spanning several statements *without* a
  transaction, and it is always taken first, so the two cannot cycle.
- **The DDL is applied with `IF NOT EXISTS` and there is no migration
  machinery.** The rule that generates the schema is *declaration and derived
  state never share a row*, so every row has exactly one writer: the
  configuration path owns `import_source`/`account`/`symbol`/`event`/`setting`/
  `advisory`, the ingestion owns `position`/`account_state`, the scrape and
  backfill own `symbol_quote`/`price_point`, the perf job owns
  `account_metrics`/`portfolio_totals`.
- **`price_point` carries no primary key and no foreign key** while the other
  eleven keep theirs (ADR-0007). Not negligence, measurement: a DuckDB ART index
  is a second copy of the data whose buffers the buffer manager does not own, so
  a primary key here is **+563 MB of resident memory on a 319 MB base**, a
  foreign key +153 MB more, and the rebuild 15× slower. Uniqueness moves to the
  writers; the integrity an index would buy is bought for free on the event row,
  where a typo'd ticker actually enters. The reason is written next to the table
  in `store.py`, not only in the ADR. **`account.source_id` is the one other
  column with no key** (#698), for a reason that is not memory: DuckDB executes
  an `UPDATE` touching a foreign-key column as a delete plus an insert, and that
  delete trips the incoming `event.account` key — so a key here would freeze the
  ownership of exactly the accounts that are in use, making an accounts file
  impossible to correct and re-drop, impossible to grow, and the seeded `default`
  row it took over impossible to hand back. Integrity moves to the writer the
  same way: `accounts` is the table's only writer and retires every row of an
  import before `ledger.forget_import` deletes the source it points at.
- **A NaN is not a number** (`store.finite`), on both boundaries and for two
  different reasons: stored, it compares false against itself, so
  `IS NOT NULL` says it is there and every arithmetic it touches becomes NaN;
  served, **JSON has no NaN** — `jsonify` emits a bare token that Python's own
  parser accepts and a browser's `JSON.parse` refuses, so the page gets a `200`
  whose body it cannot read. `None` is the honest answer either way.
- **Two kinds of time, never mixed**: `TIMESTAMPTZ` in UTC for an observed
  instant, `DATE` for a calendar day. They meet at the API, where a window
  always arrives as an instant: a bound on a `DATE` column is **cast**, or
  DuckDB widens the column to midnight and the first day of every window is
  silently dropped.
- **The seed has two halves.** The `default` account row is written **at
  creation only**, and since #698 it is also never removed — a file may take it
  over, and forgetting that file hands the row back **whole**, `type` and `label`
  restored to what the seed wrote, rather than taking it away.
  There is always at least one account, which is what lets nothing branch on
  *"are accounts declared"* (ADR-0013). The `setting` defaults are inserted **at every start** with `ON
  CONFLICT DO NOTHING`, which is what makes adding a dial in a later version
  cost no migration: the missing key appears, an answered one is left alone. A
  key absent from the table reads as **the code's default**, from
  `settings_registry.py` — the table is the mirror, never the source (ADR-0014).
  `base_currency` has no default and is therefore never seeded: "not answered
  yet" and "answered" have to stay two states.

`schema.yaml`, Cerberus, `InvalidConfigFile`, `load_shares_schema`,
`SuiviBourseMetrics.validate()` and `_ABSENT_SCHEMA` are deleted with the same
ticket; what validates is `events/validator.py` and the DDL, and since #698 the
accounts are a table rather than a block to check.

**The web UI reads through its own module, with its own error contract** (issue
#659, moved onto the store by #700). The layer between the UI and the store is
the *for-keeps* half of the prototype; the React on top of it is admitted
throwaway. Two modules, and the split is by **error contract**, not by subject
matter:

- **`store_reads.py`** — `PortfolioReader`, taking the open store. Its workhorse
  is **P1, and since #700 it is a join rather than a window**:
  `position ⋈ symbol_quote`, one row per `(account, symbol)` beside the newest
  observation of that symbol — 0,43 ms measured against 25,4 ms for the
  `ROW_NUMBER()` scan of the price series it replaces. A **LEFT** join, which is
  the interesting half: a position whose symbol has never been fetched is a row
  with every market column `NULL`, and an inner join would answer *"you own
  nothing"* to someone who has just declared everything they own. Deliberately
  **no time window**: "current" is absolute (#652 déc. 1), so a long market
  closure no longer blanks the page. Also `raw_series` and `bucketed_series` —
  the second survives for one new reason, the browser: five years of a symbol is
  tens of thousands of points after #705's ladder, fifty times what a chart
  carries. The perf series get `latest_totals` / `totals_series`,
  `latest_account_metrics` (one query for the whole comparison table) and
  `account_series`. All of them **name their fields**, which is what ADR-0001
  buys: a declared column that was never written reads as `NULL` rather than not
  existing, so naming `xirr` no longer turns "this account has no deposits" into
  a query error. And every **wide** read crosses **Arrow** (`Store.arrow`):
  materialising a `TIMESTAMPTZ` column costs 8× in rows and nothing in Arrow.
- **`portfolio_view.py`** — pure, in the taste of `scheduling.py` /
  `performance.py`. Rows in, page objects out: the derived unit cost
  `Σ cost_basis / Σ quantity` — which *is* the weighted mean, and falls out of one
  division because the basis is stored as an amount (a plain sum *and* a plain
  mean both produce plausible-looking wrong prices) — the per-account rollup
  Grafana sums away in SQL, and **plus-value latente**, which since #700 is
  `market_value − cost_basis` and carries **neither dividends nor fees**: they
  are the other two named figures, and adding either here counts it twice. The
  holdings term is required and the basis defaults to zero, because composing it
  out of null-tolerant helpers made a share whose price was never observed report
  a total loss. `build_accounts`
  (#661) joins the **declaration** to the newest metrics row and lets the
  declaration drive: an account with no series yet is a row of em dashes, a
  series with no declaration is not a row, and nothing is summed across accounts
  — the consolidated figures have one source, `portfolio_totals`.

`influx_sql.py` — the `COALESCE(account,'default')` shim, the quote escaping,
the NaN guard and the bare-UTC-Z literal — is **gone** with #700. Every one of
its four rules lost its subject at once: a price has no account, DuckDB binds
parameters instead of taking a formatted string, and a NaN never reaches the
store because the fetch drops it.

The reason this is a **separate module** from the scheduler's own reads: those
end with `except Exception: … return None`, which is right for a job surviving a
flaky query and wrong for a UI, where it makes "the database is unreadable" and
"you own nothing yet" the same screen. Here query errors **propagate** and
`web/problem.py` turns them into `503` + `application/problem+json`; absence
stays three distinct states (`200`+`null` / `200`+`[]` / `503`), and they are
**structural** rather than rescued from an exception. `_ABSENT_SCHEMA` — the
regex that read "this measurement was never written to" out of an error message
and answered `[]` — went with #696, and the window it left open closed with
#700: an install whose measurement did not exist yet answered `503` where it owed
`200` + `[]`.

**The app's own runtime state is a fourth pair, and it reads no store at all**
(issue #668, design #656). `GET /api/runtime` answers from process memory, the
config snapshot and the APScheduler jobstore — nothing else. That is a decision,
not an optimisation: `/api/shares` is a query and the blueprint answers `503`
when one fails, so a status pill riding on that payload would **vanish exactly
when it is the only thing able to explain the empty table**. #659's reserved
`status` slot is therefore *retired*, not filled.

- **`runtime_state.py`** — the one writer, of one shape. Each job ends its pass
  by publishing an immutable **last-pass record**, keyed by the *job's* identity
  (per symbol for scrape, per `(symbol, account, direction)` for backfill, global
  for ingest and perf), plus a **consecutive-failure counter on the backfill**
  that has no equivalent anywhere else — `_backfill_backward` logs a warning and
  returns `0`, the same value a healthy weekend returns, so nothing distinguished
  "pacing" from "wedged on yfinance". Only what has no home is published: no copy
  of `_failure_counts`, `_backfill_complete` or `_share_info_cache` lives here.
  The rule that keeps it safe is that **the lock never covers a fetch** and
  *readers never iterate* — the row set comes from the configuration snapshot,
  one `get` per key, because copying a dict the scrape threads are writing raises
  `RuntimeError: dictionary changed size during iteration`.
- **`runtime_view.py`** — pure, in the taste of `scheduling.py`. The contract it
  honours is that **the API reports observations and never derives a verdict
  across two items**: a reader taking `_failure_counts` at *t* and
  `next_run_time` at *t+ε* is wrong twice over, while `scheduling.decide` handed
  the job its verdict, delay and counter in **one call**. Three cases it exists
  to get right: an **absent `next_run_time` is ambiguous** (a `date` job leaves
  the jobstore *while it runs*, so absence is "being scraped now" *or*
  "departed"); the cached `marketState` is **never** the pill (`decide`
  fail-opens it, and the cache is written only on a successful fetch, so a
  failing symbol reports the state from before its failure); and the backfill's
  terminal state is never collapsed with a stall — `complete` is a conclusion,
  not an attempt. It is the last of three: `manual_mode` left with the mode it
  named (#711) and `no_buy` with #703, where the target became the first
  **acquisition** and a position carrying neither a `BUY` nor a `GRANT` stopped
  being reachable at all. Its row set is **every symbol the ledger names**, not
  the held ones, because the backfill's set is no longer the scrape's: a sold
  line is reconstructed and not polled, so the row carries `held: false`, the
  pill `not_held` and `next_run_state: not_held` instead of reading as a
  scheduler that is stuck — all three, because `unknown` is a statement about
  *this process* and a closed position would wear it for ever, no future event
  being able to clear it. Its `accounts` list stays **who holds it** and is
  empty when nobody does: a field already published must not change meaning
  because the row set widened.
  Its **progress bar divides by the holding window**, `[target, ceiling]`, and
  counts from the **anchor** rather than from the oldest stored point — #703
  parted the two, and only the anchor moves on a symbol Yahoo answers nothing
  about, where a bar drawn from the series freezes and then jumps to 1,0. The
  ceiling is a field of the record rather than a reader's assumption: with
  *now* as the denominator a line bought 2020-03-02 and sold 2022-05-04 reads
  0,82 one chunk in where it has covered 0,46 — inflated for exactly the rows
  #703 adds to the payload, at exactly the moment the bar has a use, and with
  nothing published a consumer could correct it from.

`/api/config` carries #654's read-only **effective configuration** — there
rather than on `/api/runtime`, one noun two consumers — listing the variables
*the app reads* (not the ones compose sends) — a secret would be redacted **by
name**, and since #700 the list holds none — plus the published snapshot's
declared `shares`.

**The config directory has no write path** (issue #711). `config_writer.py` and
`events/editor.py` are deleted, together with the routes they served: the row
edit, the opaque token over `(file, sheet, row)`, the `ETag`, the `409`, the
file import and conversion, and `PUT /api/accounts`. The whole apparatus existed
because **the file was the address**; in the store a row will have a primary
key, which does not go stale, so nothing it did has a row-by-row successor. The
front therefore has **no data-editing gestures** until block 2 rewrites it
around the import as the unit. `GET /api/events` survives as a read of the
published snapshot — the rows the aggregator ran on, with no id and no etag.

Its consequence for the config directory: no filename has a special meaning any
more (`ui.csv` was the last one). The one write path that came back is the
account (issue #698) — `POST`/`PATCH`/`DELETE /api/accounts` — and it writes a
**row**, never a file: a declaration made in the app carries `source_id NULL`,
which is both "created in the UI" and "editable".

Flask serves the built SPA with a catch-all that must **not** swallow `/api` or
`/metrics`: without those guards a typo'd endpoint returns the HTML shell with a
`200`, and a Prometheus scraper reads `200` as a healthy target.

**A portfolio is a dated event ledger, and only that** (issue #711). There is
one loading path: `SB_CONFIG_MODE`, the `mode:` key and the auto-detection that
arbitrated between them are gone, and so is `config.yaml` — an aggregated
position carries no dates, so it can carry neither a realised gain nor a
historical weighted average cost, and the product's headline figure is built out
of both. A `config.yaml` found in the config directory is **named at startup and
never read** (`ConfigurationManager.report_unread_files`, ADR-0008): four empty
pages otherwise read as *"the update erased my portfolio"*. An events source
that does not exist yet is a fresh install — a warning and an empty portfolio,
never a boot failure. `SB_SCRAPING_INTERVAL`, the deprecated fallback for the poll cadence, is
removed too (v5 is breaking) — and since #701 the cadence itself is a dial in
the store rather than a variable.

**Configuration is one immutable snapshot** (issue #658, design #653).
`ConfigurationManager` holds a single `ConfigSnapshot` — `shares`, `events`,
`accounts`, `cache_key` — built off-line and **published by one attribute
rebind**, so the read path (`current()`) takes no lock and a reader holds a
coherent generation for as long as it needs it; one mutex serialises the writers
(the ingestion job, the watchdog callback, and later a web handler reloading
after a file edit). Two rules follow:

- **Never mutate published state.** `invalidate_cache()` is gone; forcing is an
  argument (`reload(force=True)`). The old pair nulled all three cache fields
  *before* `ingest()` refilled them, and a backfill landing in that window read
  `events = None` → no first-BUY date → its backward pass silently neutralised.
- **Never publish what is not validated.** Loading, validating and aggregating
  all run *inside* snapshot construction, closing a split-brain that predated
  the UI: the cache was written by the loader and validated afterwards by
  `ingest()`, so a rejected file still fed **backfill and the perf recompute**
  while scraping ran on the previous one. `SuiviBourseMetrics.shares` is now a
  *read* of the snapshot, not a second copy, and `backfill()` /
  `recompute_perf()` take one snapshot per cycle. What validates is
  `events/validator.py` and, since #696, the store's DDL — `schema.yaml`,
  Cerberus, `InvalidConfigFile` and `load_shares_schema` are gone with the
  hand-written share list they were written for. An **empty portfolio** is a
  legitimate state, not a rejection: an install legitimately starts with an
  empty `events/` directory.

The declaration is read **from the store, after the import** (issue #698): an
accounts source in the drop folder is imported first, so the accounts a build
publishes are the ones its events were just validated against. `settings.yaml`
is not read at all any more, so nothing about the configuration is boot-only.

**And the replay writes** (issue #699). `ConfigurationManager._load_from_store`
replays the ledger once and hands the result to `positions.write_state`, which
lays down `position` and `account_state` in **one transaction** — the two tables
the ingestion owns, and it is their only writer (a test asserts that on the
source: `tests/test_positions.py`). Three properties come from *where* the call
sits rather than from the function: it is **after the validation**, so a ledger
that does not replay writes nothing and the previous rows stand; it runs on the
same timeline the snapshot is built from, so the store and what the app
publishes cannot be two generations of the ledger; and it is a **replacement**,
so an import forgotten takes its positions with it instead of leaving a table
that goes on describing a portfolio nobody declares. A whole-table rewrite is
affordable here for a reason of *rhythm*, not size: a replay happens on the
boot, on a file landing, and on a write — never every 120 s, which is the
measurement ADR-0011's `UPSERT` argument rests on.

The application runs independent scheduled jobs on a single APScheduler:
- **Scraping**: one **self-rescheduling job per held symbol**, market-aware
  (issue #616). *Held* is a filter on `quantity` since #699, which is what
  finally makes `_held_symbols()`'s docstring true: a position sold four years
  ago used to go on being polled at Yahoo for the life of the process. Its
  departure also `.remove()`s its quote gauges (see Prometheus below), and a
  buy-back revives it through `_reconcile_jobs`' ordinary revive path with
  nothing to remember. The **write loop is per holding**, not per symbol: a
  share still held in one account keeps its job while the account that sold out
  stops being written, or that account collects a point of zeros every cycle and
  the shares page grows a phantom row. Each job fetches its symbol from Yahoo Finance, writes a point
  per account holding it, then re-arms on its own cadence: `REGULAR` markets
  re-poll every `regular_interval` (a store dial, default 120s); closed markets sleep to
  the next open (capped 24h). A **dead-ticker guard** (issue #617) backs a
  symbol off when non-closed cycles keep producing no writable price: the first
  3 failures still re-arm at `base_interval`, then the delay grows
  `base_interval × 2^(n−3)` capped at 24h, resetting to 0 on the first
  successful write. Closed cycles never count as failures. A **price-freshness
  liveness sonde** (issue #628) rides the `REGULAR` write path: before each write
  it reads the newest stored price for the (symbol, account) and advances the
  pure `scheduling.price_freshness_step` against per-series memory
  (`_sonde_state`). When the stored value stays frozen across *consecutive*
  `REGULAR` cycles for at least `staleness_horizon` (a store dial, default 900s) while the
  live quote moves, it emits a WARNING and raises the `sb_price_staleness` gauge.
  Staleness is measured over consecutive polling, **not** the stored point's
  wall-clock age — the writer advancing the value each cycle re-baselines, and a
  polling gap wider than the horizon (overnight/weekend close) re-baselines too,
  so the first tick after a close never fires a false positive (#628 acceptance).
  Purely diagnostic — it never changes cadence, write gating, or the #617 backoff;
  it catches a writer that fetches fine but persists *stale* values, which the
  forward gap-fill (#627) can't see. There is no global
  scrape job. **Anti-herd (issue #619):** every arming offsets its `run_date` by
  a fresh `uniform(0, 30s)` jitter (the heir of the removed inter-share
  `time.sleep(1)`; a `date` trigger can't carry APScheduler's own `jitter`), so a
  same-exchange cohort sharing one next-open spreads over `[open, open+30s]` and
  the `REGULAR`-poll lockstep is re-randomized each cycle. Jobs carry
  `misfire_grace_time=None` (run however late — a skipped run would permanently
  kill a self-rescheduling job; the on-wake `marketState` re-read self-corrects)
  and `max_instances=1`. The APScheduler **executor pool** is sized at boot,
  **always automatically** since #701: the pure
  `scheduling.compute_pool_size(shares, exchange_of)` =
  `min(RESERVED + ceil(largest_cohort × 5 / 30), 50)` with `RESERVED` 3 — one
  figure since #711, there being one job set. `exchange_of` is captured by a
  pre-scheduler fetch (`capture_exchange_of`), which is therefore no longer
  optional. The fixed dial and its opt-in flag were **deleted rather than moved
  into the store**: a `ThreadPoolExecutor` does not shrink hot, so they were the
  one couple that would still have required recreating the container — and a
  fixed pool is a silent trap besides (a cohort of 30 symbols on a pool of 10
  serialises its own scrapes with nothing anywhere to say so).
- **Ingestion**: **not a job** (issue #697). It polled the drop folder every
  300s because the files were the truth; the store is the truth now, so the
  ledger only changes when a write changes it. Ingestion still happens — armed
  by the boot and by the always-on drop-folder watcher — and each run
  reconciles the per-symbol scrape jobs against the new symbol set (add /
  remove / revive). A write through the API (forgetting an import) replays with
  `import_files=False`: the ledger has just been changed by hand, and
  re-scanning the folder would import the revoked file straight back.
- **Backfill**: **bidirectional** (issue #626), every 60s, both passes run per
  symbol each cycle and are independent — and since #703 the job is **driven by
  the replay, not by current holdings** (ADR-0009). The symbol set is the union
  over the *whole* timeline and each symbol carries its own window,
  `[first acquisition, last exit or today]` — `ConfigSnapshot.backfill_windows()`.
  This is where the backfill and the scrape stop having the same symbols, and it
  is not a refinement: iterating current positions left a share bought in 2020
  and sold in 2022 with **no reconstructed price at all**, so the account's
  `xirr` and `twr_index` were wrong *permanently*. v4 hid it because the live
  series accumulated while the share was held.
  **Backward**: anchor → first acquisition, one `backfill_chunk_days` chunk per
  cycle, stopping once the `_backfill_complete` watermark is set. The anchor is
  the **oldest window tried**, `min(ceiling, oldest stored point,
  symbol_quote.oldest_window_tried)` — the last of the three being spec #695
  § 4's one named exception to *watermarks stay derived*, since the argument for
  deriving ("it recomputes itself from the rows") fails exactly where a delisted
  symbol stands. With the oldest *stored* point as the anchor, a mute symbol
  refetched the same window every 60 s **for ever**, in silence: the stop
  condition never moved and an empty return is classified as a gap rather than a
  failure (#606), so no counter rose either. It is persisted only when the fetch
  **completed** — a failure has attempted nothing the app may skip. The target
  is the first **acquisition**, `BUY` *and* `GRANT`, and the `no_buy` terminal is
  deleted rather than renamed: a position with neither cannot carry a positive
  quantity, so it has no holding window and never enters the set.
  **Forward gap-fill**
  (issue #627): recovers a trading session missed while the app was down
  (stop/crash/host asleep) by fetching `[newest → now]` — anchor =
  `quotes.newest_ts` (newest point with `price_native IS NOT NULL`), window
  sized by the pure
  `scheduling.forward_backfill_window(newest, now, chunk_days)`. Returns `None`
  (no fetch) when the series is empty (backward owns seeding) or the anchor is
  `< 1 day` old — that guard is what makes the forward pass a **no-op during
  live trading** (`newest ≈ now`), so the `REGULAR` writer stays the sole writer
  of the present with no duplicate at the seam. Gap classification is delegated
  to yfinance: a weekend/holiday window comes back empty and stays a gap (#606),
  a missed open session comes back with rows. `_backfill_complete` gates **only**
  the backward pass. Recovered points join the same series as live ones, so perf
  `holdings_value` picks them up — and the forward pass fills the gap of a
  position sold then bought back for free, its anchor being months old the day
  the line comes back; it only ever needed the symbol to be in the backfill's
  set, which the replay now supplies.
  **The two passes part company on a sold position** (issue #699, #672 D5): the
  backward one keeps running (the chart wants the history of a line the user
  held, and the watermark bounds it, so it finishes and stops), the forward one
  stops at the same predicate as the scrape. It exists to catch a live writer
  up, and that writer has just been removed — and its own `< 1 day` no-op guard
  is precisely what that writer was keeping true, so left running it would
  refetch `[newest → now]` from Yahoo **every day, forever**, for every symbol
  the owner has ever sold out of.
  **The rhythm does not change and there is no accelerated mode**: `backfill_delay`
  is a courtesy to Yahoo at the exact moment the app emits more requests than at
  any other time of its life, and a code path that runs once per installation is
  a code path nobody ever tests. ~25 minutes for 30 symbols over 5 years.
- **Performance**: Rebuilds the `account_metrics` / `portfolio_totals` series
  (opt-in accounts only until #708) as its **own interval job** on
  `scheduling.PERF_TICK` — 120s, a constant and not a dial (#701, #707) —
  decoupled from the per-symbol scrape jobs (issue #618), and firing at the boot
  rather than one tick later (`next_run_time = now`). The recompute is
  **integral and unconditional** (ADR-0011): the two tables are a *cache*, a
  pure function of the ledger, the price points and the declared accounts, and a
  full pass costs 0,4 % of the tick at five years. `scheduling.perf_should_run`
  is deleted **without a replacement**, and so are the four things that fed it —
  `_perf_lock`, `_perf_dirty_from`, `_perf_dirty_live`, `_perf_last_events` —
  plus `_mark_perf_dirty` / `_consume_perf_dirty_from`, the raise on the
  `REGULAR` write path, `decide`'s fourth return value, and the `PERF_SKIPPED`
  verdict. That was **the last coupling between the backfill and the perf**.
  Three other shapes were refused and each for its own reason: an end-of-backfill
  step is right only while the reconstruction runs and false the moment it
  finishes; an event bus rebuilds the coupling one indirection away; a step of
  the scrape fires N recomputes per market-open wave. The **only inputs are the
  store and the clock** — the job replays its own `Timeline`, because `position`
  and `account_state` are *current* states while performance needs the state of
  every day. The write is a **block `UPSERT` plus a bounded prune** of what falls
  outside the spans just written (never a replacement, never row by row), which
  is what keeps the file from drifting: a `DELETE`+`INSERT` reaches 44,8 MB for
  a 1,6 MB table over a thousand cycles, the upsert plateaus at 1,1. The series
  is **dense over calendar days**, weekends and holidays included, prices carried
  forward — "no point on a non-trading day" is a property of *observed* prices,
  and TWR chains over consecutive days. Deleting the rows is a complete rebuild:
  the next cycle rewrites them, which is why the administration page has no
  rebuild gesture to design. The cost accepted: the two tables stop being a trace
  of what the app believed at an instant — if a figure shown yesterday changed
  today, the backfill advanced, and nothing remembers.

**The price and the position stopped sharing a row** (issue #700). `quotes.py`
is the market's own writer — `symbol_quote` and `price_point`, and nothing else
writes them — and three things about it are decisions:

- **The series has no account dimension.** A market price belongs to no account,
  so a query joining prices *per account* was a bug; the code already said so
  without being listened to (`get_price_series` and `raw_series` queried by
  symbol alone while the writer wrote one point per holding). The
  `COALESCE(account, 'default')` shim dies with the column it rescued, and the
  row count falls by **25 %** before any retention decision. The scrape therefore
  writes **once per symbol**, and so does the backfill — where the old shape
  would have fetched the same window from Yahoo once per account.
- **Close only: no OHLC, no volume.** `price_open`/`high`/`low` were not dead
  columns, they were columns that **lied**: the live writer set all three to the
  close on every point it wrote.
- **One maintenance rule, written once, covering three cases**: *any writer
  inserting a `price_point` whose `ts >= last_price_ts` updates the `last_*`
  columns in the same transaction*. The invariant is "the most recent point,
  whatever its completeness" — the other spelling reintroduces the per-field
  last-non-null pass the store exists to avoid. `symbol_quote` carries the
  `last_*` columns rather than a second `latest` table because it is already one
  row per symbol, written by the same module, refreshed at the same instant.

The **name of a share is not there**: it lives on `position`, written by the
replay, because it comes from the owner's file and not from Yahoo — so renaming
a share can no longer cut its history in two.

The live writer **appends** and never rewrites its own timestamp; the range
writer **deletes its own span then inserts**, which is where `price_point`'s
uniqueness lives now that the table carries no key (ADR-0007). The span is the
**batch's**, not the window that was asked for: a `DELETE` bounded by the request
can erase a point the fetch did not bring back, so a chunk that comes back short
after a Yahoo hiccup would silently lose the history it failed to re-supply.
Timestamps stay truncated to the second, which is what makes re-running one
cycle idempotent.

**There is one reporting currency, and two levels of currency and not three**
(issue #702, ADR-0002 amended by ADR-0021). `base_currency` is the one dial with
no default and the one question the app asks; `Account.currency` is **deleted**,
not converted, and with it `MODE_MULTI_CURRENCY`, `build_multi_currency_head`,
the `account_currency` tag and the single-currency condition that gated
`portfolio_totals` — in a three-level model *"a EUR account holding a USD
security"* is a sentence with a meaning, therefore a bug needing a guard, a test
and a degraded screen; here it has no referent. Five things about it are
decisions:

- **`fx.py` is a pure module with a TTL cache**, in the taste of `scheduling.py`
  / `performance.py`: the fetch is injected, so the whole of it tests against a
  fake with no network. The TTL is what makes a market-open wave share **one**
  rate per pair — converted at N slightly different rates, the positions of one
  wave do not add up to their own total. No pseudo-symbol `EURUSD=X` in the
  scheduler (a pair has no `marketState` that projects onto the equity cadence
  model), no `fx_rates` table, no extra job. A failed fetch is cached for the
  same span: forty symbols in an unresolvable currency would otherwise ask Yahoo
  forty times a cycle, forever, for a ticker that does not exist.
- **`GBp` is normalised to `GBP ÷ 100` before any pair is named**, matched
  **case-sensitively** — `GBp` and `GBP` differ by one letter's case and by a
  factor of a hundred, so an `upper()` anywhere on that path turns pence into
  pounds in silence. The hundredth is folded into the **rate**, not applied to
  the price, so `price_converted == price_native × fx_rate` holds on the stored
  row: the row is a journal one can read back (*"2 345 € — 10 × 234,50 $ at
  1,0844 on 5 August"*), not three numbers that do not reconcile.
- **The conversion happens on the write path and is passed *in* to the writers.**
  `_scrape_symbol` converts once per pass and hands the pair to `/metrics` and to
  `quotes.record_quote` alike, so the rate stored beside a price is provably the
  one that price was multiplied by. The rebuild prefetches the pair's daily
  history beside the price history — one request per chunk — and converts each
  point at the rate of **its own day**: at today's rate a five-year-old close
  would put a currency move into a chart of a share price.
- **A missing rate writes the point with `price_converted = NULL`**, never *no
  point*. The quote is what cannot be re-fetched (Yahoo gives nothing under the
  hour past 60 days); the conversion is repaired by #704's lateral pass, which is
  the only reason a `NULL` here is viable at all.
- **Event amounts are never converted.** `unit_price` / `fee` / `amount` are the
  **debit, in the reporting currency**, which is what makes the cost basis exact
  instead of re-estimated from a historical rate and removes historical FX from
  the past entirely. Only prices are converted.

While the currency is unanswered, **nothing refuses**: the scrape runs and stores
`price_native`, the converted columns stay `NULL`, the perf job writes nothing at
all (not zeros, not `NULL`s — every figure it computes is money and an amount
with no settled unit is not a figure), the account gauges are therefore absent,
and the API states the condition through the head's `currency` being `null` and
the dial's `stored: false` on `/api/config`. No route and no field is added for
it (ADR-0021): a fourth kind of absence would make every page depend on one
preamble. The reads that draw money — P1's `price`, `raw_series`,
`bucketed_series`, `prices_at`, `daily_closes`, `quotes.price_series` — all read
the **converted** column for the same reason; the native price and the rate ride
beside P1's row so a reader can recognise the quote their broker shows them. The
freshness sonde (#628) is the one read pointed at `price_native`, because a
currency tick would otherwise pass for a price that is still being refreshed.

### Scheduled Jobs
```text
┌──────────────────────────┐  ┌───────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│  SCRAPE  (per symbol,    │  │  INGESTION        │  │    BACKFILL      │  │   PERFORMANCE      │
│  self-rescheduling)      │  │  (NOT a job)      │  │  (backfill_      │  │  (PERF_TICK,       │
│                          │  │                   │  │   interval dial) │  │   ungated)         │
│ • yfinance.Ticker()      │  │ • boot, or the    │  │ • Backward pass  │  │ • Replay the       │
│ • marketState → cadence  │  │   watcher, or a   │  │ • Forward pass   │  │   Timeline         │
│ • REGULAR: poll & write  │  │   write — never   │  │ • Chunk 1 yr/req │  │ • Full recompute   │
│ • Closed: sleep to open  │  │   a timer (#697)  │  │ • Rate limit 10s │  │ • Upsert + prune   │
└──────────────────────────┘  └───────────────────┘  └──────────────────┘  └────────────────────┘
         │                            │                       │                       │
         └────────────────────────────┴───────────┬───────────┴───────────────────────┘
                                                   ▼
                                            ┌─────────────┐
                                            │  the store  │
                                            │  (DuckDB)   │
                                            └─────────────┘
```

The two pure modules `scheduling.py` (cadence/market-context decisions) and
`performance.py` (money-weighted returns) hold the testable logic — no store or
yfinance, `now` injected.

## Configuration

### One loading path (issue #711)

A portfolio is described by `events/*.csv` and `events/*.xlsx`, and by nothing
else. There is no mode: `SB_CONFIG_MODE`, the `mode:` key and the auto-detection
between them are gone, and `config.yaml` is **named at startup, never read**.

**`settings.yaml` is named and never read either** (issue #698). It was the last
file the app parsed, and it mixed a deployment setting (`events.source`,
`events.watch`) with user data (the `accounts:` block) in one document — the
seam ADR-0006 exists to separate. Its two halves leave in different directions:
the accounts become a file in the events' own format (below), and the drop
folder is `<config dir>/events` here and a mount in the container (ADR-0015,
`SB_IMPORT_DIR` in #740). Nothing is migrated and nothing is deleted: the file
stays where its owner put it, and startup names it once.

Every `SB_*` variable treats a blank value as unset
(`env_str`/`env_int`/`env_flag`), because compose renders an undefined
substitution as an empty string.

> **Coming from a manual v4**: nothing is migrated. Typing a position means
> creating dated events — an aggregated position carries no dates, so it can
> carry neither a realised gain nor a historical weighted average cost.

---

### Events (CSV/XLSX)

Import portfolio events from files and automatically compute aggregated positions.

#### File Structure

```
~/.config/SuiviBourse/
└── events/               # The drop folder — every .csv/.xlsx in it is imported
    ├── accounts.csv      # An accounts source: id, type, label (issue #698)
    ├── 2023.csv
    ├── 2024.csv
    └── broker-export.xlsx
```

A file is an **accounts source** or an **event source** according to its
**header**, never its name: `id` + `type` and no `event_type` makes it a
declaration. `settings.yaml` sitting in the same directory is simply not one of
these.

#### CSV Format

```csv
date,event_type,symbol,name,quantity,unit_price,fee,amount,notes
2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase
2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,8.50,Q1 2024
2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Stock split bonus
2024-09-15,SELL,AAPL,Apple Inc,3,180.00,2.00,,Partial sale
```

#### Columns

| Column | Required | Description |
|--------|----------|-------------|
| `date` | Yes | ISO format (YYYY-MM-DD) |
| `event_type` | Yes | `BUY`, `SELL`, `GRANT`, `DIVIDEND` |
| `account` | See below | The id of a declared account |
| `symbol` | Yes | Yahoo Finance ticker (e.g., `AAPL`, `MSFT`) |
| `name` | Yes | Display name for the share |
| `quantity` | For BUY/SELL/GRANT | Number of shares |
| `unit_price` | For BUY/SELL; **optional on GRANT** | Price per share. On a GRANT it says *valued award* (it feeds the contribution and the cost basis together); leaving it empty says *dilution* (#699) |
| `fee` | Optional | Transaction fee. On a BUY it is absorbed into the cost basis; on a SELL it reduces the proceeds and lands in the realized gain |
| `amount` | For DIVIDEND | Dividend amount received |
| `notes` | Optional | Free text comment |

#### Declaring accounts (issue #698, ADR-0013)

An account is **user data with provenance, not a setting**, so it is declared
the way an event is: by a file in the same format, with columns `id`, `type`,
`label` (`label` falls back to the id), or from the app. The file is what
multi-account needs in the UI *and* headless: an install with no interface has
nothing to click, and reserving the declaration to the UI would forbid
multi-account to every headless install — and with it any broker export that
names accounts.

The rules, each of them keeping a mistake a refusal:

- **All account sources are imported before all event sources**, never
  alphabetically — `event.account` references `account(id)`, and a folder whose
  meaning depended on how many times it was scanned would be the bug.
- **An event file naming an undeclared account is not imported at all**, and
  the message names the account to declare.
- **A blank `account` column means `default` until something is declared, and
  is an error afterwards.** That is v4's rule *minus its opt-in*, and it is what
  makes a single-account v4's event files import without a single edit — cash
  events included, where v4 demanded an account it would now refuse.
- **A declaration that moves re-imports the event files**, fingerprint or not:
  rows written under `default` before their accounts existed would otherwise
  stay there while the page showed the accounts.
- **There is always at least one account.** The seeded `default` row is never
  removed — a file may take it over, and forgetting that file hands it back
  rather than taking it away. Nothing in the app branches on *"are accounts
  declared"*: `EventAggregator` keys by `(account, symbol)` unconditionally.
- **An account is undeletable while an event names it**, and so is the import
  that declared it — the cascade is *refused*, never performed (`409` on the
  API). Forget the event imports first. Its **cached** figures are not in that
  rule and go with it (`perf_series.forget_account`): `account_metrics`
  references the account row, so without the drop the perf job's first cycle
  would make every declared account undeletable — and a refusal on a figure the
  next cycle rebuilds would put a cache on the same footing as a fact the owner
  recorded.
- What came from a file is **read-only** (`source_id` set); what was created in
  the app is editable (`source_id NULL`). `POST`/`PATCH`/`DELETE /api/accounts`
  serve the second and refuse the first.

#### Event Types

| Type | Effect on Portfolio |
|------|---------------------|
| `BUY` | +quantity, +cost_basis (`qty×price + fee` — the acquisition fee is absorbed), −cash |
| `SELL` | −quantity, −cost_basis (`qty × PMP`), +realized_gain (`qty×price − fee − qty×PMP`), +cash |
| `GRANT` | +quantity; +cost_basis `qty×unit_price` **if the row declares one**; cash-neutral |
| `DIVIDEND` | +received_dividend, +cash (`amount − fee`) |
| `DEPOSIT` | +cash (`amount − fee`), +net_contributed (cash event: `amount` required, no share) |
| `WITHDRAWAL` | −cash (`amount + fee`), −net_contributed (cash event) |

Cash is a per-account ledger (starts at `0.00`). Negative balances are allowed
(non-blocking warning); overselling stays blocking.

#### Aggregation Logic — a position is one stock (issue #699, ADR-0003)

A position is **a `quantity` and a `cost_basis` stored as an amount**; the unit
price (the *PMP*) is derived by `events.schemas.unit_cost`, the one place in the
product that divides. `purchase.quantity` and `purchase.fee` are gone as state
*and* as names: *"how much did I ever buy"* is `SUM(quantity) WHERE event_type =
'BUY'` and *"how much did I pay in fees"* is `SUM(fee)`, both queries over the
events. Three things fall out at once:

- **a sale is a subtraction** — no average is rebuilt, so ten years of partial
  sales accumulate no rounding drift;
- **a fully sold position reports zero invested by construction** (quantity 0 →
  basis 0), which is where the phantom **−932 €** on a sold line disappears;
- **the unit price of a sold position is undefined**, which is the truth: it has
  a realized gain instead.

**The matching convention is the weighted average (PMP), with no dial** — it is
the French tax rule (CGI art. 150-0 D), and offering FIFO alongside would make
the app carry two conventions at once.

**There is no `closed` flag**: the predicate is `quantity == 0`. *Closed* and
*temporarily flat* differ only by a **future** event, so nothing computable
today separates them — and the guess is free, because `_reconcile_jobs` re-arms
any held symbol without a live job. The filtering line is `_held_symbols()`,
never `Timeline.current()`: a sold position must stay in the snapshot so the
replay writes its realized gain and the page shows it.

Three named figures replace one composite, each with its own domain:

| Figure | Formula | Defined when |
|---|---|---|
| Latent gain | `holdings_value − cost_basis` | position open (`None` with no observed quote) |
| Realized gain | Σ sales `(net proceeds − basis removed)` | from the first sale, **permanently** |
| Dividends received | `position.received_dividend` | always |

> **The rule a contributor will break:** the realized gain is a **decomposition**
> of the absolute gain, never a term added to it. The sale's proceeds are already
> in the cash balance, so `gain_absolu + realized` shows a winning account losing,
> perfectly plausibly. `tests/test_performance.py` pins #672's worked example to
> the cent — `latent +497,00 · realized −335,89 · dividends +20,00 = +181,11 €` —
> **and** pins the forbidden operation's `−154,78 €`.

**A `GRANT` carries an optional `unit_price`** feeding the external contribution
*and* the cost basis **together** — one function, `events.schemas.declared_value`,
read by the aggregator and by `performance` alike, because two spellings of
*"was a price declared?"* would eventually disagree by a few euros and the
symptom is an identity that quietly stops holding. Present is a valued award
(latent gain nil on the day), absent is dilution (both zero). It also takes
`price_at` out of the contribution path, which is what stops `gain_absolu`
drifting as the backfill advances with no event having moved.

No format change, and **no new validation** — a value that cannot be a price
(zero, negative) is normalised to dilution where it is read, never refused. The
validator runs over the **whole stored ledger** on every build, not only over a
file someone just dropped, and the column was parsed and silently discarded
before v5: a refusal there would be retroactive, and a row that was legal when
it was imported would fail the boot in the gunicorn master — in an app the user
then cannot reach to repair it.

**Dust normalisation** (ADR-0017): a sale emptying a position to under
`10⁻⁹ × Σ acquired` sets `quantity` **and** `cost_basis` to exact zero. A real
broker export writes `0.34898399999999996` and leaves `4×10⁻¹⁷` of a share
standing; the noise is in the file, not in the arithmetic, so the clamp is
applied where the file's number lands (the SELL) and nowhere else. **The
oversell guard carries the same tolerance**, because the same file rounds the
other way just as often: a tolerance on the leftover and none on the guard makes
the refusal a coin toss on the last bit of a float — and this replay runs in the
gunicorn master, so raising there takes the whole portfolio down over `4×10⁻¹⁷`
of a share, on a ledger with no row-level edit to repair it with. A real
oversell is still blocking.

---

### Key Behaviors

#### Event Ordering
Events are **sorted by date** before processing, regardless of their order in files or across multiple files. You can add events in any order.

#### Multi-file Support
All `.csv` and `.xlsx` files in the events directory are loaded and merged. Use this to organize by year, broker, or account. **No filename has a special meaning** (issue #711).

#### Caching
Since #697 the ledger lives in the store and the files are no longer re-read on a timer, so there is nothing to poll and nothing to invalidate on a schedule: an import is triggered by the boot, by the always-on watcher, or by a write. The cache key is the store's own stamp (`ledger.stamp`) and **no file joins it** since #698: it moves on a re-drop that changed content, on a forget, and when the declaration changes — including an account created in the app, which changes no import and no event.

#### Error Resilience
If ingestion fails (invalid event, file error, an accounts source that cannot stand), the **previous valid configuration is kept** and scraping continues normally. Errors are logged but don't crash the application. Since #658 this holds for the *whole* app rather than for scraping alone: a snapshot is published only once complete and valid, so backfill and the perf recompute cannot read a configuration the validator refused.

---

### The dials (issue #701, ADR-0014)

**There is one place that says what a setting is worth: the store.** No
precedence rule, no seed-on-first-boot, no settings file, no environment form —
and **no dial requires a restart**, which is what leaves the settings page a
single class of field. `settings_registry.py` is the **single list**: for each
dial its key, type, default, bounds and *what changing it triggers*. The write
path validates against it, `/api/config` enumerates it, and the form renders it.
Four lists would agree on the day they were written and not much longer.

| Dial | Default | Bounds | Effect of a change |
|---|---|---|---|
| `regular_interval` | `120` | 10–86400 | re-arms the scrape jobs **whose market is open right now** |
| `backfill_interval` | `60` | 10–86400 | reschedules the `backfill` interval job |
| `backfill_delay` | `10` | 0–3600 | read by the next backfill cycle |
| `backfill_chunk_days` | `365` | 1–3650 | read by the next backfill cycle |
| `staleness_horizon` | `900` | 0–86400 | read by the next scrape cycle; `0` disables the sonde |
| `base_currency` | *none* | ISO-4217, 3 letters | the reporting currency. No default, upper-cased on the way in, **fixed from the first recorded event** and free before that; the next cycle converts (#704 repairs the stock) |

`PUT /api/settings` is the **only writer**, and it being HTTP is what keeps a
headless install whole — *headless means without an interface, not without
HTTP*, so one `curl` suffices and the page is one client among others. It
answers `422` (`application/problem+json`, with the refused `key`) on an unknown
dial, a wrong type or a value out of bounds, and **writes nothing at all** when
it refuses: a half-applied body is a state nobody asked for.

Three properties of the apply path are decisions rather than details:

- **Only what actually changed is re-armed.** `reschedule_job` recomputes
  `next_run_time` from *now*, so a save button that rewrote every row would put
  every timer back to zero on every click — invisibly. The comparison is
  against the store's *effective* value, so re-posting `120` on a dial that
  already reads `120` reports no change at all.
- **`regular_interval` reaches only the symbols currently in `REGULAR`.** The
  question is put to the jobstore rather than to a second copy of `marketState`
  (`scheduling.rearm_split`, classified against the **outgoing** interval): a
  polling symbol was armed at most `interval + jitter` ahead, a sleeping one at
  its next market open. A sleeping symbol is not mis-set — it reads the dial
  when it wakes. The answer therefore **quantifies the effect**
  (`symbols_rescheduled` / `symbols_at_market_open`), because a portfolio-wide
  dial that reaches 3 symbols out of 11 has to say so.
- **`regular_interval` is also the base of #617's back-off**, whose wait is
  `regular_interval × 2^(n−3)` and not an absolute delay stored anywhere — so
  changing it rescales, **retroactively**, the wait of a symbol that has been
  failing since this morning. No interface can hide it: the number in the form
  is the number in the formula.

Three of v4's variables were **deleted rather than moved**:
`SB_DYNAMIC_EXECUTOR_POOL` and `SB_EXECUTOR_POOL` (a `ThreadPoolExecutor` does
not shrink hot, so they were the one couple that would still have needed a
restart — sizing is now always automatic), and `SB_PERF_INTERVAL` (the gate is
the cadence). Every retired `SB_*`/`INFLUXDB_*` variable that is still **set** is
named at start-up in **one grouped notice** and obeyed by nothing
(`main.report_unread_environment`) — the gesture `config.yaml` and
`settings.yaml` already get, and the list is *computed* rather than written down,
so it cannot drift.

### The advisories (issue #709, ADR-0021)

**`advisory(key, first_seen_at, acknowledged_at)` is a tiny table carrying an
acknowledgement, and nothing else** — not a journal: no history, no row per
occurrence, a closed list of keys. `advisories.py` holds **the text and the
predicate**, the way `settings_registry.py` holds the dials, and the table stores
only what the code cannot work out again. The sort was made on one question —
*can the app recompute this later?* — and four of the five survive it as
**derivable states**: a `stat` for a v4's `config.yaml` and its `settings.yaml`,
`main.unread_environment()` for the variables nothing obeys, and
`SuiviBourseMetrics.reconstruction_state()` — process memory — for how far the
reconstruction has got. **One is a real event**: *"v5 asserted your v4 amounts
were already in your reporting currency"*, produced **once** at the end of the
first reconstruction by comparing `symbol_quote.currency` to `base_currency`,
deferred because at import time no symbol has been fetched, and lost if it is not
written since the reconstruction never happens twice. Its sentence is actionable
rather than accusatory and it **names the events concerned** — recomputed by a
join, never stored, which is the whole trick: *that the assertion was made* is
the row, *what it was made about* is a query.

**Five keys and not six.** ADR-0021 amends spec #695 § 14 on exactly this point:
a missing base currency is a **live condition**, not an advisory — *the banner
shows conditions the owner can end; the badge counts facts they can only
acknowledge* — and counting it here produced a permanent badge on an install that
had simply not answered yet.

Logs would be cheaper, and the one thing they cannot do is the reason the table
exists: **a log cannot be acknowledged**. Every advisory *is* also logged, once,
in logfmt (`extra['context']`, so the headless channel is parseable), at the
instant the row is created — which is what makes "logged once" a property of the
mechanism rather than a discipline. Four properties follow:

- **The row exists exactly while the advisory stands.** `advisories.refresh` arms
  what stands and has no row, and **drops** the row of what no longer does — so
  an acknowledged advisory disappears, and re-arms with a fresh date and a fresh
  log line if its predicate comes back. The acknowledgement of a fact that has
  stopped being true would make the next occurrence invisible.
- **An observation has three answers.** `None` is *does not stand*, a mapping is
  *stands, and here is what it names*, `UNOBSERVED` is *not from here*. Arming
  needs a positive observation and **so does disarming**: the reconstruction's
  progress is process memory, so without the third answer a request served by a
  runtime with no scheduler would drop the row that scheduler armed a minute
  earlier and re-date it on the next cycle. **Which is why
  `SuiviBourseMetrics.reconstruction_state()` is total** and never answers
  `None`: *nothing to reconstruct* is `(0, 0)`, an observation that disarms, and
  *unobservable* is `runtime.metrics` being absent altogether — the one shape a
  process with no scheduler has. Spelling both `None` made the notice outlive
  its own subject: forgetting every import while the reconstruction was armed
  emptied `backfill_windows()`, the advisory read the silence as "not from here",
  and *"the historical reconstruction has not reached every first acquisition"*
  stood for ever on a portfolio naming no symbol at all.
- **The observation belongs to the jobs, never to a `GET`.** `review_advisories`
  runs at each `ingest()` (boot, a file landing, a write) and at the end of each
  backfill cycle — both read all four sources through the one builder,
  `main.advisory_context`, so neither can drop what the other armed, and the
  concluded reconstruction is where the recorded advisory is born.
  `GET /api/advisories` re-derives each standing row's detail and writes nothing;
  `POST /api/advisories/<key>/acknowledgement` is the only gesture, and the
  acknowledgement **persists** — which a *toast* does not, and which the
  assumed-currency advisory needs, arriving half an hour after the boot.
- **Never confused with the audit.** `import_source` is the provenance trail.
  Merging them would give an advisory box that grows by a row per import and that
  one stops reading — both failures at once.

### Environment Variables

What is left in the environment is exactly what the process must know **before**
it can open the store (ADR-0014) — a mechanical test, not a judgement about
nature. `main.ENVIRONMENT_INVENTORY` is the list `/api/config` publishes.

| Variable | Default | Description |
|----------|---------|-------------|
| `SB_STORE_DIR` | `~/.config/SuiviBourse` | Directory holding the DuckDB store `suivi-bourse.duckdb` (issue #696). Boot-scope by nature: the process must know it before it can open the store, and therefore before it can ask the store anything (ADR-0014). The default is today's mounted config directory; #679 moves it to a volume of its own. |
| `SB_WEB_PORT` | `8080` | Port for the Flask web API and its `/health` route — the container healthcheck's only target (issue #651). Since #696 the probe **reaches the store**: "survive a database outage" has no subject once the database is a file this process opens (ADR-0015) |
| `SB_PROMETHEUS_ENABLED` | `true` | Mount the legacy Prometheus `/metrics` endpoint. Since #651 it unmounts a Flask route rather than skipping an HTTP server, so `false` also leaves `SB_METRICS_PORT` unbound |
| `SB_METRICS_PORT` | `8081` | Port for the Prometheus `/metrics` endpoint — a second gunicorn socket on the same app, so existing scrapers see no change |
| `SB_STATIC_DIR` | (the image's) | Where the built SPA is served from; unset has no value rather than a default |
| `LOG_LEVEL` | `INFO` | Logging level. Here rather than in the store because the most likely failure of this app is the store failing to open, and a level kept inside it could not report that |

---

## Module Structure

```
app/src/
├── gunicorn.conf.py        # Container entrypoint AND boot sequence (issue #651)
├── main.py                 # Runtime/build_runtime/start_runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── quotes.py               # The market's two tables: symbol_quote + price_point, one `latest` rule (#700)
├── fx.py                   # Pure: the reporting currency, GBp, and one TTL cache per pair (#702)
├── perf_series.py          # The perf job's two tables: account_metrics + portfolio_totals, block upsert + bounded prune (#700, #707)
├── store_reads.py          # PortfolioReader — the UI read primitives; errors propagate (#659, #700)
├── portfolio_view.py       # Pure: P1 rows → page objects (weighted mean, per-account rollup) (#659)
├── runtime_state.py        # The scheduler's last-pass records — the one writer, one shape (#668)
├── runtime_view.py         # Pure: records + snapshot + jobstore → pills and the banner (#668)
├── prometheus_exporter.py  # Legacy Prometheus sb_* gauges (registry only, no server)
├── store.py                # The DuckDB store: connection, DDL of the twelve tables, seed (#696)
├── ledger.py               # The import: import_source/symbol/event, provenance, revocation (#697)
├── accounts.py             # The account table: the accounts file, the declaration, the refusals (#698)
├── positions.py            # The replay's two tables — position/account_state, one writer (#699)
├── settings_registry.py    # Pure: the one list of dials — key, type, default, bounds, effect (#696/#701)
├── advisories.py           # The five advisories: text and predicate in code, the table holds the ack (#709)
├── settings.py             # The dials' write path: validate the whole body, write what moved (#701)
├── static/                 # Built SPA (git-ignored; Vite's outDir, COPY'd in the image)
├── web/                    # Flask package (disposable half, per #655)
│   ├── __init__.py         # create_app() + the post_fork / worker_exit hook bodies + SPA catch-all
│   ├── api.py              # /api blueprint: shares, prices, portfolio, accounts (read + declare, #698), events, imports, advisories (#709), config, runtime
│   ├── problem.py          # RFC 9457 application/problem+json responses (#659)
│   └── health.py           # /health blueprint — touches the store (#696)
└── events/                 # Events module
    ├── __init__.py
    ├── schemas.py          # Dataclasses: Event, EventType, ShareState + unit_cost (#699)
    ├── loader.py           # CSV/XLSX loading
    ├── validator.py        # Event validation
    ├── aggregator.py       # Aggregation logic — the PMP, the realized gain, the dust clamp
    └── watcher.py          # File watcher (watchdog)

app/web/                    # Front-end workspace — Vite + React 19 + TS, Tailwind/shadcn,
                            # TanStack Table & Query, Recharts. Builds into app/src/static.
├── src/index.css           # Three blocks: preset · domain · @theme inline bridge (#713)
├── src/app.tsx             # The providers, mounted identically by main.tsx and the tests
├── src/router.tsx          # Four code-based routes; the history is an argument
├── src/i18n/{en,fr}.json   # ICU catalogues, semantic keys, English the source
├── src/lib/api.ts          # The only module that knows a URL
├── src/lib/i18n.tsx        # Language: three states, localStorage, ICU
├── src/lib/theme.tsx       # Theme: three states, localStorage, writes the alloc ramp
├── src/lib/alloc.ts        # The twelve allocation stops, generated per ground
├── src/lib/format.ts       # The eight Intl sites, locale as an argument
├── src/lib/problem.ts      # problem.type → catalogue key. `detail` is never rendered
├── src/lib/status.ts       # The dot's state and the banner's one band, pure
└── src/test/               # setup · MSW server · payload factory · renderApp
```

## Prometheus Metrics (legacy)

`/metrics` is a **first-class product** and not a legacy half (ADR-0012): it is
what makes the app usable headless, for whoever wants something very simple.
Enabled by default on `SB_METRICS_PORT`=8081, it runs beside the store and
reflects only the current snapshot per share (no historical backfill). Disable it
with `SB_PROMETHEUS_ENABLED=false`.

Since #651 it is a route on the Flask app, mounted with `DispatcherMiddleware`
and served on its own gunicorn socket — same port, same path, no change for a
scraper. `prometheus_exporter.py` owns the registry only; its `start()` and its
`ThreadingHTTPServer` are gone.

Gauges (prefix `sb_`, labels `share_name`/`share_symbol`/`account`): `sb_share_price`,
`sb_share_price_native`, `sb_fx_rate`,
`sb_cost_basis`, `sb_owned_quantity`, `sb_received_dividend`,
`sb_realized_gain`, `sb_dividend_yield`, `sb_pe_ratio`,
`sb_market_cap`, `sb_volume`, plus `sb_share_info` (value `1`, with extra labels
`share_currency`/`share_exchange`/`quote_type`). `sb_price_staleness` is the
price-freshness liveness sonde (issue #628): `1` when a symbol's stored price is
silently stale (frozen past `staleness_horizon` during `REGULAR` while the
live quote moves), `0` otherwise — a gauge so it auto-clears when the writer
recovers.

**Never a gauge whose unit depends on a setting** (issue #702, spec #695 § 12).
A single `sb_share_price` would mean dollars on one install, euros on another and
euros *from Tuesday* on a third — not a metric, a trap with a plausible-looking
value in it. So there are **two price gauges**: `sb_share_price` publishes the
converted price, `sb_share_price_native` the quote as the exchange gives it, and
`sb_fx_rate` the rate between them. While the base currency is unanswered the
converted one and the rate are **absent** (not zero — a zero is a figure every
`sum()` counts), and so is every `sb_account_*` / `sb_portfolio_*` series, since
the perf job writes nothing at all until then. The position gauges are *not*
under the rule: their amounts come from events **recorded** in the reporting
currency, so answering the dial names a unit they always had. `sb_account_info`
lost its `account_currency` label with `Account.currency`.

**Two feeders, two lives** (issue #699). `update_position` publishes what the
events say — `sb_owned_quantity`, `sb_cost_basis`, `sb_received_dividend` and
`sb_realized_gain` — and it is called by the **replay**, for every position,
sold ones included. `update_quote` publishes what the market says, on the
fetch-success gate. Riding the realized gain on the scrape's write path would
never publish it at all: the path is removed at the exact instant the figure is
born.

**Two removals, on two different predicates.** `forget_quotes(symbol)` drops
every market series of a symbol whose scrape job departs (`_reconcile_jobs`):
without it `sb_share_price{share_symbol="ALO"}` sits at its last observed price
for the life of the process, never saying it stopped moving. And
`retain_positions(shares)` — what the replay calls — drops the position series
of a position the ledger **no longer produces at all** (a forgotten import); a
loop that only ever set would leave a cost basis standing for a holding nobody
declares, quietly counted by every `sum()` over the metric until a restart.
Zero quantity is *not* what takes a position series away: a sold position is
still declared, and its realized gain is the figure it has left to say.

**All three `sb_purchased_*` gauges are gone** — renamed rather than redefined
(spec #695 § 12, `website/docs/headless-gauges.mdx`), and none of them into a
survivor, because each would have changed *meaning* under its old name:
`_quantity` counted *"ever bought"* and v5 has no such state; `_fee` counted a
fee that now lives inside the cost basis, so the only value left to publish
would be a zero reading as *"no fees paid"*; `_price` went from fee-excluded to
fee-included. What replaces them is the state itself — `sb_cost_basis`, an
**amount** — and the unit average is that divided by `sb_owned_quantity`, a
division PromQL does perfectly well and which stays honestly undefined on a
position nobody holds. A sold position publishes `0` for both: a zero is a
figure, and absence is kept for what could not be computed at all.

## The market and performance tables

**`symbol_quote`** — one row per symbol, written by the scrape (and, for the
`last_*` columns, by the backfill's forward pass). It is the `latest` row *and*
the instrument's attributes, which is why there is no second table.

| Column | Description |
|---|---|
| `symbol` | Yahoo Finance ticker; the primary key, referencing `symbol(symbol)` |
| `currency` / `exchange` / `quote_type` | the instrument's attributes, refreshed on every successful fetch |
| `dividend_yield` / `pe_ratio` / `market_cap` | the fundamentals, in **current value only** — yfinance supplies them on the live quote alone, so their v4 "history" was a comb of `NULL` |
| `fetched_at` | when the attributes above were last refreshed |
| `last_price_native` / `last_price_ts` | the `latest` row, maintained by the one rule above |
| `last_price_converted` / `last_fx_rate` | the same observation in the reporting currency, and the rate used (#702). The three price columns move together — a native price beside a converted one from an earlier point is the per-field last-non-null row the store exists to avoid |
| `oldest_window_tried` | the backward pass's anchor — the oldest window **tried**, persisted (#703). A `DATE`: a window boundary is a calendar day. Written only when a fetch completed, and only ever backwards |

**`price_point`** — the series, and the one table with **no key of any kind**
(ADR-0007): a DuckDB ART index is a second copy of the data in resident memory,
costing +563 MB on a 319 MB base. Uniqueness moves to the writers.

| Column | Description |
|---|---|
| `symbol` | the ticker. **No account**: a market price belongs to none (#700) |
| `ts` | `TIMESTAMPTZ` in UTC, truncated to the second |
| `price_native` | the close, in the security's own currency |
| `price_converted` / `fx_rate` | the close in the reporting currency and the rate that produced it (#702). `NULL` means *transient* — no currency answered yet, or a pair that did not resolve — repaired by #704's lateral pass. `price_converted == price_native × fx_rate` holds on every row, which is what makes the row a journal |

**`account_metrics`** (opt-in accounts only; one row per calendar **day**, block
upsert on `(account, day)`). The series is recomputed **and rewritten in full**
every cycle since #707: the stale-tail window lost its subject, an upsert on a
primary key not growing the file the way a `DELETE`+`INSERT` replacement does
(ADR-0011: 44,8 MB against 1,1). What follows the upsert is a **bounded prune**
— every day outside the spans the cycle wrote, per account, so an account that
computes to nothing loses its days along with the orphaned one. The primary key
is therefore a **write mechanism** and not only a constraint.

| Column | Description |
|---|---|
| `account` | account id, referencing `account(id)` |
| `day` | the calendar day the figures describe — a `DATE`, never a midnight instant (#700) |
| `cash_balance` | per-account cash ledger balance |
| `holdings_value` | Σ(quantity × price) over the account's symbols |
| `total_value` | `cash_balance + holdings_value` |
| `net_contributed` | Σ deposits − Σ withdrawals (fees excluded) |
| `xirr` | money-weighted return (annualized); latest point only, `NULL` without an external flow |
| `twr_index` | time-weighted return, base 100 (per day) |
| `gain_absolu` | absolute gain (`value − contributions`); latest point only |

`account_type` has **no column**: it was an InfluxDB tag, and a page reads it
from the declaration (ADR-0013), which is what the account *is* rather than what
it was when a point was written. `account_currency` has none either, and for a
second reason since #702 — an account has no currency at all.

**`portfolio_totals`** — the same seven figures at the **global** level, keyed by
`day` alone. A table of its own rather than a synthetic `account` row, and it
stays one for a forward-looking reason rather than an inherited one: the
constraint that made it untagged is gone, but its columns will diverge the day
the global level carries something the per-account level does not. The
single-currency condition that used to gate it left with `Account.currency`
(#702): accounts cannot disagree about a currency they do not have. What gates
**both** tables is the base currency being answered at all.

Money-weighted performance (XIRR by home-grown bisection, TWR base 100) is
computed in `app/src/performance.py` — a pure module taking a `Timeline` and an
injected `price_at` callable (no store, no yfinance). External flows
(DEPOSIT/WITHDRAWAL/GRANT) are the contribution; internal flows (BUY/SELL/
DIVIDEND/fees) are the performance — which is why a sale needs nothing here: the
proceeds land in cash and `total_value` is continuous across it. A **GRANT is
valued at the price its own event declares** since #699, never through
`price_at`: the old valuation made an account's `gain_absolu` change as the
backfill advanced with no event having moved, and a grant-only position had no
price at its date at all.

Prometheus mirrors these as `sb_account_*{account}` gauges plus `sb_account_info`
(label `account_type`; `account_currency` left with `Account.currency`, #702)
and global `sb_portfolio_*` gauges
(no `account` label). Price history for `holdings_value` is read via
`quotes.price_series(store, symbol)` — the day's **last** point, queried by
symbol, which is no longer a rule to remember: there is no account column to
forget.

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven with the `gh` CLI — including the
v5 wayfinding map (#669) and its child tickets. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### Wave orchestration

The v5 tickets are implemented in waves off `preview/v5` by the two scripts in
`.claude/workflows/`. See `docs/agents/wave-orchestration.md`.
