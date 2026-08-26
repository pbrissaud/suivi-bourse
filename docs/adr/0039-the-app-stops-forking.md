# The app stops forking, and two guards go with it

The container's entrypoint is gunicorn, and gunicorn always forks. `workers = 1` and
`preload_app = True` shape that fork rather than remove it: the master runs
`build_runtime`, the fork happens, and `post_fork` runs `start_runtime` in the worker.
[ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) left one socket
and one application; what is left to remove is the second process.

uvicorn, run programmatically from a boot module, replaces it. The existing Flask
application is unchanged behind a WSGI-to-ASGI adapter — **no route is rewritten** — and
the whole boot becomes one linear sequence in one process.

## The fork was measured, not assumed

`CLAUDE.md` has carried a warning that the app crashes on macOS as soon as a symbol is
scraped, blaming a fork without exec. Three narrower experiments failed to reproduce it —
yfinance after a fork is fine, and so is yfinance used either side of one — which is
exactly why the app itself had to be run. On macOS 26.5.1, Python 3.14.7, yfinance 1.5.2,
with one `BUY AAPL` in the ledger:

| | gunicorn | uvicorn, no fork |
|---|---|---|
| `/health` | `200` | `200` |
| the `Scrape AAPL` job runs | never — `at: null` | `at: 00:29:44`, `verdict: closed` |
| `SIGSEGV` | **two, respawning** | **none** |

The worker segfaults the moment the scrape job runs, the arbiter respawns it, the job is
re-armed, and it segfaults again. The warning was right; what it lacked was a measurement,
and this record carries one so the next reader does not have to redo it.

## Consequences

- **The boot stops being split, and `gunicorn.conf.py` stops being executable
  configuration.** `src/boot.py` reads the environment, builds the application, opens the
  store, arms the jobs and serves — in that order, in one file, with no hook to attach the
  second half to. The docstring that justified the split moves with the sequence.
- **The store is opened once instead of twice.** The master opened it to apply the DDL and
  **closed it again** so that no descriptor crossed the fork; the worker then opened its
  own. With no fork there is one connection for the life of the process, which is the
  lifecycle the reentrant lock in `store.py` already assumed.
- **`on_starting` and `control_socket_disable` are deleted, and the property they defended
  becomes structural.** They existed to stop a second worker — *N workers are N
  schedulers* — and they were two guards spent forbidding a capability the design never
  wanted. There is no arbiter left to raise a worker count against.
- **The `--workers` door is closed by having no command line.** uvicorn has a multiprocess
  mode, so replacing one CLI with another would have reopened what the guards shut. The
  entrypoint is `python boot.py`, and `boot.py` calls `uvicorn.run(...)` in process: there
  is no flag to pass because there is no CLI in the image to pass it to.
- **`preload_app`'s reason does not survive the arbiter that created it.** It kept an
  unreadable store (#696) a single clean exit rather than a respawn loop — a defence
  against a failure mode the arbiter itself introduced. One process that cannot boot
  exits, and there is no loop to prevent.
- **Supervision moves to the orchestrator, and that is the point.** gunicorn restarted a
  dead worker inside a container that stayed up, which is how a crash loop stays invisible
  from outside. Now the process dies, the container exits, and the restart policy decides
  in the open. The canonical `docker run` gains `--restart unless-stopped`, and the
  documentation says so.
- **FastAPI was considered and declined.** Its benefit is asynchronous I/O, and this
  application is synchronous by construction: yfinance blocks, and DuckDB is one
  connection behind a reentrant lock, so an `async def` route touching the store would
  block the loop while a `def` route would land in a thread pool — which is what Flask
  already does, with one layer fewer. Its other benefit, a generated OpenAPI document, is
  something [ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md)
  declined by name when `/api` stopped being a contract. The cost would have been every
  route in `web/api.py`, the RFC 9457 layer in `web/problem.py`, and `create_app()` —
  which is the seam the whole Python suite is written against.
- **waitress was the first choice and was dropped on its release history**, not on its
  design: the last release is from November 2024, and an HTTP server that parses the
  network is the wrong place to run a dormant dependency. It would have closed the
  `--workers` door by having no multiprocess mode at all; the entrypoint closes it
  instead.
- **The container contract keeps its assertions and loses a comment.** Assertion 3 counts
  the ephemeral-store line and requires exactly one; a single process says it once, so the
  check is untouched. Only its explanation, which is written in terms of a master that
  might have forked before speaking, describes something that no longer exists.
- **`test_web_boot.py` is rewritten rather than adapted.** It loads `gunicorn.conf.py` as
  a module and asserts the master/worker split — *not constructed before the fork, shut
  down once after it*. That is a true statement about a boundary this record removes, so
  the file's subject becomes the sequence: the order of the steps, and that a failure at
  any of them exits once and non-zero.

[The single socket it follows: ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) ·
[the health it must keep answering: ADR-0036](./0036-the-dot-says-health-and-the-notices-lose-their-exception.md) ·
[the store whose connection it simplifies: ADR-0001](./0001-one-embedded-store-duckdb.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
