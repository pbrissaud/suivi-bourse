# CLAUDE.md

The broad lines of the project. The detail lives elsewhere — see *Where the rest
is written* at the bottom.

## The product

SuiviBourse tracks a personal stock portfolio. The owner records what they
bought, sold, received and paid in; the app fetches prices (yfinance), values the
positions and computes the returns.

**A portfolio is a dated event ledger, and only that.** Everything else —
positions, prices, performance series — is derived from it and lives in **one
embedded DuckDB store** (ADR-0001).

## The repository

| Path | What it is |
|---|---|
| `src/application/` | The Python application (APScheduler + DuckDB) — `src/application/CLAUDE.md` |
| `src/api/` | Flask: `create_app`, the `/api` blueprint, `/health`, RFC 9457 |
| `src/web/` | The v5 front (Vite + React 19 + TS) — `src/web/CLAUDE.md` |
| `tests/` | The Python suite — unit and E2E, all network-mocked |
| `website/` | The versioned Docusaurus site, bilingual by construction — `website/CLAUDE.md` |
| `CONTEXT.md` | The domain glossary: the v5 vocabulary |
| `docs/adr/` | The 41 structural decisions |
| `docs/v5-decisions.md` | The ticket-by-ticket narrative of the rewrite (archive) |
| `docs/agents/` | How the skills consume this repo (issues, labels, waves) |

## Commands

### The application

```bash
uv sync                                     # runtime + dev deps into .venv
uv run flake8 src/application src/api \
       --ignore=E501                        # lint — the two packages, never `src/`
uv run pytest tests/                        # unit + E2E, all network-mocked
PYTHONPATH=src uv run python -m application.boot   # run it
```

`src/` is the import root — `pythonpath = ["src"]` in a checkout, `PYTHONPATH` in
the image — and it holds two Python packages, `application` and `api`, beside the
front's own `web/`. The lint names the two rather than `src/`, which would walk
the front's `node_modules`.

`src/application/boot.py` is the only boot path: the web API and the scheduler
share one process, and that file holds the sequence — the environment, the store,
the app, the jobs, the socket, in one linear read. `main.py` has no `__main__`
block.

**It runs on macOS**, and that is new (ADR-0039). gunicorn always forked, and the
worker segfaulted the moment a scrape job ran — libcurl's `Curl_macos_init`,
reached through yfinance, reads the system proxy config via CoreFoundation, which
is not survivable after a `fork()` without `exec`. uvicorn is called
programmatically from `boot.py` and never forks, so there is no longer a
container to build in order to see the app work.

### The front

```bash
cd src/web && pnpm install
pnpm lint    # tsc -b --noEmit
pnpm test    # vitest, no network and no configuration
pnpm build   # → src/static/, served by Flask (git-ignored)
pnpm dev     # Vite on :5173, proxying /api and /health to localhost:8080
```

`pnpm dev` needs the API running — `PYTHONPATH=src uv run python -m application.boot`,
on a Mac too since ADR-0039. If it is not on 8080:
`SB_API_URL=http://localhost:9000 pnpm dev`.

### The site

```bash
cd website && pnpm install
pnpm start   # dev server (beware: the /docs redirect only exists in the build)
pnpm build   # every locale, fails on a broken link
```

Bilingual **by construction**: `locales` is `['en', 'fr']` and `/fr/` is published, but
`i18n/` holds `en/` alone — French lands through the first Crowdin import, and until
then `/fr/` serves the English source. Nothing under `i18n/fr/` is ever written by hand.

### The container

There is **no compose stack** — `docker run` is the canonical form.

```bash
docker build -t suivi-bourse:dev .
docker run -d --name suivi-bourse --restart unless-stopped -p 8080:8080 \
  -v suivi-bourse:/data suivi-bourse:dev

# The image contract is asserted in CI and runnable here:
IMAGE=suivi-bourse:dev .github/scripts/container-contract.sh
```

`--restart unless-stopped` belongs to the command since ADR-0039: nothing inside
the container respawns anything any more, so a process that dies takes the
container with it and the restart policy is what decides in the open.

**One mount** (ADR-0032): `/data` holds the store, and there is no second one.
A `.csv`/`.xlsx` is handed to the app by `POST /api/events/import` — from the
page or by `curl` — read once and never seen again; the first event can also
simply be typed.

## The architecture in one page

**One container, one process, one scheduler** — and since ADR-0039 that is
structural rather than guarded: the app does not fork, so there is no worker
count to refuse. `boot.py` reads the environment, opens the store, applies the
DDL, publishes the configuration, arms the jobs and serves, in that order, on one
connection that lives as long as the process.

Four workloads write to the store, each owning its own tables:

- **Scrape** — one self-rescheduling job per held symbol, cadenced by the
  market's `marketState`;
- **Ingestion** — not a job: the boot or a write, and it reaches the ledger
  through `entries.py` (ADR-0032);
- **Backfill** — reconstructs history (backward, forward and lateral passes) and
  applies the retention ladder;
- **Performance** — replays the ledger and rewrites the return series.

The front is a packaged SPA, served by Flask, which talks to the app through
`/api` and — for the header's bell alone — `/health` (ADR-0036, #819, #829).
There is **one interface and one socket** (ADR-0033): the exporter and its port
are gone, and `/api` is the front's interface rather than a contract held for
anybody else. `/health` is the container's own probe, read by the **bell**
because health is said in one place — and the bell is the app's one global
indicator since ADR-0037: its icon carries the health colour, its badge counts
every open entry, and the panel behind it holds health, installation facts and
advisories together. There is no banner and no status dot.

## The rules that are expensive to break

- **Declaration and derived state never share a row** (ADR-0006): every table has
  exactly one writer, and several tests assert that on the source. **`event` has
  one writer too, and it is `entries.py`** (ADR-0032): there is one population of
  rows, so a line that came out of a file is corrected and deleted like any
  other, and no code anywhere asks a row where it came from. **One named
  exception apart, `reassignment.py`** (#725): it rewrites the `account` column
  in bulk, addresses no row by its key, and is a module of its own precisely so
  that a reader counting the writers finds it. `tests/test_entries.py` names the
  two on the source, and there is no third.
- **The DDL is applied with `IF NOT EXISTS` and there is no migration
  machinery.** A new column would exist on no store created before it — so derive
  at read time rather than adding one.
- **The pure modules stay pure** (`scheduling`, `performance`, `carrying`,
  `retention`, `fx`, `boot_env`, `mounts`, `market_info`, `build_info`): no
  store, no yfinance, `now` injected.
- **The market is reached through one door** (#846): `market.py` holds the only
  `import yfinance` in the tree, and `market_info.py` — pure — is the only
  place a key of Yahoo's payload is read. Both are held on the source beside the
  purity guard, and a third rule joins them (#845): the app writes **no
  sentinel** for a field the payload does not carry, so the word it used to
  fabricate appears nowhere in `src/` nor in `tests/` — a fixture naming it
  would re-teach the belief that produced the defect.
- **There is one clock, and it is the product's**, and every read of it is
  UTC-qualified — `test_suite_conventions.py` holds that on the source. **And
  one repair of what comes back from the store**, in `instants.py` (stdlib only,
  so a pure view module can import it): `utc` normalizes an instant, `iso`
  serializes one and leaves a calendar day a day. The same file refuses a ninth
  private copy of it (#843) — by name for the repair, and by shape for the
  serialization, so a copy under a new name is refused too.
- **One faked *external* edge in the whole Python suite, and it is yfinance**; one
  on the front, and it is HTTP (MSW). The store is real, in `tmp_path`. Assertions
  about **behaviour** go on the store's contents, on the API's JSON or on the
  accessible rendering, never on the fact that a method was called. Internal
  doubles exist all the same, and for one thing only: **what the app decided not
  to do**, which leaves no trace to read. A job that was not armed, a query that
  was not run, a pass that ran once — those are asserted on the call, in
  `test_scheduling_wiring.py` (the APScheduler spy) and seven other files. Reach
  for one only when there is no row and no payload to look at.
- **A read in flight is not an absence** (ADR-0026): a block that waits renders
  nothing at all, title included.

## Where the rest is written

| Question | File |
|---|---|
| What is this thing called? | `CONTEXT.md` |
| Why is it done this way? | `docs/adr/`, then `docs/v5-decisions.md` |
| How does the backend work? | `src/application/CLAUDE.md` |
| How does the front work? | `src/web/CLAUDE.md` |
| How does the site work? | `website/CLAUDE.md` |
| What is left to do? | GitHub Issues (`gh`), v5 map #669 |

The sub-tree `CLAUDE.md` files are loaded **on demand**, when a file of that tree
is opened: the detail costs nothing until you work there.

## Contributing

- DCO sign-off required: `git commit -s`
- Conventional commits (`feat`, `fix`, `docs`, `deps`, `chore`, `refactor`)
- Version bumping is automatic (Release Please)

## Agent skills

- **Issue tracker** — GitHub Issues driven with `gh`, v5 map #669: `docs/agents/issue-tracker.md`
- **Triage labels** — the five canonical roles: `docs/agents/triage-labels.md`
- **Domain docs** — `CONTEXT.md` + `docs/adr/`: `docs/agents/domain.md`
- **Wave orchestration** — the scripts in `.claude/workflows/`: `docs/agents/wave-orchestration.md`
