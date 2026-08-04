
# Stock Share Monitoring

Small app written in Python to monitor the stock shares you own. It uses Prometheus as TSDB and Yfinance to scrape the price in realtime.  

![](website/static/img/screenshot.png)

## Using SuiviBourse

Please visit the [documentation's website](https://pbrissaud.github.io/suivi-bourse/docs) !

## Getting Started

There are mutiple ways to run the app but **Docker Compose** is the easiest way to begin !

Note: Docker Compose launches a full environnement with a pre-configured Prometheus and Grafana 

### 1. Install Requirements
* Docker (>19.03.0)
* Docker-Compose 

### 2. Create your configuration
In the `docker-compose` folder, create your `.env` and config directory from the
shipped templates — these two are yours, no other file needs editing:

```bash
make init
```

It creates `.env` (with a freshly generated InfluxDB token) and `data/`, skipping
whatever already exists — re-running it never overwrites your configuration.

### 3. Modify config
Edit `data/config.yaml` with the current state of your portfolio, or visit the
[configuration documentation](https://pbrissaud.github.io/suivi-bourse/docs/configuration/overview)
to know more about writing a config file.

*Example Config:*
```yaml
---
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

To track transactions instead, drop your broker exports (`.csv` / `.xlsx`) into
`data/events/` — SuiviBourse detects them and switches to
[events mode](https://pbrissaud.github.io/suivi-bourse/docs/configuration/events-mode)
by itself.

### 4. Run the stack
Run the following command in the `docker-compose` folder :

```bash
docker compose up -d
```

### 5. Visit Grafana
Connect to Grafana (`http://localhost:3000`) with the following credentials:
* login:  `admin`
* password: `admin`
    
and go to dashboard **Stock share monitoring**

*NB:* please wait ~10m to see all the cells getting filled
