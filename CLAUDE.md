# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuiviBourse is a Python application that monitors stock shares using yfinance for real-time pricing and exposes metrics via Prometheus for visualization in Grafana.

## Commands

### Python App (in `app/` directory)

```bash
# Install dependencies
pip install -r app/requirements.txt

# Run the app locally (requires config at ~/.config/SuiviBourse/config.yaml)
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
```

## Architecture

**Main entry point**: `app/src/main.py`

The `SuiviBourseMetrics` class:
- Loads configuration from `~/.config/SuiviBourse/config.yaml` (validated against `app/src/schema.yaml`)
- Starts HTTP server on port 8081 (configurable via `SB_METRICS_PORT`)
- Runs a scheduled job every 120 seconds (configurable via `SB_SCRAPING_INTERVAL`)
- Fetches stock prices via yfinance with exponential backoff retry on rate limiting
- Exposes Prometheus gauges: `sb_share_price`, `sb_purchased_quantity`, `sb_purchased_price`, `sb_purchased_fee`, `sb_owned_quantity`, `sb_received_dividend`, `sb_share_info`

## Configuration

Config file structure (YAML):
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

Environment variables:
- `SB_METRICS_PORT`: HTTP server port (default: 8081)
- `SB_SCRAPING_INTERVAL`: Scraping interval in seconds (default: 120)
- `LOG_LEVEL`: Logging level (default: INFO)

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please
