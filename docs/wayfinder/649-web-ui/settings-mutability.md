# Which `SB_*` settings can change without a restart?

> Asset for [Which SB_* settings can change without a restart?](https://github.com/pbrissaud/suivi-bourse/issues/654),
> a ticket of the map [First-party web UI — a playable prototype to judge against Grafana](https://github.com/pbrissaud/suivi-bourse/issues/649).

The dev's position while charting #649: settings editing is in scope **only if**
it does not demand large changes. This document settles that with facts.

**Headline:** the app reads **17 environment variables**. **8 of the 17 are
cheap to apply** to the running process — 5 are already mutable instance
attributes consumed per cycle, 3 are APScheduler interval jobs with stable ids
that `reschedule_job` re-arms in one call. And **0 of the 17 can be persisted**,
because `.env` is a *host* file that the container never sees and that compose
re-reads only at `up`.

That asymmetry — cheap to apply, impossible to persist — is the answer. The
question framed three buckets along the *applying* axis, and along that axis the
news is good. But applying is only half of "editable": a settings page whose
values silently revert on the next `docker compose up` is worse than no settings
page, because it looks like configuration and behaves like a scratchpad.
Building the missing half means inventing a **second configuration source with a
precedence rule against the environment** — a v5-sized product change, the same
shape as the SQLite question already ruled out of scope in
[#653](https://github.com/pbrissaud/suivi-bourse/issues/653).

**Verdict: settings editing is out of scope for the prototype.** Two consolation
items survive, both cheap and neither a write path — see [§6](#6-verdict).

---

## 1. The full inventory

Every variable the Python app reads, with the exact site and the moment it is
read. Bucket per the ticket's framing: **H** trivially hot, **R** reloadable by
re-arming, **B** boot-only.

| Variable | Read at | When | Consumed at | Bucket |
|---|---|---|---|---|
| `SB_REGULAR_INTERVAL` | `resolve_regular_interval()` `main.py:128-145`, called `main.py:1767` → `sb_metrics.regular_interval` `main.py:1776` | boot | `main.py:1109`, every scrape cycle | **H** |
| `SB_SCRAPING_INTERVAL` *(deprecated)* | idem — fallback branch `main.py:143-144` | boot | same attribute | **H** |
| `SB_BACKFILL_DELAY` | `main.py:572` → `self.backfill_delay` | boot | `main.py:776`, `1409`, `1414`, every backfill fetch | **H** |
| `SB_BACKFILL_CHUNK_DAYS` | `main.py:573` → `self.backfill_chunk_days` | boot | `main.py:1453`, `1506`, every backfill cycle | **H** |
| `SB_STALENESS_HORIZON` | `main.py:581-582` → `self.staleness_horizon` | boot | `main.py:1047`, `1058`, every `REGULAR` write | **H** |
| `SB_INGESTION_INTERVAL` | `main.py:1768` | boot | job `ingest`, `main.py:188-192` | **R** |
| `SB_BACKFILL_INTERVAL` | `main.py:1769` | boot | job `backfill`, `main.py:193-197` | **R** |
| `SB_PERF_INTERVAL` | `main.py:1770` | boot | job `perf`, `main.py:198-202` | **R** |
| `SB_DYNAMIC_EXECUTOR_POOL` | `main.py:167` (via `main.py:1791`) | boot | `ThreadPoolExecutor(pool_size)` `main.py:1798` | **B** |
| `SB_EXECUTOR_POOL` | `main.py:168`, `170` | boot | idem | **B** |
| `SB_CONFIG_MODE` | `main.py:271`, inside `_load_settings()` | **once, ever** | mode resolution, snapshot construction | **B** |
| `SB_PROMETHEUS_ENABLED` | `main.py:568` | boot | whether `self.prometheus` exists at all | **B** |
| `SB_METRICS_PORT` | `main.py:1779` | boot | `prometheus.start(port)` `main.py:1780` | **B** |
| `LOG_LEVEL` | module import ×3: `main.py:41`, `influxdb_writer.py:15`, `prometheus_exporter.py:16` | **import** | 5 named loggers | **B\*** |
| `INFLUXDB_HOST` | `influxdb_writer.py:71` | boot | `InfluxDBClient3(...)` `:84-88` | **B** |
| `INFLUXDB_TOKEN` | `influxdb_writer.py:73` | boot | idem | **B** |
| `INFLUXDB_DATABASE` | `influxdb_writer.py:74` | boot | idem | **B** |

**B\*** — boot-only as written, but the only boot-only entry that is *recoverable*
in-process, because `logging` exposes a runtime setter. See [T6](#t6).

Totals: **5 H + 3 R = 8 applyable**, **9 B**, of which 3 (`INFLUXDB_*`) are
already out of scope per the map.

### 1.1 Not app settings at all

These live in the same `.env`, two of them even carry the `SB_` prefix, and a
settings page would be expected to show them — but no Python code ever reads
them. They are consumed by compose and the docker daemon:

| Variable | Consumed by |
|---|---|
| `SB_VERSION` | image tag, `docker-compose.yaml:25` |
| `SB_CONFIG_DIR` | bind-mount source, `docker-compose.yaml:70` |
| `COMPOSE_PROJECT_NAME` | container/volume name prefix |
| `COMPOSE_FILE` | overlay chaining, `.env.example:40` |
| `GRAFANA_PORT`, `INFLUXDB_PORT` | `docker-compose.expose.yaml` |
| `GF_ADMIN_PASSWORD`, `INFLUXDB_NODE_ID` | the other services |

`SB_CONFIG_DIR` is the sharpest of these: from inside the container the config
directory is *always* `/home/appuser/.config/SuiviBourse`. The app cannot even
name its own host path, let alone change it.

---

## 2. The applying axis: good news

### 2.1 The five hot attributes (H)

The pattern is uniform and better than the ticket assumed. Each of these is read
from the environment **once** at boot, but stored on a plain mutable attribute of
`SuiviBourseMetrics` and **re-read on every use**:

```python
# main.py:572-582 — set once
self.backfill_delay      = env_int('SB_BACKFILL_DELAY', 10)
self.backfill_chunk_days = env_int('SB_BACKFILL_CHUNK_DAYS', 365)
self.staleness_horizon   = env_int('SB_STALENESS_HORIZON', scheduling.STALENESS_HORIZON)

# main.py:1453 — read every cycle
start_date = end_date - timedelta(days=self.backfill_chunk_days)
```

So applying a change is literally `sb_metrics.backfill_chunk_days = 180`. No
re-read of `os.environ`, no re-plumbing, no restart. `regular_interval` is the
same shape (`main.py:597`, overwritten from the env at `main.py:1776`, consumed
at `main.py:1109`).

The pure modules make this safer than it looks: `scheduling.decide` and
`scheduling.price_freshness_step` take the interval and the horizon as
**arguments**, with `now` injected. Nothing caches them.

### 2.2 The three interval jobs (R)

`register_interval_jobs` (`main.py:178-202`) registers exactly three jobs under
stable ids — `ingest`, `backfill`, `perf`. APScheduler 3.11.3 exposes
`reschedule_job(job_id, trigger, **trigger_args)`
(`apscheduler/schedulers/base.py:592-609`), which works against `MemoryJobStore`:

```python
scheduler.reschedule_job('perf', trigger='interval', seconds=300)
```

One call per dial. See [T5](#t5) for the countdown-reset side effect.

### 2.3 Why the boot-only nine are genuinely boot-only

- **Executor pool.** APScheduler's `ThreadPoolExecutor` wraps
  `concurrent.futures.ThreadPoolExecutor(int(max_workers))` in its constructor
  (`apscheduler/executors/pool.py:47-50`) and exposes no resize. The escape hatch
  is `remove_executor('default')` + `add_executor(...)`, but `remove_executor`
  calls `shutdown(wait=True)` — it blocks until every in-flight job finishes,
  including a backfill sitting in `time.sleep(self.backfill_delay)`. And #619's
  whole design is that the size is derived from the largest same-exchange cohort
  *at boot*, once the exchanges are known.
- **`SB_CONFIG_MODE`.** `_load_settings()` is guarded by `if self._mode is None`
  at all three call sites (`main.py:367`, `374`, `411`), so it runs **exactly
  once in the process's life**. #653 decided to make it re-runnable — but
  explicitly *for the `accounts:` block alone*, naming `mode` as excluded.
  Switching mode at runtime would invalidate the whole published snapshot and
  every armed `scrape:*` job.
- **`SB_METRICS_PORT` / `SB_PROMETHEUS_ENABLED`.** A bound listening socket is
  not rebindable in-process, and #651 moves both further out of reach — see
  [T7](#t7) and [T8](#t8).
- **`INFLUXDB_*`.** Out of scope by the map, and the client is built once in
  `connect()` (`influxdb_writer.py:79-89`).

---

## 3. The blocking fact: `.env` is unreachable and unwritable

The container's environment comes from `docker-compose.yaml:31-54`, which
renders values out of the **host's** `.env`:

```yaml
environment:
  SB_REGULAR_INTERVAL: ${SB_REGULAR_INTERVAL:-120}
```

The app service mounts exactly one volume — the config directory
(`docker-compose.yaml:69-74`). **`.env` is not in it.** The container has no file
descriptor to `.env`, no path to it, and no knowledge that it exists.

And even granting the app a write, it would not help: compose reads `.env` when
it *builds* the container spec. Changing a value takes a `docker compose up -d`
to recreate the container — the very restart the ticket is trying to avoid.

Mutating `os.environ` in-process is the same dead end from the other direction:
nothing re-reads it (§1 shows every read is a one-shot), and it evaporates with
the process.

So for all 17 variables, the persistence answer is identical and it is *no*.
This is not a bucket-dependent finding — the H/R/B split has nothing to say
about it.

---

## 4. What persisting would actually cost

Suppose we build it anyway. #653 already fixed the write surface: the app may
write **event files and the `accounts:` block of `settings.yaml`**, and nothing
else. Extending that to settings means:

1. **A second configuration source.** `SB_*` would have to be readable from
   `settings.yaml` too. That is a new top-level block, a new Cerberus schema, and
   a documented precedence rule against the environment — the kind of thing #607
   was deliberate about when it gave `SB_REGULAR_INTERVAL` precedence over
   `SB_SCRAPING_INTERVAL` with a warning on every boot.
2. **`.env` becomes a lie.** Compose's `environment:` block always sets the
   variable (see [T2](#t2)), so an env-wins rule makes the UI read-only in
   practice, and a file-wins rule means the file the user opens says `120` while
   the app runs `300`. Both readings are bad, and the choice is a product
   decision, not an implementation detail.
3. **A migration and a docs rewrite.** `.env.example` (91 lines, 13 documented
   dials), the `CLAUDE.md` environment table, and the versioned website docs all
   describe env-only configuration.
4. **The boot-only nine still need a restart anyway**, so the page would carry
   two classes of field with different semantics — "applies now" and "applies
   after you recreate the container, which you must do by hand on the host".

That is the shape of a v5 feature, not of a prototype's side panel.

---

## 5. Traps

<a id="t1"></a>**T1 — `.env` is invisible to the container.** Not mounted
(`docker-compose.yaml:69-74`), and compose re-reads it only at `up`. This single
fact decides the ticket. §3.

<a id="t2"></a>**T2 — compose hardcodes a second set of defaults, and always sets
the variable.** `${SB_REGULAR_INTERVAL:-120}` renders `120` even when `.env`
omits the line, so under compose the app's own defaults (`env_int(name, 120)`)
are dead code — compose's are the effective ones. Two default sources to keep in
sync (they agree today). A settings UI showing "unset → default 120" would be
factually wrong: the value is always explicitly set. The exception is
`SB_CONFIG_MODE: ${SB_CONFIG_MODE:-}`, which renders the empty string — which is
precisely why `env_str` treats blank as unset (`main.py:85-97`).

<a id="t3"></a>**T3 — changing `regular_interval` does not wake a sleeping
symbol.** Scrape jobs are `date` triggers re-armed by `_arm_symbol`
(`main.py:954-981`) at the end of each cycle. A symbol whose market is closed is
armed up to 24 h out; the new cadence applies only at its next completion. So a
UI change looks like a no-op outside market hours — exactly when a dev would be
fiddling with settings. Force-re-arming every `scrape:*` job would fix the
optics, at the price of an immediate fetch storm across the whole portfolio.

<a id="t4"></a>**T4 — `regular_interval` is also the dead-ticker backoff base.**
#617 grows the delay as `base_interval × 2^(n−3)` (`main.py:1109` feeds it into
`scheduling.decide`). Changing the poll interval retroactively rescales any
symbol already in backoff. Correct, but not what "poll interval" reads like.

<a id="t5"></a>**T5 — `reschedule_job` resets the countdown.** It computes
`next_run_time = trigger.get_next_fire_time(None, now)`
(`apscheduler/schedulers/base.py:604-606`), so re-arming a job to *the same*
value still restarts its timer from now. A save button that writes all fields
would silently reset all three job timers on every save — including `backfill`,
whose 60 s cadence is what advances the backward pass one chunk at a time.

<a id="t6"></a>**T6 — `LOG_LEVEL` needs the handler set too, on five loggers.**
`logfmt_logger.getLogger` sets the level on both the logger (`__init__.py:67`)
**and** its `StreamHandler` (`:73`). Calling only `logger.setLevel(DEBUG)` leaves
the handler at INFO and nothing new is printed. And there are five
independently-configured loggers: `suivi_bourse`, `apscheduler.scheduler`,
`yfinance` (`main.py:42-44`), `influxdb_writer` (`:16`), `prometheus_exporter`
(`:17`). A runtime toggle is ~6 lines, but it must walk all five and touch each
handler.

<a id="t7"></a>**T7 — `SB_METRICS_PORT` moves *further* out of reach after
#651.** Today it is `prometheus.start(port)` in `__main__`. After #651 it becomes
an entry in gunicorn's `bind` **list**, read by `gunicorn.conf.py` in the master
before the app module is even imported. A port a running server is bound to is
not changeable in-process, and after #651 the app does not own the bind at all.

<a id="t8"></a>**T8 — `SB_PROMETHEUS_ENABLED` changes meaning after #651**, from
"run no HTTP server" to "do not mount `/metrics`". The mount is built into
`DispatcherMiddleware` at import time, **in the gunicorn master, before the
fork** — toggling it at runtime would mean rebuilding the WSGI application under
a live server.

<a id="t9"></a>**T9 — `SB_CONFIG_MODE` is read exactly once, ever.** Guarded by
`if self._mode is None` at every call site. #653's "make `_load_settings()`
re-runnable" is scoped to the `accounts:` block and names `mode` as excluded.

<a id="t10"></a>**T10 — the executor pool has no resize.** §2.3.

<a id="t11"></a>**T11 — `SB_SCRAPING_INTERVAL` is honored but never rendered.**
`resolve_regular_interval` still reads it (`main.py:129`, `143-144`), yet
`docker-compose.yaml` does not pass it and `.env.example` does not mention it. So
"what the app reads" (14 app vars + 3 InfluxDB) and "what compose sends" (13 SB_*
+ 4) are *different lists*. Any settings view must pick one and say which.

<a id="t12"></a>**T12 — a read-only view still needs a redaction rule.**
`INFLUXDB_TOKEN` is a secret sitting in the same environment. Displaying it on a
page the prototype does not authenticate (auth is out of scope per the map) is a
leak. Redact by name, not by value.

<a id="t13"></a>**T13 — compose-only variables look like app settings.** §1.1.
Two of them carry the `SB_` prefix. A page that lists "the `SB_*` settings" and
omits `SB_VERSION`/`SB_CONFIG_DIR` will read as broken; one that includes them
will imply they are editable.

---

## 6. Verdict

**No editable settings in the prototype.** Applying is cheap for 8 of 17;
persisting is architecturally absent for all 17, and supplying it is a v5-scale
product change (§4). The dev's charting condition — "only if it does not demand
large changes" — is not met.

Two things worth keeping, neither of which is a write path:

**(a) A read-only "effective configuration" view — fold into
[#656](https://github.com/pbrissaud/suivi-bourse/issues/656).** The effective
config *is* runtime state, and it answers a question the dev genuinely has while
judging a prototype: what is this container actually running? It costs one
dictionary, has no precedence problem, and needs only T11's list-choice and
T12's redaction rule. It belongs beside the scheduler's live state, not in a
settings page of its own.

**(b) `LOG_LEVEL` as an explicitly ephemeral debug toggle — optional.** The one
carve-out whose non-persistence is a *feature*: a log-level switch that resets on
restart is the expected behaviour everywhere else, so it creates no expectation
of a second config source. ~6 lines, with T6 as the only trap. Worth it only if
debugging the prototype turns out to want it; not worth pre-building.

Everything else — the 5 hot attributes, the 3 re-armable jobs, the 9 boot-only —
stays where it is: configured through `.env`, applied by
`docker compose up -d`.
