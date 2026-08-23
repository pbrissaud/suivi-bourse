# app/ — the application

Python 3, Flask + APScheduler + DuckDB, served by gunicorn. The commands are in
the root `CLAUDE.md`; the *why* of each choice is in `docs/adr/`, then in
`docs/v5-decisions.md`.

## The boot

`src/gunicorn.conf.py` is the container `ENTRYPOINT` **and** the boot sequence,
split in two by the `fork()`:

- **master, under `preload_app`** — `main.build_runtime()`: the store (opened, DDL
  applied, seeded, **closed again**), `ConfigurationManager`, the first
  publication of the config snapshot, the Prometheus registry. Pure work only: no
  thread, no socket, no fd survives a fork. A failure here is `sys.exit(1)`.
- **`post_fork`** — `main.start_runtime()`: the store connection (its own), the
  `BackgroundScheduler`, the watcher, the first `ingest()`. A failure here
  **re-raises**: gunicorn reads an exception as `WORKER_BOOT_ERROR` and halts the
  arbiter, where an exit code would be respawned forever.
- **`worker_exit`** — `main.shutdown_runtime()`, closing the store last.

`workers = 1` is a property of the design, not a tuning default: N workers would
be N schedulers. Concurrency comes from `threads`. One master, **two sockets, one
application**: `gunicorn.conf.py` appends `SB_METRICS_PORT` to `bind`, which
takes a list — so `/metrics` answers on `SB_WEB_PORT` too, and the whole API,
writes included (`POST /api/events`, `PUT /api/settings`, `DELETE
/api/store/orphans`), answers on `SB_METRICS_PORT` too. Neither port is a
filtered view of the other, and "publish only the metrics port" hides nothing:
whoever reaches a socket reaches the whole app. The second socket is bound only
when `/metrics` is on and the two ports differ.

## The store

`store.py` owns the file: the connection, the DDL of the twelve tables, the seed.

- **One thread inside the connection at a time**, reentrant lock;
  `Store.transaction()` holds it from `BEGIN` to `COMMIT` (a transaction on one
  connection is visible to every thread using it).
- **DDL with `IF NOT EXISTS`, no migration machinery.** A new column would exist
  on no store created before it: derive at read time instead.
- **Every table has exactly one writer** — the configuration path owns
  `import_source`/`account`/`symbol`/`event`/`setting`/`advisory`, the ingestion
  `position`/`account_state`, the market `symbol_quote`/`price_point`, the perf
  job `account_metrics`/`portfolio_totals`.
- **`price_point` carries no primary key and no foreign key** (ADR-0007): a DuckDB
  ART index is a second copy of the data in resident memory (+563 MB on a 319 MB
  base). Uniqueness moves to the writers.
- **A NaN is not a number** (`store.finite`), neither stored nor served — JSON has
  no NaN.
- **Two kinds of time, never mixed**: `TIMESTAMPTZ` in UTC for an observed
  instant, `DATE` for a calendar day. A bound on a `DATE` column is **cast**, or
  DuckDB widens it to midnight and the first day of every window is dropped.
- **The seed has two halves**: the `default` account row is written at creation
  only and never removed; the `setting` defaults are inserted at every start with
  `ON CONFLICT DO NOTHING`. `base_currency` has no default and is therefore never
  seeded.

## The jobs

```text
SCRAPE (per symbol)    INGESTION (not a job)    BACKFILL (dial)     PERFORMANCE (PERF_TICK)
• yfinance.Ticker()    • boot / watcher /       • ladder collapse   • replays the Timeline
• marketState→cadence    a write — never        • backward pass     • full recompute
• REGULAR: poll+write    a timer                • forward pass      • upsert + bounded prune
• closed: sleep to open                         • lateral pass
```

- **Scrape** — one self-rescheduling job per **held** symbol, a fresh 0–30 s
  jitter at every arming (anti-herd), `misfire_grace_time=None`. A closed market
  sleeps to the next open; a dead ticker backs off at `regular_interval ×
  2^(n−3)`. A freshness sonde (`sb_price_staleness`) watches for a writer that
  persists frozen values — purely diagnostic.
- **Ingestion** — armed by the boot, by the drop-folder watcher, or by a write
  through the API. Each run reconciles the per-symbol scrape jobs.
- **Backfill** — an interval job driven by the replay rather than by current
  holdings: the symbol set is the union over the *whole* timeline, each symbol
  carrying its own holding window (ADR-0009). Three independent passes plus the
  retention ladder's collapse (ADR-0010: as written under a year, hourly from one
  to two years, daily beyond).
- **Performance** — an **integral and unconditional** recompute every tick
  (ADR-0011: the two tables are a *cache*, a pure function of the ledger, the
  price points and the declared accounts). A block `UPSERT` plus a bounded prune,
  never a `DELETE`+`INSERT`. The series is **dense over calendar days**. It also
  runs **on every write through `/api`**, inside `replay_after_write` and in the
  same shape (ADR-0032). The tick is what is left for the rest: a quote landing,
  a backfill chunk — **and a file dropped in `/import`**, whose watcher is wired
  straight to `ingest` and therefore still leaves the curves up to one
  `PERF_TICK` behind. That last one is a gap rather than a design: ADR-0032
  removes the drop folder, so it closes with the mount rather than by a second
  spelling of the seam. **One pass at a time** (`_perf_lock`, reentrant): the
  pass computes outside the writers' mutex and the prune is bounded by its *own*
  spans, so a stale pass committing last would delete the days a fresh one just
  wrote. The lock order is `_perf_lock` then `writing()`, never the reverse.

## The figures

The gain has **four terms** and their sum is an identity (ADR-0018):
`Σ latent + Σ realised + Σ dividends + Σ transfer fees == gain_absolu`, closed
positions included.

| Figure | Formula | Defined when |
|---|---|---|
| Latent gain | `holdings_value − cost_basis` | position open |
| Realised gain | Σ sales `(net proceeds − basis removed)` | from the first sale, **permanently** |
| Dividends | `position.received_dividend` | always |

> **The rule a contributor will break**: the realised gain is a *decomposition* of
> the absolute gain, never a term added to it. `tests/test_performance.py` pins
> the worked example **and** the forbidden operation.

A position is **a quantity and a cost basis stored as an amount**; the unit price
(the *PMP*) is derived by division (`events.schemas.unit_cost`), never stored.
There is **no `closed` flag**: the predicate is `quantity == 0` (ADR-0003).

**A position with no price is carried at its cost** (`carrying.py`, ADR-0004), on
two conditions: no quote was observed **and** the symbol's backfill is terminal. A
quote is a number **and** a unit: with no nameable currency there is no quote.

## Configuration

### Environment variables — six names, no seventh

What is left in the environment is exactly what the process must know **before**
it can open the store (ADR-0014). `boot_env.py` says them once.

| Variable | Default | Role |
|---|---|---|
| `SB_STORE_DIR` | `/data` | Directory holding `suivi-bourse.duckdb` |
| `SB_IMPORT_DIR` | `/import` | The drop folder — optional |
| `SB_WEB_PORT` | `8080` | First socket the one app is bound to (API, `/health`, and `/metrics` too) |
| `SB_PROMETHEUS_ENABLED` | `true` | Mounts `/metrics`; `false` leaves the second socket unbound |
| `SB_METRICS_PORT` | `8081` | Second socket the **same** app is bound to — it serves the API as well |
| `LOG_LEVEL` | `INFO` | Logging level (here, since the likeliest failure is the store) |

They are **directories, never files**; the defaults describe the container;
**blank counts as unset** (compose renders an undefined substitution as an empty
string). Every retired `SB_*`/`INFLUXDB_*` variable still set is named at start-up
in **one grouped notice**, and that list is *computed*, never written down.

### The dials — the store is the only source

No dial requires a restart. `settings_registry.py` is the single list (key, type,
default, bounds, effect); `PUT /api/settings` is the only writer, validates the
whole body and **writes nothing at all** when it refuses.

| Dial | Default | Bounds | Effect |
|---|---|---|---|
| `regular_interval` | `120` | 10–86400 | re-arms the scrape jobs whose market is open now |
| `backfill_interval` | `60` | 10–86400 | reschedules the backfill job |
| `backfill_delay` | `10` | 0–3600 | read by the next cycle |
| `backfill_chunk_days` | `365` | 1–3650 | read by the next cycle |
| `staleness_horizon` | `900` | 0–86400 | read by the next cycle; `0` disables the sonde |
| `base_currency` | *none* | ISO-4217 | the reporting currency — **retroactive** |

Only what actually changed is re-armed (`reschedule_job` recomputes from *now*).

### The ledger (CSV/XLSX)

A file reaches the app **two ways, and that is deliberate for two tickets**
(ADR-0032): `POST /api/events/import` takes one in a `multipart/form-data` body
and writes its rows through `entries` — no source row, no provenance, nothing to
revoke — and the drop folder goes on importing whatever is in it until #815
removes the mount. A file is an **accounts source** or an **event source**
according to its *header*, never its name: `id` + `type` with no `event_type`
makes it a declaration. No filename has a special meaning — except on the
upload, where a v4 `config.yaml`/`settings.yaml` is recognised **by its name**
and refused with the migration page, having no header to read.

```csv
date,event_type,symbol,name,quantity,unit_price,fee,amount,notes
2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase
2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,8.50,Q1 2024
2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Stock grant
2024-09-15,SELL,AAPL,Apple Inc,3,180.00,2.00,,Partial sale
```

| Type | Effect |
|---|---|
| `BUY` | +quantity, +basis (`qty×price + fee`), −cash |
| `SELL` | −quantity, −basis (`qty × PMP`), +realised gain, +cash |
| `GRANT` | +quantity; +basis `qty×unit_price` **if the row declares one**; cash-neutral |
| `DIVIDEND` | +received dividend, +cash (`amount − fee`) |
| `DEPOSIT` | +cash, +net contributed (`amount` required, no security) |
| `WITHDRAWAL` | −cash, −net contributed |

Optional columns worth knowing: `account` (the id of a declared account — blank
means `default` **until something is declared**, and is an error afterwards), and
`base_currency` (a fact about the *whole* file, written by the export and read on
the way in).

Events are **sorted by date** before processing, whatever their order in the
files. Accounts sources are imported **before** event sources. An event file
naming an undeclared account is not imported at all. An account is **undeletable
while an event names it** (`409`, the cascade is refused rather than performed).

If ingestion fails, **the previous valid configuration is kept** and scraping
continues: a snapshot is published only once complete and validated.

The upload's own refusals are all `422` and **none of them writes**: an
unrecognised header (naming the column), an undeclared account (naming the
account), a v4 file (naming it, with the migration page), a declaration of
accounts (accounts are born in the app — ADR-0034), a format it does not read,
and a `base_currency` this install can no longer take — that last one being
`ledger.currency_to_adopt`, asked by **both** doors so they cannot come to
disagree about the unit a ledger is recorded in. Past `uploads.MAX_UPLOAD_BYTES`
it is `413`, and that bound is held in three places because each sees what the
others cannot: the declared `Content-Length`, Flask's `MAX_CONTENT_LENGTH` (on
the *envelope*, `MAX_BODY_BYTES` — the only one that stops bytes in flight), and
the file's own size when it is read. What comes back on success is
a **receipt** — rows written, the period covered, the accounts and securities
touched — and the same object answers #813's preview before anything is written.

## Prometheus

`/metrics` is a first-class product (ADR-0012): it is what makes the app usable
with no interface. Prefix `sb_`, labels `share_name`/`share_symbol`/`account`.

**Never a gauge whose unit depends on a setting**: `sb_share_price` publishes the
converted price, `sb_share_price_native` the raw quote, `sb_fx_rate` the rate
between them. While the reporting currency is unanswered the converted one and the
rate are **absent** (not zero — a zero is a figure every `sum()` counts), and so
is every `sb_account_*` / `sb_portfolio_*` series.

`sb_store_ephemeral` (no label) is `1` when the store lives in the container's
writable layer, `0` on a mount that outlives it, and **absent** while the mount is
unobservable: it is the only notice a headless install gets about the state of its
*installation*.

A gauge whose field goes away is **retracted**, never left at its last value: a
scraper cannot tell a stale figure from a current one.

## Module map

```
src/
├── gunicorn.conf.py    # entrypoint AND boot sequence
├── main.py             # Runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── store.py            # the connection, the DDL of the twelve tables, the seed
├── boot_env.py         # pure: the six boot variables, the computed list of the quiet ones
├── mounts.py           # pure: mountinfo + a path → persistent / ephemeral / unknown
├── boot_conditions.py  # pure: the three start-up lines, said once each
├── scheduling.py       # pure: cadence, market context, back-off, pool sizing,
│                       #       the fetch windows and Yahoo's hourly ceiling
├── performance.py      # pure: XIRR/TWR, the sliding horizon, the per-field rule
├── carrying.py         # pure: the carrying price, the holding window, the backward anchor
├── retention.py        # pure: the three rungs, the two walls
├── fx.py               # pure: the reporting currency, GBp, one TTL cache per pair
├── quotes.py           # symbol_quote + price_point, the `latest` rule, the lateral repair
├── perf_series.py      # account_metrics + portfolio_totals, block upsert + bounded prune
├── positions.py        # the replay's two tables — position/account_state
├── ledger.py           # the drop folder's import: provenance and revocation
├── uploads.py          # the gesture: one file in, read once, refused by name
├── entries.py          # the row's four gestures (source_id NULL only)
├── accounts.py         # the account table, the declaration, the refusals
├── reassignment.py     # the named, bounded exception: the unassigned events
├── settings_registry.py / settings.py   # the one list of dials, and the write path
├── advisories.py       # the five advisories: predicate in code, the table holds the ack
├── runtime_state.py / runtime_view.py   # the jobs' last-pass records, and how they read
├── store_reads.py / portfolio_view.py   # the UI read primitives, and their page shapes
├── prometheus_exporter.py   # the sb_* registry (no server)
├── web/                # Flask: create_app, the /api blueprint, problem.py (RFC 9457), health
└── events/             # schemas · loader · export · validator · aggregator · watcher
```

## The tests

The v5 seam is **a real store in `tmp_path` with a faked yfinance**: a genuine
DuckDB *file* (never `:memory:` — DuckDB refuses a second process, and persistence
is part of what is asserted), with the DDL applied and the seed in place.

Assertions about **behaviour** go on the store's contents or on the API's JSON,
never on the fact that a method was called. **There is one faked *external* edge
left in the whole suite, and it is yfinance** — nothing else the app talks to is
replaced by a double for the sake of being replaced.

**Internal spies exist, and their subject is the negative.** What the app decided
*not* to do writes no row and returns no payload, so there is nothing else to
assert on: 77 call-shaped assertions live in nine files, and they are overwhelmingly
`assert_not_called` and `call_count`. Where they are:

| File | What is doubled, and what it proves |
|---|---|
| `test_scheduling_wiring.py` (36) | `MagicMock(spec=BackgroundScheduler)` and the exporter — a job armed, removed, **not re-armed**; the sonde skipped on a cycle that does not write |
| `test_watcher.py` (13) | the watchdog observer — scheduled once, started once, **not** re-triggered |
| `test_metrics.py` (12) | the replay and the fetch — recomputed once, and **not** fetched when nothing is held or the anchor has reached the acquisition |
| `test_web_boot.py` (5) | the runtime classes — **not constructed** before the fork, shut down once after it |
| `test_quotes.py` (4), `test_configuration_manager.py` (2), `test_retention.py` (2), `test_web_api.py` (2), `test_carrying.py` (1) | `call_count` on a read, to prove a query was **avoided** |

The rule is therefore *"a spy is the last resort, and it is for an absence"*, not
*"there are no spies"*. If a row or a payload can answer the question, it answers it.

And **there is one clock, and it is the product's**: every read of it
is UTC-qualified, and `test_suite_conventions.py` holds that on the source over
`src/` and `tests/` alike, because CI runs in UTC.
