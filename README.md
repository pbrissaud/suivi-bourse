
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

### 3. Describe your portfolio
A portfolio is a ledger of dated events and nothing else: drop your broker
exports (`.csv` / `.xlsx`) into `data/events/` and SuiviBourse loads them.
There is no mode to pick and no static portfolio file.

*Example event file* (see also `docker-compose/examples/events-example.csv`):
```csv
date,event_type,symbol,name,quantity,unit_price,fee,amount,notes
2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase
2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,8.50,Q1 2024
```

Options — where events are read from, whether a file change reloads immediately,
and the opt-in `accounts:` block — live in `data/settings.yaml`. The
[documentation](https://pbrissaud.github.io/suivi-bourse/docs) has the details.

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
