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

```bash
cd website
yarn install
yarn start    # Development server
yarn build    # Production build
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

The application runs three independent scheduled jobs:
- **Scraping**: Fetches stock prices from Yahoo Finance (default: every 120s)
- **Ingestion**: Reloads portfolio events from files (default: every 300s)
- **Backfill**: Progressively fills historical price data (default: every 60s)

Writes to InfluxDB measurement `portfolio_metrics` with fields: `share_price`, `purchased_quantity`, `purchased_price`, `purchased_fee`, `owned_quantity`, `received_dividend`, `dividend_yield`, `pe_ratio`, `market_cap`

### Three Independent Schedules
```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│     SCRAPING        │  │     INGESTION       │  │     BACKFILL        │
│   (every 120s)      │  │   (every 300s)      │  │   (every 60s)       │
│                     │  │                     │  │                     │
│ • yfinance.Ticker() │  │ • Load events CSV   │  │ • Check gaps        │
│ • Current prices    │  │ • Recalculate state │  │ • yfinance.history()│
│ • Write InfluxDB    │  │ • Update shares[]   │  │ • Chunk 1 year/req  │
│                     │  │                     │  │ • Rate limit 10s    │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  ▼
                           ┌─────────────┐
                           │  InfluxDB 3 │
                           │  (database) │
                           └─────────────┘
```

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
| `BUY` | +purchase.quantity, +estate.quantity, recalculates weighted avg cost_price, +purchase.fee |
| `SELL` | -estate.quantity, +purchase.fee (sale fees are tracked) |
| `GRANT` | +estate.quantity only (free shares, no impact on purchase) |
| `DIVIDEND` | +estate.received_dividend |

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
| `SB_SCRAPING_INTERVAL` | `120` | Price scraping interval (seconds) |
| `SB_INGESTION_INTERVAL` | `300` | Event ingestion interval (seconds) |
| `SB_BACKFILL_INTERVAL` | `60` | Backfill check interval (seconds) |
| `SB_BACKFILL_DELAY` | `10` | Delay between yfinance requests (seconds) |
| `SB_BACKFILL_CHUNK_DAYS` | `365` | Days of history per backfill request |
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

Gauges (prefix `sb_`, labels `share_name`/`share_symbol`): `sb_share_price`,
`sb_purchased_quantity`, `sb_purchased_price`, `sb_purchased_fee`,
`sb_owned_quantity`, `sb_received_dividend`, `sb_dividend_yield`, `sb_pe_ratio`,
`sb_market_cap`, `sb_volume`, plus `sb_share_info` (value `1`, with extra labels
`share_currency`/`share_exchange`/`quote_type`).

## InfluxDB Data Model

**Measurement**: `portfolio_metrics`

| Type | Name | Description |
|------|------|-------------|
| Tag | `share_name` | Display name |
| Tag | `share_symbol` | Yahoo Finance ticker |
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

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please
