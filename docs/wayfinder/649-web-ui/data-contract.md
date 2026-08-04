# The data contract behind the four pages

> Asset for [Inventory the data contract behind the four pages](https://github.com/pbrissaud/suivi-bourse/issues/650),
> a ticket of the map [First-party web UI — a playable prototype to judge against Grafana](https://github.com/pbrissaud/suivi-bourse/issues/649).

The two provisioned Grafana dashboards are the de-facto spec of the read side.
This document extracts every query they run, maps it onto the measurements /
fields / tags it touches, inventories what `app/src/influxdb_writer.py` already
exposes, and marks each panel **already served** / **served with a tweak** /
**needs a new query**.

**Headline:** of the **30 distinct queries** the two dashboards run (26 panel
targets + 4 template-variable queries), **0 are served as-is** and **2 are
served with a tweak**. The read surface of `influxdb_writer.py` was built for
the scheduler's own needs (backfill anchors, a liveness sonde), not for a UI.
The good news is that those 30 queries collapse into **5 query primitives** —
that, not 30 endpoints, is the shape of the for-keeps API layer.

---

## 1. The read surface that exists today

`app/src/influxdb_writer.py` (592 lines) is overwhelmingly a *writer*. Its
entire read surface is five methods, each built for one internal caller:

| Method | Signature | Returns | Built for | Scope |
|---|---|---|---|---|
| `get_oldest_timestamp` | `(share_symbol, account=None)` | `datetime \| None` | Backward backfill anchor | symbol + optional account |
| `get_newest_timestamp` | `(share_symbol, account=None)` | `datetime \| None` | Forward gap-fill anchor (#627) | symbol + optional account, `share_price IS NOT NULL` |
| `get_newest_price` | `(share_symbol, account=None)` | `float \| None` | Price-freshness sonde (#628) | idem |
| `has_data_for_date` | `(share_symbol, date)` | `bool` | Backfill coverage probe | symbol only, whole-day window |
| `get_price_series` | `(share_symbol)` | `{date: close}` | `holdings_value` in the perf job | **symbol only, never account** (`influxdb_writer.py:482-508`) |

Three shared helpers matter to the new layer:

- `_symbol_account_where()` (`influxdb_writer.py:283-299`) — the single place
  the `COALESCE(account, 'default')` rule and the `'` → `''` SQL escaping live.
  Every new read query should route through the same helper rather than
  re-deriving the rule.
- `_is_valid_number()` — NaN is a float that passes `is not None`; the writer
  skips those fields entirely, which is *why* every dashboard query carries an
  `IS NOT NULL` filter.
- `_utc_z()` — timestamps must be emitted as bare-UTC `...Z`; `isoformat()`
  alone yields `+00:00Z`, which InfluxDB rejects.

There is **no** query builder, no time-window parameter, no multi-series read,
no tag-discovery read. All of that is new.

---

## 2. Dashboard A — `Stock share monitoring` (`suivi_bourse.json`)

`uid=O9_AegInk`, default window `now-7d`, no auto-refresh. 17 panels: one row
repeated over `$share`, 3 portfolio-wide stats above it, 13 per-share panels
inside.

### 2.1 Portfolio-wide stats (above the repeated row)

All three share one shape: bucket to 5 minutes, average per
`(bucket, share_symbol, COALESCE(account,'default'))`, then `SUM` per bucket —
i.e. a **series**, which the stat panel reduces client-side with `lastNotNull`.

| # | Panel | Fields | Expression | Unit | Verdict |
|---|---|---|---|---|---|
| 76 | Total Investment | `purchased_price`, `purchased_quantity` | `SUM(AVG(pp × pq))` | `short` | needs a new query |
| 87 | Total Valuation | `share_price`, `owned_quantity` | `SUM(AVG(sp × oq))` | `short` | needs a new query |
| 88 | Total Performance | `share_price`, `owned_quantity`, `received_dividend`, `purchased_price`, `purchased_quantity` | `(Σval + Σdiv − Σinv) / NULLIF(Σinv, 0)` | `percentunit` | needs a new query |

Panel 76 verbatim, as the reference for the shape:

```sql
SELECT bucket as time, SUM(investment) as value FROM (
  SELECT DATE_BIN(INTERVAL '5 minutes', time) as bucket,
         share_symbol, COALESCE(account, 'default') as account,
         AVG(purchased_price * purchased_quantity) as investment
  FROM portfolio_metrics
  WHERE $__timeFilter(time)
    AND purchased_price IS NOT NULL AND purchased_quantity IS NOT NULL
  GROUP BY bucket, share_symbol, COALESCE(account, 'default')
) GROUP BY bucket ORDER BY bucket
```

Note what the inner `GROUP BY` is doing: it de-duplicates the *many* points a
symbol writes inside a 5-minute bucket (the `REGULAR` cadence is 120 s, so ~2–3
points per bucket) **per account**, so a share held in two accounts contributes
twice — correctly — while the same share polled three times contributes once.
Any API that flattens this to a plain `SUM` over rows will over-count by the
poll rate.

### 2.2 Per-share panels (inside the row repeated over `$share`)

Every one of these filters on **`share_name = '${share}'`** — the display name
tag, *not* `share_symbol`.

| # | Panel | Type | Measurement / fields | Shape | Verdict |
|---|---|---|---|---|---|
| 4 | Share price evolution | candlestick | `price_open/high/low`, `share_price` | raw series, `ORDER BY time` | **served with a tweak** — see §2.3 |
| 100 | Volume | timeseries | `volume` | `MAX(volume)` per `DATE_BIN(1 hour)` | needs a new query |
| 8 | Purchased quantity | stat | `purchased_quantity` | latest-per-account → `SUM` | needs a new query |
| 9 | Cost price | stat | `purchased_price`, `purchased_quantity` | latest-per-account → `SUM(pp×pq)/NULLIF(SUM(pq),0)` | needs a new query |
| 10 | Fees | stat | `purchased_fee` | latest-per-account → `SUM` | needs a new query |
| 11 | Actual price | stat | `share_price` | newest non-null point | **served with a tweak** — see §2.3 |
| 12 | Unitary Gain / Loss | stat | `share_price`, `purchased_price`, `purchased_quantity` | latest-per-account → `MAX(sp) − weighted cost` | needs a new query |
| 6 | Owned quantity | stat | `owned_quantity` | latest-per-account → `SUM` | needs a new query |
| 13 | Received dividend | stat | `received_dividend` | latest-per-account → `SUM` | needs a new query |
| 14 | Total gain / loss | stat | `owned_quantity`, `share_price`, `received_dividend`, `purchased_quantity`, `purchased_price`, `purchased_fee` | latest-per-account → `Σ(oq×sp) + Σrd − Σ(pq×pp) − Σpf` | needs a new query |
| 17 | Dividend Yield | stat | `dividend_yield` | newest non-null in a **hardcoded 30-day** window | needs a new query |
| 18 | P/E Ratio | stat | `pe_ratio` | idem | needs a new query |
| 19 | Market Cap | stat | `market_cap` | idem | needs a new query |

The **latest-per-account** shape (8 panels) is the workhorse of the whole
dashboard:

```sql
SELECT MAX(time) as time, SUM(value) as value FROM (
  SELECT time, owned_quantity as value,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(account, 'default') ORDER BY time DESC) as rn
  FROM portfolio_metrics
  WHERE share_name = '${share}' AND $__timeFilter(time)
    AND owned_quantity IS NOT NULL
) WHERE rn = 1
```

Take the newest row **per account**, *then* aggregate. Panels 9 and 12 vary the
aggregate (quantity-weighted mean rather than sum), panel 14 combines six
fields off the same `rn = 1` rows. One primitive, six call sites.

### 2.3 The two panels that are partly served today

- **Panel 11 (Actual price)** ≈ `get_newest_price(share_symbol)`. Same
  `IS NOT NULL ORDER BY time DESC LIMIT 1`. Three tweaks: it keys on
  `share_symbol` where the panel keys on `share_name`; it returns a bare float
  where the panel wants `(time, value)`; and it has no time-window parameter
  where the panel is bounded by `$__timeFilter`.
- **Panel 4 (Share price evolution)** ≈ `get_price_series(share_symbol)` — but
  only for a *line* chart. `get_price_series` collapses to one close per
  calendar day (`ROW_NUMBER() … PARTITION BY date_trunc('day', time)`), which
  discards the intraday points and all three OHLC fields. It also takes no
  window, so it always returns the full history. It serves a daily line; it
  does not serve the candlestick.

### 2.4 Template variables

| Variable | Query | Multi / All | Used by any panel? |
|---|---|---|---|
| `share` | `SELECT DISTINCT share_name … WHERE time >= NOW() - INTERVAL '30 days' ORDER BY share_name` | yes / yes | **yes** — repeats the row, filters every per-share panel |
| `quote_type` | `SELECT DISTINCT quote_type … 30 days … IS NOT NULL` | no / yes | **no — dead** |
| `exchange` | `SELECT DISTINCT share_exchange … 30 days … IS NOT NULL` | no / yes | **no — dead** |

`quote_type` and `exchange` are declared, queried on every dashboard load, and
referenced by **zero** panel SQL (verified by grepping every `rawSql` in the
file). The map's baseline note — "templated by `share`/`quote_type`/`exchange`"
— describes the picker bar, not the behaviour: only `share` filters anything.
The new UI inherits **one** working facet, and gets to decide whether the other
two become real filters.

---

## 3. Dashboard B — `SuiviBourse - Accounts` (`accounts_performance.json`)

`uid=suivibourse-accounts`, default window `now-90d`, refresh 5 m. 13 panels:
three rows (one repeated over `$account`) holding 10 panels. All units
hardcoded `currencyEUR`.

| # | Panel | Measurement | Fields | Shape | Verdict |
|---|---|---|---|---|---|
| 11 | Total value (global) | `portfolio_totals` | `total_value` | newest non-null | needs a new query |
| 12 | Net contributed (global) | `portfolio_totals` | `net_contributed` | newest non-null | needs a new query |
| 13 | XIRR (global) | `portfolio_totals` | `xirr` | newest non-null | needs a new query |
| 14 | Absolute gain (global) | `portfolio_totals` | `gain_absolu` | newest non-null | needs a new query |
| 15 | TWR index — global | `portfolio_totals` | `twr_index` | raw series, `spanNulls: true` | needs a new query |
| 20 | TWR index by account | `account_metrics` | `twr_index` + `account` tag | **multi-series**, one line per account | needs a new query |
| 2 | Cash balance | `account_metrics` | `cash_balance` | newest non-null for `account = '$account'` | needs a new query |
| 4 | XIRR | `account_metrics` | `xirr` | idem | needs a new query |
| 5 | Absolute gain | `account_metrics` | `gain_absolu` | idem | needs a new query |
| 3 | Cash & value over time | `account_metrics` | `cash_balance`, `holdings_value`, `net_contributed` | raw 3-field series, `spanNulls: true` | needs a new query |

Template variable `account`: `SELECT DISTINCT account AS __text, account AS
__value FROM account_metrics ORDER BY account` — note **no time filter**, and
note the source: `account_metrics`, which is written **only for opt-in
accounts**. An account that holds shares but has not opted into performance
never appears in this dashboard at all.

Two fields are written but shown nowhere: **`total_value` per account** (only
the global one is displayed) and the `account_type` / `account_currency` tags,
which no panel reads — the currency is a hardcoded `currencyEUR` unit instead.

Panel 20 is the only **multi-series** query in either dashboard: it selects the
`account` tag alongside the value and lets Grafana split. Every other query
returns a single series. That is a distinct API shape.

---

## 4. The 30 queries collapse to 5 primitives

This is the actionable output. The for-keeps layer needs these, not 30
endpoints:

| # | Primitive | Signature sketch | Serves |
|---|---|---|---|
| **P1** | `latest_per_account(symbol, fields[], window)` | rows: one newest point per account, chosen fields | 8 share stats (6, 8, 9, 10, 12, 13, 14) — caller aggregates |
| **P2** | `latest_scalar(measurement, field, filters, window)` | `(time, value) \| None` | 11, 17, 18, 19, 2, 4, 5, 11g, 12g, 13g, 14g — **11 panels** |
| **P3** | `raw_series(measurement, fields[], filters, window)` | rows over time | 4, 3, 15, 20 (20 adds a group-by tag) |
| **P4** | `bucketed_series(expr, interval, group_by[], window)` | rows over time | 76, 87, 88, 100 |
| **P5** | `distinct_tag_values(measurement, tag, window)` | `str[]` | the 4 template-variable queries |

P2 alone covers a third of the dashboards. P1 is the one with real logic in it
(the `ROW_NUMBER() … PARTITION BY COALESCE(account,'default')` window) and is
the primitive most worth getting right and testing — the aggregation on top of
it is trivial arithmetic best done in the API layer, not in SQL, so the UI can
show the per-account breakdown that Grafana throws away.

---

## 5. Traps the new API must keep honouring

The five named in the ticket, confirmed against the source, plus nine more the
inventory surfaced.

**Confirmed from the ticket:**

1. **`COALESCE(account, 'default')`** — pre-v4.1 points carry no `account` tag.
   Every share-level aggregate in dashboard A partitions on the COALESCE, never
   on the bare tag. `_symbol_account_where()` (`influxdb_writer.py:283-299`) is
   the canonical implementation; new queries should reuse it. Note the
   deliberate exception: `get_price_series` queries by symbol **only** — a
   market price belongs to no account, and filtering on account would silently
   truncate history (`influxdb_writer.py:482-491`).
2. **`account_metrics` is daily, midnight-stamped, idempotently upserted, with
   only the stale tail rewritten** (#597). Consequence for a UI: "latest" for an
   account means "latest *day*", and **today's point mutates in place** through
   the day. Any client-side cache keyed on `(account, day)` must expect the
   value at today's key to change; caching it as immutable is wrong.
3. **`xirr` and `gain_absolu` are latest-point-only; `xirr` is absent entirely
   without an external flow.** Every account panel filters `IS NOT NULL` then
   `LIMIT 1`. A missing XIRR is a **normal state**, not an error — the UI needs
   an empty state for it (a fresh events file with no DEPOSIT has no XIRR at
   all), and must not render `null` as `0`.
4. **`portfolio_totals` carries no tag on purpose.** Never derive the global
   figures by `SUM`-ing `account_metrics` — read the untagged measurement.
   Corollary from `CLAUDE.md`: it is written **only when all accounts share one
   currency**. A multi-currency portfolio has *no* `portfolio_totals` series at
   all, and the four global stats plus the global TWR chart go blank.
5. **Non-trading-day gaps are by design** (#606). The read layer must return the
   gap and let the presentation decide. Note the two dashboards already disagree:
   the share panels leave `spanNulls` at its default (gaps visible), while all
   four account/portfolio timeseries set `spanNulls: true` (gaps bridged). The
   API returns holes; the chart config bridges them.

**Surfaced by this inventory:**

6. **"Latest" is window-scoped.** `$__timeFilter(time)` wraps even the stats
   that read as "the current value". Point the shares dashboard at a window
   containing no data and every stat goes blank rather than falling back to the
   last known value. The API has to make this an explicit choice, not an
   accident.
7. **The slow-moving fields escape that window on purpose.** Panels 17/18/19
   (dividend yield, P/E, market cap) ignore `$__timeFilter` and hardcode
   `time >= NOW() - INTERVAL '30 days'`, because yfinance only supplies those
   fundamentals intermittently and a 7-day window would show nothing. The three
   template-variable queries use the same 30-day lookback. Any "latest scalar"
   primitive needs a per-field lookback, not one global window.
8. **Discovery is 30-day-scoped, and keyed on the display name.** The `share`
   picker is `DISTINCT share_name` over the last 30 days: a share sold and
   removed more than 30 days ago silently vanishes from the dashboard.
9. **Panels key on `share_name`, the writer's identity is `share_symbol`.**
   Every per-share panel filters `share_name = '${share}'`. Renaming a share in
   the events file therefore splits its dashboard history in two, even though
   the symbol — and the actual series — is continuous. **Recommendation: the new
   API keys on `share_symbol` and carries `share_name` as a display attribute.**
10. **OHLC is degenerate on live points.** `write_metrics` sets
    `price_open = price_high = price_low = share_price`
    (`influxdb_writer.py:160-165`); only the backfill writes real bars, from
    yfinance's `Open`/`High`/`Low` (`main.py:766-768`). A candlestick therefore
    shows real bodies for history and a column of dojis for the current session.
    A line chart is the honest default for the live part.
11. **`quote_type` and `exchange` are dead variables** (§2.4). One working facet
    is inherited, not three.
12. **Account discovery runs off `account_metrics`**, so it lists only
    performance-opt-in accounts. The shares side (`portfolio_metrics`) knows
    about *every* account. Two different account lists exist in the data; the UI
    must pick one deliberately.
13. **Divide guards are everywhere** — `NULLIF(SUM(pq), 0)`, `NULLIF(SUM(investment), 0)`.
    An empty or fully-sold position must yield `null`, not a division error and
    not `0`.
14. **`share_currency` is a tag nobody reads.** Dashboard A formats everything
    as unit-less `short`; dashboard B hardcodes `currencyEUR`. A UI that wants
    to render `1 234,56 €` has to start reading a tag the baseline ignores — and
    will immediately hit the multi-currency question of trap 4.

---

## 6. The data page reads something else entirely

Nothing on the data page comes from InfluxDB. Its read side is the **config
directory** (`SB_CONFIG_DIR`, mounted at `/home/appuser/.config/SuiviBourse`):

| Source | Shape | Authority |
|---|---|---|
| `settings.yaml` → `mode`, `events.source`, `events.watch` | mode resolution (env > `settings.yaml` > auto-detect > `manual`) | `main.py:251-295` |
| `settings.yaml` → `accounts[]` | `id`, `type`, `currency` (all required), `label` (optional) | `ACCOUNTS_SCHEMA`, `main.py:49-64` |
| `config.yaml` (manual mode) | `shares[]`: `name`, `symbol`, `account?`, `purchase{quantity,fee,cost_price}`, `estate{quantity,received_dividend}` | `app/src/schema.yaml` |
| `events/*.csv`, `events/*.xlsx` | required `date`, `event_type`; optional `symbol`, `name`, `quantity`, `unit_price`, `fee`, `amount`, `notes`, `account` | `EventLoader`, `events/loader.py:24-25` |

And the **derived** view the app already computes in memory, which the page will
want to show next to the raw events: `ShareState`
(`name`/`symbol`/`account`/`purchase`/`estate`, with `to_dict()` already
emitting the config-shaped dict — `events/schemas.py:74-97`) and `CashState`
(`cash_balance`, `net_contributed`).

One constraint lands here rather than on the read side and belongs to
[How does the UI write to the config directory safely?](https://github.com/pbrissaud/suivi-bourse/issues/653):
`docker-compose.yaml` mounts the config directory **read-only**. As it stands
today the UI cannot write a single byte of it.

---

## 7. Verdict tally

| Verdict | Count | Which |
|---|---|---|
| Already served as-is | **0** | — |
| Served with a tweak | **2** | Actual price (`get_newest_price`), Share price evolution as a *line* (`get_price_series`) |
| Needs a new query | **28** | everything else — 24 panel targets + 4 variable queries |

---

## 8. Questions this hands onward

Read-side decisions this inventory surfaces but does not resolve — for
[What does each of the four pages actually show?](https://github.com/pbrissaud/suivi-bourse/issues/652)
unless noted:

- Is "current value" window-scoped like Grafana's, or absolute-latest? (traps 6, 7)
- Does the shares page key on symbol or on display name? (trap 9 — recommendation: symbol)
- Candlestick or line, given live OHLC is degenerate? (trap 10)
- Do `quote_type` / `exchange` become real filters, or disappear? (trap 11)
- Which account list does the accounts page use — perf-opt-in or all held? (trap 12)
- Does the UI surface the per-account breakdown that P1 computes and Grafana discards?
- What do the global figures show for a multi-currency portfolio, where
  `portfolio_totals` is simply absent? (trap 4) — **this one is new fog**: it is
  a product question about a state the baseline never handles, not a page-content
  detail.
