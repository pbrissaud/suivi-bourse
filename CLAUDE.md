# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuiviBourse is a Python application that monitors stock shares using yfinance for real-time pricing and stores metrics in InfluxDB 3 Core for visualization in Grafana. It supports historical data backfill for viewing past price evolution.

## Commands

### Python App (in `app/` directory)

```bash
# Dependencies are managed with uv (app/pyproject.toml + app/uv.lock).
# Install runtime + dev deps into a uv-managed .venv:
cd app && uv sync

# Run the app locally (requires config at ~/.config/SuiviBourse/config.yaml or events/)
# Also requires INFLUXDB_TOKEN environment variable. gunicorn is the only boot
# path: the web API and the scheduler share one process (issue #651), and
# src/gunicorn.conf.py holds the boot sequence. `main.py` has no __main__ block.
cd app && INFLUXDB_TOKEN=your-token uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
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

### Web UI (in `app/web/` directory)

The front is a packaged SPA (issue #659). It lives under `app/` because the
Docker build context is `./app`; it is **not** a pnpm workspace with `website/`.

```bash
cd app/web
pnpm install
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
latter would otherwise shadow the image's own build.

### Documentation Website (in `website/` directory)

Dependencies are managed with pnpm. The docs are versioned: `docs/` holds the
current **v4** docs (served at `/docs`), `versioned_docs/version-3.x/` holds the
frozen **v3** docs (served at `/docs/v3`). Use the navbar version selector to
switch. Snapshot a new version with `pnpm docusaurus docs:version <name>`.

```bash
cd website
pnpm install
pnpm start    # Development server
pnpm build    # Production build (fails on broken links)
```

### Docker Compose (in `docker-compose/` directory)

```bash
cd docker-compose
make init                         # .env from .env.example, data/ from data.example/
docker compose up -d              # Full stack: app + InfluxDB + Grafana
docker compose -f docker-compose.dev.yaml up -d  # Development mode (uses data.example/)

# Events mode: drop a .csv/.xlsx into the config dir's events/ folder — the mode
# is auto-detected. SB_CONFIG_MODE only forces it.
```

The stack owns exactly two user-writable things, both git-ignored: `.env` (every
setting, names identical to the app's own env vars) and the **config directory**
(`SB_CONFIG_DIR`, default `./data`) mounted as a single volume at
`/home/appuser/.config/SuiviBourse`. That mount is **writable** since #658 — the
web UI's data page edits events and the `accounts:` block — so the service runs
as `user: "${SB_UID:-1000}:${SB_GID:-1000}"` and `make init` records the
invoking `id -u`/`id -g` in `.env`, keeping the files owned by the human who
also edits them by hand. The image sets `ENV HOME=/home/appuser` for the same
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

- **master, under `preload_app`** — `main.build_runtime()`: `ConfigurationManager`
  (which owns the Cerberus validator), the **first publication** of the config
  snapshot **that validates it**, and the `PrometheusExporter` registry. Pure
  work only: no thread, no socket, no fd survives a fork. Publishing the config
  here is what keeps a broken one a single clean exit — the arbiter has not
  forked yet, so there is nothing to respawn — and the worker inherits the
  published snapshot through the fork, so `post_fork`'s `ingest()` is a cache
  hit that only arms the jobs.
- **`post_fork`** — `main.start_runtime()`: the InfluxDB client (a connection
  pool the master must not share), `BackgroundScheduler` (not Blocking — the
  worker owns the foreground), `start_watcher()`, and the first `ingest()` that
  arms the per-symbol scrape jobs.
- **`worker_exit`** — `main.shutdown_runtime()`, the heir of the old `finally`.

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

**The web UI reads through a sibling of the writer** (issue #659, design #655).
The layer between the UI and InfluxDB is the *for-keeps* half of the prototype;
the React on top of it is admitted throwaway. Three modules, and the split is by
**error contract**, not by subject matter:

- **`influx_reads.py`** — `PortfolioReader`, taking a `query(sql) -> table`
  executor as its single injection point (the pooled client is created in
  `post_fork`). Its workhorse is **P1 generalised**: one window function,
  `ROW_NUMBER() … PARTITION BY share_symbol, COALESCE(account,'default')`,
  returning the newest observation per pair for the *whole* portfolio in one
  query — the shares table and (later) the dashboard's allocation + movers share
  it. It is a single query because every live point carries the price, the
  position fields **and** the fundamentals together (`write_metrics` is only
  called once the quote fetch succeeded), so there is no per-field last-non-null
  pass to do. Deliberately **no time window**: "current" is absolute (#652
  déc. 1), so a long market closure no longer blanks the page. Also
  `raw_series` and `bucketed_series` — the latter is not in the design and the
  arithmetic forced it: 120 s over a 6.5-hour session is ~200 points a day, so a
  five-year raw window is a quarter of a million points on the wire.
- **`portfolio_view.py`** — pure, in the taste of `scheduling.py` /
  `performance.py`. Rows in, page objects out: the weighted mean
  `Σ(pp×pq)/Σpq` (a plain sum *and* a plain mean both produce plausible-looking
  wrong prices), the per-account rollup Grafana sums away in SQL, and
  **plus-value latente** — which requires the holdings term and defaults the
  other three to zero, because composing it out of null-tolerant helpers made a
  share whose price was never observed report a total loss.
- **`influx_sql.py`** — the one rule both halves share: trap 1's
  `COALESCE(account,'default')` + quote escaping, the NaN guard, the bare-UTC-Z
  literal. A second implementation would decay, and its symptom — history that
  stops at a version boundary — reads as missing data, not as a bug.

The reason this is a **sibling** of `influxdb_writer.py` rather than a growth of
it: the writer ends every read with `except Exception: … return None`, which is
right for a scheduler surviving a flaky query and wrong for a UI, where it makes
"the database is unreachable" and "you own nothing yet" the same screen. Here
query errors **propagate** and `web/problem.py` turns them into `503` +
`application/problem+json`; absence stays three distinct states (`200`+`null` /
`200`+`[]` / `503`). The one exception is a measurement that does not exist yet
— a fresh install, answered `[]`.

`events/editor.py` is a **second read of the event files, as files**, beside the
loader: `Event`, the aggregator and the validator stay byte-identical. Each row
gets an **opaque token** over `(file, sheet, row)` — never `(file, row)`, since
`row_num` restarts at 2 in every xlsx worksheet — plus a content fingerprint
exposed as `ETag`, which is what makes a stale address a `409` instead of a
silently mis-edited row. Reads are tolerant of a malformed row (it comes back
with its error) so the ledger can be used to *fix* it.

Flask serves the built SPA with a catch-all that must **not** swallow `/api` or
`/metrics`: without those guards a typo'd endpoint returns the HTML shell with a
`200`, and a Prometheus scraper reads `200` as a healthy target.

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
- **Never publish what is not validated.** Cerberus runs *inside* snapshot
  construction, closing a split-brain that predated the UI: the cache was
  written by the loader and validated afterwards by `ingest()`, so a rejected
  file still fed **backfill and the perf recompute** while scraping ran on the
  previous one. `SuiviBourseMetrics.shares` is now a *read* of the snapshot, not
  a second copy, and `backfill()` / `recompute_perf()` take one snapshot per
  cycle. An **empty portfolio is exempt** from `schema.yaml`'s `empty: False` —
  events mode legitimately starts with an empty `events/` directory.

The `accounts:` block is re-read on every build (`settings.yaml`'s mtime joined
the cache key), so editing it no longer needs a restart; `mode` / `events.source`
/ `events.watch` stay boot-only — they are deployment settings.

The application runs independent scheduled jobs on a single APScheduler:
- **Scraping**: one **self-rescheduling job per held symbol**, market-aware
  (issue #616). Each job fetches its symbol from Yahoo Finance, writes a point
  per account holding it, then re-arms on its own cadence: `REGULAR` markets
  re-poll every `SB_REGULAR_INTERVAL` (default 120s); closed markets sleep to
  the next open (capped 24h). A **dead-ticker guard** (issue #617) backs a
  symbol off when non-closed cycles keep producing no writable price: the first
  3 failures still re-arm at `base_interval`, then the delay grows
  `base_interval × 2^(n−3)` capped at 24h, resetting to 0 on the first
  successful write. Closed cycles never count as failures. A **price-freshness
  liveness sonde** (issue #628) rides the `REGULAR` write path: before each write
  it reads the newest stored price for the (symbol, account) and advances the
  pure `scheduling.price_freshness_step` against per-series memory
  (`_sonde_state`). When the stored value stays frozen across *consecutive*
  `REGULAR` cycles for at least `SB_STALENESS_HORIZON` (default 900s) while the
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
  and `max_instances=1`. The APScheduler **executor pool** is sized at boot from
  two dials: `SB_DYNAMIC_EXECUTOR_POOL` (default `false` → fixed
  `SB_EXECUTOR_POOL`, default 10) or, when `true`, the pure
  `scheduling.compute_pool_size(mode, shares, exchange_of)` =
  `min(reserved + ceil(largest_cohort × 5 / 30), 50)` with `reserved` 3 (events)
  / 1 (manual). `exchange_of` is captured by a pre-scheduler fetch
  (`capture_exchange_of`) only on the auto path.
- **Ingestion**: Reloads portfolio events from files (default: every 300s) and
  reconciles the per-symbol scrape jobs against the new symbol set (add / remove
  / revive).
- **Backfill**: **bidirectional** (issue #626), every 60s, both passes run per
  share each cycle and are independent. **Backward** (pre-existing): oldest
  stored point → first `BUY`, one `SB_BACKFILL_CHUNK_DAYS` chunk per cycle,
  stops once the `_backfill_complete` watermark is set. **Forward gap-fill**
  (issue #627): recovers a trading session missed while the app was down
  (stop/crash/host asleep) by fetching `[newest → now]` — anchor =
  `get_newest_timestamp` (newest point with `share_price IS NOT NULL`, scoped by
  symbol+account), window sized by the pure
  `scheduling.forward_backfill_window(newest, now, chunk_days)`. Returns `None`
  (no fetch) when the series is empty (backward owns seeding) or the anchor is
  `< 1 day` old — that guard is what makes the forward pass a **no-op during
  live trading** (`newest ≈ now`), so the `REGULAR` writer stays the sole writer
  of the present with no duplicate at the seam. Gap classification is delegated
  to yfinance: a weekend/holiday window comes back empty and stays a gap (#606),
  a missed open session comes back with rows. `_backfill_complete` gates **only**
  the backward pass. Recovered points carry the same tags/series identity as live
  points, so perf `holdings_value` picks them up.
- **Performance**: Recomputes the `account_metrics` / `portfolio_totals` series
  (opt-in accounts only) as its **own gated interval job** at `SB_PERF_INTERVAL`
  (default 120s), decoupled from the per-symbol scrape jobs (issue #618). Each
  run is gated by the pure predicate `scheduling.perf_should_run()` — it runs
  only when something changed since the last run: the events cache reloaded, a
  backfill watermark is pending, or a `REGULAR` write occurred. The live-write
  signal is a single global bool set on the `REGULAR` write path in
  `_scrape_symbol`, checked-and-cleared up front under `_perf_lock` and seeded
  `True` at boot (so today's point is fresh after an overnight restart). A
  fully-closed market wave writes nothing — the non-trading-day gap is by design
  (#606) and there is no closed-day Parquet drip (#597).

Writes to InfluxDB measurement `portfolio_metrics` with fields: `share_price`, `purchased_quantity`, `purchased_price`, `purchased_fee`, `owned_quantity`, `received_dividend`, `dividend_yield`, `pe_ratio`, `market_cap`

### Scheduled Jobs
```text
┌──────────────────────────┐  ┌───────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│  SCRAPE  (per symbol,    │  │    INGESTION      │  │    BACKFILL      │  │   PERFORMANCE      │
│  self-rescheduling)      │  │   (every 300s)    │  │   (every 60s)    │  │ (SB_PERF_INTERVAL) │
│                          │  │                   │  │                  │  │                    │
│ • yfinance.Ticker()      │  │ • Load events CSV │  │ • Backward pass  │  │ • perf_should_run? │
│ • marketState → cadence  │  │ • Recalc state    │  │ • Forward pass   │  │ • Recompute perf   │
│ • REGULAR: poll & write  │  │ • Update shares[] │  │ • Chunk 1 yr/req │  │   series (opt-in   │
│ • Closed: sleep to open  │  │ • Reconcile jobs  │  │ • Rate limit 10s │  │   accounts only)   │
└──────────────────────────┘  └───────────────────┘  └──────────────────┘  └────────────────────┘
         │                            │                       │                       │
         └────────────────────────────┴───────────┬───────────┴───────────────────────┘
                                                   ▼
                                            ┌─────────────┐
                                            │  InfluxDB 3 │
                                            │  (database) │
                                            └─────────────┘
```

The two pure modules `scheduling.py` (cadence/market-context decisions) and
`performance.py` (money-weighted returns) hold the testable logic — no InfluxDB
or yfinance, `now` injected.

## Configuration

### Configuration Modes

SuiviBourse supports two **mutually exclusive** configuration modes:

| Mode | Source | Description |
|------|--------|-------------|
| `manual` | `config.yaml` | Traditional static configuration |
| `events` | `events/*.csv`, `events/*.xlsx` | Event-based portfolio tracking |

**Mode selection priority:**
1. Environment variable `SB_CONFIG_MODE` (`manual` or `events`)
2. `~/.config/SuiviBourse/settings.yaml` → `mode` field
3. Auto-detection: `events` if the events source holds ≥1 `.csv`/`.xlsx`
4. Default: `manual`

The `events:` block (`source`, `watch`) is parsed regardless of *how* the mode
was selected — it describes how to read events, not whether to. Every `SB_*`
variable treats a blank value as unset (`env_str`/`env_int`/`env_flag`), because
compose renders an undefined substitution as an empty string.

> **Note**: The two modes are mutually exclusive. Switching to `events` mode ignores `config.yaml` entirely. There is no automatic migration between modes.

---

### Manual Mode (config.yaml)

```yaml
shares:
- name: Apple
  symbol: AAPL
  purchase:
    quantity: 1
    fee: 2
    cost_price: 119.98
  estate:
    quantity: 2
    received_dividend: 2.85
```

---

### Events Mode (CSV/XLSX)

Import portfolio events from files and automatically compute aggregated positions.

#### File Structure

```
~/.config/SuiviBourse/
├── settings.yaml         # Mode configuration
└── events/               # Event files directory
    ├── 2023.csv
    ├── 2024.csv
    └── broker-export.xlsx
```

#### settings.yaml

```yaml
mode: events
events:
  source: ~/.config/SuiviBourse/events/
  watch: true  # Optional: enable file watcher for immediate reload
```

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
| `symbol` | Yes | Yahoo Finance ticker (e.g., `AAPL`, `MSFT`) |
| `name` | Yes | Display name for the share |
| `quantity` | For BUY/SELL/GRANT | Number of shares |
| `unit_price` | For BUY/SELL | Price per share |
| `fee` | Optional | Transaction fee |
| `amount` | For DIVIDEND | Dividend amount received |
| `notes` | Optional | Free text comment |

#### Event Types

| Type | Effect on Portfolio |
|------|---------------------|
| `BUY` | +purchase.quantity, +estate.quantity, recalculates weighted avg cost_price, +purchase.fee, −cash |
| `SELL` | -estate.quantity, +purchase.fee, +cash (proceeds `qty×price − fee`) |
| `GRANT` | +estate.quantity only (free shares, no impact on purchase); cash-neutral |
| `DIVIDEND` | +estate.received_dividend, +cash (`amount − fee`) |
| `DEPOSIT` | +cash (`amount − fee`), +net_contributed (cash event: `account`+`amount` required, no share) |
| `WITHDRAWAL` | −cash (`amount + fee`), −net_contributed (cash event) |

Cash is a per-account ledger (starts at `0.00`). Negative balances are allowed
(non-blocking warning); overselling stays blocking.

#### Aggregation Logic

**BUY** - Weighted average cost price:
```
new_cost_price = (old_qty × old_price + new_qty × new_price) / total_qty
```

**SELL** - Validation:
- Cannot sell more shares than currently owned
- Sale price is recorded in the event but not aggregated (realized gains not tracked)

**GRANT** - Free shares:
- Only increases estate.quantity
- Does not affect purchase.quantity or cost_price

---

### Key Behaviors

#### Event Ordering
Events are **sorted by date** before processing, regardless of their order in files or across multiple files. You can add events in any order.

#### Multi-file Support
All `.csv` and `.xlsx` files in the events directory are loaded and merged. Use this to organize by year, broker, or account.

#### Caching
Ingestion uses **file modification time (mtime)** to detect changes — of the event files *and* of `settings.yaml`, so an edited `accounts:` block is not hidden behind an unchanged events directory. If nothing changed, the published snapshot is reused unchanged (same object).

#### Error Resilience
If ingestion fails (invalid event, file error, `accounts:` malformed, `schema.yaml` rejected), the **previous valid configuration is kept** and scraping continues normally. Errors are logged but don't crash the application. Since #658 this holds for the *whole* app rather than for scraping alone: a snapshot is published only once complete and valid, so backfill and the perf recompute cannot read a configuration the validator refused.

---

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INFLUXDB_HOST` | `http://influxdb:8181` | InfluxDB 3 host URL |
| `INFLUXDB_TOKEN` | (required) | InfluxDB API token |
| `INFLUXDB_DATABASE` | `suivi_bourse` | InfluxDB database name |
| `SB_REGULAR_INTERVAL` | `120` | Poll interval (seconds) for a symbol whose market is in `REGULAR` state (per-symbol scheduling). Closed markets sleep to next open instead. |
| `SB_SCRAPING_INTERVAL` | — | **Deprecated** heir of the removed global scrape interval. Honored as a fallback for `SB_REGULAR_INTERVAL` when the latter is unset; logs a warning whenever present. |
| `SB_PERF_INTERVAL` | `120` | Perf-recompute interval (seconds) for the gated `account_metrics`/`portfolio_totals` job (issue #618) |
| `SB_DYNAMIC_EXECUTOR_POOL` | `false` | Opt-in: auto-size the APScheduler thread pool from the largest same-exchange cohort (issue #619). Off = fixed pool, zero change from today. |
| `SB_EXECUTOR_POOL` | `10` | Fixed executor pool size when `SB_DYNAMIC_EXECUTOR_POOL=false`. Enforced `≥1`. Ignored (warns) when auto sizing is on (issue #619). |
| `SB_WEB_PORT` | `8080` | Port for the Flask web API and its shallow `/health` route — the container healthcheck's only target (issue #651) |
| `SB_INGESTION_INTERVAL` | `300` | Event ingestion interval (seconds) |
| `SB_BACKFILL_INTERVAL` | `60` | Backfill check interval (seconds) |
| `SB_BACKFILL_DELAY` | `10` | Delay between yfinance requests (seconds) |
| `SB_BACKFILL_CHUNK_DAYS` | `365` | Days of history per backfill request |
| `SB_STALENESS_HORIZON` | `900` | Price-freshness liveness sonde horizon (seconds): during `REGULAR`, flag a symbol whose stored price stays frozen this long across consecutive polling cycles while the live quote moves (issue #628). Diagnostic only — never changes cadence/write gating/#617 backoff. `0` disables the sonde. |
| `SB_CONFIG_MODE` | _(unset)_ | Force the configuration mode (`manual` or `events`). Unset/blank → `settings.yaml`, then auto-detection, then `manual`. |
| `SB_PROMETHEUS_ENABLED` | `true` | Mount the legacy Prometheus `/metrics` endpoint. Since #651 it unmounts a Flask route rather than skipping an HTTP server, so `false` also leaves `SB_METRICS_PORT` unbound |
| `SB_METRICS_PORT` | `8081` | Port for the Prometheus `/metrics` endpoint — a second gunicorn socket on the same app, so existing scrapers see no change |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## Module Structure

```
app/src/
├── gunicorn.conf.py        # Container entrypoint AND boot sequence (issue #651)
├── main.py                 # Runtime/build_runtime/start_runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── influxdb_writer.py      # InfluxDB 3 client wrapper — the scheduler's writes + its 5 anchor reads
├── influx_sql.py           # Shared SQL rule: COALESCE(account,'default') + escaping, NaN guard, UTC-Z (#659)
├── influx_reads.py         # PortfolioReader — the UI read primitives; errors propagate (#659)
├── portfolio_view.py       # Pure: P1 rows → page objects (weighted mean, per-account rollup) (#659)
├── prometheus_exporter.py  # Legacy Prometheus sb_* gauges (registry only, no server)
├── schema.yaml             # Cerberus validation schema
├── static/                 # Built SPA (git-ignored; Vite's outDir, COPY'd in the image)
├── web/                    # Flask package (disposable half, per #655)
│   ├── __init__.py         # create_app() + the post_fork / worker_exit hook bodies + SPA catch-all
│   ├── api.py              # /api blueprint: shares, prices, accounts, events (#659)
│   ├── problem.py          # RFC 9457 application/problem+json responses (#659)
│   └── health.py           # /health blueprint
└── events/                 # Events module
    ├── __init__.py
    ├── schemas.py          # Dataclasses: Event, EventType, ShareState
    ├── loader.py           # CSV/XLSX loading
    ├── editor.py           # Editor read path: addressable rows, opaque id + ETag (#659)
    ├── validator.py        # Event validation
    ├── aggregator.py       # Aggregation logic
    └── watcher.py          # File watcher (watchdog)

app/web/                    # Front-end workspace — Vite + React 19 + TS, Tailwind/shadcn,
                            # TanStack Table & Query, Recharts. Builds into app/src/static.
```

## Prometheus Metrics (legacy)

For backward compatibility with pre-InfluxDB deployments, the app also exposes a
Prometheus `/metrics` endpoint (enabled by default, `SB_METRICS_PORT`=8081). It
runs in parallel with the InfluxDB writer and reflects only the current snapshot
per share (no historical backfill). Disable it with `SB_PROMETHEUS_ENABLED=false`.

Since #651 it is a route on the Flask app, mounted with `DispatcherMiddleware`
and served on its own gunicorn socket — same port, same path, no change for a
scraper. `prometheus_exporter.py` owns the registry only; its `start()` and its
`ThreadingHTTPServer` are gone.

Gauges (prefix `sb_`, labels `share_name`/`share_symbol`/`account`): `sb_share_price`,
`sb_purchased_quantity`, `sb_purchased_price`, `sb_purchased_fee`,
`sb_owned_quantity`, `sb_received_dividend`, `sb_dividend_yield`, `sb_pe_ratio`,
`sb_market_cap`, `sb_volume`, plus `sb_share_info` (value `1`, with extra labels
`share_currency`/`share_exchange`/`quote_type`). `sb_price_staleness` is the
price-freshness liveness sonde (issue #628): `1` when a symbol's stored price is
silently stale (frozen past `SB_STALENESS_HORIZON` during `REGULAR` while the
live quote moves), `0` otherwise — a gauge so it auto-clears when the writer
recovers.

## InfluxDB Data Model

**Measurement**: `portfolio_metrics`

| Type | Name | Description |
|------|------|-------------|
| Tag | `share_name` | Display name |
| Tag | `share_symbol` | Yahoo Finance ticker |
| Tag | `account` | Account bucket (`default` unless accounts are declared); on v4.1+ writes only — pre-v4.1 points have no tag (`NULL`), read with `COALESCE(account, 'default')` |
| Tag | `share_currency` | Currency (USD, EUR, etc.) |
| Tag | `share_exchange` | Exchange (NMS, PAR, etc.) |
| Tag | `quote_type` | Type (EQUITY, ETF, etc.) |
| Field | `share_price` | Current/historical price |
| Field | `purchased_quantity` | Quantity bought |
| Field | `purchased_price` | Weighted average cost |
| Field | `purchased_fee` | Total fees |
| Field | `owned_quantity` | Currently owned |
| Field | `received_dividend` | Total dividends |
| Field | `dividend_yield` | Yield percentage |
| Field | `pe_ratio` | P/E ratio |
| Field | `market_cap` | Market capitalization |
| Field | `volume` | Trading volume |

**Measurement**: `account_metrics` (opt-in accounts only; daily series, points
stamped at midnight of the day, idempotent upsert). The series is recomputed in
full every cycle but only the **stale tail** is written — a steady cycle rewrites
just today's point; the window widens back when backfill fills earlier prices or
the events cache reloads. This keeps InfluxDB 3 Core from accumulating unbounded
Parquet files (issue #597).

| Type | Name | Description |
|------|------|-------------|
| Tag | `account` | Account id |
| Tag | `account_type` | Account type (PEA, CTO, …) |
| Tag | `account_currency` | Account currency |
| Field | `cash_balance` | Per-account cash ledger balance |
| Field | `holdings_value` | Σ(owned_quantity × price) over the account's symbols |
| Field | `total_value` | `cash_balance + holdings_value` |
| Field | `net_contributed` | Σ deposits − Σ withdrawals (fees excluded) |
| Field | `xirr` | Money-weighted return (annualized); latest point only, absent without an external flow |
| Field | `twr_index` | Time-weighted return, base 100 (per day) |
| Field | `gain_absolu` | Absolute gain (`value − contributions`); latest point only |

**Measurement**: `portfolio_totals` — the same 7 perf fields at the **global**
level, written with **no tag** (a synthetic account tag would double every
`SUM()`). Written only when all accounts share one currency (FX is out of scope).

Money-weighted performance (XIRR by home-grown bisection, TWR base 100) is
computed in `app/src/performance.py` — a pure module taking a `Timeline` and an
injected `price_at` callable (no InfluxDB/yfinance). External flows
(DEPOSIT/WITHDRAWAL/GRANT) are the contribution; internal flows (BUY/SELL/
DIVIDEND/fees) are the performance.

Prometheus mirrors these as `sb_account_*{account}` gauges plus `sb_account_info`
(labels `account_type`/`account_currency`) and global `sb_portfolio_*` gauges
(no `account` label). Price history for `holdings_value` is read via
`InfluxDBWriter.get_price_series(symbol)` — queried by `share_symbol` only, never
by `account` (a market price belongs to no account).

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please
