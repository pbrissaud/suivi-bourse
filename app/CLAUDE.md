# app/ — the application

Python 3, Flask + APScheduler + DuckDB, served by gunicorn. The commands are in
the root `CLAUDE.md`; the *why* of each choice is in `docs/adr/`, then in
`docs/v5-decisions.md`.

## The boot

`src/gunicorn.conf.py` is the container `ENTRYPOINT` **and** the boot sequence,
split in two by the `fork()`:

- **master, under `preload_app`** — `main.build_runtime()`: the store (opened, DDL
  applied, seeded, **closed again**), `ConfigurationManager`, the first
  publication of the config snapshot. Pure work only: no thread, no socket, no fd
  survives a fork. A failure here is `sys.exit(1)`.
- **`post_fork`** — `main.start_runtime()`: the store connection (its own), the
  `BackgroundScheduler`, the first `ingest()`. A failure here
  **re-raises**: gunicorn reads an exception as `WORKER_BOOT_ERROR` and halts the
  arbiter, where an exit code would be respawned forever.
- **`worker_exit`** — `main.shutdown_runtime()`, closing the store last.

`workers = 1` is a property of the design, not a tuning default: N workers would
be N schedulers. Concurrency comes from `threads`. One master, **one socket, one
application** (ADR-0033): `bind` holds `SB_WEB_PORT` and nothing else, and the
whole app — the page, `/api` writes included, `/health` — answers on it. The
second socket the exporter used to be bound to is gone, and with it the "publish
only the metrics port" that hid nothing anyway: whoever reaches the socket
reaches the whole app.

**`/health` says health in two registers that never mix** (ADR-0036). The
**status code** is the orchestrator's, and its predicate is the one #696 settled
— the worker serves and the store answers; nothing else reaches it. The **body**
is a person's: each job (scrape, backfill, performance) with its last pass and
its verdict, plus one word for the whole. A job that is late, wedged or silent
is amber **with a `200`** — restarting repairs nothing yfinance broke, and a
probe that reddened on it would turn a stuck job into a restart loop. The body
is folded by `runtime_view.build_health` out of the recorder's last-pass records
and issues no query, which is what keeps the two registers apart; when the store
goes, so does the body, and the `503` is the whole answer. The route keeps its
name: `/healthz` was examined and declined.

## The store

`store.py` owns the file: the connection, the DDL of the eleven tables, the seed.

- **One thread inside the connection at a time**, reentrant lock;
  `Store.transaction()` holds it from `BEGIN` to `COMMIT` (a transaction on one
  connection is visible to every thread using it).
- **DDL with `IF NOT EXISTS`, no migration machinery.** A new column would exist
  on no store created before it: derive at read time instead.
- **Every table has exactly one writer** — the configuration path owns
  `account`/`symbol`/`advisory`, `entries.py` owns `event` **whole**
  (ADR-0032, #816: one population, one writer, the named exception of
  `reassignment.py` apart), the ingestion `position`/`account_state`, the market
  `symbol_quote`/`price_point`, the perf job
  `account_metrics`/`portfolio_totals`.
- **`setting` is the one table with two named writers**: the configuration path
  answers for a human's choice, and `entries.py` upserts two keys of its own —
  the reporting currency a file declares, and `ledger_last_write` (`_stamp_write`,
  inside the gesture's own transaction, since #816 left no `import_source` row to
  read the instant off).
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
• yfinance.Ticker()    • boot or a write —      • ladder collapse   • replays the Timeline
• marketState→cadence    never a timer          • backward pass     • full recompute
• REGULAR: poll+write                           • forward pass      • upsert + bounded prune
• closed: sleep to open                         • lateral pass
```

- **Scrape** — one self-rescheduling job per **held** symbol, a fresh 0–30 s
  jitter at every arming (anti-herd), `misfire_grace_time=None`. A closed market
  sleeps to the next open; a dead ticker backs off at `regular_interval ×
  2^(n−3)`. A freshness sonde watches for a writer that persists frozen values —
  purely diagnostic, and it says so twice: a `WARNING` in the logs and the
  *stale* field of the scrape record, which the runtime tab renders as a
  `frozen` pill and `/health`'s body folds into the scrape job's verdict. Its
  threshold is the `staleness_horizon` dial.
- **Ingestion** — armed by the boot or by a write through the API, and by
  nothing else since ADR-0032 took the drop folder and its watcher. Each run
  reconciles the per-symbol scrape jobs; the write's own passes `force=True`,
  because `ledger.stamp` does not move for an edit that changes no count.
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
  a backfill chunk. There was a third — a file dropped in `/import`, whose
  watcher was wired straight to `ingest` and therefore left the curves up to one
  `PERF_TICK` behind — and it closed with the mount rather than by a second
  spelling of the seam (#815). **One pass at a time** (`_perf_lock`, reentrant): the
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

### Environment variables — three names, no fourth

What is left in the environment is exactly what the process must know **before**
it can open the store (ADR-0014). `boot_env.py` says them once.

| Variable | Default | Role |
|---|---|---|
| `SB_STORE_DIR` | `/data` | Directory holding `suivi-bourse.duckdb` |
| `SB_WEB_PORT` | `8080` | The one socket the app is bound to — the page, `/api`, `/health` |
| `LOG_LEVEL` | `INFO` | Logging level (here, since the likeliest failure is the store) |

The path is **a directory, never a file**; the defaults describe the container;
**blank counts as unset** (compose renders an undefined substitution as an empty
string). Every retired `SB_*`/`INFLUXDB_*` variable still set is named at start-up
in **one grouped notice**, and that list is *computed*, never written down.
The two names the exporter answered for left this table with it (ADR-0033,
#809) and `SB_IMPORT_DIR` with the drop folder (ADR-0032, #815); all three are
in `boot_env.DELETED`, so an install that still sets one hears it in that notice
as **removed with no successor** — the gauges became the health body and the
runtime tab, and the folder became a gesture, never a dial to turn either back
on.

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

A file reaches the app **one way** (ADR-0032): `POST /api/events/import` takes
one in a `multipart/form-data` body and writes its rows through `entries`. The
drop folder, its watcher and `SB_IMPORT_DIR` left with #815; `import_source`,
`event.source_id`/`source_sheet`/`source_row` and the `409` on `PUT`/`DELETE`
left with #816. **There is one population of rows and one writer**: a row a file
laid down is corrected and deleted exactly like a row somebody typed, and
*"the import path has no row-level write"* has nothing left to be true about.
A file is still read for what it **is** — `id` + `type` with no `event_type` is
a declaration of accounts, and the upload refuses it by name (ADR-0034) — and
no filename has a special meaning, except a v4 `config.yaml`/`settings.yaml`,
recognised **by its name** and refused with the migration page, having no header
to read.

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
file. An event file naming an undeclared account is not imported at all. An
account is **undeletable while an event names it** (`409`, the cascade is
refused rather than performed).

If ingestion fails, **the previous valid configuration is kept** and scraping
continues: a snapshot is published only once complete and validated.

**The way back out of an import is `DELETE /api/events`** (#814, ADR-0032). It
takes **exactly the five reduction parameters of the export routes** — `q`,
`type`, `account`, repeated `symbol`, and the `since`/`until` period — read by
one function (`web.api._selection`) so the reduction the table shows is the one
the deletion consumes. Its subject is the **reduction and never the row**: the
predicate *this line came from a file* is not consulted, which is what lets it
undo a whole import and repair a dozen mistyped rows with one gesture. With no
parameter at all — or with all of them blank — it answers `422` and **writes
nothing**: emptying the ledger stays possible by reducing on something that
covers it, and a truncated request cannot destroy a history. A reduction that
retains nothing removes nothing and is a `200`. The answer is
`{"events_removed": n}`, and the replay follows it like every other write, the
performance series included.

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
a **receipt** — what the file holds, what of it the ledger already had, what was
written, the period covered, the accounts and securities touched.

**A ledger that does not replay is a `409` of its own** (#824,
`/problems/unreplayable-ledger`). The oversell is not `/problems/conflict`: that
type's one sentence was written for #698's refusals — *what this names is already
there, or something still rests on it* — and it describes nothing whatsoever
about a file that sells shares nobody ever bought, which since #811 is the
ordinary case (an export starting mid-history). Every write path that replays
answers it — the four on the events, the bulk delete, and the two account
gestures that move rows — carrying `gesture` (`write` or `remove`, because a
payload cannot say whether the ledger broke on the way in or on the way out) and
`symbol`/`wanted`/`owned` as **extension members**, which is what lets the front
compose the sentence in the reader's language (ADR-0024). `detail` stays
`AggregationError`'s own English, word for word: it is what a log and a `curl`
read, and it is deliberately not what a page renders.

**The receipt is answered at two moments and the object is one** (#813,
ADR-0032). `?dry_run=1` reads the store through the lock-free accessor, runs the
same two judgements the write runs (`entries.judge`: the validator over the whole
file, then the replay of the ledger it would leave), answers the same shape with
the same refusals — and **writes nothing at all**, which is why it is a `200`.
It holds **no server state**: there is no pending-import id, because that
identifier would be the `import_source` table #816 deleted, under another name
and with a lifetime and a sweeper to write, so the front commits by re-uploading
the same file.

**Duplicates are caught by content and never by a constraint.** The key is
`entries.DUPLICATE_KEY_COLUMNS` — `(date, event_type, account, symbol, quantity,
unit_price, fee, amount)`; `name` and `notes` are out, or annotating a row would
make it re-importable. `entries.split_duplicates` compares it against the ledger
**and** against the file itself, the receipt counts what it finds, the import
skips it, and `?write_duplicates=1` writes it anyway — the owner is the only one
who knows whether two identical `BUY` are one order filled twice. The key is
declared **nowhere in the DDL**: a `UNIQUE` over those eight columns would make
that order impossible to record from the keyboard as well, and ADR-0007's rule
puts a constraint where the error enters, which is at the import.

## Module map

```
src/
├── gunicorn.conf.py    # entrypoint AND boot sequence
├── main.py             # Runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── store.py            # the connection, the DDL of the eleven tables, the seed
├── boot_env.py         # pure: the four boot variables, the computed list of the quiet ones
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
├── ledger.py           # the ledger's reads: read_events, the stamp, the last write, the orphans
├── uploads.py          # the gesture: one file in, read once, refused by name
├── entries.py          # the one writer of `event`: the row's four gestures + the bulk one
│                       #   and the forecast that writes none: the content key, the split, the judgement
├── accounts.py         # the account table, the declaration, the refusals
├── reassignment.py     # the named, bounded exception: the unassigned events
├── settings_registry.py / settings.py   # the one list of dials, and the write path
├── advisories.py       # the three advisories: predicate in code, the table holds the ack
├── runtime_state.py / runtime_view.py   # the jobs' last-pass records, and how they read
├── store_reads.py / portfolio_view.py   # the UI read primitives, and their page shapes
├── web/                # Flask: create_app, the /api blueprint, problem.py (RFC 9457), health
└── events/             # schemas · loader · export · validator · aggregator
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
assert on: 62 call-shaped assertions live in eight files, and they are overwhelmingly
`assert_not_called` and `call_count`. Where they are:

| File | What is doubled, and what it proves |
|---|---|
| `test_scheduling_wiring.py` (35) | `MagicMock(spec=BackgroundScheduler)` — a job armed, removed, **not re-armed**; the sonde skipped on a cycle that does not write |
| `test_metrics.py` (12) | the replay and the fetch — recomputed once, and **not** fetched when nothing is held or the anchor has reached the acquisition |
| `test_web_boot.py` (4) | the runtime classes — **not constructed** before the fork, shut down once after it |
| `test_quotes.py` (4), `test_configuration_manager.py` (2), `test_retention.py` (2), `test_web_api.py` (2), `test_carrying.py` (1) | `call_count` on a read, to prove a query was **avoided** |

The rule is therefore *"a spy is the last resort, and it is for an absence"*, not
*"there are no spies"*. If a row or a payload can answer the question, it answers it.

`test_watcher.py` was the second-largest of them (13, the watchdog observer:
scheduled once, started once, **not** re-triggered) and it left with no
replacement — the observer no longer exists, so there is no absence left to
prove (ADR-0032). It is the only place in the v5 rewrite where that is true.

And **there is one clock, and it is the product's**: every read of it
is UTC-qualified, and `test_suite_conventions.py` holds that on the source over
`src/` and `tests/` alike, because CI runs in UTC.
