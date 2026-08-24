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
| `app/` | The Python application (Flask + APScheduler + DuckDB) — `app/CLAUDE.md` |
| `app/web/` | The v5 front (Vite + React 19 + TS) — `app/web/CLAUDE.md` |
| `website/` | The versioned Docusaurus site, bilingual by construction — `website/CLAUDE.md` |
| `CONTEXT.md` | The domain glossary: the v5 vocabulary |
| `docs/adr/` | The 36 structural decisions |
| `docs/v5-decisions.md` | The ticket-by-ticket narrative of the rewrite (archive) |
| `docs/agents/` | How the skills consume this repo (issues, labels, waves) |

## Commands

### The application

```bash
cd app && uv sync                          # runtime + dev deps into .venv
uv run flake8 src/ --ignore=E501           # lint
uv run pytest tests/                       # unit + E2E, all network-mocked
uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
```

gunicorn is the only boot path: the web API and the scheduler share one process,
and `src/gunicorn.conf.py` holds the sequence. `main.py` has no `__main__` block.

> **Running it locally crashes on macOS** as soon as a symbol is scraped:
> gunicorn forks its worker and libcurl's `Curl_macos_init` (reached through
> yfinance) reads the system proxy config via CoreFoundation, which is not
> survivable after a fork without exec. Linux has no such init. On a Mac, build
> the image and run it.

### The front

```bash
cd app/web && pnpm install
pnpm lint    # tsc -b --noEmit
pnpm test    # vitest, no network and no configuration
pnpm build   # → app/src/static/, served by Flask (git-ignored)
pnpm dev     # Vite on :5173, proxying /api to localhost:8080
```

`pnpm dev` needs the API running — which on a Mac means the container. If it is
not on 8080: `SB_API_URL=http://localhost:9000 pnpm dev`.

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
docker build -t suivi-bourse:dev ./app
docker run -d --name suivi-bourse -p 8080:8080 \
  -v suivi-bourse:/data -v "$PWD/my-events:/import:ro" suivi-bourse:dev

# The image contract is asserted in CI and runnable here:
IMAGE=suivi-bourse:dev .github/scripts/container-contract.sh
```

`/data` holds the store, `/import` is the drop folder (optional, read-only).
Dropping a `.csv`/`.xlsx` in it imports it; with no `/import` at all, the first
event is typed in the app.

## The architecture in one page

**One container, one process, one scheduler** (`workers = 1` is a property of the
design, guarded twice). The boot is split either side of gunicorn's `fork()`: the
master opens the store, applies the DDL and publishes the configuration; the
worker opens its own connection and arms the jobs. The connection does not cross
the fork.

Four workloads write to the store, each owning its own tables:

- **Scrape** — one self-rescheduling job per held symbol, cadenced by the
  market's `marketState`;
- **Ingestion** — not a job: the boot, the drop-folder watcher, or a write;
- **Backfill** — reconstructs history (backward, forward and lateral passes) and
  applies the retention ladder;
- **Performance** — replays the ledger and rewrites the return series.

The front is a packaged SPA, served by Flask, which only ever talks to the app
through `/api`. There is **one interface and one socket** (ADR-0033): the
exporter and its second port are gone, and `/api` is the front's interface rather
than a contract held for anybody else.

## The rules that are expensive to break

- **Declaration and derived state never share a row** (ADR-0006): every table has
  exactly one writer, and several tests assert that on the source.
- **The DDL is applied with `IF NOT EXISTS` and there is no migration
  machinery.** A new column would exist on no store created before it — so derive
  at read time rather than adding one.
- **The pure modules stay pure** (`scheduling`, `performance`, `carrying`,
  `retention`, `fx`, `boot_env`, `mounts`): no store, no yfinance, `now`
  injected.
- **There is one clock, and it is the product's**, and every read of it is
  UTC-qualified — `test_suite_conventions.py` holds that on the source.
- **One faked *external* edge in the whole Python suite, and it is yfinance**; one
  on the front, and it is HTTP (MSW). The store is real, in `tmp_path`. Assertions
  about **behaviour** go on the store's contents, on the API's JSON or on the
  accessible rendering, never on the fact that a method was called. Internal
  doubles exist all the same, and for one thing only: **what the app decided not
  to do**, which leaves no trace to read. A job that was not armed, a query that
  was not run, a pass that ran once — those are asserted on the call, in
  `test_scheduling_wiring.py` (the APScheduler spy) and eight other files. Reach
  for one only when there is no row and no payload to look at.
- **A read in flight is not an absence** (ADR-0026): a block that waits renders
  nothing at all, title included.

## Where the rest is written

| Question | File |
|---|---|
| What is this thing called? | `CONTEXT.md` |
| Why is it done this way? | `docs/adr/`, then `docs/v5-decisions.md` |
| How does the backend work? | `app/CLAUDE.md` |
| How does the front work? | `app/web/CLAUDE.md` |
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
