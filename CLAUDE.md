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
# Also requires INFLUXDB_TOKEN environment variable
cd app && INFLUXDB_TOKEN=your-token uv run python src/main.py

# Lint
cd app && uv run flake8 src/ --ignore=E501

# Run tests (unit + E2E, all network-mocked; no config or network required)
cd app && uv run pytest tests/            # add --cov=src for coverage
```

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
docker-compose up -d              # Full stack: app + InfluxDB + Grafana
docker-compose -f docker-compose.dev.yaml up -d  # Development mode

# Events mode
SB_CONFIG_MODE=events docker-compose -f docker-compose.dev.yaml up -d
```

## Architecture

**Main entry point**: `app/src/main.py`

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
3. Default: `manual`

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
Ingestion uses **file modification time (mtime)** to detect changes. If no files have changed, the cache is used and no reprocessing occurs.

#### Error Resilience
If ingestion fails (invalid event, file error), the **previous valid configuration is kept** and scraping continues normally. Errors are logged but don't crash the application.

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
| `SB_INGESTION_INTERVAL` | `300` | Event ingestion interval (seconds) |
| `SB_BACKFILL_INTERVAL` | `60` | Backfill check interval (seconds) |
| `SB_BACKFILL_DELAY` | `10` | Delay between yfinance requests (seconds) |
| `SB_BACKFILL_CHUNK_DAYS` | `365` | Days of history per backfill request |
| `SB_STALENESS_HORIZON` | `900` | Price-freshness liveness sonde horizon (seconds): during `REGULAR`, flag a symbol whose stored price stays frozen this long across consecutive polling cycles while the live quote moves (issue #628). Diagnostic only — never changes cadence/write gating/#617 backoff. `0` disables the sonde. |
| `SB_CONFIG_MODE` | `manual` | Configuration mode (`manual` or `events`) |
| `SB_PROMETHEUS_ENABLED` | `true` | Expose the legacy Prometheus `/metrics` endpoint |
| `SB_METRICS_PORT` | `8081` | Port for the Prometheus `/metrics` endpoint |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## Module Structure

```
app/src/
├── main.py                 # Entry point, ConfigurationManager, SuiviBourseMetrics
├── influxdb_writer.py      # InfluxDB 3 client wrapper (SQL queries)
├── prometheus_exporter.py  # Legacy Prometheus /metrics exporter (sb_* gauges)
├── schema.yaml             # Cerberus validation schema
└── events/                 # Events module
    ├── __init__.py
    ├── schemas.py          # Dataclasses: Event, EventType, ShareState
    ├── loader.py           # CSV/XLSX loading
    ├── validator.py        # Event validation
    ├── aggregator.py       # Aggregation logic
    └── watcher.py          # File watcher (watchdog)
```

## Prometheus Metrics (legacy)

For backward compatibility with pre-InfluxDB deployments, the app also exposes a
Prometheus `/metrics` endpoint (enabled by default, `SB_METRICS_PORT`=8081). It
runs in parallel with the InfluxDB writer and reflects only the current snapshot
per share (no historical backfill). Disable it with `SB_PROMETHEUS_ENABLED=false`.

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
