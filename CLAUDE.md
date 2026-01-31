# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuiviBourse is a Python application that monitors stock shares using yfinance for real-time pricing and exposes metrics via Prometheus for visualization in Grafana.

## Commands

### Python App (in `app/` directory)

```bash
# Install dependencies
pip install -r app/requirements.txt

# Run the app locally (requires config at ~/.config/SuiviBourse/config.yaml or events/)
python app/src/main.py

# Lint
flake8 app/src/ --ignore=E501

# Run E2E tests (fetches real stock data, requires config file)
python app/src/testing.py
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
docker-compose up -d              # Full stack: app + Prometheus + Grafana
docker-compose -f docker-compose.dev.yaml up -d  # Development mode

# Events mode
SB_CONFIG_MODE=events docker-compose -f docker-compose.dev.yaml up -d
```

## Architecture

**Main entry point**: `app/src/main.py`

The application runs two independent scheduled jobs:
- **Scraping**: Fetches stock prices from Yahoo Finance (default: every 120s)
- **Ingestion**: Reloads portfolio events from files (default: every 300s)

Exposes Prometheus gauges: `sb_share_price`, `sb_purchased_quantity`, `sb_purchased_price`, `sb_purchased_fee`, `sb_owned_quantity`, `sb_received_dividend`, `sb_share_info`, `sb_dividend_yield`, `sb_pe_ratio`, `sb_market_cap`

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

#### Two Independent Schedules
```
┌─────────────────────┐     ┌─────────────────────┐
│     INGESTION       │     │      SCRAPING       │
│  (every 300s)       │     │   (every 120s)      │
│                     │     │                     │
│  • Load events      │     │  • Fetch prices     │
│  • Check cache      │     │  • Update metrics   │
│  • Validate         │     │                     │
│  • Aggregate        │     │                     │
└─────────────────────┘     └─────────────────────┘
         │                           │
         └───── Independent ─────────┘
```

An ingestion error **never blocks** price scraping.

---

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SB_METRICS_PORT` | `8081` | HTTP server port for Prometheus metrics |
| `SB_SCRAPING_INTERVAL` | `120` | Price scraping interval (seconds) |
| `SB_INGESTION_INTERVAL` | `300` | Event ingestion interval (seconds) |
| `SB_CONFIG_MODE` | `manual` | Configuration mode (`manual` or `events`) |
| `LOG_LEVEL` | `INFO` | Logging level |

---

## Module Structure

```
app/src/
├── main.py                 # Entry point, ConfigurationManager, SuiviBourseMetrics
├── schema.yaml             # Cerberus validation schema
└── events/                 # Events module
    ├── __init__.py
    ├── schemas.py          # Dataclasses: Event, EventType, ShareState
    ├── loader.py           # CSV/XLSX loading
    ├── validator.py        # Event validation
    ├── aggregator.py       # Aggregation logic
    └── watcher.py          # File watcher (watchdog)
```

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please
