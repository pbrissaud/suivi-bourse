# app/ — the application

Python 3, Flask + APScheduler + DuckDB, served by uvicorn. The commands are in
the root `CLAUDE.md`; the *why* of each choice is in `docs/adr/`, then in
`docs/v5-decisions.md`.

## The boot

`src/boot.py` is the container `ENTRYPOINT` **and** the boot sequence, and since
ADR-0039 it is linear — the app does not fork:

1. **the environment** — `boot_env.read()`, once and as a whole.
2. **`main.build_runtime()`** — the store (opened, DDL applied, seeded, and
   **kept open** for the life of the process), `ConfigurationManager`, the first
   publication of the config snapshot.
3. **`web.create_app(runtime)`** — the Flask app, on that runtime. It no longer
   builds one of its own: the factory used to be named on gunicorn's command
   line, which is why it could.
4. **`main.start_runtime()`** — the `BackgroundScheduler` and the first
   `ingest()`. It opens nothing.
5. **`boot.serve()`** — `uvicorn.run()` in process, on `Serving`: the Flask app
   behind a WSGI→ASGI adapter, no route rewritten.

A failure at any of the five is **one** non-zero exit (`boot.run`). There used to
be two answers — the master exited 1, `post_fork` re-raised so gunicorn would
halt the arbiter rather than respawn a worker that would fail identically — and
there is no arbiter.

**The teardown is the lifespan shutdown**, not a `finally` after `uvicorn.run`:
uvicorn catches `SIGTERM`, shuts down gracefully, then re-raises the signal, so
the process dies the instant `run()` returns. `main.shutdown_runtime` is called
from `Serving`'s `lifespan.shutdown` — the heir of `worker_exit` — and again from
the `finally`, which covers a boot that never bound a socket at all. It is
written to be called twice.

**One process is structural, not guarded.** `on_starting` and
`control_socket_disable` were two guards spent forbidding a second worker — N
workers would be N schedulers — and they left with the arbiter. uvicorn has a
multiprocess mode, and the door stays shut by the image having **no server
command line**: the `ENTRYPOINT` is `python boot.py`. Concurrency comes from the
WSGI thread pool (`boot.WSGI_THREADS`). **One socket, one application**
(ADR-0033): `SB_WEB_PORT` and nothing else, and the whole app — the page, `/api`
writes included, `/health` — answers on it. The second socket the exporter used
to be bound to is gone, and with it the "publish only the metrics port" that hid
nothing anyway: whoever reaches the socket reaches the whole app.

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

`store.py` owns the file: the connection, the DDL of the twelve tables, the seed.

- **One thread inside the connection at a time**, reentrant lock;
  `Store.transaction()` holds it from `BEGIN` to `COMMIT` (a transaction on one
  connection is visible to every thread using it).
- **DDL with `IF NOT EXISTS`, no migration machinery.** A new column would exist
  on no store created before it: derive at read time instead.
- **Every table has exactly one writer** — the configuration path owns
  `account`/`symbol`/`installation_fact`, `advisories.py` owns `advisory_ack`
  (one write path, and it is the acknowledgement), `entries.py` owns `event`
  **whole**
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
  *stale* field of the scrape record, which `/health`'s body folds into the
  scrape job's verdict — read on the settings page's **workloads** card since
  #830, as a sentence naming the securities concerned. Its threshold is the
  `staleness_horizon` dial, which is on that same page and disables the sonde
  at `0`.
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

## The advisories

`advisories.py` is the third register ADR-0036 separated and ADR-0037 gave a
surface to: **what the owner's data says about itself**, as opposed to what is
true of the install (`installation_facts.py`) or of the app (`/health`).

- **Derived on every read and stored nowhere.** There is no row saying an
  advisory stands, because the condition *is* the figures — so no arming, no
  dropping, and no `first_seen_at`: the instant published is the instant it was
  looked at.
- **The acknowledgement is bounded**, thirty days (`ACK_WINDOW`), which is what
  answers 0036's objection by name — a permanent one *"would silence the app the
  second time the cash piled up"*. Nothing has to observe the condition going
  false, because the expiry needs no observer.
- **`standing` and `listing` are two questions, and the route asks both.**
  `GET /api/advisories` answers the *inventory* — what is left to act on, an
  acknowledged advisory dropped — and `?asleep=include` answers the *reading*,
  which is `standing`: the cash is still sitting in that account while the card
  sleeps, so the chip beside the figure goes on saying so (ADR-0037). Served
  from one derivation, so the two cannot disagree about what stands; an unknown
  value of the parameter is the inventory, a typo in a URL being no reason to
  refuse a page.
- **It is a table and not a column** on `installation_fact`: the DDL is
  `IF NOT EXISTS` with no migration machinery, so a column added there would
  exist on no store created before it. `advisory_ack` is the twelfth table, and
  it carries the expiry the fact's own row deliberately does not.
- **One family today** — the cash share of an account, over a constant
  threshold (`CASH_SHARE_THRESHOLD`, ADR-0036: *"a setting nobody has ever
  turned is a setting that should not have been written"*). The four **subjects**
  the panel groups by are declared all the same, `portfolio` included: a front
  inventing a heading for a key it does not know would be a second authority on
  the grouping.

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
default, bounds, effect, **required**); `PUT /api/settings` is the only writer,
validates the whole body and **writes nothing at all** when it refuses.

`required` is the first run's predicate, published with the rest of what a dial
is: *a required dial with nothing stored is a question nobody has answered*
(ADR-0035). `base_currency` wears it alone today — it is the one dial with no
default — and the front reads the mark rather than the key, so a second required
dial is a line in this list and nothing else.

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

**The way out is three routes and one of them is not a backup** (#796, #836).
`GET /api/export/events.csv` and `…/events.xlsx` render the ledger — the second
one sheet per year — and both take the five reduction parameters above off the
same `web.api._selection`, so a *selection* is a name the server gives a file
and never a shape assembled in the front. `GET /api/export/portfolio.csv` is the
third and it is a **report**: the accounts with their cash, and their positions
with the PMP and what the last observed price makes of them. It takes no
reduction (a position has no event type and no date), it reads the **store** and
not the published snapshot like the two beside it, and it does not apply the
carrying convention — establishing that a symbol's backfill is terminal takes
the snapshot's holding windows, which is the one read an export must not make,
so an unpriced holding is an empty cell. `/api/export/accounts.csv` is still a
`404` and stays one: ADR-0034 retired a *declaration* nothing reads back, and
what keeps this file on the right side of that record is that the loader refuses
it by name for want of `date` and `event_type`.

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

**And the gesture takes an account correspondence** (#835, ADR-0006). `?map=`
carries one JSON object — each account the file names to the id of a **declared**
one — and repeated `?declare=` names the labels to be declared *with* the import,
which is what repairs the `422` that rejected a whole file over an account nobody
had declared. It is applied to `parsed.events` **before `_to_write` and
identically in both branches**: the duplicate key carries the account, so a
correspondence applied to the write alone would leave the preview counting
duplicates against accounts the write is not going to use. It is **consumed and
dropped** — a parameter of the gesture, not the persistent mapping layer
`reassignment.py` refused: no `UPDATE`, no table, no window, and the next file
asks the question again. The receipt gains the file's own **census**
(`file_accounts`: each label the `account` column carries, with its volume, read
before the correspondence), the **named duplicates** (`duplicate_rows`, each with
`duplicate_of` — the stored row it repeats, or `null` where it repeats another
line of the file), and what the file declares as its reporting currency with what
this import does with it (`currency`, `?adopt_currency=0` declining the offer —
never the disagreement, which stays a refusal in prose). One asymmetry, and it is
written down: a **preview carrying a `map` parameter** does not judge the account
column at all (`entries.judge(..., accounts_pending=True)`), because refusing
there would refuse a file over the very question the response is being asked in
order to put. The **write** judges it exactly as before, so what the front gives
up at the forecast it gives back by blocking its button.

**Duplicates are caught by content and never by a constraint.** The key is
`entries.DUPLICATE_KEY_COLUMNS` — `(date, event_type, account, symbol, quantity,
unit_price, fee, amount)`; `name` and `notes` are out, or annotating a row would
make it re-importable. `entries.split_duplicates` compares it against the ledger
**and** against the file itself, the receipt counts what it finds, the import
skips it, and `?write_duplicates=1` writes it anyway — the owner is the only one
who knows whether two identical `BUY` are one order filled twice. **The flag is
judged at the preview as well**, and that is load-bearing rather than incidental:
keeping the duplicated rows is a *different ledger to replay*, so a `SELL` that
only got through because its duplicate was skipped stops replaying once it does
not, and a preview that ignored the flag would answer `200` to a file the write
then refuses — the refusal after the button #835 forbids. The key is
declared **nowhere in the DDL**: a `UNIQUE` over those eight columns would make
that order impossible to record from the keyboard as well, and ADR-0007's rule
puts a constraint where the error enters, which is at the import.

## Module map

```
src/
├── boot.py             # entrypoint AND boot sequence (ADR-0039)
├── main.py             # Runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── store.py            # the connection, the DDL of the twelve tables, the seed
├── boot_env.py         # pure: the four boot variables, the computed list of the quiet ones
├── mounts.py           # pure: mountinfo + a path → persistent / ephemeral / unknown
├── boot_conditions.py  # pure: the three start-up lines, said once each
├── instants.py         # stdlib only: the one UTC repair and the one ISO,
│                       #   an instant stamped, a calendar day left alone
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
├── installation_facts.py  # the three facts: predicate in code, the table holds the ack
├── advisories.py       # what the data says about itself: derived per read, the ack expires
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

**And one repair of what comes back from the store**, which is the other way a
naive instant enters: `instants.utc` / `instants.iso`, held on the source by the
same file (#843). It had been rewritten in eight modules, in three variants that
had already drifted — some converting an aware instant, some letting it through,
two not repairing at all — and no test could ever see the consequence, a page
shifted by the browser's offset being invisible on a machine in UTC.

The guard names the **definition**, never the expression: the three repairs made
**on the way in** (`scheduling` on an argument it is handed, `main` on a pandas
`Timestamp` at the market's edge, `web.api` on an ISO string arriving from the
front) stay spelled where they happen. It reads the definition two ways, because
one of them was not enough: by **name** for the repair (`_utc`, `_stamp_value`,
and `_iso` for a helper that merely delegates), and by **shape** for the
serialization — a private function whose own answer is a value's `.isoformat()`
is a second definition whatever it is called. The list of names alone let
`runtime_view._day` stand as one; the shape is the rule.
