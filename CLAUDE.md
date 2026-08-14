# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuiviBourse is a Python application that monitors stock shares using yfinance for real-time pricing and stores everything — the ledger, the positions, the prices and the performance series — in **one embedded DuckDB store** (ADR-0001). It supports historical data backfill for viewing past price evolution.

## Commands

### Python App (in `app/` directory)

```bash
# Dependencies are managed with uv (app/pyproject.toml + app/uv.lock).
# Install runtime + dev deps into a uv-managed .venv:
cd app && uv sync

# Run the app locally (requires an events folder at ~/.config/SuiviBourse/events/)
# gunicorn is the only boot path: the web API and the scheduler share one
# process (issue #651), and src/gunicorn.conf.py holds the boot sequence.
# `main.py` has no __main__ block.
cd app && uv run gunicorn -c src/gunicorn.conf.py 'web:create_app()'
# On macOS this crashes as soon as a symbol is scraped — gunicorn forks its
# worker and libcurl's macOS-only Curl_macos_init (reached from curl_easy_init
# in yfinance's HTTP backend) reads the system proxy config through
# CoreFoundation, which is unsafe after a fork without exec. Linux has no such
# init and is unaffected; on a Mac build the image and run it (below).

# Lint
cd app && uv run flake8 src/ --ignore=E501

# Run tests (unit + E2E, all network-mocked; no config or network required)
cd app && uv run pytest tests/            # add --cov=src for coverage
```

The v5 seam is **a real store in `tmp_path` with a faked yfinance** (spec #695):
the `store` fixture opens a genuine DuckDB *file* — never `:memory:`, since
DuckDB refuses a second process and persistence is part of what is asserted —
with the DDL applied and the seed in place. Assertions go on the store's
contents or on the API's JSON, never on the fact that a method was called; the
`mock_influx` fixture was the counter-example and left with `influxdb_writer.py`
at #700; `shares_validator` went with `schema.yaml`. **There is one faked edge
left in the whole suite, and it is yfinance.**

### Web UI (in `app/web/` directory)

The front is a packaged SPA (issue #659). It lives under `app/` because the
Docker build context is `./app`; it is **not** a pnpm workspace with `website/`.

```bash
cd app/web
pnpm install
pnpm lint      # tsc -b --noEmit
pnpm test      # vitest, no network and no configuration required
pnpm build     # → app/src/static/, which Flask serves. Git-ignored.
pnpm dev       # Vite on :5173, proxying /api to http://localhost:8080

# `pnpm dev` needs the API running. On a Mac that means the container, not a
# local process — #657: gunicorn forks and libcurl's Curl_macos_init then dies
# in CoreFoundation. Build it and run it (issue #743 — there is no composed
# development stack any more, and nothing replaces it). From the repo root:
docker build -t suivi-bourse:dev ./app
docker run -d --name suivi-bourse-dev -p 8080:8080 \
  -v suivi-bourse-dev:/data -v "$PWD/my-events:/import:ro" suivi-bourse:dev
# Then, back in app/web, point Vite at it if it is not on 8080:
SB_API_URL=http://localhost:9000 pnpm dev
```

The image builds the bundle itself in a first `node` stage and `COPY --from`s
`dist/`; the runtime image stays Python-only. `app/.dockerignore` keeps the
host's `node_modules` and a locally built `src/static` out of the context — the
latter would otherwise shadow the image's own build. The install layer copies
`package.json`, `pnpm-lock.yaml` **and `pnpm-workspace.yaml`**: pnpm 11 reads
its `allowBuilds` verdicts from the workspace file and `pnpm install` is what
asks for them, so leaving it out fails the build on `ERR_PNPM_IGNORED_BUILDS`
while every gate run *from* `app/web` stays green. A pull request touching
`app/**` now builds the image for that reason — it is the only gate that reads
the Dockerfile, which was otherwise built by the release workflow alone, i.e.
after the merge. Since #744 that build is the **first of nine assertions** of
the `Container` job (below) rather than a job of its own.

**The image separates what the app writes from what a human edits** (issue #742,
ADR-0015), and the whole uid apparatus that existed only because the two shared
a directory loses its cause: `chmod 0755` on `/home/appuser`, the
sticky-writable `.cache` and `ENV HOME` all become pointless the moment the
container runs as `appuser`, who owns their own `$HOME` — Debian's `HOME_MODE`
0700 is correct again, and the inherited PaaS hazard (a platform that records no
invoking uid landing on `1000:1000` by accident) has no subject left.

**Two of the three survived #742 as `TRANSITIONAL` lines, and #743 deleted them
with their subject.** They were kept because a foreign uid needs all of them or
none — the traverse bit (without it gunicorn's `chdir` dies before a line of
application code) and `HOME` (Docker gives `/` to a uid with no `/etc/passwd`
entry, which sends `ConfigurationManager`'s `expanduser` to
`/.config/SuiviBourse`, so ADR-0008's *named, never read* never fires for the one
population it exists for) — and the only thing that still ran a foreign uid was
the compose stack, which pointed `SB_STORE_DIR` **inside** the mount a human
owns and therefore ran the service under the invoking user's own uid. **#742's
first acceptance criterion was therefore deferred rather than half-met**, and it
is discharged here: the stack is gone, so `/home/appuser` is back to Debian's
`HOME_MODE` 0700 and `Config.Env` carries no `HOME=`. The third line — the
sticky-writable `.cache` — had already left with `ENV XDG_CACHE_HOME` at #742,
on an argument of its own that survives (below). Four things replace the
apparatus:

- **`/data` and `/import` exist in the image, empty and owned by `appuser`.**
  That is the mechanism, not a nicety: Docker initialises a fresh named volume
  with the content **and the permissions** of the image directory it covers, so
  a non-root container writes into a brand-new volume with no uid gesture
  anywhere. An unmounted `/import` is an ordinary state.
- **No `VOLUME` instruction.** It would have Docker create an anonymous volume
  on every bare `docker run`, making the trial run persist behind the user's
  back into a volume they cannot name — the opposite of a trial run.
- **A `HEALTHCHECK`**, in the image rather than in compose, so a plain
  `docker run` has one: `python -c urlopen(/health)` on `SB_WEB_PORT` (blank
  counts as unset, like `boot_env.text`; the runtime image ships no curl). It
  **touches the store**, because `/health` does, and **never the scheduler** — a
  wedged backfill is something `/api/runtime` displays, not something a probe
  restarts the container over. The `start-period` covers the store opening and
  deliberately not the reconstruction, whose ~25 minutes would otherwise read as
  *starting* on a container whose store never answers. **It only started
  applying at #743**: the stack's own file declared a `healthcheck:` block,
  which overrides the image's, so the one stack the repository shipped masked
  the one probe it had.
- **Two `--mount=type=cache`**, on the pnpm store (`$PNPM_HOME/store`) and on
  uv's cache (`/root/.cache/uv`). They serve **the contributor who rebuilds**;
  the cache that serves a PaaS starting from nothing is a registry cache and
  belongs to the release workflow. The layer order is unchanged, and `docker
  build ./app` still needs neither buildx nor a custom syntax directive.

**And that contract is attested rather than documented** (issue #744, spec #730
§ 7). `pr-checks.yml` carries a `Container` job — the heir of `Image`, which
built `./app` and stopped there — running
`.github/scripts/container-contract.sh` against the image it has just built:

```bash
docker build -t suivi-bourse:pr ./app
IMAGE=suivi-bourse:pr .github/scripts/container-contract.sh
```

**Nine assertions, and every one of them is on behaviour observable from
outside** — never on the shape of a line of `Dockerfile`, which breaks at the
first refactor **and passes on a broken probe**: the build succeeds; a bare
`docker run` boots and stays up; it says it keeps nothing **once**; a mounted
`/data` does not say it; `/health` and `/metrics` follow `SB_WEB_PORT` and
`SB_METRICS_PORT` while `SB_PROMETHEUS_ENABLED=false` leaves the second socket
unbound; `sb_store_ephemeral` is `1` bare and `0` mounted; the effective user is
not root and `/data` is writable; a `HEALTHCHECK` is declared **and the
container reaches `healthy`**; and `SB_INGESTION_INTERVAL=42` produces the
grouped notice and changes nothing else. It is in CI rather than in `pytest`
because its subject **is** the image: a Python test that simulates a container
attests the simulation.

Five things about the script are decisions:

- **Each assertion fails for its own reason**, which is what forced liveness and
  greenness apart: waiting on the image's own probe would have made a deleted
  `HEALTHCHECK` report as *"the bare container does not start"*. So assertion 2
  waits on `/health` and assertion 8 waits on `docker inspect`.
- **The declaration is read as `Healthcheck.Test[0]`**, not as the presence of
  the object: `HEALTHCHECK NONE` leaves a `Healthcheck` behind whose test is
  `["NONE"]`, so a truthiness check passes on an image that has explicitly
  disabled its probe — the regression the assertion exists to catch.
- **The grep is on the logfmt `condition=` key**, never on the sentence: the key
  is #741's contract, the wording is not. Assertion 9 is anchored on the
  emitting function's name in `location=`, because the advisory (#709) names the
  same variable on another line.
- **The unbound metrics socket is asked from *inside*** (`docker exec … python
  -c socket.create_connection`): a published host port whose upstream is not
  listening still completes a handshake with the userland proxy, so probing it
  from the runner confuses *unbound* with *refused later*. Python does the
  asking because the runtime image ships no curl — which is also why the
  `HEALTHCHECK` is a `python -c`.
- **Everything created carries one label** and is removed from an `EXIT` trap,
  so a failed assertion leaves nothing behind; the workflow repeats the query
  under `if: always()` for the runner killed between two `docker run`s. The job
  builds `linux/amd64` alone — multi-arch is the release's business and QEMU
  would multiply a pull request's check by five — and it pushes nothing, logs
  into no registry and holds no credential.

**The v5 front is a walking skeleton** (issue #713, spec #712): the harness, the
theme, the two catalogues and the shell, with the four routes reachable and the
four pages still placeholders — they are **redesigned, not ported**, one ticket
each, and **all four have landed since**: the dashboard's head (#718), the shares
page (#719), the data page and its second tab (#723, #724) and the accounts page
(#721), which took `PendingPage` with it. Four things about it are decisions, not
defaults:

- **One test seam, the outermost.** The real router, the real pages, the real
  catalogues, the real theme and a real `QueryClient` mount in jsdom; **HTTP is
  the only faked edge** (MSW), which is the exact parallel of `tests/test_e2e.py`
  (real runtime, faked yfinance). `src/test/factories.ts` is one *parameterised*
  factory in the taste of `conftest.py`'s `fake_ticker`, and it covers the three
  shapes the real portfolio cannot show — N ≥ 3 accounts, a held position in a
  foreign currency, a held position with no price. No fixture carries a real
  symbol, amount or label. Assertions are on the accessible rendering — never a
  class, a component name, or a DOM snapshot.
- **`index.css` has exactly three blocks** (ADR-0023): the tweakcn `Vercel`
  primitives, **never hand-edited** and regenerated with `pnpm dlx shadcn@latest
  add https://tweakcn.com/r/themes/vercel.json`; the domain layer, which holds
  only what the preset cannot say (`--price` = `--chart-2` and `--grant` =
  `--chart-1` verbatim, `--dividend` and `--attention` added, `--loss` distinct
  from `--destructive` and lower in chroma); and an `@theme inline` bridge, so
  `text-gain` is written like `bg-card`. The twelve `--alloc-*` are **generated**
  in `lib/alloc.ts` and written onto the root element by `ThemeProvider` — rank 1
  is the most contrasted on **both** grounds, which is why the lightness ramp
  reverses between them.
- **The theme and the language are the reader's two preferences, one mechanism**
  (ADR-0024): three states each (`light|dark|auto`, `fr|en|auto`), absence
  meaning `auto`, two `localStorage` keys of identical shape, and **no dial in
  the store** — the app asks one question at first run, and that one is not it.
  The catalogues are ICU, one JSON per language, keyed semantically, English the
  source. Numbers and dates follow the **language**, not the currency: `LOCALE`
  is gone and the eight `Intl` sites take a locale. The front branches on
  `problem.type` and renders `detail` nowhere.
- **The shell is shadcn's `Sidebar`** (ADR-0022) — `collapsible="icon"` wide, a
  drawer under 768 px, nothing hand-written for the narrow case — plus the
  **content header bar** carrying four objects on all four pages (collapse,
  status dot, language, theme), and a banner that lives *in the content column*
  and shows **one band or none**. `lib/api.ts` is the only module that knows a
  URL, and the paths it exports are what the test handlers fake.

**The three shared primitives, and the dashboard head that consumes them first**
(issue #718, ADR-0016, ADR-0018). They arrive together because each of the three
repairs a *measured* defect rather than anticipating one:

- **`Explain`** — the convention bubble, which did not exist at all: the whole
  product explained itself through two `title=` attributes, one second of delay,
  unstyled, and **absent on touch**. One bubble, **one text** (what the figure
  means, the rule it rests on, the link), opening **on click and never on
  hover** — hover does not exist on a finger, and click is also what lets the
  reader walk to the link inside. It **closes on scroll** and opens **beside**
  its figure: a bubble must not outlive its subject, and both boards mounted it
  over the very numbers it explained. The link is the front's **first `href` to
  the outside** and carries version *and* locale (`lib/docs.ts`,
  `/{fr/}docs/v5/read-your-figures#<anchor>`); the ten anchors are a contract
  with `website/docs/read-your-figures.mdx`, hand-written on every heading there
  because a *derived* anchor moves with a reworded title, the front sees
  nothing, the site still builds, and every bubble lands at the top of the page.
- **`Stat`** — the *figure + label* pair, **one** where the prototype had four:
  `Stat` copied three times plus a fourth component, `Summary`, **with no slot
  for a hint** — and it was `Summary` that carried `Plus-value latente
  335,22 €`. The most wrong figure in the product sat on the only component
  incapable of explaining itself, so the slot is the reason the primitive
  exists. Three weights (`head` / `term` / `stat`) because subordination is
  vertical and a total never shares a line with its terms.
- **`EmptyState`** — one, where eight were written by hand `<Alert>` by
  `<Alert>`. It replaces them **as the pages land**, never in a sweep across
  pages being rewritten anyway. It says a thing is **empty** and never that
  something failed: a failure is a **band**, and the two must not look alike.
- **`Band`** — the band in one spelling, mounted twice. The shell's `Banner`
  puts the full-bleed one at the top of the content column for what is true of
  the installation; a **page mounts its own, in place, for a read of its own
  that failed**. That second mount is not symmetry: `/api/runtime` answers from
  process memory and never opens the store (#668) — the very property that keeps
  the status dot alive through a database outage — so the shell is **silent** on
  the one failure that empties a page's figures. The head rendering `null` there
  made *"the store is unreadable"* and *"you own nothing yet"* one screen, in the
  worst form: a blank one. `lib/status.ts`'s `readConditions` holds the causal
  order across the two — a page says nothing while the shell's band is up — so
  **one band on screen or none** stays true by construction.

Three pure modules go with them and hold what a component must not decide:
`lib/absence.ts` (the **four** renderings under *the em dash means there is
nothing to compute; anything merely missing is named* — and the fourth case
reports **its count**, never *« jamais »*, which is not computable),
`lib/sign.ts` (where **zero stops rendering as absence**: neutral in colour but
in the *colour of text*, since a sold row carries `0,00 €` and `—` side by
side), and `lib/gain.ts` (ADR-0018's identity). **No row-marker component is
created** — *a per-row marker that does not discriminate is noise however
correct it is*, and two independent tickets produced that defect under two names.

**`absence.ts` is the classification, and `gain.ts` calls it rather than holding
a second one.** That is the whole of what makes the rule a rule: written twice,
the copy loses a branch. `positionTerms` held *quoted with no rate* and *no
quote at all* inline — `absenceCase`'s second and third cases, **minus its
first**, `quantity === 0`, which that module tests first and unconditionally
because ordering it last is how *sold* and *broken ticker* collapse. One line the
owner closed years ago, still carrying a `symbol_quote` price with no resolved
rate, therefore turned the gain of the **entire portfolio** into an absence —
the exact failure the four-term computation exists to prevent. And a sum carries
its **reason** rather than a bare `null` (`Unrealised`), because a caller holding
only the nullity can write nothing but an em dash — which by ADR-0016 says
*there is nothing to compute* about a rate the app fetches by itself. The three
`Rendering` constants are exported for that: a total wears the same one as a
cell, and `absence.awaitingRate` stays in one file.

The head itself **computes `Gain total` from its four terms and never reads
`portfolio_totals.gain_absolu`**, which is the same number written down
elsewhere; three of the four terms come off `/api/positions`, so a global row
that cannot be written no longer blanks the headline. The fourth term — the fees
a broker takes out of a transfer — **renders only when it is not zero**, colour
goes only to the two terms that can change sign, the statistics **shrink**
instead of filling with dashes, and there are **four icons in the block, not
nine**. The year-to-date is **two figures that never share a line**: the euro
under the head, the percentage inside the TWR statistic (measured `+40,69 €`
against `−1,25 %`, opposite signs over the same period and both correct). The
`1S / 1M / 1A / —` selector does not exist.

Being two figures is also why **both** of them carry the rebuild's sentence.
They are kept apart on purpose, so a reader looking at one never sees the
other's caption, and a bare `—` on the percentage says — by this ticket's own
rule — *there is nothing to compute*, when what is going on is a history not
rebuilt that far back yet. **A read that has not landed is not a fact**, and the
rule splits the block's four reads in two. `positions` and `portfolio-totals`
are *needed*, so the head waits for **both** before rendering anything: the
sentences it writes are about the totals as much as about the positions, so
letting one land first turned *not arrived yet* into a statement — *« un grand
livre d'événements datés ajouterait… »* printed under a portfolio that has one,
for as long as the second request took, then a headline swapped for another
number under the reader's eyes. `accounts` and `runtime` are *optional*: their
absence removes a line instead of falsifying one, which is why they keep a
`?? null` and the required pair does not. **And there is no skeleton** — the
block renders nothing until both land, deliberately: P1 is a DuckDB query on a
local file (0,43 ms measured), so a placeholder would flash for a few tens of
milliseconds, which is worse than an instant. If it ever stops being true it
stops being true on all four pages at once, so the skeleton arrives **once, in
the shell**, the way `Band` did — never local to one page, which is how a
product ends up with four loading conventions. The perimeter line under the
consolidated
figures is **not written at all** while the accounts read has not landed:
ADR-0013 seeds a `default` row that is never removed, so `0 compte` is a state
the product declares impossible, and it was being printed as the statement of
the gain's own scope.

Two members joined the HTTP contract for it, announced on #745 before being
written into `lib/api.ts`: **`GET /api/portfolio-totals`** (named after the
store's table, never after the page) and **`runtime.rebuilding`** — the latter
on the app-state resource rather than beside the figures, because the fact it
decides is *is the TWR's base date still moving*, which is a property of this
process.

**And the server half of that head is #763.** #718 merged without it — its
acceptance criteria did not name a route, so the adversarial reading counted 23
of 23 in good faith — leaving `DashboardHead` mounted over two `404`s, i.e. a
page that had gone from *not built yet* to *the app is not answering*. Three
things about the pair that now serves it are decisions:

- **`GET /api/positions` is shaping**, `store_reads.positions()` being P1
  already: one row per `(account, symbol)`, folded nowhere, a **sold** line among
  them (ADR-0017) and a never-fetched symbol as a row whose two market objects
  are `null` rather than as a missing line. `price` is the quote in **its own**
  currency and `converted` the same observation in the reporting one with the
  rate that got it there — two objects, because *quoted with no rate* and *no
  quote at all* are two absences and a single nullable number cannot carry both.
- **`GET /api/portfolio-totals` is not.** The DDL carries eight columns and the
  contract asks for eleven, so `twr_since`, `transfer_fees` and `ytd` are
  **derived at read time**. What settles it against a ninth column is the store's
  own rule: the DDL is applied with `IF NOT EXISTS` and there is **no migration
  machinery**, so a new column would simply not exist on any store created
  before it — and every install of that vintage would answer a binder error to
  the named `SELECT` ADR-0001 exists to make safe. The cost accepted is that a
  resource named after `portfolio_totals` reads the `event` table, once, for the
  fourth term. `transfer_fees` is **negative** where it is produced, never
  subtracted by its caller — the whole interest of the figure is that the four
  terms add up — and it is bounded by the row's own day, which is what keeps
  ADR-0018's identity between figures measured at the same instant.
- **The year-to-date counts from the last day at or before 31 December of the
  previous year**, never from the first day on or after 1 January. Both rows
  exist whenever the series reaches the previous year (it is dense over calendar
  days), so the choice is not settled by availability: the base has to be a state
  the measured year has **not touched**, or 1 January's own move is silently
  outside the figure. `ytd: null` therefore means *the series does not reach the
  base* — the one state the reconstruction degrades — and never *a sum failed*;
  `test_web_api.py` pins `+40,69 €` against `−1,25 %` to the cent, opposite signs
  over one period and both correct. **And the identity of the four terms is
  pinned end to end**, on a ledger carrying a transfer fee, with the perf cache
  written by the real job rather than seeded: `transfer_fees` is derived from
  `event` while `net_contributed` is computed in `performance.py` from the
  `Timeline`, so two modules state what a cash movement is, and the sum is the
  assertion that keeps the two statements from drifting apart — the symptom
  otherwise being an identity that quietly stops holding, on the page that
  exists to show that it holds.

**#719's three members are served by the same ticket** (#763's enlargement),
because it is the same work on the same two files and a ticket per page that
rediscovers it has to write its own route is the pattern the map has now seen
three times:

- **`position.closed_at`** — the day the line reached zero, `null` while it is
  held and `null` again after a buy-back. Derived **in P1's own query** (a
  `LEFT JOIN` on the last `SELL`, under `CASE WHEN quantity = 0`), never a
  thirteenth column on `position`, for the argument that decided `transfer_fees`:
  no migration machinery, so a new column simply would not exist on a store
  created before it. The shares page's folded section **sorts on it** and it is
  the only column that discriminates those rows — market value is zero across
  the whole section, and a column of zeros orders nothing.
- **`GET /api/prices/<symbol>?window=`** — a **new** resource, not a rename of
  `/api/shares/<symbol>/prices`, which goes on serving until the page reading it
  is rewritten. The window is a **rung of the retention ladder** (`1M` / `1Y` /
  `2Y` / `MAX`, ADR-0010), an unknown one is a `422` and never a fallback, and
  `resolution` states the **coarsest of the bucket applied and the rung
  traversed** — announced once, so the chart's *aggregated by X* caption reads a
  field instead of stating a second bucketing of its own. A point whose
  conversion never resolved is `price: null` and **never a missing point**,
  which is what makes `chart_series` a third reader beside `raw_series` and
  `bucketed_series` rather than an argument on either: a weekend and an
  unresolved rate are two different pieces of news, and only the second repairs
  itself (#704).
- **`ytd: null` is rendered by its real cause.** Two of them — the
  reconstruction has not reached January, **or** the portfolio is younger than
  the year — and the head wrote one sentence for both, announcing a rebuild to
  somebody with nothing to rebuild. The discriminant is `runtime.rebuilding`,
  already on screen four lines above for the TWR's base date; no fourth kind of
  absence is invented (ADR-0021). The young-portfolio sentence needs a
  **positive** observation (`rebuilding === false`), #709's third-answer rule
  applied: a runtime read that has not landed says nothing about this process,
  and *your ledger does not go back that far* is a claim about the reader's own
  data.

**The shares page: the header sums its lines, so the closed ones fold** (issue
#719, ADR-0017, ADR-0016). It is the page the dev actually opens, and it carried
the most wrong figure in the product — `Plus-value latente 335,22 €`, holding
**−1 288,32 €** of phantom loss from three closed positions valued at `0,00 €`.
What repairs it is a **coupling**, and that coupling is the ticket:

- **What is written over a table is read as that table's summary**, and no note
  undoes the reading. Coupled with a *hide the closed ones* switch, that makes a
  **second correct figure**: hiding the seven closed lines moves the total from
  `+977,61 €` to `+1 686,53 €` — the sum of the three terms over the live lines
  alone — with nothing on screen saying which one equals `gain_absolu`. So the
  closed positions never leave the table: they **fold**, the fold is not a
  filter, and the header does not move when the section opens. There is no
  *hide* switch anywhere. The gap was **708,92 €, 73 % of the figure shown**,
  over seven lines out of nineteen, and it only grows with the age of an install.
- **The folded section is not the live table with empty cells.** Its columns are
  its own — `Titre · Soldée le · Réalisée · Dividendes · Compte` — because price,
  quantity, unit cost and latent gain are an em dash on every one of its rows;
  it **sorts on the closing date, descending**, market value being zero across
  the whole section (a column of zeros orders nothing); and it is **closed on
  load with its two figures already on its summary line**, so opening it is an
  intention rather than a discovery.
- **Nine columns live**, `Titre · Cours · Détenu · PRU · Valorisation · Latente ·
  Réalisée · Dividendes · Compte`, the percentage a **second line** under the
  latent gain. `Écart unitaire` **dies** — it is `Cours − PRU`, two columns
  already on the same line, and nil by construction on a position carried at its
  cost; `Investi` does not come in (`Valorisation − latente`); and there is **no
  fourth `Gain total` column**, the header being their sum, checkable by eye. The
  label stays **`PRU`**, the word read at the broker — *PMP* names the rule, and
  stating the rule is what ADR-0016 gave the icon for a job.
- **Nine icons, five on the header block and four on the column headers.** The
  rule is *one per figure and **per surface***, the two being deliberately two
  surfaces (a table is read scrolled, with the page's header off screen), and the
  folded section is **not a surface** but a part of the page — which is what
  takes eleven candidates down to nine (#684 D7). The `Gain total` bubble is the
  one on the page that must state a **scope**: it counts the closed positions,
  and it can never carry ADR-0018's fourth term, the fees a broker takes out of a
  transfer belonging to no security. That is why this figure and the dashboard's
  can differ, and the reader is told so rather than left to discover it.
- **The exception marker is not a column** and the market pill is dead: eleven
  rows rendered ten identical *Marché ouvert*. What is left is an icon on the
  `Titre` cell of a share **the app** cannot price — the single exception
  ADR-0016 allows to *icons never go on a cell*, its text being a repair — plus a
  **counter in the page header that *is* the filter at a click**. It fires zero
  times on the real portfolio, and the header is the only place where the
  **absence** of an anomaly reads as information rather than as a void.
- **One mention of the date, at the level of the page** (*Cours au 7 août 2026,
  17:42*), never a column: a table of money with no date reads as *now*, and the
  rows that depart from it already say so by the absence rule.
- **A row is a symbol, not a holding.** `lib/shares.ts` folds `(account,
  symbol)` into one line; the model stays multi-account — the same ETF on a PEA
  and on a CTO is the most ordinary case of the domain, and that none of the
  nineteen real symbols shows it is **contingent** — so it is the *rendering*
  that bends: one account is plain text, never a list of one. The same module
  holds the rule a component would otherwise re-decide per cell: **the failure
  counter is a rendering concern and never an arithmetic one**, so a ticker the
  app has asked N times and got nothing from renders *N consecutive readings, no
  price* in three cells and is still carried at its cost in every sum. Written
  the other way round it would subtract its whole basis from the portfolio's
  value the day its quote went missing.
- **The chart's presets are the rungs of the retention ladder** — `1M / 1A / 2A /
  MAX` (ADR-0010) — so changing the range changes the resolution *visibly*; `3M`
  changed nothing. And the *aggregated by X* caption **reads the resolution the
  API announces** instead of naming a bucketing of its own: two announcers on one
  graph is the defect the map found independently on four pages. The chart lands
  in the share's sheet as its **first tenant**; the naked form, the event list
  and the selection that links it to the markers are #720's.

Three members joined the HTTP contract with it, the front being written **in
front of** the store: **`position.closed_at`** (the folded section sorts on it,
and a position carries a quantity, never the event that emptied it),
**`GET /api/prices/:symbol?window=`** and its announced **`resolution`**.

**The share's sheet: ADR-0016's form naked, and the liaison is a selection**
(issue #720, ADR-0016, ADR-0017). The sheet **shrinks, and the room is not
filled back in** — `RuntimeDetail` (a per-account backfill readout on a
*security*'s card, answering a question `/api/runtime` has a page for), the
per-account breakdown when it would have one line, and `Variation`, the
percentage already glued to the latent gain in the table. Three things about
what is left are decisions:

- **`Gain total` dominates its three terms because it is a block**, and the
  nesting *is* the statement: the terms are rendered **inside** the total's own
  group. That is possible here and nowhere else on the page for a reason of
  geometry rather than of taste — a table row has the horizontal axis and
  nothing else, so a total mounted beside its terms is four numeric figures of
  equal weight and nothing says the last three are inside the first. The
  position facts — `Cours · PRU · Détenu · Valorisation · Investi`, `Investi`
  being the `Valorisation − latente` that stayed off the table — drop behind it.
  **Five bubbles**, and `Cours` / `Valorisation` carry none for the reason the
  table's own headers do not: the carrying rule is stated once, on the page
  header this sheet was opened from.
- **The breakdown does not exist at one account** (`accountBreakdown` answers
  `[]` there, the rule living beside the arithmetic rather than in a component),
  and comes back the moment a share is held on two — the ordinary case of the
  domain, contingently absent from the nineteen real symbols. Each of its lines
  is a `ShareRow` of one account, so every figure on it is the same function the
  folded row uses and the breakdown cannot drift from what it decomposes.
- **The liaison between the chart and the list is a selection**, amending
  #675/D2's *hovering a line lights its point* on ADR-0016's own argument: hover
  does not exist on a finger and says nothing to a keyboard. **The unit of the
  selection is the day**, which is what makes *several lines when the marker
  announces `×3`* true by construction rather than by a second rule — a marker
  cannot grow for a third of itself. The collisions are measured, not
  hypothetical: one real symbol carries `×2`, `×2`, `×3`, `×3` over four days,
  so **one marker per day announcing its count** and never three points merged
  in silence. The markers are a **band under the plot rather than dots inside
  it**, for two reasons: a marker has to be a *control* (clicked, and reached by
  keyboard), and `lib/shares.ts` gives each day the **rank** of the point it
  names so there is **one** statement of the x-axis — the rule the resolution
  caption already follows one line above. The rank and not a fraction of the
  elapsed span: the chart draws on Recharts' **category** axis, one step per
  point whatever the interval before it, so a span fraction is a *second*
  abscissa. The two agree to ~0,5 % on `1A / 2A / MAX`, where only the weekends
  are missing, and part company on `1M` — whose rung is the raw series, where
  the live scrape writes a point every 120 s in session and the reconstruction
  one per hour or per day, a density varying by a factor of ~25 inside one
  window. A three-week-old event then lands under the curve of six days ago,
  i.e. the liaison this ticket exists for points at the wrong place. The window
  bounds them, so changing the range changes what is announced.

One member joined the HTTP contract with it and **its server half is in the same
ticket**: **`position.fundamentals`** — the instrument's own attributes
(`currency`, `exchange`, `quote_type`, `dividend_yield`, `pe_ratio`,
`market_cap`), which P1 already selected and nothing published. It rides on the
holding's row the way `price` does and is **read, never summed** (holding the
same ETF on two accounts does not double its market capitalisation). Its two
absences are two: a `null` **member** is the ordinary one — yfinance publishes
no `pe_ratio` for an ETF, and `quote_type` beside it is what makes that legible
rather than suspicious — while the object being `null` is the symbol the fetch
has never reached, and the sheet then draws **no block at all** rather than five
em dashes (#724's *a block with nothing in it does not exist*). `exchange` is in
there rather than left out as decoration: ADR-0004's one surviving
mis-valuation is an Amsterdam execution priced against the NASDAQ quote of the
same company.

**The data page: a revocation surface, not a repair one** (issue #723, ADR-0020,
ADR-0005). #662's whole apparatus — the inline editor, the opaque token over
`(file, sheet, row)`, the content fingerprint as an `ETag`, its `409` and
*invalid → invalid allowed* — existed because the faulty line lived **in** the
truth. With the store as the truth a bad file is not imported at all, so it
loses its subject in one go and **none of it has a row-by-row successor**: the
unit of the gesture is the import (#728). What this ticket lands is **two tabs
under one route** — *Le grand livre* and *L'installation*, split by what the user
**declared** against what the installation **is**, which is ADR-0014's boot test
transposed to the render — with the first in its journal half.

Two of its decisions were taken **against** the interview, both in front of a
board mounted on the 285 real events:

- **The identity column is not `Titre`.** The interview had the free-text label
  leaving the table, *"empty almost everywhere"*; measured, **278 rows of 285**
  carry one (median 36 characters, 101 distinct values), and a `DEPOSIT` has no
  symbol at all — `Apple Pay Top up`, `Incoming transfer from BRISSAUD` — so
  there the label **is** the identity. One column does the work for both
  families of event, in place of a `Symbole` empty 105 times out of 285 doubled
  by a `Notes` truncated one row in two. `Nom` leaves instead: a security's name
  is an attribute of the security, not of each of its 285 events. And the
  full-text search stops being a convenience — on nineteen purchases of the same
  ETF the label is the only discriminant a row owns — which is also what pays
  for **no pagination**: « page 4 sur 6 » means nothing on an axis of dates.
- **The padlock is not a column.** Rendered, read-only-per-row gave 285 identical
  locks on 285 rows, and nothing replaces it because nothing has to: *a row that
  carries a provenance came from a file; a row that carries none was typed here*.
  The information was already in the one column that discriminates. The editor
  therefore survives **only** on a row with no provenance **and a key to address
  it by**, which on an install that has only ever imported is never — and it is
  the row's own name that carries it, never a tenth column whose heading would
  appear on a table where no row can use it.

Four more things about it are decisions:

- **The provenance is a label, never an address**, and never the file's presence
  on disk: the drop folder is an optional read-only bind (ADR-0015), so *file
  not found* would be a permanent false defect. It is composed **in the front**
  from the file's name — a rendering follows the reader's language (ADR-0024),
  and the store's own `2024.csv, row 14` is kept as a fallback only.
- **The create form is the onboarding** (ADR-0005), so it asks **the type
  first** — six labels stating their *effect* (`Achat`, `Vente`, `Attribution`,
  `Dividende`, `Versement`, `Retrait`, and `Free shares` / `Cash in` /
  `Cash out` in English) and never the six codes — then shows **only** the
  fields of that type: a transfer names no security at all, and a `GRANT`'s unit
  price is the one field in the product whose **emptiness is a statement**. It
  lives in a **lateral panel** because the form *changes shape* after the first
  choice and an editable row cannot.
- **Two ADR-0016 icons on the page and zero in a table**: on the `date` label —
  extending the instrument from *the figure displayed* to *the entry that
  produces it* is the one place where *returns are computed from the dates of
  your events* arrives while it can still change a behaviour — and on a grant's
  unit price.
- **`<input type="date">` stops discarding in silence**, and the repair is *one
  sentence for two states*: the field hands back an empty string both for what
  was never typed and for what it could not read, the value being destroyed
  before any code sees it, so the form names the trap rather than guessing which
  happened — and records nothing. `lib/ledger.ts` owns that parse and the
  decimal one beside it (`<input type="number">` drops a decimal comma exactly
  as silently, in a form whose French reader types one).
- **At zero events the ledger block is replaced by two entries of equal
  weight** — drop a file, or type a first event — and never by an empty table
  with a small button over it. `EntryPair` is a **shared primitive** beside
  `Stat`, `EmptyState` and `Band` for one reason: the first-run modal's last
  step is that same pair (#726), and a second design of it is what the criterion
  forbids.

The ledger is read through the shape **`GET /api/events` already serves**, field
for field — #718 mounting a head over two routes nobody had written is what
#763 had to repair, and a client that renamed the members would render an
**empty ledger on a full install**, which is worse than a `404` because it reads
as a fact. Three members are additions, the first two optional so today's server
renders the page whole: **`source_filename`** (the label follows the reader),
**`event.id`** (a row typed here is the one kind that can be edited, and editing
needs an address), and **`POST /api/events`**, without which the create form has
nowhere to write.

**And the server half of that page is #764**, the fifth time the map has seen a
page ticket declare a contract nobody serves — #713, #718, #719 and #763 being
the first four, and the mechanism is stable rather than negligent: *a page
ticket's acceptance criteria do not name a route*, so an adversarial reading
counts them all met in good faith. #723 was the first to write the deferral
down (in `lib/api.ts` and here) instead of leaving it in a hand-over message,
which is what this ticket answered. Four things about it are decisions:

- **The population is the whole subject.** `forget_import`'s docstring said the
  absence of a `PATCH /api/events/<id>` was *a decision rather than an
  omission*, and that argument is about a row **a file provisioned**: the file
  and the store must not become two truths about one purchase, so revoking the
  file is what is offered instead. It never covered a row somebody typed here a
  minute ago — which comes from no file, which no revocation can reach, and
  which ADR-0005 makes the *first* gesture of a new arrival. Refusing to edit
  that one made a typo in the onboarding permanent. So the sentence is now
  **imprecise rather than false**, it names its population, and `PATCH` /
  `DELETE /api/events/<id>` refuse an imported row by name (`409`, quoting the
  import to forget).
- **The split is structural, not a comment.** `entries.py` owns the three row
  gestures and writes only `source_id NULL` rows, the way `accounts.py` owns the
  app's half of the `account` table — so *"the import path has no row-level
  write"* stays true by inspection, and `test_ledger.py`'s assertion on
  `ledger.__all__` keeps standing rather than being weakened.
- **`event.id` descends into the snapshot**, and the alternative — the resource
  reading the store — was open and is refused **by its error contract**.
  `GET /api/events` answers from process memory, so it has no `503`: the shares
  page's chart markers read it and would otherwise go down for a fault they read
  no ledger about, and the rows served are by construction the ones the
  aggregator ran on. It cannot go stale either, since every writer of `event`
  replays synchronously in this process. The export keeps the opposite contract
  on purpose (#710): a backup is of what is **stored**, a snapshot the validator
  refused leaving the previous one standing. Two resources over one table, two
  contracts, each argued where it is chosen. The key is served as **text** — a
  `BIGINT` above 2^53 is not the number that was sent, and a client does no
  arithmetic with an address.
- **Validation keeps one owner, and the parse is not a second one.**
  `events/validator.py` judges a typed event and an imported one word for word —
  the ledger is replayed whole on every build, so a row one road let through
  would fail the *boot*, in the gunicorn master. Its refusals now carry the
  **field** they are about (`ValidationIssue`), which is what lets a `422` mark
  an input instead of printing a paragraph. What the HTTP boundary owns is the
  *parse*, exactly as `EventLoader` owns a CSV cell's: `2026-02-31` has the
  shape of a day and is not one, and that rule is observable **from the server
  alone** — `<input type="date">` empties its own value before any script sees
  it. One member the form never sends is settled by the store rather than
  invented by the client: the security's **name**, read off whatever the ledger
  already calls that symbol and falling back to the ticker — the argument that
  took `Nom` out of the table (ADR-0020) applied to the write path, and what
  keeps *name is required* one rule for both roads instead of a refusal the form
  could never satisfy. **The account is not that second member**, and the
  ordering is what makes it so: a blank one means `default` *until something is
  declared and is an error afterwards* (#698), so the blank is what the
  validator judges and it is resolved only **at the write**, `event.account or
  DEFAULT_ACCOUNT`, exactly where and when `ledger._insert_events` resolves it.
  Resolved before the validator instead, the rule fires on the file road alone:
  an install declaring `pea` answered `201` to a body with an empty account and
  grew the phantom `default` — all-zero figures on a third account nobody
  declared — where the same row in a file is refused whole.

`app/web` is **unchanged**: the client contract was already written and faked by
MSW, and this ticket makes it true. One thing measured on the dev stack is
worth writing down because no test covers it: on an install that has declared
**no** account, `GET /api/accounts` answers `[]` (the seeded `default` is not a
declaration, ADR-0013), the form's account `<select>` is therefore empty, and
its own client-side check blocks the save before a request leaves — so the
onboarding form is unusable on exactly the install ADR-0005 wrote it for. That
is a front defect on #723's side of the seam and it belongs to #729's accounts
work; the server has never refused the body. **#729 took it up**, and both
halves of the sentence turned out to be one repair (below).

**The declaration of the accounts, on the same tab and in the ledger's own
shape** (issue #729, ADR-0013, ADR-0002, ADR-0020). It is the same thing said
about another table — *what the user declared* — so it is the ledger's form
rather than a second one: no padlock column (a row carrying a provenance came
from a file, a row carrying none was declared here), a lateral panel and never
an editable row, and the affordance is the row's **own name**, a button exactly
where the row may be edited and plain text everywhere else. `lib/accounts.ts`
grows the rules rather than a second module beside it, `#721`'s comparison
arithmetic already living there. Five things about it are decisions:

- **The form loses `currency`.** ADR-0002 deleted `Account.currency` rather than
  converting it — two currency levels, the reporting one and the security's
  quote, and not three — so *an account whose positions disagree with its
  currency* has no referent to be a bug about. The page built during the
  prototype still carried the field; there is no column for it either.
- **A removal that cannot happen is absent and names its reason** — *« 71
  événements nomment ce compte »* — never present and refused. The interface's
  obligation is the opposite of the API's: a control the app knows will be
  refused teaches nothing by being there, while the count is the exact thing the
  owner has to act on. `removalOf` holds the classification in
  `accounts.delete_account`'s own order, the events before the file on purpose:
  both apply to a file-provisioned account an event names, and only one of them
  is actionable, forgetting the import being refused in cascade for the same
  reason. The count comes off the ledger this tab has already read, and the
  block is withheld until that read lands — *not arrived yet* must not render as
  *nothing names this account*.
- **The server serves the seeded row, and the front synthesises nothing.**
  `list_accounts` answered `{declared: false, accounts: []}` on an install that
  declared nothing, which is a resource answering *none* to a question ADR-0013
  says cannot be answered that way. The consequence was not cosmetic: `default`
  is the only account a fresh install has, so it is the only one there is to
  rename, and a payload that never carried the row made the rename **invisible**
  — the store held `Mon PEA` while every page re-drew a row it had rebuilt from
  nothing. `declared` keeps its exact meaning (*is there a declaration beyond the
  one every install is given*) and carries the distinction alone. The cost is one
  query where this route used to read no database; the property that argument was
  written for — the shares filter surviving a store outage — left with the page
  itself at #719.
- **`default` is named by one function, read by both pages.** `declaredLabel`
  answers `null` while the row still wears `Default account` — the *server's*
  English about a row nobody declared, which ADR-0024 forbids rendering — and the
  owner's name the moment they give one. That refines #745 rather than
  contradicting it, on #745's own argument: what must never follow the reader is
  a **seeded** value, and a name somebody typed is not one. The accounts page and
  the declaration block call the same function, so *two pages do not name one
  thing two ways* is true by construction rather than by discipline; `declaredType`
  is the same clause on the other seeded column, which is also why the form opens
  both fields **empty** (handing `OTHER` back had the reader typing `PEA` into it
  and saving `OTHERPEA`).
- **The block exists at every N, N = 1 and the true first run included.** The
  accounts *page* leaves the navigation at one account because a comparison of
  one term is not one; the declaration stays, being the only place `default` can
  be renamed or replaced and the only place a first account can be declared
  without writing a file. So `rows.length === 0` has exactly one meaning left —
  *the read has not landed* — and the block renders nothing on it.

**And the create form records on an install that has declared nothing**, which is
#764's deferral discharged. `accountChoice` has five states because they are five
renderings and three of them are three different repairs: a single declared
account answers itself; **nothing declared** is #698's rule (*a blank account
means `default` until something is declared*) and not a missing answer, so the
panel states the row, the blank travels **as a blank**, and the server resolves
it at the write exactly where the file road resolves its own empty cell; and a
read **in flight** or **failed** says nothing about a declaration either way, so
neither may claim the first state — the field names what is going on and the save
is withheld rather than offered and refused, the same rule the removal follows.
`/api/accounts` also joins the tab's causal order (`readConditions`), so *the
store is unreadable* cannot come out as *you have declared nothing*.

**The data page's second tab: what the installation *is*** (issue #724,
ADR-0014, ADR-0015, ADR-0020, ADR-0021). Three blocks in one order — **Avis ·
Réglages · Le magasin** — and *a block with nothing in it does not exist*: the
layout shifts when a notice appears, which is the counterpart of the badge on
the tab. Five things about it are decisions:

- **The badge counts unacknowledged notices and nothing else**, and the three
  things it excludes are three things that *look* countable: the **ephemeral
  store** (a predicate that is never acknowledgeable, so a permanent badge, so
  noise that takes the notices that matter down with it), the **orphan symbols**
  (*a choice, not a waste* — nobody is being told anything), and the
  **reconstruction**, which is one of #709's five keys and has exactly **one**
  announcer, the banner. That last one is why the exclusion lives in
  `lib/advisories.ts` rather than in a filter: dropped from the badge alone it
  would stay in the block and make the badge under-count what is on screen;
  left in both it would put two announcers on one fact. `shownAdvisories` and
  `unacknowledgedCount` read **one list**, so *a badge promises something to
  find* is true by construction.
- **The settings are one surface with two sections**, and the line between them
  is ADR-0014's boot test transposed to the render. The **effective-configuration
  card disappears as an object** — it was drawn twice from the same source on the
  same page, answering a precedence problem that no longer exists. The form is
  **drawn by the registry** (`/api/config`'s `settings`, which *is*
  `settings_registry.py` crossing HTTP): a dial the catalogue has never heard of
  renders under its key with its own bounds, which is what stops a seventh hand
  written list appearing. The environment half is a **key/value list nothing in
  which is focusable** — rendered as greyed fields it invites the click and reads
  as a form that refused — with *changes when the container is recreated*
  written **once for the section**. `unread_environment` is deliberately not
  repeated there: it is one of the five notices, and the block above already
  says it with the names it found.
- **The cadence says who it reaches, and names its own trap.** The count is
  `lib/installation.ts`'s `cadenceReach`, and it is read off **`closed`** — the
  market state of the symbol's last completed pass, published per symbol — and
  **not** off `next_run`, which the ticket names: #701 settled that with three
  counter-examples, and the front would reproduce all three (a symbol asleep
  until an open falling *inside* a long outgoing interval, a dead-ticker back-off
  indistinguishable from a market close, and an instrument that inverts the
  moment the dial it is compared against is the one being changed). Using the
  server's own instrument is also what makes the forecast agree with the receipt
  the save answers with — two instruments would give the reader two counts of one
  gesture, and the receipt is therefore written **in the past tense and in its
  own words** rather than repeating the forecast verbatim. The trap is stated
  because no interface can hide it: the back-off waits `regular_interval ×
  2^(n−3)` and stores no absolute delay, so the number in the form is the number
  in the formula. And **only what moved is sent**: `reschedule_job` recomputes
  the next run from *now*, so a form posting every field would reset every timer
  on every click, invisibly.
- **The store block reads two resources, and the split is #668's line.** The
  **path and its persistence** ride on `/api/runtime`, which opens nothing, so
  they are still on screen when the store cannot answer — which is exactly when
  *« où sont passées mes données ? »* is asked; the **size**, the **last write of
  the ledger** and the **orphans** are `GET /api/store`, which fails with the
  file it describes. An **ephemeral store dominates the block** instead of
  appearing in it as a note — the only screen where a trial run learns that it is
  one — and is **never a notice**. The size never appears without *a purge
  returns rows, not bytes: the store reuses its blocks* (measured: 79 % of a real
  store's rows purged for **zero bytes**, 126,0 Mo before and after, the same
  content rebuilt fitting in 26,0). The last write is the newest **import** and
  never the newest observed price — that second one is liveness, it belongs to
  the banner, and here it would make a store whose last import was a year ago
  read as freshly written.
- **The orphan list is absent at zero**, and a **sold position is not one**: the
  predicate is *no event names this symbol*, never *its quantity is zero*.
  `DELETE /api/store/orphans` is the gesture spec #695 § 10 owes in exchange for
  keeping the series — forgetting an import is reversible, a reconstructed series
  is not — and it runs in **two transactions** for `forget_import`'s reason:
  DuckDB refuses to delete a referenced key in the transaction that deleted its
  references.

Two members joined the HTTP contract with it: **`runtime.store.path`** (beside
the persistence, because the two are read as one line and both are boot
knowledge) and **`GET /api/store`** with its `DELETE .../orphans`. The one
gesture a notice carries inside the app is the **assumed-currency** one, which
*names the events it was made about*, so it switches to the ledger tab already
reduced to **every** security it names; the other four are about a file on disk
or a variable in the container's environment, and their own sentence — the
server's, because it names *this* installation's paths — already says what to do
out there.

**That reduction is a filter of its own, and it names itself on screen.** The
free-text search is single-term (`haystack(event).includes(needle)`), so a
notice naming three securities — the ordinary case, since
`_observe_assumed_base_currency` folds its events into
`sorted({event['symbol'] …})` and any portfolio reporting in EUR while holding
two foreign currencies produces several — would have to drop two of them to be
expressible there, landing the reader on a ledger stating a repair
perimeter smaller than the sentence they have just read, with nothing on screen
saying so. So `LedgerFilters` carries a `symbols` set nothing types into, the
reduction bar **states it with all its names and offers to undo it** — a table
silently shorter than expected is the same defect one step on — and the gesture
**sets** the filters rather than merging them, so a search left behind cannot
subtract from the notice's own perimeter. The unit is the **security** and not
the event, and the reason is **not** that the id is missing — #764 serves
`event.id`, landing in the same wave as this, so an argument resting on its
absence would have been stale on arrival. It is that the server names the
symbols beside the ids precisely because *one re-export repairs every line of a
security*: the repair the notice asks for is per-security, so a perimeter drawn
per-event would be narrower than the gesture it introduces. Rebuilding an
address out of `(date, type, symbol, account)` to be exact instead would be
#662's opaque token over `(file, sheet, row)` under another name.

**The accounts page: a comparison does not outrun the period where it exists**
(issue #721, ADR-0019, ADR-0016). It was the only one of the four **rendered and
never judged** — measured on a declared account it reproduced the dashboard's
head to the cent — and what the measurement showed at N = 2 is not that each
column discriminates: it is that **the instrument of comparison was not one**.
`pea 171,5` against `TR 115,0` compares 6,8 years with 2,4. Rebased on a common
window the same two accounts **swap places four times over seven windows**, every
figure correct. Five things about it are decisions:

- **One range control, and it drives the chart *and* the table's `perf`
  column.** They read **one** rebasing — every curve at 100 on the first day of
  the visible window, `lib/accounts.ts` — so the two stop being two announcers
  that contradict each other, and the scalar strip under the chart is the same
  number as the cell. `MAX` is **not offered**: what fails there is not the
  differing bases (an account entering mid-chart reads perfectly, dated marker
  included) but that a time-weighted index has **no bounded amplitude** — `pea`
  spiked to +542 % in February 2022, the axis runs −58 % to +542 %, and both
  accounts' recent history is crushed into the bottom sixth of the plot. The
  bound's other half is the table: at `MAX` that column rendered `+71,49 %`
  beside `+15,00 %` with nothing saying they cover 6,8 years and 2,4, which no
  annotation could have repaired. The longest preset is therefore *since the
  opening*, a `max` over the accounts' first days — and since **no payload states
  an opening**, the page reads each series whole and applies the bound to the
  **drawing**, which is where ADR-0019 puts it. Asking the server for the window
  would mean knowing the bound before reading what defines it; the cost is ~2 500
  days per account, read **once** for the four presets.
- **Eight columns** — `Compte · Valeur totale · Titres · Liquidités · Versé net ·
  Gain total · TRI · perf` — `Type` folded into the `Compte` cell. The table
  carries **`Gain total` alone**: the twelve-column variant, the total beside its
  four terms, **fits** at 1 440 px, which is exactly what condemns it — the
  constraint is one of **form** and not of room, and it becomes sayable for the
  whole product (*a total and its terms never share a row*, ADR-0016). `Versé
  net` stays though it is `Valeur − Gain`: it is the silent denominator of the
  two last columns. **`Portefeuille`, never `Total`**, at the bottom behind a
  rule — six of its eight cells describe the whole, `TRI` and `perf` are not sums
  and **not em dashes either**, the store holding both at portfolio level — and
  it is **read** from `portfolio_totals` rather than summed, the accounts being
  unsummable the moment one of them has no cash ledger (#708). **At N = 1 the row
  is absent** (it would copy the single line above it), the page leaves the
  navigation and the **route survives**.
- **Pointing previews, clicking opens** — **one** gesture per row, and the table
  is still the chart's control **without adding a control**: the pointer over a
  row isolates its curve, a click anywhere along the row opens the account's
  sheet. #721 shipped the other split — the click isolating, the *name* opening
  — and that is what made *the two gestures must be visibly distinct at hover* an
  acceptance criterion at all. Checked by eye on the real portfolio, the
  criterion was met and the split was still wrong: two clicks on one row, told
  apart by a rule the reader has to learn, where there is one thing to do. The
  same look measured the two defects that left with it — the name's
  `hover:text-primary` was a **no-op in both themes**, the preset giving
  `--primary` the value of `--foreground` (black on black, then white on white),
  and the name carried the browser's `cursor: default` inside a row carrying
  `pointer`, so the affordance *lost* its pointer over the very word that opened
  the sheet. What survives untouched is the other eye-checked criterion: the
  dimmed series does not fall to 16 % opacity, where the highlight becomes a
  filter and loses the context that justified it (`DIMMED_OPACITY`, pinned above
  that floor by a test). **Hover is the one input that says nothing to a keyboard
  or a finger**, so the name's *focus* carries the preview the pointer gets, and
  a tap goes straight to the sheet — which is where the figures are anyway. **There is no *Amounts* view**: mounted here it is four curves at
  two accounts, the pairs overlap and **no surface is anybody's gain**; at five
  accounts, ten curves. The value-against-contributed shape keeps its two homes,
  the dashboard and the account's own sheet.
- **A row with no figures names its reason**, on a second line of its `Compte`
  cell, the money columns keeping their dashes: *without a cash ledger* (five
  dashes out of eight, #708's per-field rule) and *being rebuilt* (eight) are
  otherwise **indistinguishable**. A **third** answer exists and is not an
  invention — `rebuilding === false` on an account with no series at all means an
  empty account, not a slow one, and telling its owner to wait is a sentence that
  never comes true; a runtime read that has **not landed** keeps the rebuild's
  sentence, exactly as the dashboard's year-to-date does (#709's third answer).
  The row names a **reason**, never a progression with a target date, which stays
  on the banner. **A column disappears when it is absent for *every* account**,
  and `Liquidités` follows `total_value`: without a ledger the balance reads
  `−6 517,26 €`, arithmetically defined and semantically false — five dashes, not
  four. As soon as one account out of two has a ledger the dashes stay, where
  they are a **difference between the accounts**, which is the subject of the
  page. And **`Non affecté`** is distinguished and carries the reassignment link
  to Données: it is the one line the promise *your declared accounts* does not
  cover.
- **Five icons — four here and the fifth is #722's**, on the sheet's `Gain total`
  block, *one per figure and per surface*. The four are `Versé net`, `Gain
  total`, `TRI` and `perf`; the two rate bubbles end on the **same** last
  sentence (*returns are computed from the dates of your events*) deliberately,
  the two being far more often misread together than apart, and **`perf` is the
  one bubble in the product that warns against its own figure** — it depends on
  the window and the ranking can reverse inside it. One mention of the date at
  the level of the page (*Chiffres arrêtés au …*), the money figures being a
  **day**; the **interval is never written in words**, the range control already
  carrying it. The sheet itself arrives as a **shell**: the gesture is this
  ticket's, its three objects and that fifth icon are #722's, exactly as
  `ShareSheet` landed for #720.

Two series resources join the HTTP contract with it, announced on #745 before
being written into `lib/api.ts` — and **their server half is written in the same
ticket**, the map having seen a page ticket declare an unserved contract five
times: **`GET /api/accounts/<id>/history`** (already served; what changes is that
a client reads it) and **`GET /api/portfolio-totals/history`**, new, with the
**same five members field for field** so one client shape reads both and the
rebasing is written once. `/api/portfolio/history` serves that table already and
is not reused: it is a v4 route discriminated by a `?mode=` v5 is dismantling,
and it publishes `value`/`contributed` for a chart. The declaration's figures
join too — `/api/accounts` has been serving the newest `account_metrics` row all
along while the client contract declared `{id, label, type}` alone, which is
`declared`'s own defect one level down. **`twr_index` is published and rendered
nowhere.**

`PendingPage` and its one sentence leave with this ticket: it was the last
placeholder, and *this page is not built yet* has no subject once all four are.

### Documentation Website (in `website/` directory)

Dependencies are managed with pnpm. The docs are versioned and **every version
has an address, the current one included** (ADR-0025, issue #733): `docs/` holds
**v5** at `/docs/v5`, `versioned_docs/version-4.x/` and
`versioned_docs/version-3.x/` hold the frozen **v4** and **v3** at `/docs/v4`
and `/docs/v3`. `lastVersion` is still `current` — v5 is the default version, it
simply no longer sits at the bare root. Use the navbar version selector to
switch. Snapshot a new version with `pnpm docusaurus docs:version <name>`.

The scheme is uniform rather than *everything is versioned except the newest*,
which is the rule that made ADR-0016's in-app convention bubble impossible: with
`/docs` meaning *latest*, a link a v5 install emits serves v6's page the day v6
ships — a correct page about another product. **The link contract the product
consumes** (issue #712) is therefore:

```
https://pbrissaud.github.io/suivi-bourse/{locale}/docs/v5/<page>#<anchor>
```

locale segment absent for the default locale (English), `fr/` for French, and
the version frozen at the **major** (a 5.1 install still reads `/docs/v5`).

`/docs` is kept alive by `@docusaurus/plugin-client-redirects`, which points it
at `/docs/v5/`. That redirect is **client-side and only exists in the built
output** — under `pnpm start` `/docs` 404s, so a manual check in development
concludes the opposite of the truth; verify it on `build/docs/index.html`.

**The site is bilingual through Crowdin, scoped to the v5 corpus** (issue #739,
ADR-0024). `i18n.locales` is `['en', 'fr']` with English the **source**, so
`pnpm build` builds both and `/fr/` is published — the locale half of the link
contract above. `crowdin.yml` sits at the **repository root** and covers the
whole product in **one** project (ADR-0024, amended by #739): the site *and*
`app/web/src/i18n/en.json`. Two projects were specified and the reason —
"different formats" — is refuted by the file itself, which already mixes
Markdown and ICU JSON; what settles it is that a translation memory is
per-project by default, so *plus-value latente* translated in the interface
would never suggest itself in the page that explains it. Its sources are
`website/docs/` plus the theme catalogues under `website/i18n/en/` (generated by
`pnpm write-translations`, committed) and the front's hand-written catalogue;
the frozen versions never enter it, neither their pages nor their sidebar
catalogues, which `.gitignore` keeps out of the repository as well. `editUrl`
splits by locale — GitHub for English, Crowdin otherwise — since a pull request
on a French file is lost at the next import.

Two gates guard it, and neither is `pnpm build` — which opens neither file:

- **The CI lints `crowdin.yml` with the tool that consumes it** — from the
  repository root, `npx @crowdin/cli config lint`, no network and no secret. The CLI
  compiles each `source:` into a regex, so `'/docs/**/*.{md,mdx}'` — valid YAML,
  valid shell — is refused with `Illegal repetition` (`{` opens a quantifier);
  Crowdin has no brace expansion, hence **one extension per entry**. Checking
  the file with a YAML parser passes it, and the symptom is an upload that
  carries nothing.
- **`pnpm write-translations --override` must leave `i18n/en/` unchanged.** The
  committed English catalogues **win over `docusaurus.config.js` at build time,
  for English too**, so a theme string edited in the config and not regenerated
  is ignored with every check green. `--override` is what makes the check real:
  plain `write-translations` only adds missing keys. It is also why the footer
  copyright carries no year — a `new Date().getFullYear()` frozen into a
  catalogue goes on reading 2026 into 2027 with nobody having edited anything.

The cost no configuration removes: Docusaurus falls back to the source for an
**untranslated** string, never for a translated one whose source moved, so a
superseded French rule can be served. It is written in `website/README.md`
because it decides a rhythm — translate after the English text settles, never
during.

```bash
cd website
pnpm install
pnpm start    # Development server (no /docs redirect — see above)
pnpm build    # Production build, every locale (fails on broken links)
pnpm build --locale fr   # French alone — still builds with no translation file
pnpm write-translations --override  # Refresh the English sources Crowdin uploads

# The Crowdin config is at the repository root and covers both halves:
cd .. && CROWDIN_PROJECT_ID=0 CROWDIN_PERSONAL_TOKEN=config-lint-only \
  npx @crowdin/cli@4.15.0 config lint
```

### Running it — there is no compose stack (issue #743)

`docker-compose/` is **gone in its entirety**, `Makefile` included, and **nothing
replaces it**: `docker run` is the canonical form, and a PaaS deploys from an
image or from a `Dockerfile` without ever needing compose.

```bash
# No buildx, no custom syntax directive — the build context is ./app.
docker build -t suivi-bourse:dev ./app

# /data is the store and is the one argument to keep; /import is the drop
# folder, read-only, and its absence is an ordinary state (ADR-0015).
docker run -d --name suivi-bourse \
  -p 8080:8080 \
  -v suivi-bourse:/data \
  -v "$PWD/my-events:/import:ro" \
  suivi-bourse:dev

# A portfolio is a ledger: drop a .csv/.xlsx into the mounted drop folder and it
# is loaded. There is no mode to choose (issue #711). With no /import at all the
# first event is typed in the app, which is what ADR-0005 made the onboarding.

# The image contract is asserted in CI and runnable here (issue #744):
docker build -t suivi-bourse:pr ./app
IMAGE=suivi-bourse:pr .github/scripts/container-contract.sh
```

The detail worth keeping is that **the `Makefile`'s four preparation jobs died
of four independent causes, and not one of them was "compose is leaving"**:
generating the InfluxDB token (there is no InfluxDB), copying the example config
directory (there is no manual mode), recording the invoking uid and gid (the uid
apparatus died with its cause at #742/#743), and warning that the variable
chaining the port overlay was missing (there is no overlay). It was not a tool,
it was **a stack of workarounds each with its own cause** — which is why nothing
was left to port, and why *"what becomes of `docker-compose/`"* had no partial
answer available.

**The port overlay lost its subject rather than its support.** It existed so that
Grafana would *not* be published when a reverse proxy fronted it; in v5 the thing
one reaches is the app itself, and there is no choice left to express.

**Grafana's retreat took two more things with it**:
`assets/grafana-dashboard-external-v8..v11.json` — four dashboards published for
a user-supplied Grafana, whose reference surface in the **live** corpus was
`deployment/` and `advanced/`, both deleted with it — and `assets/screenshot.png`,
the `README` having moved to `website/static/img/screenshot.png`, which shows the
app. **The frozen v3 page links all four all the same**
(`versioned_docs/version-3.x/deployment/standalone.mdx`), by absolute GitHub URL
on `blob/master` rather than by a relative link — so Docusaurus checks nothing,
the build stays green, and the four links become `404` the day v5 reaches
`master`. That is written down here rather than repaired: a frozen corpus is not
rewritten, `versioned_docs/` is excluded from this ticket's own criterion, and
whether v3's readers are owed those files back is the owner's arbitration.

**And the image's `HEALTHCHECK` starts applying here.** The stack's own file
declared a `healthcheck:` block, which overrides the image's, so the only stack
the repository shipped masked the only probe it had. Nothing declares one now,
so #742's probe is the one that runs.

**The *no reference left* criterion is held on its intention, and the arbitration
is written down here rather than left for the next reader to redo.** It listed
seven strings — `docker compose`, `make init`, `SB_UID`, `SB_GID`,
`SB_CONFIG_DIR`, `SB_VERSION`, `COMPOSE_FILE` — and three of them are held to the
letter: outside `versioned_docs/` there is **zero `docker compose`, zero `make
init`, zero `COMPOSE_FILE`** in the repository, the release `CHANGELOG` aside,
whose `docker-compose:` scopes are the record of shipped releases and not a
reference to a stack. The **four names the app has never read** stay, deliberately:
they are not references to the compose stack, they are the tuple that keeps them
**out** of the boot notice (`boot_env.NEVER_READ`, required by spec #730 § 3).
Deleting it would not remove the four names from the product — it would move them
into the one sentence spec #730 § 3 forbids them, i.e. a behaviour regression, and
it would break the four tests that pin the exclusion. So they survive in six
places and no others, each of them a statement *about* their disappearance rather
than a use of them: `app/src/boot_env.py`'s `NEVER_READ`; the four tests pinning
it (`test_boot_env.py`, `test_runtime_wiring.py`, `test_scheduling_wiring.py`,
`test_web_api.py`); `website/docs/settings.mdx`'s *a different case again* row;
and **ADR-0015's opening sentence**, which is the sentence that *decides* the uid
apparatus goes — taking the names out of it would make the ADR say less than it
decided, and an ADR is not rewritten to satisfy a grep.

**There is no composed development mode either**, and the replacement is the two
commands above with `pnpm dev` pointed at the container through `SB_API_URL` (see
the Web UI section). That is also why this work came **after** the image's: one
does not delete the only way to start the stack before `docker run` replaces it.

## Architecture

**Entry point**: `app/src/gunicorn.conf.py` (the container `ENTRYPOINT` is
`gunicorn --config gunicorn.conf.py 'web:create_app()'`).

**Process shape** (issue #651): the web API lives *inside* the scraper process —
one container, one process, one scheduler. gunicorn is not just a server here,
it is the boot sequence, split either side of its `fork()`:

- **master, under `preload_app`** — `main.build_runtime()`: **the store**
  (issue #696), then `ConfigurationManager`, the **first publication** of the
  config snapshot, and the `PrometheusExporter` registry. Pure work only: no
  thread, no socket, no fd survives a fork. Opening the store here is what keeps
  an unreadable one a single clean exit — same place #658 gave the Cerberus
  validation, different cause — and publishing the config here does the same for
  a broken ledger; the arbiter has not forked yet, so there is nothing to
  respawn, and the worker inherits the published snapshot through the fork, so
  `post_fork`'s `ingest()` is a cache hit that only arms the jobs.
- **`post_fork`** — `main.start_runtime()`: the **store connection**,
  `BackgroundScheduler` (not Blocking — the worker owns the foreground),
  `start_watcher()`, and the first `ingest()` that arms the per-symbol scrape
  jobs.
- **`worker_exit`** — `main.shutdown_runtime()`, the heir of the old `finally`,
  closing the store last.

**The store connection does not cross the fork.** The master opens the file,
applies the DDL, seeds it and **closes it again**; the worker opens its own.
Keeping the master's open would leave the file locked by the parent while the
child used buffers it no longer owns — and DuckDB refuses a second process
precisely because that is not survivable. What crosses the fork is
`Runtime.store_path`, never `Runtime.store`.

The two failure paths differ on purpose: the master calls `sys.exit(1)`, while
`post_fork` **re-raises**, because gunicorn reads an exception there as
`WORKER_BOOT_ERROR` and halts the arbiter, whereas an exit code would read as an
ordinary worker death and be respawned forever.

**`workers = 1` is a property of the design, not a tuning default**, and it is
guarded twice: `on_starting` refuses to boot with more (checked there, not in the
config body, because the command line is applied last), and the gunicorn control
socket is disabled so `gunicornc -c "worker add 2"` cannot raise it on a running
arbiter. N workers would be N schedulers: duplicate points on the same series
identity, N× yfinance pressure, and #617/#618/#628's in-memory state split N
ways — all of it silent. Concurrency comes from `threads` instead.

One gunicorn master binds **two sockets** (`bind` takes a list): `SB_WEB_PORT`
serves the app, `SB_METRICS_PORT` keeps `/metrics` exactly where scrapers expect
it. `PrometheusExporter` no longer runs an HTTP server of its own; the endpoint
is a `DispatcherMiddleware` mount on the Flask app, fed the exporter's dedicated
registry.

**One embedded store, and the app does not boot without it** (issue #696, spec
#695, ADR-0001). `store.py` owns the file: the connection, the DDL of the
**twelve** tables, and the seed. It is the socle of v5, and every ticket that
follows branches off it: the configuration path fills `import_source`/`account`/
`symbol`/`event` (#697, #698) and the **replay fills `position`/`account_state`**
(#699, `positions.py`).

Five things about it are decisions rather than defaults:

- **One thread is inside the connection at a time, and a transaction is the
  unit** (issue #700). `Store` holds a reentrant lock: every statement takes it,
  and `Store.transaction()` — the only way to open one — holds it from `BEGIN`
  to `COMMIT`. Both halves earn it. A DuckDB connection carries **one** pending
  result, so two threads doing `execute`/`fetchall` can hand each other the
  wrong rows; and a transaction on one connection is **visible to every thread
  using it**, so a reader landing between a `DELETE` and its `INSERT` reads the
  hole — a chart losing a year while a backward chunk is rewritten, and the perf
  job computing `holdings_value` from a half-deleted series and *persisting* the
  wrong daily total. In v4 the readers were a second process against another
  database and the problem had no expression; it appears the moment one store
  holds both halves. `ConfigurationManager.writing()` is a **different** lock and
  survives: it groups gestures spanning several statements *without* a
  transaction, and it is always taken first, so the two cannot cycle.
- **The DDL is applied with `IF NOT EXISTS` and there is no migration
  machinery.** The rule that generates the schema is *declaration and derived
  state never share a row*, so every row has exactly one writer: the
  configuration path owns `import_source`/`account`/`symbol`/`event`/`setting`/
  `advisory`, the ingestion owns `position`/`account_state`, the scrape and
  backfill own `symbol_quote`/`price_point`, the perf job owns
  `account_metrics`/`portfolio_totals`.
- **`price_point` carries no primary key and no foreign key** while the other
  eleven keep theirs (ADR-0007). Not negligence, measurement: a DuckDB ART index
  is a second copy of the data whose buffers the buffer manager does not own, so
  a primary key here is **+563 MB of resident memory on a 319 MB base**, a
  foreign key +153 MB more, and the rebuild 15× slower. Uniqueness moves to the
  writers; the integrity an index would buy is bought for free on the event row,
  where a typo'd ticker actually enters. The reason is written next to the table
  in `store.py`, not only in the ADR. **`account.source_id` is the one other
  column with no key** (#698), for a reason that is not memory: DuckDB executes
  an `UPDATE` touching a foreign-key column as a delete plus an insert, and that
  delete trips the incoming `event.account` key — so a key here would freeze the
  ownership of exactly the accounts that are in use, making an accounts file
  impossible to correct and re-drop, impossible to grow, and the seeded `default`
  row it took over impossible to hand back. Integrity moves to the writer the
  same way: `accounts` is the table's only writer and retires every row of an
  import before `ledger.forget_import` deletes the source it points at.
- **A NaN is not a number** (`store.finite`), on both boundaries and for two
  different reasons: stored, it compares false against itself, so
  `IS NOT NULL` says it is there and every arithmetic it touches becomes NaN;
  served, **JSON has no NaN** — `jsonify` emits a bare token that Python's own
  parser accepts and a browser's `JSON.parse` refuses, so the page gets a `200`
  whose body it cannot read. `None` is the honest answer either way.
- **Two kinds of time, never mixed**: `TIMESTAMPTZ` in UTC for an observed
  instant, `DATE` for a calendar day. They meet at the API, where a window
  always arrives as an instant: a bound on a `DATE` column is **cast**, or
  DuckDB widens the column to midnight and the first day of every window is
  silently dropped.
- **The seed has two halves.** The `default` account row is written **at
  creation only**, and since #698 it is also never removed — a file may take it
  over, and forgetting that file hands the row back **whole**, `type` and `label`
  restored to what the seed wrote, rather than taking it away.
  There is always at least one account, which is what lets nothing branch on
  *"are accounts declared"* (ADR-0013). The `setting` defaults are inserted **at every start** with `ON
  CONFLICT DO NOTHING`, which is what makes adding a dial in a later version
  cost no migration: the missing key appears, an answered one is left alone. A
  key absent from the table reads as **the code's default**, from
  `settings_registry.py` — the table is the mirror, never the source (ADR-0014).
  `base_currency` has no default and is therefore never seeded: "not answered
  yet" and "answered" have to stay two states.

`schema.yaml`, Cerberus, `InvalidConfigFile`, `load_shares_schema`,
`SuiviBourseMetrics.validate()` and `_ABSENT_SCHEMA` are deleted with the same
ticket; what validates is `events/validator.py` and the DDL, and since #698 the
accounts are a table rather than a block to check.

**The web UI reads through its own module, with its own error contract** (issue
#659, moved onto the store by #700). The layer between the UI and the store is
the *for-keeps* half of the prototype; the React on top of it is admitted
throwaway. Two modules, and the split is by **error contract**, not by subject
matter:

- **`store_reads.py`** — `PortfolioReader`, taking the open store. Its workhorse
  is **P1, and since #700 it is a join rather than a window**:
  `position ⋈ symbol_quote`, one row per `(account, symbol)` beside the newest
  observation of that symbol — 0,43 ms measured against 25,4 ms for the
  `ROW_NUMBER()` scan of the price series it replaces. A **LEFT** join, which is
  the interesting half: a position whose symbol has never been fetched is a row
  with every market column `NULL`, and an inner join would answer *"you own
  nothing"* to someone who has just declared everything they own. Deliberately
  **no time window**: "current" is absolute (#652 déc. 1), so a long market
  closure no longer blanks the page. Also `raw_series` and `bucketed_series` —
  the second survives for one new reason, the browser: five years of a symbol is
  tens of thousands of points after #705's ladder, fifty times what a chart
  carries. The perf series get `latest_totals` / `totals_series`,
  `latest_account_metrics` (one query for the whole comparison table) and
  `account_series`. All of them **name their fields**, which is what ADR-0001
  buys: a declared column that was never written reads as `NULL` rather than not
  existing, so naming `xirr` no longer turns "this account has no deposits" into
  a query error. And every **wide** read crosses **Arrow** (`Store.arrow`):
  materialising a `TIMESTAMPTZ` column costs 8× in rows and nothing in Arrow.
- **`portfolio_view.py`** — pure, in the taste of `scheduling.py` /
  `performance.py`. Rows in, page objects out: the derived unit cost
  `Σ cost_basis / Σ quantity` — which *is* the weighted mean, and falls out of one
  division because the basis is stored as an amount (a plain sum *and* a plain
  mean both produce plausible-looking wrong prices) — the per-account rollup
  Grafana sums away in SQL, and **plus-value latente**, which since #700 is
  `market_value − cost_basis` and carries **neither dividends nor fees**: they
  are the other two named figures, and adding either here counts it twice. The
  holdings term is required and the basis defaults to zero, because composing it
  out of null-tolerant helpers made a share whose price was never observed report
  a total loss. `build_accounts`
  (#661) joins the **declaration** to the newest metrics row and lets the
  declaration drive: an account with no series yet is a row of em dashes, a
  series with no declaration is not a row, and nothing is summed across accounts
  — the consolidated figures have one source, `portfolio_totals`.

`influx_sql.py` — the `COALESCE(account,'default')` shim, the quote escaping,
the NaN guard and the bare-UTC-Z literal — is **gone** with #700. Every one of
its four rules lost its subject at once: a price has no account, DuckDB binds
parameters instead of taking a formatted string, and a NaN never reaches the
store because the fetch drops it.

The reason this is a **separate module** from the scheduler's own reads: those
end with `except Exception: … return None`, which is right for a job surviving a
flaky query and wrong for a UI, where it makes "the database is unreadable" and
"you own nothing yet" the same screen. Here query errors **propagate** and
`web/problem.py` turns them into `503` + `application/problem+json`; absence
stays three distinct states (`200`+`null` / `200`+`[]` / `503`), and they are
**structural** rather than rescued from an exception. `_ABSENT_SCHEMA` — the
regex that read "this measurement was never written to" out of an error message
and answered `[]` — went with #696, and the window it left open closed with
#700: an install whose measurement did not exist yet answered `503` where it owed
`200` + `[]`.

**The app's own runtime state is a fourth pair, and it reads no store at all**
(issue #668, design #656). `GET /api/runtime` answers from process memory, the
config snapshot and the APScheduler jobstore — nothing else. That is a decision,
not an optimisation: `/api/shares` is a query and the blueprint answers `503`
when one fails, so a status pill riding on that payload would **vanish exactly
when it is the only thing able to explain the empty table**. #659's reserved
`status` slot is therefore *retired*, not filled.

- **`runtime_state.py`** — the one writer, of one shape. Each job ends its pass
  by publishing an immutable **last-pass record**, keyed by the *job's* identity
  (per symbol for scrape, per `(symbol, account, direction)` for backfill, global
  for ingest and perf), plus a **consecutive-failure counter on the backfill**
  that has no equivalent anywhere else — `_backfill_backward` logs a warning and
  returns `0`, the same value a healthy weekend returns, so nothing distinguished
  "pacing" from "wedged on yfinance". Only what has no home is published: no copy
  of `_failure_counts`, `_backfill_complete` or `_share_info_cache` lives here.
  The rule that keeps it safe is that **the lock never covers a fetch** and
  *readers never iterate* — the row set comes from the configuration snapshot,
  one `get` per key, because copying a dict the scrape threads are writing raises
  `RuntimeError: dictionary changed size during iteration`.
- **`runtime_view.py`** — pure, in the taste of `scheduling.py`. The contract it
  honours is that **the API reports observations and never derives a verdict
  across two items**: a reader taking `_failure_counts` at *t* and
  `next_run_time` at *t+ε* is wrong twice over, while `scheduling.decide` handed
  the job its verdict, delay and counter in **one call**. Three cases it exists
  to get right: an **absent `next_run_time` is ambiguous** (a `date` job leaves
  the jobstore *while it runs*, so absence is "being scraped now" *or*
  "departed"); the cached `marketState` is **never** the pill (`decide`
  fail-opens it, and the cache is written only on a successful fetch, so a
  failing symbol reports the state from before its failure); and the backfill's
  terminal state is never collapsed with a stall — `complete` is a conclusion,
  not an attempt. It is the last of three: `manual_mode` left with the mode it
  named (#711) and `no_buy` with #703, where the target became the first
  **acquisition** and a position carrying neither a `BUY` nor a `GRANT` stopped
  being reachable at all. Its row set is **every symbol the ledger names**, not
  the held ones, because the backfill's set is no longer the scrape's: a sold
  line is reconstructed and not polled, so the row carries `held: false`, the
  pill `not_held` and `next_run_state: not_held` instead of reading as a
  scheduler that is stuck — all three, because `unknown` is a statement about
  *this process* and a closed position would wear it for ever, no future event
  being able to clear it. Its `accounts` list stays **who holds it** and is
  empty when nobody does: a field already published must not change meaning
  because the row set widened.
  Its **progress bar divides by the holding window**, `[target, ceiling]`, and
  counts from the **anchor** rather than from the oldest stored point — #703
  parted the two, and only the anchor moves on a symbol Yahoo answers nothing
  about, where a bar drawn from the series freezes and then jumps to 1,0. The
  ceiling is a field of the record rather than a reader's assumption: with
  *now* as the denominator a line bought 2020-03-02 and sold 2022-05-04 reads
  0,82 one chunk in where it has covered 0,46 — inflated for exactly the rows
  #703 adds to the payload, at exactly the moment the bar has a use, and with
  nothing published a consumer could correct it from.

`/api/config` carries #654's read-only **effective configuration** — there
rather than on `/api/runtime`, one noun two consumers — listing the variables
*the app reads* (not the ones compose sends) — a secret would be redacted **by
name**, and since #700 the list holds none — plus the published snapshot's
declared `shares`.

**The config directory has no write path** (issue #711). `config_writer.py` and
`events/editor.py` are deleted, together with the routes they served: the row
edit, the opaque token over `(file, sheet, row)`, the `ETag`, the `409`, the
file import and conversion, and `PUT /api/accounts`. The whole apparatus existed
because **the file was the address**; in the store a row will have a primary
key, which does not go stale, so nothing it did has a **file-shaped** successor:
no token, no `ETag`, no `409` on a fingerprint. The front therefore has no
data-editing gestures until block 2 rewrites it around the import as the unit.
`GET /api/events` survives as a read of the published snapshot — the rows the
aggregator ran on, with no etag, and since #764 **with the row's own key**,
which is the primary key that sentence was pointing at all along.

Its consequence for the config directory: no filename has a special meaning any
more (`ui.csv` was the last one). Two write paths came back, and they are the
same shape twice: the account (issue #698) — `POST`/`PATCH`/`DELETE
/api/accounts` — and the event (issue #764) — `POST`/`PATCH`/`DELETE
/api/events`. Both write a **row**, never a file, and both are guarded by one
column: `source_id NULL` is at once "created in the app" and "editable", and
what a file provisioned is refused by name and revoked with its import.

**And the ledger leaves the way it came in** (issue #710, ADR-0008, ADR-0021).
`GET /api/export/events.csv` and `GET /api/export/accounts.csv` render the store
in the **import format**, so the round trip is round by construction rather than
by a mapping kept in step by hand — which is what makes *"can I go back to v4?"*
a one-sentence answer (*export, then point v4 at a folder holding the exported
`events.csv` alone*) and a backup something other than a binary DuckDB file.
The word *alone* is load-bearing and it is what the documentation has to carry:
v4's `EventLoader._load_directory` **re-raises**, so an `accounts.csv` — a
format v4 has no notion of — refuses the whole directory rather than itself,
and a single-account install is not spared, its accounts export being a header
row with no rows under it. `events/export.py` is pure —
rows in, text out — and it is a **rewrite** of the "render a CSV" half spec #695
§ 6 had reserved when #711 deleted `events/editor.py` whole: the old one
rendered a file being edited in place (an addressable `CsvFile`, an atomic
rename, a workbook conversion), and none of those three has a subject once the
rows come from the store and the bytes go into an HTTP response. Four decisions:

- **Two files, not one**: a file is an accounts source or an event source
  according to its header, never both, and an event file naming `pea` is refused
  whole where nothing declares `pea` — so exporting the events alone would
  restore a multi-account install into a refusal. The seeded `default` row is
  **not** in the accounts file unless something changed it: it is on every
  install and nobody declared it, and re-importing it would hand the one row
  every install owns a `source_id`, making it read-only and forgettable.
- **The file states its reporting currency**, in a `base_currency` column
  repeated on every row. Event amounts are the debit *in the reporting currency*
  (ADR-0002) and nothing else in the file says which one, so a round trip
  through an install that answered differently re-reads every amount as another
  unit. The name is the guard: a broker export routinely carries a `currency`
  column meaning the **security's quote** currency, and there are two currency
  levels and not three. A column and not a preamble, because a CSV has one
  header row and a sidecar document would not be imported by the drop folder at
  all — and the export must re-enter by the **normal** path or it proves
  nothing.
- **On the way back in, the app reads a declaration rather than asserting one**
  (ADR-0021): a store that has never answered **takes** the file's currency,
  which is what makes the headless round trip work without a single `curl`. A
  disagreement is arbitrated by the dial's own rule and not by a second one —
  free while the ledger is empty, fixed from the first recorded event — so an
  install with events refuses the file **whole**, the raise happening before the
  transaction opens. The *shape* of the code is `settings_registry`'s, so an
  events file saying `EURO` is refused with the message the settings form gives.
  A file declaring two different codes is refused by the loader: it is one fact
  about the whole file.
- **The import is the third writer of a dial**, and `ingest()` therefore
  re-reads `base_currency` after a reload (`_adopt_declared_currency`). A dial
  reaches the process at boot and from `PUT /api/settings`; without that line
  the row would be in the store while the process went on converting nothing
  until the next restart — invisibly, since a missing currency writes `NULL`
  conversions rather than failing anything.

Provenance and prices are deliberately **not** exported: the export replaces the
imports it came from, and prices are re-fetched. An account created in the app
therefore comes back file-declared and read-only.

Flask serves the built SPA with a catch-all that must **not** swallow `/api` or
`/metrics`: without those guards a typo'd endpoint returns the HTML shell with a
`200`, and a Prometheus scraper reads `200` as a healthy target.

**A portfolio is a dated event ledger, and only that** (issue #711). There is
one loading path: `SB_CONFIG_MODE`, the `mode:` key and the auto-detection that
arbitrated between them are gone, and so is `config.yaml` — an aggregated
position carries no dates, so it can carry neither a realised gain nor a
historical weighted average cost, and the product's headline figure is built out
of both. A `config.yaml` found in the config directory is **named at startup and
never read** (`ConfigurationManager.report_unread_files`, ADR-0008): four empty
pages otherwise read as *"the update erased my portfolio"*. An events source
that does not exist yet is a fresh install — a warning and an empty portfolio,
never a boot failure. `SB_SCRAPING_INTERVAL`, the deprecated fallback for the poll cadence, is
removed too (v5 is breaking) — and since #701 the cadence itself is a dial in
the store rather than a variable.

**Configuration is one immutable snapshot** (issue #658, design #653).
`ConfigurationManager` holds a single `ConfigSnapshot` — `shares`, `events`,
`accounts`, `cache_key` — built off-line and **published by one attribute
rebind**, so the read path (`current()`) takes no lock and a reader holds a
coherent generation for as long as it needs it; one mutex serialises the writers
(the ingestion job, the watchdog callback, and later a web handler reloading
after a file edit). Two rules follow:

- **Never mutate published state.** `invalidate_cache()` is gone; forcing is an
  argument (`reload(force=True)`). The old pair nulled all three cache fields
  *before* `ingest()` refilled them, and a backfill landing in that window read
  `events = None` → no first-BUY date → its backward pass silently neutralised.
- **Never publish what is not validated.** Loading, validating and aggregating
  all run *inside* snapshot construction, closing a split-brain that predated
  the UI: the cache was written by the loader and validated afterwards by
  `ingest()`, so a rejected file still fed **backfill and the perf recompute**
  while scraping ran on the previous one. `SuiviBourseMetrics.shares` is now a
  *read* of the snapshot, not a second copy, and `backfill()` /
  `recompute_perf()` take one snapshot per cycle. What validates is
  `events/validator.py` and, since #696, the store's DDL — `schema.yaml`,
  Cerberus, `InvalidConfigFile` and `load_shares_schema` are gone with the
  hand-written share list they were written for. An **empty portfolio** is a
  legitimate state, not a rejection: an install legitimately starts with an
  empty `events/` directory.

The declaration is read **from the store, after the import** (issue #698): an
accounts source in the drop folder is imported first, so the accounts a build
publishes are the ones its events were just validated against. `settings.yaml`
is not read at all any more, so nothing about the configuration is boot-only.

**And the replay writes** (issue #699). `ConfigurationManager._load_from_store`
replays the ledger once and hands the result to `positions.write_state`, which
lays down `position` and `account_state` in **one transaction** — the two tables
the ingestion owns, and it is their only writer (a test asserts that on the
source: `tests/test_positions.py`). Three properties come from *where* the call
sits rather than from the function: it is **after the validation**, so a ledger
that does not replay writes nothing and the previous rows stand; it runs on the
same timeline the snapshot is built from, so the store and what the app
publishes cannot be two generations of the ledger; and it is a **replacement**,
so an import forgotten takes its positions with it instead of leaving a table
that goes on describing a portfolio nobody declares. A whole-table rewrite is
affordable here for a reason of *rhythm*, not size: a replay happens on the
boot, on a file landing, and on a write — never every 120 s, which is the
measurement ADR-0011's `UPSERT` argument rests on.

The application runs independent scheduled jobs on a single APScheduler:
- **Scraping**: one **self-rescheduling job per held symbol**, market-aware
  (issue #616). *Held* is a filter on `quantity` since #699, which is what
  finally makes `_held_symbols()`'s docstring true: a position sold four years
  ago used to go on being polled at Yahoo for the life of the process. Its
  departure also `.remove()`s its quote gauges (see Prometheus below), and a
  buy-back revives it through `_reconcile_jobs`' ordinary revive path with
  nothing to remember. The **write loop is per holding**, not per symbol: a
  share still held in one account keeps its job while the account that sold out
  stops being written, or that account collects a point of zeros every cycle and
  the shares page grows a phantom row. Each job fetches its symbol from Yahoo Finance, writes a point
  per account holding it, then re-arms on its own cadence: `REGULAR` markets
  re-poll every `regular_interval` (a store dial, default 120s); closed markets sleep to
  the next open (capped 24h). **And a closed market really does sleep** (issue
  #769): `extract_market_context` now holds one invariant — *a `next_open` it
  returns is strictly future, or it is `None`* — because `currentTradingPeriod`
  describes the **current** period and never the next one, so after the close
  `regular.start` is that same morning's open. Handed on as-is it made
  `decide`'s non-positive-delta branch — written for a holiday or a half-day —
  fire *every evening*, and `SHORT_RETRY` became the cadence of a fifteen-hour
  closure: 70 to 90 s per symbol with #619's jitter, of the order of 4 000 Yahoo
  requests a night on eleven European lines, **not one of which may write**, the
  write gate being shut on a closed market by construction. A non-future value
  never leaves the function — and **what replaces it is that value's own hour,
  never its date**. The date belongs to the period Yahoo calls current, which
  may be today's, this morning's, or one it has not rolled yet; the hour is the
  venue's opening hour and it is the one thing the payload states about
  tomorrow. So a past `regular.start` answers **the next occurrence of that same
  opening hour** — 09:00 Paris, not `_approx_next_open`'s ~08:00 guess, which is
  an hour before Euronext opens and now serves **only where there is no exact
  field at all**. **And which of the two things a past value means is asked of
  `marketState`, not of the clock**: `PRE`/`PREPRE` name the side *before* a
  session and `POST`/`POSTPOST` the side *after* one, so a pre-session state
  answers `None`, i.e. `SHORT_RETRY`, i.e. one minute and a re-read — **that
  half is the daily path, not a corner**, `decide` arming the job *at* the open
  with no lead-in margin and #619 adding `uniform(0, 30)`, so every wake lands
  0–30 s after it and a state that has not flipped yet (Yahoo's lag, an opening
  auction, a half-day) must not be read as *the day is done*, measured at
  82 800 s of sleep, i.e. **no `price_point` for the whole session, in
  silence**, nothing re-arming a symbol that still has a job.
  **That the window is on the wall clock and not on the timestamp is the whole
  repair, and it was got wrong once**: compared against the timestamp it covered
  only the wake armed from a period Yahoo had already rolled, so a payload still
  naming yesterday read 23 h past at 09:00:12, fell out of the window, and the
  symbol slept another day — *every* day, for ever, writing nothing. Measured on
  the capture over five simulated days with `decide` and the jitter in the loop:
  **preview/v5 1 010 writes and 3 117 closed probes, the first repair 0 writes
  and 6 probes, this one 1 010 writes and 21 probes**. Anchored on the hour no
  such fixed point can form — the target armed *is* the hour then woken just
  past.
  **`OPENING_LAG` is a net and not the judge, and making it the judge cost every
  session rather than one.** The third pass reads the state that was already in
  hand: a pre-session state answers `None` **whatever its distance**, a
  post-session state arms the next occurrence of the opening hour, and the window
  keeps exactly one subject — `CLOSED`, absent or unknown, the holiday shape,
  where the payload names a session and nothing says which. While the wall clock
  was the sole judge, a `marketState` lagging its venue by more than fifteen
  minutes fell out of the window at the wake, was read as *the session is over*,
  and the symbol slept ~23 h 50 — and the condition is **stable** (a systematic
  lag, a delayed opening, a half-day), so it lost **every** session, every day,
  for as long as it held. Measured on the capture with the real `decide` and the
  jitter at a 20-minute flip: **0 writes over 5 days and 0 over 14**, against
  980 and 2 744 for preview/v5. This pass matches preview/v5 **write for write**
  at 5, 20 and 60 minutes of lag while cutting the closed probes from 3 117 to
  21, 3 167 to 71 and 3 300 to 206. The cost accepted and written down: during
  the opening blur a closed symbol is probed once a minute, a few probes a day
  against a whole night, `marketState` staying the authority on wake as design
  #603 assumes — and reading it here disturbs neither of its other two
  properties, `decide` still fail-opening an unrecognised state onto `REGULAR`
  and the cached state still being nobody's status pill. Two residues are named
  rather than widened away: a state saying `CLOSED` **through** its own venue's
  open for more than fifteen minutes, and — the price of dropping the ceiling —
  a venue publishing a long pre-market (`PREPRE` from 20:00 ET, `PRE` from 04:00,
  against a 09:30 open) *whose* period Yahoo has also not rolled, which probes
  once a minute until that open. The repository's one capture cannot show the
  second (Paris has `pre.start == regular.start`), and the trade is this module's
  own asymmetry — *a guess too early costs a fetch, too late costs a session* —
  a bounded run of requests against a session lost every day. The four exits not taken are argued
  in `scheduling.py` where the choice is made: `_approx_next_open` for any past
  value (its ~08:00 is not the venue's open, so the first wake of each day falls
  an hour *before* it, outside any window, on a payload that may still name
  yesterday — the first repair's own failure); `SHORT_RETRY` for any past value,
  which closes the morning and reopens the evening, 60 s across fifteen hours not
  being a *short* retry; `OPENING_LAG` as sole judge, the second repair's own
  failure above; and deriving the real open from `post.end` or the venue
  calendar, which rests on fields Yahoo does not guarantee (the capture carries
  no `end` at all). The test that let the original defect live
  did **not** miss the case — it pinned it: `ts = 1_700_000_000` is 2023-11-14,
  *before* the test's own `NOW`, and the assertion was that the function
  returned that past date. The successor reads **one real capture at several
  instants** — before the open, thirty seconds after it with the state still
  `PRE`, twenty and sixty minutes after it with the state *still* `PRE`, the same
  wake with the payload 1, 3 and 40 days stale under `CLOSED` as well as `PRE`,
  and five hours after the close (`app/tests/fixtures/trading_period/`, the
  `mountinfo` fixtures' rule applied to a field whose name misleads) — the
  invariant is swept across the whole captured day **on the three readings a
  closed payload can carry**, and five simulated days run end to end under the
  hypothesis the capture cannot refute, at a lag of 5 minutes and of 20. A **dead-ticker guard** (issue #617) backs a
  symbol off when non-closed cycles keep producing no writable price: the first
  3 failures still re-arm at `base_interval`, then the delay grows
  `base_interval × 2^(n−3)` capped at 24h, resetting to 0 on the first
  successful write. Closed cycles never count as failures. A **price-freshness
  liveness sonde** (issue #628) rides the `REGULAR` write path: before each write
  it reads the newest stored price for the (symbol, account) and advances the
  pure `scheduling.price_freshness_step` against per-series memory
  (`_sonde_state`). When the stored value stays frozen across *consecutive*
  `REGULAR` cycles for at least `staleness_horizon` (a store dial, default 900s) while the
  live quote moves, it emits a WARNING and raises the `sb_price_staleness` gauge.
  Staleness is measured over consecutive polling, **not** the stored point's
  wall-clock age — the writer advancing the value each cycle re-baselines, and a
  polling gap wider than the horizon (overnight/weekend close) re-baselines too,
  so the first tick after a close never fires a false positive (#628 acceptance).
  Purely diagnostic — it never changes cadence, write gating, or the #617 backoff;
  it catches a writer that fetches fine but persists *stale* values, which the
  forward gap-fill (#627) can't see. There is no global
  scrape job. **Anti-herd (issue #619):** every arming offsets its `run_date` by
  a fresh `uniform(0, 30s)` jitter (the heir of the removed inter-share
  `time.sleep(1)`; a `date` trigger can't carry APScheduler's own `jitter`), so a
  same-exchange cohort sharing one next-open spreads over `[open, open+30s]` and
  the `REGULAR`-poll lockstep is re-randomized each cycle. Jobs carry
  `misfire_grace_time=None` (run however late — a skipped run would permanently
  kill a self-rescheduling job; the on-wake `marketState` re-read self-corrects)
  and `max_instances=1`. The APScheduler **executor pool** is sized at boot,
  **always automatically** since #701: the pure
  `scheduling.compute_pool_size(shares, exchange_of)` =
  `min(RESERVED + ceil(largest_cohort × 5 / 30), 50)` with `RESERVED` 3 — one
  figure since #711, there being one job set. `exchange_of` is captured by a
  pre-scheduler fetch (`capture_exchange_of`), which is therefore no longer
  optional. The fixed dial and its opt-in flag were **deleted rather than moved
  into the store**: a `ThreadPoolExecutor` does not shrink hot, so they were the
  one couple that would still have required recreating the container — and a
  fixed pool is a silent trap besides (a cohort of 30 symbols on a pool of 10
  serialises its own scrapes with nothing anywhere to say so).
- **Ingestion**: **not a job** (issue #697). It polled the drop folder every
  300s because the files were the truth; the store is the truth now, so the
  ledger only changes when a write changes it. Ingestion still happens — armed
  by the boot and by the always-on drop-folder watcher — and each run
  reconciles the per-symbol scrape jobs against the new symbol set (add /
  remove / revive). A write through the API (forgetting an import) replays with
  `import_files=False`: the ledger has just been changed by hand, and
  re-scanning the folder would import the revoked file straight back.
- **Backfill**: **bidirectional** (issue #626), every 60s, both passes run per
  symbol each cycle and are independent — and since #703 the job is **driven by
  the replay, not by current holdings** (ADR-0009). The symbol set is the union
  over the *whole* timeline and each symbol carries its own window,
  `[first acquisition, last exit or today]` — `ConfigSnapshot.backfill_windows()`.
  This is where the backfill and the scrape stop having the same symbols, and it
  is not a refinement: iterating current positions left a share bought in 2020
  and sold in 2022 with **no reconstructed price at all**, so the account's
  `xirr` and `twr_index` were wrong *permanently*. v4 hid it because the live
  series accumulated while the share was held.
  **Backward**: anchor → first acquisition, one `backfill_chunk_days` chunk per
  cycle, stopping once the `_backfill_complete` watermark is set. The anchor is
  the **oldest window tried**, `min(ceiling, oldest stored point,
  symbol_quote.oldest_window_tried)` — the last of the three being spec #695
  § 4's one named exception to *watermarks stay derived*, since the argument for
  deriving ("it recomputes itself from the rows") fails exactly where a delisted
  symbol stands. With the oldest *stored* point as the anchor, a mute symbol
  refetched the same window every 60 s **for ever**, in silence: the stop
  condition never moved and an empty return is classified as a gap rather than a
  failure (#606), so no counter rose either. It is persisted only when the fetch
  **completed** — a failure has attempted nothing the app may skip. The target
  is the first **acquisition**, `BUY` *and* `GRANT`, and the `no_buy` terminal is
  deleted rather than renamed: a position with neither cannot carry a positive
  quantity, so it has no holding window and never enters the set.
  **Forward gap-fill**
  (issue #627): recovers a trading session missed while the app was down
  (stop/crash/host asleep) by fetching `[newest → now]` — anchor =
  `quotes.newest_ts` (newest point with `price_native IS NOT NULL`), window
  sized by the pure
  `scheduling.forward_backfill_window(newest, now, chunk_days)`. Returns `None`
  (no fetch) when the series is empty (backward owns seeding) or the anchor is
  `< 1 day` old — that guard is what makes the forward pass a **no-op during
  live trading** (`newest ≈ now`), so the `REGULAR` writer stays the sole writer
  of the present with no duplicate at the seam. Gap classification is delegated
  to yfinance: a weekend/holiday window comes back empty and stays a gap (#606),
  a missed open session comes back with rows. `_backfill_complete` gates **only**
  the backward pass. Recovered points join the same series as live ones, so perf
  `holdings_value` picks them up — and the forward pass fills the gap of a
  position sold then bought back for free, its anchor being months old the day
  the line comes back; it only ever needed the symbol to be in the backfill's
  set, which the replay now supplies.
  **The two passes part company on a sold position** (issue #699, #672 D5): the
  backward one keeps running (the chart wants the history of a line the user
  held, and the watermark bounds it, so it finishes and stops), the forward one
  stops at the same predicate as the scrape. It exists to catch a live writer
  up, and that writer has just been removed — and its own `< 1 day` no-op guard
  is precisely what that writer was keeping true, so left running it would
  refetch `[newest → now]` from Yahoo **every day, forever**, for every symbol
  the owner has ever sold out of.
  **Lateral** (issue #704): repairs the points whose `price_converted` is
  missing — an `UPDATE` on rows that exist, never an `INSERT` — gated by
  nothing the other two decide, the holding included: a series can be complete
  backwards, up to date forwards and entirely unconverted, and a sold line's
  reconstructed history is exactly what an account's returns are computed from.
  Its two stopping conditions never collapse (a fetch that failed retries for
  ever behind #617's back-off; a pair that does not resolve arms the
  `unconvertible` terminal), and an unanswered reporting currency arms neither.
  See below.
  **The rhythm does not change and there is no accelerated mode**: `backfill_delay`
  is a courtesy to Yahoo at the exact moment the app emits more requests than at
  any other time of its life, and a code path that runs once per installation is
  a code path nobody ever tests. ~25 minutes for 30 symbols over 5 years.
- **Performance**: Rebuilds the `account_metrics` / `portfolio_totals` series
  (every account since #708) as its **own interval job** on
  `scheduling.PERF_TICK` — 120s, a constant and not a dial (#701, #707) —
  decoupled from the per-symbol scrape jobs (issue #618), and firing at the boot
  rather than one tick later (`next_run_time = now`). The recompute is
  **integral and unconditional** (ADR-0011): the two tables are a *cache*, a
  pure function of the ledger, the price points and the declared accounts, and a
  full pass costs 0,4 % of the tick at five years. `scheduling.perf_should_run`
  is deleted **without a replacement**, and so are the four things that fed it —
  `_perf_lock`, `_perf_dirty_from`, `_perf_dirty_live`, `_perf_last_events` —
  plus `_mark_perf_dirty` / `_consume_perf_dirty_from`, the raise on the
  `REGULAR` write path, `decide`'s fourth return value, and the `PERF_SKIPPED`
  verdict. That was **the last coupling between the backfill and the perf**.
  Three other shapes were refused and each for its own reason: an end-of-backfill
  step is right only while the reconstruction runs and false the moment it
  finishes; an event bus rebuilds the coupling one indirection away; a step of
  the scrape fires N recomputes per market-open wave. The **only inputs are the
  store and the clock** — the job replays its own `Timeline`, because `position`
  and `account_state` are *current* states while performance needs the state of
  every day. The write is a **block `UPSERT` plus a bounded prune** of what falls
  outside the spans just written (never a replacement, never row by row), which
  is what keeps the file from drifting: a `DELETE`+`INSERT` reaches 44,8 MB for
  a 1,6 MB table over a thousand cycles, the upsert plateaus at 1,1. The series
  is **dense over calendar days**, weekends and holidays included, prices carried
  forward — "no point on a non-trading day" is a property of *observed* prices,
  and TWR chains over consecutive days. Deleting the rows is a complete rebuild:
  the next cycle rewrites them, which is why the administration page has no
  rebuild gesture to design. The cost accepted: the two tables stop being a trace
  of what the app believed at an instant — if a figure shown yesterday changed
  today, the backfill advanced, and nothing remembers.
  **It writes on a sliding horizon and by field** (issue #708, ADR-0018): see
  below.

**The perf writes on a sliding horizon, and by field** (issue #708, spec #695
§ 11, ADR-0011, ADR-0018). The two halves arrive together because removing
either one alone produces a wrong figure rather than a missing one:

- **The horizon** is an **interval**, `[first, last]`, per account, in
  `performance.account_horizon`. Every symbol blocks `[acquired(s), min(oldest
  price(s) − 1, last held day(s))]` and the series is **the latest run of days no
  block covers**. Outside it **nothing is written at all** — not a zero, not a
  `NULL` row: a held position with no price yet counts as worth nothing beside a
  cash ledger that has already paid for it, and a chained index carries that
  crater for the whole cycle. Measured on the real portfolio at #708: three
  purchases on 2020-09-28, `twr_index` 0,057, the dashboard reading
  **`TWR −100,00 %`** on eleven thousand euros. #706's second term cannot catch
  it — it is right about a **permanent** absence and silent about a
  **transitory** one, which is exactly what a reconstruction is. Seven things
  about the formula: it is **bounded by each symbol's holding window**
  (unbounded, a line sold in 2022 whose backfill is starting has its oldest
  available price dated *this year* and holds the whole account at today, a case
  ADR-0009 made ordinary); it is bounded by that window's **two** ends, the lower
  one being the same decision on the other side — the backward pass never
  overshoots the first acquisition, so a symbol's oldest price *is* its
  acquisition day once reconstructed, and without the lower bound a portfolio
  that bought a line this morning would take a horizon of this morning — and that
  lower end is a statement about **the block**, `unpriced < acquired` being
  #708's `oldest ≤ acquired` **or a degenerate window** — `holding_window` puts
  no clamp on its two ends and the validator forbids no future-dated event, so a
  single row dated next year answers a last day before its first, which #708 did
  not skip and which emptied the table; on a held symbol quoted nowhere the
  window is ordinary, the branch is not taken, and what treats that symbol is
  the cap; **a block
  that reaches the ceiling caps the series instead of bounding it** (#765, below);
  **the days left of a block that does *not* reach the ceiling go with it**, the
  residue #765 leaves standing and names rather than repairs — a line acquired
  2020-03-02, exited 2022-05-04 and quoted nowhere pins a ledger opened in 2019
  at 2022-05-05, 2019 included, on days it held nothing of that line, because a
  horizon is **one interval** and the run that survives is the one holding today;
  **when no run survives the reading falls back to the left bound**, which is the
  fresh install whose first purchase has no price yet — the series is empty
  either way and `first` names the day it could resume rather than claiming
  nothing constrains the account, which is what `/api/runtime`'s `null` means; a
  **settled** symbol does not contribute (terminal backfill, or quoted in a
  currency that does not resolve), or the horizon would freeze at today for ever
  and `carrying_price`'s domain — *terminal symbol, any day* — would be
  unreachable; and a **per-day mask was refused** though nearly free, since it
  holes the middle of the series the moment a symbol is imported late, which
  breaks the TWR's chaining and contradicts the calendar density — a cap is not a
  mask, it moves an **end** and the run stays contiguous.
  `portfolio_totals` takes the **max** of the horizons and the **min** of the
  caps: the global is written only where every account is, one slow account
  delaying the whole home page, because summing whichever accounts are ready
  draws a step nothing caused — upwards on the left, downwards on the right.
- **The block is treated where it is, and a purchase stops deleting the
  history** (issue #765). #708's horizon is a *left* bound, and it happened to
  bound a block sitting on the *right*: buying a line of a security the portfolio
  did not hold yet gives a symbol with no price anywhere, its block is
  `[acquired, today]`, and the bound landed on **tomorrow** — so the cycle
  produced no point for **anybody** and `prune_account_metrics`, doing exactly
  what its docstring says (*an empty `spans` empties the table, and that is the
  honest reading*), took the whole cache away. Measured on a real store: **1 perf
  cycle out of 2 wrote an empty table**, 1 468 days of figures gone on the
  ordinary gesture of buying something (`test_a_new_line_leaves_no_perf_cycle_
  writing_an_empty_table`). The window is short — one `PERF_TICK` ended by one
  backfill cycle, two to three minutes, the backfill being an interval job driven
  by the replay and not by `marketState` — and it lasts as long as Yahoo fails,
  or until a mistyped ticker's backward pass concludes and settles it. **That it
  is short is not what repairs it**: over that window the page does not degrade,
  it is entirely empty, and no band names it — nothing failed, the computation
  concluded there was nothing to write, which is the white screen #718 mounted
  `Band` in the content column to abolish. So the series now **stops the day
  before the block** rather than starting the day after it: the history stays,
  the last point is a day old, the next cycle catches up, and the right edge
  walks left past every block it lands in so the cap and the left bound stay
  **one rule on one axis** rather than two guards crossing. The three other exits
  are refused in the code where the choice is taken: never letting the horizon
  rise above what a previous cycle wrote contradicts ADR-0011 head on (reading
  the cache to decide what to write destroys the property the integral
  unconditional recompute bought, and repairs nothing on a fresh install);
  treating *held, never quoted, backfill not yet run* as settled contradicts
  #706's two-term predicate, whose whole argument is that carrying at cost needs
  a **permanent** absence; and assuming the blank page is the failure mode the
  product refuses everywhere else. The prune is **not** modified — its argument is
  right, it was being lied to upstream — and `carrying_price` keeps its domain:
  the cap removes days from the series, it never hands a transitory absence to
  the carrying convention.
  **What the ticket asked for and did not get is written down rather than
  counted**: its second acceptance criterion — *a day before a symbol's
  acquisition is never blocked by it, priced or not* — is held for the **block**
  and **not** for the horizon the blocks feed. A block lying wholly in the past
  bounds the series on its left edge and takes those days with it, and the two
  ways to give them back are refused by the argument that refused the per-day
  mask: keeping the *left* run abandons today's figures, which is the whole of
  the sliding horizon, and keeping both makes the series two runs with a hole
  between them. The refactor into blocks is what made the cap expressible; it
  changed **one** verdict of #708's guard and only one, the degenerate window
  above, and reading it as the repair of the ticket still reads a no-op
  (`test_the_empty_block_guard_is_708s_plus_the_degenerate_window`, whose sweep
  covers `last_held < acquired` — an earlier version claimed the two guards
  equivalent and swept only the half where they agree, so it attested a property
  it had never exercised; and the residue asserted at
  `test_the_days_left_of_a_past_block_are_lost_with_it`). Whether a horizon may
  ever be **more than one interval** is the open question, carried by #766, and
  it is #708's calendar-density decision to reopen, not this ticket's.
- **The rule is by field, never by account.** The opt-in guard read
  `declared_portfolio`, whose `None` means *nothing declared beyond the seed* —
  and ADR-0013 seeds a `default` row at the creation of the schema and never
  removes it, so the condition had lost its subject while silently leaving a
  **single-account install with no performance series at all**. Removing it alone
  would have been the other half of the bug: the replay debits cash on every
  purchase without touching the contributions, so an owner who never wrote a
  `DEPOSIT` carries `cash_balance = −invested` and `net_contributed = 0`, and
  `total_value` publishes their **latent gain under the label "total value"**.
  So `holdings_value` and `gain_absolu` are written **always** — with no external
  flow, `gain_absolu = holdings − invested` is exact, and only `xirr` has nothing
  to weight — while `cash_balance` / `total_value` / `net_contributed` /
  `twr_index` need a cash event and `xirr` an external flow.
  `performance.writable_fields` is the one spelling, applied in
  `_value_kwargs` for both tables, and the global folds the condition with
  `all` over the accounts that produce a series (ADR-0018: *a global figure is
  written only where it is writable for every account*).
- **The gain's fourth term** is the fees a broker takes out of a transfer:
  `Σ latent + Σ realized + Σ dividends + Σ transfer fees == gain_absolu`, closed
  positions included, 13,95 € on the real portfolio. Absorbing the fee into
  `net_contributed` is **explicitly refused** — the money left the owner's
  pocket, and `gain_absolu` was the only figure that knew.
- **The year-to-date gain is the movement of `gain_absolu`**, not the movement
  of value minus the movement of contributions. The two are one quantity —
  `gain_absolu = total_value − net_contributed`, so the difference of the
  differences *is* the difference of the gains — and the spelling is chosen for
  where they stop being **equally defined**: this ticket makes the two
  subtracted terms `NULL` on an install with no cash event, while `gain_absolu`
  is written always. Written the other way round, an ordinary v4 arrival — v4
  having no cash events at all — got a **present** `ytd` object with two `null`
  members, and the head printed *the history is not rebuilt that far back* under
  a portfolio whose history is complete, permanently, for exactly the population
  the per-field rule exists to serve. `twr` has no such repair and needs none:
  `twr_index` follows `total_value`, so the percentage genuinely is not
  computable there, and **the head owes an absent member an em dash rather than
  a sentence** — *there is nothing to compute* (ADR-0016) is the truth about a
  time-weighted return with no cash ledger under it. That is the second half:
  `build_portfolio_totals` already said *an unwritable member stays a `null`
  member inside a present object*, and `DashboardHead` read both through `?.`
  alone, which collapses them. `ytd: null` still means, and only means, *the
  series does not reach the base*.
- **A gauge whose field is absent is not published**, and it is a *retract*:
  a field that stops being writable has its series removed. The seven
  `sb_portfolio_*` are built **outside the registry** and join it on their first
  real value, because an unlabelled gauge has no label set to remove and
  publishes `0` from construction — a fresh install was answering
  `sb_portfolio_total_value 0` while its reporting currency was unanswered,
  the exact reading the rule exists against. **The rule has two levels**, and
  the second is not the first applied twice: absence of a *field* is
  `update_account`'s, absence of the whole *row* is `retain_accounts`' —
  `update_account` is only ever reached for a row a cycle produced, so an
  account that stops producing one is never visited and its seven gauges would
  keep the last values they ever had for the life of the process, while
  `prune_account_metrics` emptied the table beside them in the same cycle. It is
  `retain_positions`' argument on the perf's side, and `update_portfolio(None)`
  says it for the global. A stale **real** figure is worse than the zero the
  rule was written against: a scraper cannot tell it from a current one.
- **`/api/runtime` publishes the horizon per account**, from process memory: it
  rides on `PerfRecord.horizons` and comes out as `accounts: [{account,
  horizon}]` — a **calendar day** rendered as one, the shape `lib/api.ts`
  announced before either half was written, the way `rebuilding` and
  `/api/portfolio-totals` arrived. It is the one thing the recompute knows that
  no query recovers: the rows say where a series *starts*, which is another
  question the moment an account's first activity is later than its horizon.
  `horizon: null` means *nothing constrains this account*; an account **absent
  from the list** means this pass computed nothing — a perf job that has not run
  yet, or one that raised.
- **The TWR re-bases on every cycle while the reconstruction runs**, and that is
  assumed rather than corrected: the base is the first day of the series, the
  series' left edge walks backwards, so the percentage moves with no price having
  changed. It is written down in `website/docs/rebuild-and-resolution.mdx` and
  it is what `runtime.rebuilding` and `twr_since` exist to say on screen.

**The price and the position stopped sharing a row** (issue #700). `quotes.py`
is the market's own writer — `symbol_quote` and `price_point`, and nothing else
writes them — and three things about it are decisions:

- **The series has no account dimension.** A market price belongs to no account,
  so a query joining prices *per account* was a bug; the code already said so
  without being listened to (`get_price_series` and `raw_series` queried by
  symbol alone while the writer wrote one point per holding). The
  `COALESCE(account, 'default')` shim dies with the column it rescued, and the
  row count falls by **25 %** before any retention decision. The scrape therefore
  writes **once per symbol**, and so does the backfill — where the old shape
  would have fetched the same window from Yahoo once per account.
- **Close only: no OHLC, no volume.** `price_open`/`high`/`low` were not dead
  columns, they were columns that **lied**: the live writer set all three to the
  close on every point it wrote.
- **One maintenance rule, written once, covering three cases**: *any writer
  inserting a `price_point` whose `ts >= last_price_ts` updates the `last_*`
  columns in the same transaction*. The invariant is "the most recent point,
  whatever its completeness" — the other spelling reintroduces the per-field
  last-non-null pass the store exists to avoid. `symbol_quote` carries the
  `last_*` columns rather than a second `latest` table because it is already one
  row per symbol, written by the same module, refreshed at the same instant.

The **name of a share is not there**: it lives on `position`, written by the
replay, because it comes from the owner's file and not from Yahoo — so renaming
a share can no longer cut its history in two.

The live writer **appends** and never rewrites its own timestamp; the range
writer **deletes its own span then inserts**, which is where `price_point`'s
uniqueness lives now that the table carries no key (ADR-0007). The span is the
**batch's**, not the window that was asked for: a `DELETE` bounded by the request
can erase a point the fetch did not bring back, so a chunk that comes back short
after a Yahoo hiccup would silently lose the history it failed to re-supply.
Timestamps stay truncated to the second, which is what makes re-running one
cycle idempotent.

**There is one reporting currency, and two levels of currency and not three**
(issue #702, ADR-0002 amended by ADR-0021). `base_currency` is the one dial with
no default and the one question the app asks; `Account.currency` is **deleted**,
not converted, and with it `MODE_MULTI_CURRENCY`, `build_multi_currency_head`,
the `account_currency` tag and the single-currency condition that gated
`portfolio_totals` — in a three-level model *"a EUR account holding a USD
security"* is a sentence with a meaning, therefore a bug needing a guard, a test
and a degraded screen; here it has no referent. Five things about it are
decisions:

- **`fx.py` is a pure module with a TTL cache**, in the taste of `scheduling.py`
  / `performance.py`: the fetch is injected, so the whole of it tests against a
  fake with no network. The TTL is what makes a market-open wave share **one**
  rate per pair — converted at N slightly different rates, the positions of one
  wave do not add up to their own total. No pseudo-symbol `EURUSD=X` in the
  scheduler (a pair has no `marketState` that projects onto the equity cadence
  model), no `fx_rates` table, no extra job. A failed fetch is cached for the
  same span: forty symbols in an unresolvable currency would otherwise ask Yahoo
  forty times a cycle, forever, for a ticker that does not exist.
- **`GBp` is normalised to `GBP ÷ 100` before any pair is named**, matched
  **case-sensitively** — `GBp` and `GBP` differ by one letter's case and by a
  factor of a hundred, so an `upper()` anywhere on that path turns pence into
  pounds in silence. The hundredth is folded into the **rate**, not applied to
  the price, so `price_converted == price_native × fx_rate` holds on the stored
  row: the row is a journal one can read back (*"2 345 € — 10 × 234,50 $ at
  1,0844 on 5 August"*), not three numbers that do not reconcile.
- **The conversion happens on the write path and is passed *in* to the writers.**
  `_scrape_symbol` converts once per pass and hands the pair to `/metrics` and to
  `quotes.record_quote` alike, so the rate stored beside a price is provably the
  one that price was multiplied by. The rebuild prefetches the pair's daily
  history beside the price history — one request per chunk — and converts each
  point at the rate of **its own day**: at today's rate a five-year-old close
  would put a currency move into a chart of a share price.
- **A missing rate writes the point with `price_converted = NULL`**, never *no
  point*. The quote is what cannot be re-fetched (Yahoo gives nothing under the
  hour past 60 days); the conversion is repaired by #704's lateral pass, which is
  the only reason a `NULL` here is viable at all.
- **Event amounts are never converted.** `unit_price` / `fee` / `amount` are the
  **debit, in the reporting currency**, which is what makes the cost basis exact
  instead of re-estimated from a historical rate and removes historical FX from
  the past entirely. Only prices are converted.

While the currency is unanswered, **nothing refuses**: the scrape runs and stores
`price_native`, the converted columns stay `NULL`, the perf job writes nothing at
all (not zeros, not `NULL`s — every figure it computes is money and an amount
with no settled unit is not a figure), the account gauges are therefore absent,
and the API states the condition through the head's `currency` being `null` and
the dial's `stored: false` on `/api/config`. No route and no field is added for
it (ADR-0021): a fourth kind of absence would make every page depend on one
preamble. The reads that draw money — P1's `price`, `raw_series`,
`bucketed_series`, `prices_at`, `daily_closes`, `quotes.price_series` — all read
the **converted** column for the same reason; the native price and the rate ride
beside P1's row so a reader can recognise the quote their broker shows them. The
freshness sonde (#628) is the one read pointed at `price_native`, because a
currency tick would otherwise pass for a price that is still being refreshed.

**And the lateral pass is what makes that `NULL` viable** (issue #704, spec #695
§ 4 / § 5 / § 7). A third backfill pass repairs the points whose
`price_converted` is missing: it works on **the same rows as the series, short
of a column**, so it is an `UPDATE` and never an `INSERT` — on a table that
carries no key to refuse a duplicate (ADR-0007). Without it the `NULL` would be
a permanent absence every reader had to work around, and the `latest` rule would
have to become *the most recent **complete** point*, which is the per-field
last-non-null pass the store exists to avoid. It rides on the backfill rather
than owning a job: same cadence, same politeness delay, same chunk, and its
last-pass record is **one more direction** (`runtime_state.LATERAL`) on the same
recorder — so the fold of consecutive failures, the retention on a forgotten
import and the payload's shape all come for free. Five things about it are
decisions:

- **Two stopping conditions that never collapse into each other**, and that is
  the ticket. A **fetch that did not complete** is a failure: it follows #617's
  back-off (`regular_interval × 2^(n−3)` past the grace of three, capped at 24 h,
  reset by the first conversion that lands) and retries **indefinitely** —
  nothing was learnt about the pair, so nothing may be concluded about it. A
  **pair that does not resolve** is a *reply*: yfinance completed the request and
  `XYZEUR=X` is not a ticker, so it arms the `unconvertible` terminal — the
  fourth of the family — and names the pair. *« En attente de conversion »* and
  *« ne se convertira jamais »* are two different sentences and only the second
  asks the owner to act.
- **The difference is made structural rather than guessed.** `rate()` folds every
  unanswerable case into `None` on purpose — a writer writes the point either way
  — so a second entry point, `fx.Rates.observe`, answers `resolved` /
  `unresolved` / `failed` beside the rates. What decides it is the injected
  fetch's own shape: `main._fetch_fx_series` **raises** now instead of swallowing
  (`fx.Rates` catches and logs exactly as it used to, so the rebuild sees no
  change), and an empty answer is the pair saying it does not exist. A window is
  asked for with ten days of padding on its left, which is both the forward-fill
  a Sunday needs and what keeps *a window with no trading day* from reading as
  *this pair is not a ticker*.
- **An unanswered reporting currency arms neither**, and it is locked twice —
  in the pass, which stands down on `no_base_currency` before it looks at
  anything, and in `observe`, which answers `failed` for a missing code. That
  absence is transitory and lifted by a write of the owner's; reading it as an
  unresolvable pair would make answering the dial change nothing for the whole
  stock already scraped, which is the one gesture the feature exists to honour.
  The **security's** currency missing is a third state and not a failure either
  (`no_quote_currency`): it is only ever learnt at a first successful fetch, so a
  symbol nobody has managed to quote sits durably with no converted point at all,
  and the runtime state is what says so.
- **Answering the currency starts the pass**, which is why `base_currency` is the
  one dial carrying a `REPAIR_CONVERSIONS` effect rather than `NEXT_CYCLE`: its
  value is **retroactive**. `repair_conversions_now` clears the back-off memory —
  a symbol backing off was failing at a question that has just changed — and
  advances the backfill job's next run; it is called by `PUT /api/settings` *and*
  by `_adopt_declared_currency`, an import declaring its currency (#710) being
  the same pose on the road a headless install takes.
- **The `latest` rule covers the repair with no additional clause** (spec #695
  § 7). The newest repaired point is handed to `_advance_latest` exactly as the
  live writer hands its own, and its `WHERE` decides by itself: the row moves
  when the repaired point *is* the most recent one, and is refused when it is
  not. A day the pair has no rate for keeps its `NULL` and comes back next cycle
  — with the window cached by then, so no request is emitted for it.

`runtime_state.DIRECTIONS` exists for one reason worth writing down: the route
enumerated the two directions by hand, so the pass was invisible on
`/api/runtime` the day it landed. `build_backfill_summary` still counts the
**backward** pass alone — an `unconvertible` series is not an achievement but a
fault to act on, and counting it as *done* would have the banner announce as
finished the very thing it should be naming.

**And the pass learns the unit it used to only name the absence of** (issue
#773, ADR-0009, ADR-0002, ADR-0004). Measured on staging: two accounts reading
**−99,98 %** and **−29 120,25 %**, seven `/api/positions` rows out of nineteen
with `converted: null` and **all seven `quantity = 0`**, `lateral:
{'no_quote_currency': 7}` stable over thirty backfill cycles on an install
otherwise healthy. The chain is two modules deferring to each other, each in
writing: `_convert_history` read the currency from `_share_info_cache` *"because
the backfill runs on symbols the scrape has already met"*, and left the case it
did not cover to *"#704's lateral pass, which is exactly what that pass is
for"*; the lateral pass stood down on `no_quote_currency` because a quote
currency *"is only ever learnt at a first successful fetch"*. **The faulty
premise is dated**: it was true before #703, and ADR-0009 made the backfill's set
the union over the *whole* timeline while the three paths that can learn a
currency — `_scrape_symbol`, `capture_exchange_of` and the cache both fill —
stayed bounded by the **held** lines. So a line sold before the install existed
got years of reconstructed prices in a unit nothing could ever record, and
`no_quote_currency` was the one lateral condition with **no exit** (the other two
have one: an owner's write, and a terminal that says to act). Downstream, the
symbol was absent from `oldest_priced`, therefore classed `settled`, therefore
did not bound the horizon, therefore counted **zero** in `_holdings_value` on
every day it was held while the cash ledger had paid — and the TWR chained the
crater. Four things about the repair are decisions:

- **The pass asks, because it is the one that knows.** It already owns #617's
  back-off, the backfill's politeness delay and a last-pass record, and the cost
  lands on the job whose rhythm is built for it. The two other exits are refused
  where they stand: asking from the rebuild's own conversion step contradicts
  `_convert_history`'s argument head on — a second `.info` **per chunk** doubles
  the rate-limit exposure of the job that already emits the most requests —
  where the need is one fact **per symbol**; and widening `capture_exchange_of`
  to the replay's set puts it in `post_fork`, where the whole boot blocks and
  the time cap is already load-bearing rather than defensive (#701).
- **The answer goes to `symbol_quote.currency`**, through a writer of its own
  (`quotes.record_attributes`) rather than through `record_quote`, which appends
  a `price_point`: the lateral pass is *an `UPDATE`, never an `INSERT`*, and a
  row inserted to carry a unit would be a market observation nobody made on a
  table with no key to refuse it (ADR-0007). The store is also what makes the
  cost **bounded and per symbol**: the next cycle reads the answer instead of
  asking. What is *not* learnable is bounded by process memory
  (`_quote_currency_unknown`) — a reply of *Yahoo names no currency* has nothing
  to write, and a `NULL` column already means *nobody has asked*, so a second
  meaning on it would collapse the two states at the exact moment
  `SKIP_NO_QUOTE_CURRENCY` has to tell them apart.
- **The three lateral answers stay three.** A request that does not complete is
  a **failure** — #617's back-off, retried for ever, nothing concluded because
  nothing was learnt — and a request that completes naming no currency is a
  **reply** that keeps `SKIP_NO_QUOTE_CURRENCY` as its subject and still never
  arms `unconvertible`: there is no pair yet, so nothing has refused to resolve.
  #704's distinction is not overwritten by the repair.
- **The third state shrinks, and what is left of it joins the carrying
  convention** (ADR-0004, ADR-0021) — the criterion's two branches, and it takes
  both. Learning the unit repairs every symbol Yahoo **names** one for: the
  position is priced and `_holdings_value` stops counting it zero. It leaves
  intact the population Yahoo answers *cours and no currency at all* for — which
  criterion 3 requires be kept as a distinct state — and for that one the whole
  chain still stood: quoted, terminal, never converted, absent from
  `oldest_priced`, therefore `settled`, therefore not bounding the horizon,
  therefore **zero** on every day it was held. Measured on a real store at
  `value_on(2024-06-02) == (0.0, True)` on a line worth ten shares. So it joins
  one of the two existing conventions rather than becoming a fourth kind of
  absence, and the argument is one sentence: **a number with no unit is not a
  cours**. #706 refuses to carry *quoted with no rate* because that absence is
  **transitory**; here Yahoo has been asked and names none, so there is no pair,
  no rate coming and nothing to wait for — and the cost is defined in the right
  unit already, event amounts being the debit in the reporting currency
  (ADR-0002). The rule is therefore in the `quoted` **term**, never in
  `carrying_price`, whose domain is untouched: `quotes.first_quoted_days` joins
  `symbol_quote.currency` on the series paths and `carrying.is_quoted` says the
  same on a P1 row, so the valuation and the shares page cannot answer
  differently. **It is derivable from the store, which is what decided the
  implementation**: the perf job's only inputs are the store and the clock
  (#707), so `_quote_currency_unknown` — process memory — could not have carried
  it, and no column is added (the DDL is applied `IF NOT EXISTS` with no
  migration machinery, the argument that decided `transfer_fees` and
  `closed_at`). What makes the reading permanent rather than premature is #706's
  **second** term, unchanged: a symbol whose backward pass has not concluded is
  never handed to the convention at all — it blocks the horizon instead, so its
  days are *not written* rather than written at nothing. `_share_info_cache` is
  filled on the way, so the chunks the backward pass fetches **after** the learn
  are converted at write time and the pass has less to repair each cycle.

### Scheduled Jobs
```text
┌──────────────────────────┐  ┌───────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│  SCRAPE  (per symbol,    │  │  INGESTION        │  │    BACKFILL      │  │   PERFORMANCE      │
│  self-rescheduling)      │  │  (NOT a job)      │  │  (backfill_      │  │  (PERF_TICK,       │
│                          │  │                   │  │   interval dial) │  │   ungated)         │
│ • yfinance.Ticker()      │  │ • boot, or the    │  │ • Backward pass  │  │ • Replay the       │
│ • marketState → cadence  │  │   watcher, or a   │  │ • Forward pass   │  │   Timeline         │
│ • REGULAR: poll & write  │  │   write — never   │  │ • Lateral pass   │  │ • Full recompute   │
│ • Closed: sleep to open  │  │   a timer (#697)  │  │ • Chunk 1 yr/req │  │ • Upsert + prune   │
│                          │  │                   │  │ • Rate limit 10s │  │                    │
└──────────────────────────┘  └───────────────────┘  └──────────────────┘  └────────────────────┘
         │                            │                       │                       │
         └────────────────────────────┴───────────┬───────────┴───────────────────────┘
                                                   ▼
                                            ┌─────────────┐
                                            │  the store  │
                                            │  (DuckDB)   │
                                            └─────────────┘
```

The two pure modules `scheduling.py` (cadence/market-context decisions) and
`performance.py` (money-weighted returns) hold the testable logic — no store or
yfinance, `now` injected.

## Configuration

### One loading path (issue #711)

A portfolio is described by `events/*.csv` and `events/*.xlsx`, and by nothing
else. There is no mode: `SB_CONFIG_MODE`, the `mode:` key and the auto-detection
between them are gone, and `config.yaml` is **named at startup, never read**.

**`settings.yaml` is named and never read either** (issue #698). It was the last
file the app parsed, and it mixed a deployment setting (`events.source`,
`events.watch`) with user data (the `accounts:` block) in one document — the
seam ADR-0006 exists to separate. Its two halves leave in different directions:
the accounts become a file in the events' own format (below), and the drop
folder is **`SB_IMPORT_DIR`** since #740 — a directory, `/import` in the
container, read once at boot and handed to `ConfigurationManager` rather than
fetched from the environment down there (ADR-0015). Nothing is migrated and
nothing is deleted: the file stays where its owner put it, and startup names it
once.

Every `SB_*` variable treats a blank value as unset (`boot_env.text` /
`integer` / `flag`, still spelled `env_str`/`env_int`/`env_flag` for the
process-wide callers), because compose renders an undefined substitution as an
empty string.

> **Coming from a manual v4**: nothing is migrated. Typing a position means
> creating dated events — an aggregated position carries no dates, so it can
> carry neither a realised gain nor a historical weighted average cost.

---

### Events (CSV/XLSX)

Import portfolio events from files and automatically compute aggregated positions.

#### File Structure

```
~/.config/SuiviBourse/
└── events/               # The drop folder — every .csv/.xlsx in it is imported
    ├── accounts.csv      # An accounts source: id, type, label (issue #698)
    ├── 2023.csv
    ├── 2024.csv
    └── broker-export.xlsx
```

A file is an **accounts source** or an **event source** according to its
**header**, never its name: `id` + `type` and no `event_type` makes it a
declaration. `settings.yaml` sitting in the same directory is simply not one of
these.

#### CSV Format

```csv
date,event_type,symbol,name,quantity,unit_price,fee,amount,notes
2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase
2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,8.50,Q1 2024
2024-06-01,GRANT,AAPL,Apple Inc,1,,,,Stock split bonus
2024-09-15,SELL,AAPL,Apple Inc,3,180.00,2.00,,Partial sale
```

#### Columns

| Column | Required | Description |
|--------|----------|-------------|
| `date` | Yes | ISO format (YYYY-MM-DD) |
| `event_type` | Yes | `BUY`, `SELL`, `GRANT`, `DIVIDEND` |
| `account` | See below | The id of a declared account |
| `symbol` | Yes | Yahoo Finance ticker (e.g., `AAPL`, `MSFT`) |
| `name` | Yes | Display name for the share |
| `quantity` | For BUY/SELL/GRANT | Number of shares |
| `unit_price` | For BUY/SELL; **optional on GRANT** | Price per share. On a GRANT it says *valued award* (it feeds the contribution and the cost basis together); leaving it empty says *dilution* (#699) |
| `fee` | Optional | Transaction fee. On a BUY it is absorbed into the cost basis; on a SELL it reduces the proceeds and lands in the realized gain |
| `amount` | For DIVIDEND | Dividend amount received |
| `notes` | Optional | Free text comment |
| `base_currency` | Optional | The reporting currency the file's amounts are recorded in (issue #710). A fact about the **whole file**, so two different codes in one file is a refusal; written by the export, and read on the way in — a store that has none takes it. Never `currency`, which a broker export uses for the *security's* quote currency |

#### Declaring accounts (issue #698, ADR-0013)

An account is **user data with provenance, not a setting**, so it is declared
the way an event is: by a file in the same format, with columns `id`, `type`,
`label` (`label` falls back to the id), or from the app. The file is what
multi-account needs in the UI *and* headless: an install with no interface has
nothing to click, and reserving the declaration to the UI would forbid
multi-account to every headless install — and with it any broker export that
names accounts.

The rules, each of them keeping a mistake a refusal:

- **All account sources are imported before all event sources**, never
  alphabetically — `event.account` references `account(id)`, and a folder whose
  meaning depended on how many times it was scanned would be the bug.
- **An event file naming an undeclared account is not imported at all**, and
  the message names the account to declare.
- **A blank `account` column means `default` until something is declared, and
  is an error afterwards.** That is v4's rule *minus its opt-in*, and it is what
  makes a single-account v4's event files import without a single edit — cash
  events included, where v4 demanded an account it would now refuse.
- **A declaration that moves re-imports the event files**, fingerprint or not:
  rows written under `default` before their accounts existed would otherwise
  stay there while the page showed the accounts.
- **There is always at least one account.** The seeded `default` row is never
  removed — a file may take it over, and forgetting that file hands it back
  rather than taking it away. Nothing in the app branches on *"are accounts
  declared"*: `EventAggregator` keys by `(account, symbol)` unconditionally.
- **An account is undeletable while an event names it**, and so is the import
  that declared it — the cascade is *refused*, never performed (`409` on the
  API). Forget the event imports first. Its **cached** figures are not in that
  rule and go with it (`perf_series.forget_account`): `account_metrics`
  references the account row, so without the drop the perf job's first cycle
  would make every declared account undeletable — and a refusal on a figure the
  next cycle rebuilds would put a cache on the same footing as a fact the owner
  recorded.
- What came from a file is **read-only** (`source_id` set); what was created in
  the app is editable (`source_id NULL`). `POST`/`PATCH`/`DELETE /api/accounts`
  serve the second and refuse the first.

#### Event Types

| Type | Effect on Portfolio |
|------|---------------------|
| `BUY` | +quantity, +cost_basis (`qty×price + fee` — the acquisition fee is absorbed), −cash |
| `SELL` | −quantity, −cost_basis (`qty × PMP`), +realized_gain (`qty×price − fee − qty×PMP`), +cash |
| `GRANT` | +quantity; +cost_basis `qty×unit_price` **if the row declares one**; cash-neutral |
| `DIVIDEND` | +received_dividend, +cash (`amount − fee`) |
| `DEPOSIT` | +cash (`amount − fee`), +net_contributed (cash event: `amount` required, no share) |
| `WITHDRAWAL` | −cash (`amount + fee`), −net_contributed (cash event) |

Cash is a per-account ledger (starts at `0.00`). Negative balances are allowed
(non-blocking warning); overselling stays blocking.

#### Aggregation Logic — a position is one stock (issue #699, ADR-0003)

A position is **a `quantity` and a `cost_basis` stored as an amount**; the unit
price (the *PMP*) is derived by `events.schemas.unit_cost`, the one place in the
product that divides. `purchase.quantity` and `purchase.fee` are gone as state
*and* as names: *"how much did I ever buy"* is `SUM(quantity) WHERE event_type =
'BUY'` and *"how much did I pay in fees"* is `SUM(fee)`, both queries over the
events. Three things fall out at once:

- **a sale is a subtraction** — no average is rebuilt, so ten years of partial
  sales accumulate no rounding drift;
- **a fully sold position reports zero invested by construction** (quantity 0 →
  basis 0), which is where the phantom **−932 €** on a sold line disappears;
- **the unit price of a sold position is undefined**, which is the truth: it has
  a realized gain instead.

**The matching convention is the weighted average (PMP), with no dial** — it is
the French tax rule (CGI art. 150-0 D), and offering FIFO alongside would make
the app carry two conventions at once.

**There is no `closed` flag**: the predicate is `quantity == 0`. *Closed* and
*temporarily flat* differ only by a **future** event, so nothing computable
today separates them — and the guess is free, because `_reconcile_jobs` re-arms
any held symbol without a live job. The filtering line is `_held_symbols()`,
never `Timeline.current()`: a sold position must stay in the snapshot so the
replay writes its realized gain and the page shows it.

Three named figures replace one composite, each with its own domain:

| Figure | Formula | Defined when |
|---|---|---|
| Latent gain | `holdings_value − cost_basis` | position open (`None` with no observed quote **whose backfill is still running**, and `None` while a known quote waits for its rate) |
| Realized gain | Σ sales `(net proceeds − basis removed)` | from the first sale, **permanently** |
| Dividends received | `position.received_dividend` | always |

**A position with no price is carried at its cost** (issue #706, ADR-0004,
`carrying.py`). On a day where a held position has no observed price — *and
never will* — it is valued at its own PMP, never at the last execution price and
never at zero. Zero is what dug a crater in the consolidated curve on the day of
a purchase: the cash ledger had already paid while the holding was worth
nothing, so the total dropped by the purchase and climbed back the next morning.
Without the cash ledger the two curves ignored the position together and simply
stepped up a day late, which is why no version before the consolidated dashboard
ever drew the hole. Five things about it are decisions:

- **The rule is keyed on the absence of a price, never on a calendar.** A market
  calendar would explain the hole without filling it — the surviving occurrence
  is an Amsterdam execution mis-valued because the app asks Yahoo for the
  *NASDAQ* quote of the same company.
- **The predicate has two terms, not one**: no cours was observed **and** the
  symbol's backfill is terminal. `carrying_price(observed, quoted, quantity,
  cost_basis)` owns the first, the caller owns the second — a set from
  `quotes.terminal_symbols`, derived from the **store** (the ceiling, the oldest
  stored point, `oldest_window_tried`) rather than from the scheduler's
  in-memory `_backfill_complete`, which is empty for one cycle after every boot.
  Without the second term a reconstruction replays a portfolio flat-at-cost for
  four years that takes off and then corrects itself, with the owner having done
  nothing.
- **The first term is about the quote, not about its conversion.** Every money
  figure the app draws reads `price_converted`, so the naive spelling — *the
  price is absent* — also catches the position whose **quote is known and whose
  rate is not**: `base_currency` unanswered, or a pair that does not resolve.
  That state is *waiting*, one of `CONTEXT.md` § Absence's four kinds and never
  rendered like *carried at cost*, and it is durable — the point is written with
  `price_converted NULL` until #704's lateral pass repairs it. So `quoted` is a
  required argument, and each caller supplies it from what it has:
  `carrying.is_quoted` on a P1 row, and `carrying.was_quoted` against
  `quotes.first_quoted_days` — one `GROUP BY` — on the two series paths,
  forward-filled exactly as the close beside it is. **And a quote is a number
  *and* a unit** (#773): both spellings ask for `symbol_quote.currency` beside
  `price_native`, because a close in no nameable unit is one no rate can turn
  into money — that one is *carried at cost*, and reading it as *waiting* counted
  it zero for ever.
- **One implementation, called by the valuation and by the shares page.** Two
  would make two users of the same software see two curves for the same
  portfolio with nothing on screen able to say so — so `performance.
  _holdings_value`, `portfolio_view.build_shares` / `valuation_series` and the
  `titres` head all hold the same function object, and a test asserts that on
  the source.
- **The price column stays the em dash** — the app does not invent a quote —
  while value and latent gain use the carried price, which is what makes the sum
  of the rows equal the total. **A carried value is not marked at the point**
  either: it is *right*, not approximate, and annotating it would amount to
  annotating "the app did what it says it does".
- **The backfill anchor does not overshoot.** Fetching even a week before the
  first acquisition would give the forward-fill a close to carry onto the
  purchase day, and the fallback would never fire there — the two exclude each
  other, and a convention that only triggers in rare cases is one that rots with
  no test noticing.

The one case where carrying visibly parts company with a valuation is stated in
`website/docs/read-your-figures.mdx`: a position mixing a purchase and a
zero-cost grant *inside* the window with no price is carried at its cost,
therefore at half of what its shares are worth.

> **The rule a contributor will break:** the realized gain is a **decomposition**
> of the absolute gain, never a term added to it. The sale's proceeds are already
> in the cash balance, so `gain_absolu + realized` shows a winning account losing,
> perfectly plausibly. `tests/test_performance.py` pins #672's worked example to
> the cent — `latent +497,00 · realized −335,89 · dividends +20,00 = +181,11 €` —
> **and** pins the forbidden operation's `−154,78 €`.

**A `GRANT` carries an optional `unit_price`** feeding the external contribution
*and* the cost basis **together** — one function, `events.schemas.declared_value`,
read by the aggregator and by `performance` alike, because two spellings of
*"was a price declared?"* would eventually disagree by a few euros and the
symptom is an identity that quietly stops holding. Present is a valued award
(latent gain nil on the day), absent is dilution (both zero). It also takes
`price_at` out of the contribution path, which is what stops `gain_absolu`
drifting as the backfill advances with no event having moved.

No format change, and **no new validation** — a value that cannot be a price
(zero, negative) is normalised to dilution where it is read, never refused. The
validator runs over the **whole stored ledger** on every build, not only over a
file someone just dropped, and the column was parsed and silently discarded
before v5: a refusal there would be retroactive, and a row that was legal when
it was imported would fail the boot in the gunicorn master — in an app the user
then cannot reach to repair it.

**Dust normalisation** (ADR-0017): a sale emptying a position to under
`10⁻⁹ × Σ acquired` sets `quantity` **and** `cost_basis` to exact zero. A real
broker export writes `0.34898399999999996` and leaves `4×10⁻¹⁷` of a share
standing; the noise is in the file, not in the arithmetic, so the clamp is
applied where the file's number lands (the SELL) and nowhere else. **The
oversell guard carries the same tolerance**, because the same file rounds the
other way just as often: a tolerance on the leftover and none on the guard makes
the refusal a coin toss on the last bit of a float — and this replay runs in the
gunicorn master, so raising there takes the whole portfolio down over `4×10⁻¹⁷`
of a share, on a ledger with no row-level edit to repair it with. A real
oversell is still blocking.

---

### Key Behaviors

#### Event Ordering
Events are **sorted by date** before processing, regardless of their order in files or across multiple files. You can add events in any order.

#### Multi-file Support
All `.csv` and `.xlsx` files in the events directory are loaded and merged. Use this to organize by year, broker, or account. **No filename has a special meaning** (issue #711).

#### Caching
Since #697 the ledger lives in the store and the files are no longer re-read on a timer, so there is nothing to poll and nothing to invalidate on a schedule: an import is triggered by the boot, by the always-on watcher, or by a write. The cache key is the store's own stamp (`ledger.stamp`) and **no file joins it** since #698: it moves on a re-drop that changed content, on a forget, and when the declaration changes — including an account created in the app, which changes no import and no event.

#### Error Resilience
If ingestion fails (invalid event, file error, an accounts source that cannot stand), the **previous valid configuration is kept** and scraping continues normally. Errors are logged but don't crash the application. Since #658 this holds for the *whole* app rather than for scraping alone: a snapshot is published only once complete and valid, so backfill and the perf recompute cannot read a configuration the validator refused.

---

### The dials (issue #701, ADR-0014)

**There is one place that says what a setting is worth: the store.** No
precedence rule, no seed-on-first-boot, no settings file, no environment form —
and **no dial requires a restart**, which is what leaves the settings page a
single class of field. `settings_registry.py` is the **single list**: for each
dial its key, type, default, bounds and *what changing it triggers*. The write
path validates against it, `/api/config` enumerates it, and the form renders it.
Four lists would agree on the day they were written and not much longer.

| Dial | Default | Bounds | Effect of a change |
|---|---|---|---|
| `regular_interval` | `120` | 10–86400 | re-arms the scrape jobs **whose market is open right now** |
| `backfill_interval` | `60` | 10–86400 | reschedules the `backfill` interval job |
| `backfill_delay` | `10` | 0–3600 | read by the next backfill cycle |
| `backfill_chunk_days` | `365` | 1–3650 | read by the next backfill cycle |
| `staleness_horizon` | `900` | 0–86400 | read by the next scrape cycle; `0` disables the sonde |
| `base_currency` | *none* | ISO-4217, 3 letters | the reporting currency. No default, upper-cased on the way in, **fixed from the first recorded event** and free before that; the next cycle converts, and answering it **starts the lateral pass over the whole stock already scraped** (#704) — the one dial whose value is retroactive |

`PUT /api/settings` is the **only writer**, and it being HTTP is what keeps a
headless install whole — *headless means without an interface, not without
HTTP*, so one `curl` suffices and the page is one client among others. It
answers `422` (`application/problem+json`, with the refused `key`) on an unknown
dial, a wrong type or a value out of bounds, and **writes nothing at all** when
it refuses: a half-applied body is a state nobody asked for.

Three properties of the apply path are decisions rather than details:

- **Only what actually changed is re-armed.** `reschedule_job` recomputes
  `next_run_time` from *now*, so a save button that rewrote every row would put
  every timer back to zero on every click — invisibly. The comparison is
  against the store's *effective* value, so re-posting `120` on a dial that
  already reads `120` reports no change at all.
- **`regular_interval` reaches only the symbols currently in `REGULAR`.** The
  question is put to the jobstore rather than to a second copy of `marketState`
  (`scheduling.rearm_split`, classified against the **outgoing** interval): a
  polling symbol was armed at most `interval + jitter` ahead, a sleeping one at
  its next market open. A sleeping symbol is not mis-set — it reads the dial
  when it wakes. The answer therefore **quantifies the effect**
  (`symbols_rescheduled` / `symbols_at_market_open`), because a portfolio-wide
  dial that reaches 3 symbols out of 11 has to say so.
- **`regular_interval` is also the base of #617's back-off**, whose wait is
  `regular_interval × 2^(n−3)` and not an absolute delay stored anywhere — so
  changing it rescales, **retroactively**, the wait of a symbol that has been
  failing since this morning. No interface can hide it: the number in the form
  is the number in the formula.

Three of v4's variables were **deleted rather than moved**:
`SB_DYNAMIC_EXECUTOR_POOL` and `SB_EXECUTOR_POOL` (a `ThreadPoolExecutor` does
not shrink hot, so they were the one couple that would still have needed a
restart — sizing is now always automatic), and `SB_PERF_INTERVAL` (the gate is
the cadence). Every retired `SB_*`/`INFLUXDB_*` variable that is still **set** is
named at start-up in **one grouped notice** and obeyed by nothing
(`main.report_unread_environment`) — the gesture `config.yaml` and
`settings.yaml` already get, and the list is *computed* rather than written down,
so it cannot drift.

### The advisories (issue #709, ADR-0021)

**`advisory(key, first_seen_at, acknowledged_at)` is a tiny table carrying an
acknowledgement, and nothing else** — not a journal: no history, no row per
occurrence, a closed list of keys. `advisories.py` holds **the text and the
predicate**, the way `settings_registry.py` holds the dials, and the table stores
only what the code cannot work out again. The sort was made on one question —
*can the app recompute this later?* — and four of the five survive it as
**derivable states**: a `stat` for a v4's `config.yaml` and its `settings.yaml`,
`main.unread_environment()` for the variables nothing obeys, and
`SuiviBourseMetrics.reconstruction_state()` — process memory — for how far the
reconstruction has got. **One is a real event**: *"v5 asserted your v4 amounts
were already in your reporting currency"*, produced **once** at the end of the
first reconstruction by comparing `symbol_quote.currency` to `base_currency`,
deferred because at import time no symbol has been fetched, and lost if it is not
written since the reconstruction never happens twice. Its sentence is actionable
rather than accusatory and it **names the events concerned** — recomputed by a
join, never stored, which is the whole trick: *that the assertion was made* is
the row, *what it was made about* is a query.

**Five keys and not six.** ADR-0021 amends spec #695 § 14 on exactly this point:
a missing base currency is a **live condition**, not an advisory — *the banner
shows conditions the owner can end; the badge counts facts they can only
acknowledge* — and counting it here produced a permanent badge on an install that
had simply not answered yet.

Logs would be cheaper, and the one thing they cannot do is the reason the table
exists: **a log cannot be acknowledged**. Every advisory *is* also logged, once,
in logfmt (`extra['context']`, so the headless channel is parseable), at the
instant the row is created — which is what makes "logged once" a property of the
mechanism rather than a discipline. Four properties follow:

- **The row exists exactly while the advisory stands.** `advisories.refresh` arms
  what stands and has no row, and **drops** the row of what no longer does — so
  an acknowledged advisory disappears, and re-arms with a fresh date and a fresh
  log line if its predicate comes back. The acknowledgement of a fact that has
  stopped being true would make the next occurrence invisible.
- **An observation has three answers.** `None` is *does not stand*, a mapping is
  *stands, and here is what it names*, `UNOBSERVED` is *not from here*. Arming
  needs a positive observation and **so does disarming**: the reconstruction's
  progress is process memory, so without the third answer a request served by a
  runtime with no scheduler would drop the row that scheduler armed a minute
  earlier and re-date it on the next cycle. **Which is why
  `SuiviBourseMetrics.reconstruction_state()` is total** and never answers
  `None`: *nothing to reconstruct* is `(0, 0)`, an observation that disarms, and
  *unobservable* is `runtime.metrics` being absent altogether — the one shape a
  process with no scheduler has. Spelling both `None` made the notice outlive
  its own subject: forgetting every import while the reconstruction was armed
  emptied `backfill_windows()`, the advisory read the silence as "not from here",
  and *"the historical reconstruction has not reached every first acquisition"*
  stood for ever on a portfolio naming no symbol at all.
- **The observation belongs to the jobs, never to a `GET`.** `review_advisories`
  runs at each `ingest()` (boot, a file landing, a write) and at the end of each
  backfill cycle — both read all four sources through the one builder,
  `main.advisory_context`, so neither can drop what the other armed, and the
  concluded reconstruction is where the recorded advisory is born.
  `GET /api/advisories` re-derives each standing row's detail and writes nothing;
  `POST /api/advisories/<key>/acknowledgement` is the only gesture, and the
  acknowledgement **persists** — which a *toast* does not, and which the
  assumed-currency advisory needs, arriving half an hour after the boot.
- **Never confused with the audit.** `import_source` is the provenance trail.
  Merging them would give an advisory box that grows by a row per import and that
  one stops reading — both failures at once.

### Environment Variables

What is left in the environment is exactly what the process must know **before**
it can open the store (ADR-0014) — a mechanical test, not a judgement about
nature. **Six names and no seventh** (issue #740): `boot_env.py` is the pure
module that says them once, `main.ENVIRONMENT_INVENTORY` is its alias, and it is
the list `/api/config` publishes.

| Variable | Default | Description |
|----------|---------|-------------|
| `SB_STORE_DIR` | `/data` | Directory holding the DuckDB store `suivi-bourse.duckdb` (issue #696). Boot-scope by nature: the process must know it before it can open the store, and therefore before it can ask the store anything (ADR-0014) |
| `SB_IMPORT_DIR` | `/import` | Directory the drop folder is read from (issue #740, ADR-0015). Optional: an install with no file to import is a complete install |
| `SB_WEB_PORT` | `8080` | Port for the Flask web API and its `/health` route — the container healthcheck's only target (issue #651). Since #696 the probe **reaches the store**: "survive a database outage" has no subject once the database is a file this process opens (ADR-0015) |
| `SB_PROMETHEUS_ENABLED` | `true` | Mount the legacy Prometheus `/metrics` endpoint. Since #651 it unmounts a Flask route rather than skipping an HTTP server, so `false` also leaves `SB_METRICS_PORT` unbound |
| `SB_METRICS_PORT` | `8081` | Port for the Prometheus `/metrics` endpoint — a second gunicorn socket on the same app, so existing scrapers see no change |
| `LOG_LEVEL` | `INFO` | Logging level. Here rather than in the store because the most likely failure of this app is the store failing to open, and a level kept inside it could not report that |

Three rules ride with the two directories, and each removes a class of mistake
rather than adding a convenience:

- **They are directories, never files.** The app names its own store file and
  its write-ahead log, so pointing at a path whose parent is not mounted stops
  being expressible — and the mount observation that follows interrogates a
  *directory* rather than a file that does not exist yet.
- **The defaults describe the container**, and it is the deployment *without*
  Docker that overrides them. That is the reverse of v4, where compose always
  rendered every variable and made the app's own defaults dead code.
- **Blank counts as unset** for all six (`boot_env.text`/`integer`/`flag`),
  because compose renders an undefined substitution as the empty string.

**There is no `SB_WEB_ENABLED`** and there will not be one (ADR-0015): headless
is a *usage*, not a setting. The page has no port of its own — it is served on
the API's socket — so a switch for it would be a dial **of the store**, in a
product that has just deleted its only restart-scoped dial. What an operator
stops serving is the page; **never the API**, the only non-interactive path to
answering the reporting currency. `SB_PROMETHEUS_ENABLED` is not the
counter-example it looks like: it decides a **socket to bind**, and the list of
binds is fixed when the gunicorn master starts.

**`SB_STATIC_DIR` left with #740** rather than becoming a seventh name: it
existed for "anyone serving the bundle from elsewhere", and there is one image
carrying the bundle at one path. It is named in the boot notice like any other
variable that stopped being read. **And no variable carries a secret any more** —
`INFLUXDB_TOKEN` was the only one, so the effective-configuration view's
redact-by-name rule died with its subject and the `secret` field is gone from the
payload.

**The fourteen that went quiet are a computed complement**, never a literal:
present `SB_*`/`INFLUXDB_*`, minus the six, minus the four the app has *never*
read (`SB_VERSION`, `SB_CONFIG_DIR`, `SB_UID`, `SB_GID` — naming those would
introduce names the app never obeyed into a sentence about names it stopped
obeying). Which of the three clauses a name lands in — *moved to a dial*,
*removed with no successor*, *never read at all* — is read off
`settings_registry`, so adding a dial takes `SB_<KEY>` out of the last clause
with nothing in `boot_env.py` edited. One grouped logfmt line at start-up, and
only when there is something to say.

**That fourth list survives #743, and it is the only *live* one of the six places
those four names are still written.** It survives on purpose: they belonged to the
compose file, the compose file is gone, and the population the exclusion protects
is precisely someone who still has a v4 `.env` sourced into their environment.
Deleting the tuple would not remove the names from the product, it would move them
into the notice — which is the one thing spec #730 § 3 says they must never enter
— and it would break the four tests that pin the exclusion (`test_boot_env.py`,
`test_runtime_wiring.py`, `test_scheduling_wiring.py`, `test_web_api.py`). The two
remaining mentions are prose about the disappearance rather than uses of the
names: `website/docs/settings.mdx`'s *a different case again* row, and ADR-0015's
opening sentence. The arbitration that keeps all six is written up with #743
above.

### Persistence is observed and said, never demanded (issue #741, ADR-0015)

**`docker run ghcr.io/pbrissaud/suivi-bourse` starts, and what it lacks is a
volume rather than a variable.** #677/D12 refused to boot without an explicit
store location, the error message being the guide; ADR-0015 amends it, and the
ephemeral container becomes a **trial run** — type three positions, look at what
it gives, lose it all on the way out — which is exactly what ADR-0005 needs now
that typing a position is the onboarding.

What makes the amendment *safe* is one fact, **asserted false in session before
it was verified**: `/proc/self/mountinfo` distinguishes a mounted path — named
volume *or* bind — from the container's writable layer with certainty. The
predicate was in the wrong place, not wrong: it refused at boot what it is
enough to **observe and state**. `app/tests/fixtures/mountinfo/` holds the
verification — four tables captured in a real container, versioned beside the
`docker run` that produced each — and it is the proof rather than an
illustration.

- **`mounts.py` is pure and takes the *text*.** That is what makes the whole of
  it testable without a container; reading `/proc` is one function at the
  bottom, and `resolve` is injected the way `now` is in `scheduling.py`, so
  symlinks are followed by `os.path.realpath` in production and by a fake in a
  test. `..` is collapsed either way.
- **The match is on the longest mount point that *prefixes* the path**, never on
  equality: a bind of `/data` and a bind of an ancestor both answer *persistent*,
  and a volume mounted inside a bind wins over the bind. Ties go to the later
  line — a second mount over one point shadows the first.
- **What that match then decides is its filesystem, not its name.** The captured
  tables are why: an unmounted `/data` is absent, but `/` is always there, so
  *"the path is not in the table"* is never the observation actually made. The
  naive spelling — *the longest match is `/`, therefore ephemeral* — is right in
  a container and **false on a Docker-less install**, where `/` is an ordinary
  filesystem that survives everything. So the discriminant is the field already
  parsed beside the mount point: `overlay`/`aufs` is the writable layer,
  `tmpfs`/`ramfs` is a RAM disk, anything else outlives the container.
- **Off Linux the answer is `unknown`, and `unknown` prints nothing.** The
  observation is a property of the kernel, and an absent `/proc` must not
  manufacture a false *ephemeral* on the machine of a macOS developer — the one
  platform this app cannot run natively on at all (#657).

**`sb_store_ephemeral` (`1`/`0`) is not an ornament: it is the only form of
notice a headless installation receives**, and without it ADR-0012's *"Prometheus
stays"* serves the portfolio's figures and never the state of the installation.
A **gauge and not a counter**, so it goes out the day the container is restarted
with a volume, and published **in both directions** — a series that disappears
reads as a scraper that lost its target, not as *off*. On `unknown` it is
**absent**, which is the exporter's own rule rather than an exception to it: a
`0` states that the store *is* kept, and an observer that could not look has no
ground to state it. That is also why it is created by the first observation:
`prometheus_client` publishes an unlabelled gauge at `0` from the instant it is
constructed.

**Three lines at start-up** (`boot_conditions.py`, pure — the text and the
predicate here, the one impure emission in `main.report_boot_conditions`), each
in logfmt with a `condition=` key to grep for, **once each and only when true**:
no persistence, no reporting currency, no portfolio. *Once* is a property of
*where* they are said — `build_runtime`, in the gunicorn master, under
`preload_app` — and not of a flag. The currency line carries the `curl` on
`PUT /api/settings`, the only non-interactive path to answering it (ADR-0015);
the empty-portfolio line names the drop folder rather than a `curl`, the API
having **no write path** for a ledger since #711.

**"No persistence" is a condition and never an advisory** — in ADR-0021's exact
sense, *the banner shows conditions the owner can end; the badge counts facts
they can only acknowledge*. So none of the three lines is one of #709's five
keys: no row, no `first_seen_at` and above all **no acknowledgement**, which
would make *"this container keeps nothing"* go quiet while it is still true.
`boot_conditions.py` says it and `test_boot_conditions.py` asserts it on the
source — the three keys are disjoint from `advisories.SPECS`. They do not count
towards a page's screen obligations either: they are at the
terminal and in the metrics. The fact reaches the front by the **same path as
the rest of the runtime state**, `GET /api/runtime`'s `store.persistence`, for
the reason that put `rebuilding` there: it is a property of *this process* and
its mount namespace, answered from memory with no query, so it survives the one
failure that empties every page. It is observed **once**, in the master, and
carried on `Runtime` across the fork — a mount namespace does not change under a
running process. The data page's *store* block (#724) consumes this, and it is
where an ephemeral store **dominates** rather than appears in a note.

---

## Module Structure

```
app/src/
├── gunicorn.conf.py        # Container entrypoint AND boot sequence (issue #651)
├── main.py                 # Runtime/build_runtime/start_runtime, ConfigSnapshot, ConfigurationManager, SuiviBourseMetrics
├── boot_env.py             # Pure: the six boot variables and the computed list of names gone quiet (#740)
├── mounts.py               # Pure: mountinfo text + a path → persistent / ephemeral / unknown (#741)
├── boot_conditions.py      # Pure: the three start-up lines — text and predicate, said once each (#741)
├── quotes.py               # The market's two tables: symbol_quote + price_point, one `latest` rule (#700), and the lateral repair — an UPDATE, never an INSERT (#704)
├── fx.py                   # Pure: the reporting currency, GBp, one TTL cache per pair (#702), and the three answers a window fetch carries back (#704)
├── carrying.py             # Pure: the carrying price, the holding window, the backward anchor (#706)
├── performance.py          # Pure: XIRR/TWR, the sliding horizon and the per-field rule (#563, #708)
├── perf_series.py          # The perf job's two tables: account_metrics + portfolio_totals, block upsert + bounded prune (#700, #707)
├── store_reads.py          # PortfolioReader — the UI read primitives; errors propagate (#659, #700)
├── portfolio_view.py       # Pure: P1 rows → page objects (weighted mean, per-account rollup) (#659)
├── runtime_state.py        # The scheduler's last-pass records — the one writer, one shape (#668), three backfill directions (#704)
├── runtime_view.py         # Pure: records + snapshot + jobstore → pills and the banner (#668)
├── prometheus_exporter.py  # Legacy Prometheus sb_* gauges (registry only, no server)
├── store.py                # The DuckDB store: connection, DDL of the twelve tables, seed (#696)
├── ledger.py               # The import: import_source/symbol/event, provenance, revocation (#697)
├── entries.py              # The typed row's three gestures — source_id NULL only (#764)
├── accounts.py             # The account table: the accounts file, the declaration, the refusals (#698)
├── positions.py            # The replay's two tables — position/account_state, one writer (#699)
├── settings_registry.py    # Pure: the one list of dials — key, type, default, bounds, effect (#696/#701)
├── advisories.py           # The five advisories: text and predicate in code, the table holds the ack (#709)
├── settings.py             # The dials' write path: validate the whole body, write what moved (#701)
├── static/                 # Built SPA (git-ignored; Vite's outDir, COPY'd in the image)
├── web/                    # Flask package (disposable half, per #655)
│   ├── __init__.py         # create_app() + the post_fork / worker_exit hook bodies + SPA catch-all
│   ├── api.py              # /api blueprint: positions + portfolio-totals and its history (#763, #721), shares, prices, portfolio, accounts (read — the seeded row included, #729 — and declare, #698) and one account's history, events (read + the typed row's three writes, #764), export (#710), imports, advisories (#709), store + orphan purge (#724), config, runtime
│   ├── problem.py          # RFC 9457 application/problem+json responses (#659)
│   └── health.py           # /health blueprint — touches the store (#696)
└── events/                 # Events module
    ├── __init__.py
    ├── schemas.py          # Dataclasses: Event, EventType, ShareState + unit_cost (#699)
    ├── loader.py           # CSV/XLSX loading, and the file's own base_currency (#710)
    ├── export.py           # Pure: the ledger back out, in the import format (#710)
    ├── validator.py        # Event validation
    ├── aggregator.py       # Aggregation logic — the PMP, the realized gain, the dust clamp
    └── watcher.py          # File watcher (watchdog)

app/web/                    # Front-end workspace — Vite + React 19 + TS, Tailwind/shadcn,
                            # TanStack Table & Query, Recharts. Builds into app/src/static.
├── src/index.css           # Three blocks: preset · domain · @theme inline bridge (#713)
├── src/app.tsx             # The providers, mounted identically by main.tsx and the tests
├── src/router.tsx          # Four code-based routes; the history is an argument
├── src/i18n/{en,fr}.json   # ICU catalogues, semantic keys, English the source
├── src/lib/api.ts          # The only module that knows a URL
├── src/lib/i18n.tsx        # Language: three states, localStorage, ICU
├── src/lib/theme.tsx       # Theme: three states, localStorage, writes the alloc ramp
├── src/lib/alloc.ts        # The twelve allocation stops, generated per ground
├── src/lib/format.ts       # The eight Intl sites, locale as an argument
├── src/lib/problem.ts      # problem.type → catalogue key. `detail` is never rendered
├── src/lib/status.ts       # The dot's state, and who says a band — shell then page (#718)
├── src/lib/docs.ts         # The one door outside: page, version, locale, ten anchors (#718)
├── src/lib/sign.ts         # The colour of a figure — and zero is not absence (#718)
├── src/lib/absence.ts      # Pure: the four renderings of absence (#718)
├── src/lib/gain.ts         # Pure: ADR-0018's four terms and their sum (#718)
├── src/lib/shares.ts       # Pure: a row is a symbol, the carried value, the two orderings (#719)
│                           #       plus the sheet: the breakdown that is absent at one account, the day-markers (#720)
├── src/lib/ledger.ts       # Pure: the fields of a type, the identity, the reduction, the two parses (#723)
├── src/lib/advisories.ts   # Pure: what the block shows, what the badge counts, what a notice leads to (#724)
├── src/lib/installation.ts # Pure: the cadence's reach, and only what moved is sent (#724)
├── src/lib/accounts.ts     # Pure: the window, the rebasing to 100, the vanishing column, the reason (#721)
│                           #       plus the declaration: who names a row, where it came from, why it stays (#729)
├── src/components/Explain.tsx     # The convention bubble: click, scroll-closes, versioned link
├── src/components/Stat.tsx        # The one figure+label pair, explanation slot included
├── src/components/EmptyState.tsx  # The one empty state
├── src/components/Band.tsx        # The one band — the shell's, and a page's own read (#718)
├── src/components/EntryPair.tsx   # The two ways in, equal weight — shared with the first run (#723)
├── src/components/dashboard/      # The dashboard's own blocks — Head first (#718)
├── src/components/shares/         # Head · table · the fold · the chart (#719) · the sheet, its event list and the selection that links the two (#720)
├── src/components/data/           # Tab 1: the ledger, the create form (#723) and the accounts' declaration (#729) · Tab 2: notices, settings, the store (#724)
├── src/components/accounts/       # The rebased chart · the eight columns · the sheet's shell (#721)
└── src/test/               # setup · MSW server · payload factory · renderApp
```

## Prometheus Metrics (legacy)

`/metrics` is a **first-class product** and not a legacy half (ADR-0012): it is
what makes the app usable headless, for whoever wants something very simple.
Enabled by default on `SB_METRICS_PORT`=8081, it runs beside the store and
reflects only the current snapshot per share (no historical backfill). Disable it
with `SB_PROMETHEUS_ENABLED=false`.

Since #651 it is a route on the Flask app, mounted with `DispatcherMiddleware`
and served on its own gunicorn socket — same port, same path, no change for a
scraper. `prometheus_exporter.py` owns the registry only; its `start()` and its
`ThreadingHTTPServer` are gone.

Gauges (prefix `sb_`, labels `share_name`/`share_symbol`/`account`): `sb_share_price`,
`sb_share_price_native`, `sb_fx_rate`,
`sb_cost_basis`, `sb_owned_quantity`, `sb_received_dividend`,
`sb_realized_gain`, `sb_dividend_yield`, `sb_pe_ratio`,
`sb_market_cap`, `sb_volume`, plus `sb_share_info` (value `1`, with extra labels
`share_currency`/`share_exchange`/`quote_type`). `sb_price_staleness` is the
price-freshness liveness sonde (issue #628): `1` when a symbol's stored price is
silently stale (frozen past `staleness_horizon` during `REGULAR` while the
live quote moves), `0` otherwise — a gauge so it auto-clears when the writer
recovers.

`sb_store_ephemeral` carries **no label at all** and is not about a share (issue
#741): `1` when the store lives in the container's writable layer, `0` when it
is on a mount that outlives it, **absent** while the mount is unobservable. It
is the one series that reports the state of the *installation* rather than of
the portfolio, and it is what makes a bare `docker run` say — to a headless
install too — that it keeps nothing.

**Never a gauge whose unit depends on a setting** (issue #702, spec #695 § 12).
A single `sb_share_price` would mean dollars on one install, euros on another and
euros *from Tuesday* on a third — not a metric, a trap with a plausible-looking
value in it. So there are **two price gauges**: `sb_share_price` publishes the
converted price, `sb_share_price_native` the quote as the exchange gives it, and
`sb_fx_rate` the rate between them. While the base currency is unanswered the
converted one and the rate are **absent** (not zero — a zero is a figure every
`sum()` counts), and so is every `sb_account_*` / `sb_portfolio_*` series, since
the perf job writes nothing at all until then. The position gauges are *not*
under the rule: their amounts come from events **recorded** in the reporting
currency, so answering the dial names a unit they always had. `sb_account_info`
lost its `account_currency` label with `Account.currency`.

**Two feeders, two lives** (issue #699). `update_position` publishes what the
events say — `sb_owned_quantity`, `sb_cost_basis`, `sb_received_dividend` and
`sb_realized_gain` — and it is called by the **replay**, for every position,
sold ones included. `update_quote` publishes what the market says, on the
fetch-success gate. Riding the realized gain on the scrape's write path would
never publish it at all: the path is removed at the exact instant the figure is
born.

**Two removals, on two different predicates.** `forget_quotes(symbol)` drops
every market series of a symbol whose scrape job departs (`_reconcile_jobs`):
without it `sb_share_price{share_symbol="ALO"}` sits at its last observed price
for the life of the process, never saying it stopped moving. And
`retain_positions(shares)` — what the replay calls — drops the position series
of a position the ledger **no longer produces at all** (a forgotten import); a
loop that only ever set would leave a cost basis standing for a holding nobody
declares, quietly counted by every `sum()` over the metric until a restart.
Zero quantity is *not* what takes a position series away: a sold position is
still declared, and its realized gain is the figure it has left to say.

**All three `sb_purchased_*` gauges are gone** — renamed rather than redefined
(spec #695 § 12, `website/docs/headless-gauges.mdx`), and none of them into a
survivor, because each would have changed *meaning* under its old name:
`_quantity` counted *"ever bought"* and v5 has no such state; `_fee` counted a
fee that now lives inside the cost basis, so the only value left to publish
would be a zero reading as *"no fees paid"*; `_price` went from fee-excluded to
fee-included. What replaces them is the state itself — `sb_cost_basis`, an
**amount** — and the unit average is that divided by `sb_owned_quantity`, a
division PromQL does perfectly well and which stays honestly undefined on a
position nobody holds. A sold position publishes `0` for both: a zero is a
figure, and absence is kept for what could not be computed at all.

## The market and performance tables

**`symbol_quote`** — one row per symbol, written by the scrape (and, for the
`last_*` columns, by the backfill's forward pass). It is the `latest` row *and*
the instrument's attributes, which is why there is no second table.

| Column | Description |
|---|---|
| `symbol` | Yahoo Finance ticker; the primary key, referencing `symbol(symbol)` |
| `currency` / `exchange` / `quote_type` | the instrument's attributes, refreshed on every successful fetch |
| `dividend_yield` / `pe_ratio` / `market_cap` | the fundamentals, in **current value only** — yfinance supplies them on the live quote alone, so their v4 "history" was a comb of `NULL` |
| `fetched_at` | when the attributes above were last refreshed |
| `last_price_native` / `last_price_ts` | the `latest` row, maintained by the one rule above |
| `last_price_converted` / `last_fx_rate` | the same observation in the reporting currency, and the rate used (#702). The three price columns move together — a native price beside a converted one from an earlier point is the per-field last-non-null row the store exists to avoid |
| `oldest_window_tried` | the backward pass's anchor — the oldest window **tried**, persisted (#703). A `DATE`: a window boundary is a calendar day. Written only when a fetch completed, and only ever backwards |

**`price_point`** — the series, and the one table with **no key of any kind**
(ADR-0007): a DuckDB ART index is a second copy of the data in resident memory,
costing +563 MB on a 319 MB base. Uniqueness moves to the writers.

| Column | Description |
|---|---|
| `symbol` | the ticker. **No account**: a market price belongs to none (#700) |
| `ts` | `TIMESTAMPTZ` in UTC, truncated to the second |
| `price_native` | the close, in the security's own currency |
| `price_converted` / `fx_rate` | the close in the reporting currency and the rate that produced it (#702). `NULL` means *transient* — no currency answered yet, or a pair that did not resolve — repaired by #704's lateral pass. `price_converted == price_native × fx_rate` holds on every row, which is what makes the row a journal |

**`account_metrics`** (every declared account since #708; one row per calendar
**day**, inside the account's **horizon** `[first, last]` and never outside it
— the cap being what keeps a purchase from deleting the series (#765) — block
upsert on `(account, day)`). The series is recomputed **and rewritten in full**
every cycle since #707: the stale-tail window lost its subject, an upsert on a
primary key not growing the file the way a `DELETE`+`INSERT` replacement does
(ADR-0011: 44,8 MB against 1,1). What follows the upsert is a **bounded prune**
— every day outside the spans the cycle wrote, per account, so an account that
computes to nothing loses its days along with the orphaned one. The primary key
is therefore a **write mechanism** and not only a constraint.

| Column | Description |
|---|---|
| `account` | account id, referencing `account(id)` |
| `day` | the calendar day the figures describe — a `DATE`, never a midnight instant (#700) |
| `cash_balance` | per-account cash ledger balance. `NULL` without a cash event (#708) |
| `holdings_value` | Σ(quantity × price) over the account's symbols — **always written** |
| `total_value` | `cash_balance + holdings_value`. `NULL` without a cash event |
| `net_contributed` | Σ deposits − Σ withdrawals (fees excluded). `NULL` without a cash event |
| `xirr` | money-weighted return (annualized); latest point only, `NULL` without an external flow |
| `twr_index` | time-weighted return, base 100 (per day). `NULL` without a cash event — it follows `total_value` |
| `gain_absolu` | absolute gain (`value − contributions`); latest point only, **always written** (ADR-0018) |

`account_type` has **no column**: it was an InfluxDB tag, and a page reads it
from the declaration (ADR-0013), which is what the account *is* rather than what
it was when a point was written. `account_currency` has none either, and for a
second reason since #702 — an account has no currency at all.

**`portfolio_totals`** — the same seven figures at the **global** level, keyed by
`day` alone. A table of its own rather than a synthetic `account` row, and it
stays one for a forward-looking reason rather than an inherited one: the
constraint that made it untagged is gone, but its columns will diverge the day
the global level carries something the per-account level does not. The
single-currency condition that used to gate it left with `Account.currency`
(#702): accounts cannot disagree about a currency they do not have. What gates
**both** tables is the base currency being answered at all — and, per row, the
horizon and the per-field rule (#708): the global's days start at the **max** of
the accounts' horizons and stop at the **min** of their caps (#765), and its
cash-derived four are `NULL` unless every account that produces a series has a
cash ledger.

Money-weighted performance (XIRR by home-grown bisection, TWR base 100) is
computed in `app/src/performance.py` — a pure module taking a `Timeline` and an
injected `price_at` callable (no store, no yfinance). External flows
(DEPOSIT/WITHDRAWAL/GRANT) are the contribution; internal flows (BUY/SELL/
DIVIDEND/fees) are the performance — which is why a sale needs nothing here: the
proceeds land in cash and `total_value` is continuous across it. A **GRANT is
valued at the price its own event declares** since #699, never through
`price_at`: the old valuation made an account's `gain_absolu` change as the
backfill advanced with no event having moved, and a grant-only position had no
price at its date at all.

Prometheus mirrors these as `sb_account_*{account}` gauges plus `sb_account_info`
(label `account_type`; `account_currency` left with `Account.currency`, #702)
and global `sb_portfolio_*` gauges
(no `account` label). Price history for `holdings_value` is read via
`quotes.price_series(store, symbol)` — the day's **last** point, queried by
symbol, which is no longer a rule to remember: there is no account column to
forget.

## Contributing

- DCO sign-off required: use `git commit -s`
- Conventional commits enforced (feat, fix, docs, deps, chore, refactor)
- Version bumping is automatic via Release Please

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven with the `gh` CLI — including the
v5 wayfinding map (#669) and its child tickets. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.

### Wave orchestration

The v5 tickets are implemented in waves off `preview/v5` by the two scripts in
`.claude/workflows/`. See `docs/agents/wave-orchestration.md`.
