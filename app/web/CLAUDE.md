# app/web/ — the front

> **ADR-0031 has landed for the ledger** (#795): the table reveals forty rows at
> a time, its header is sticky and its body bounded, the two filters are chips,
> and the count and the end-of-ledger sentence are true of the reduction. The
> suspension of `docs/adr/README.md`'s rule for `preview/v5` that this file
> carried ends here — with one clause of the record still ahead of the code, the
> ⌘K palette's three optional sections, which are #797.
> **ADR-0030 has landed** (#794): the data page is the three tabs described
> below, the notices are the one block that exists when it is empty, and the
> imports are one band above the ledger table.
> **ADR-0029 has landed** (#788): the preset below is the one the app runs on.
> **ADR-0028 has landed whole** (#792, #793): the accounts page is the
> master-detail described below, and it is where an account is declared, renamed
> and removed.

Vite + React 19 + TypeScript, Tailwind/shadcn, TanStack Query & Router, Recharts.
The tables are written by hand on the `components/ui/table.tsx` primitives:
TanStack Table was a dependency of the prototype and no file ever imported it.
Builds into `app/src/static/`, which Flask serves. It lives under `app/` because
the Docker build context is `./app` — it is **not** a pnpm workspace with
`website/`.

```bash
pnpm install
pnpm lint    # tsc -b --noEmit
pnpm test    # vitest, no network and no configuration
pnpm build   # → app/src/static/ (git-ignored)
pnpm dev     # Vite :5173, proxying /api → localhost:8080 (SB_API_URL to change it)
```

The content column is **uncapped** since #792: `max-w-7xl` was a measured
decision whose measurement expired with the two pages it was taken on, and what
it did on the branch was nothing below 1 536 px and an off-centre page above it
(ADR-0022, amended). Width is answered by **tracks, not by longer rows**; the
976 px reflow target and the 390 px drawer are untouched.

**`lint` is the type-checker and nothing else** — there is no ESLint here. One
`// eslint-disable-next-line react-hooks/exhaustive-deps` survives from the
prototype (`AccountsCard`); it documents a deliberate dependency and **enforces
nothing**, so a hook's dependency array is held by review alone. It sits on a
`useMemo` keyed by a hand-built stamp, and the stamp is the thing to read when
touching it.

The *why* of each screen is in `docs/adr/` (0016 through 0026), then in
`docs/v5-decisions.md`.

## One test seam, the outermost

The real router, the real pages, the real catalogues, the real theme and a real
`QueryClient` mount in jsdom; **HTTP is the only faked edge** (MSW) — the exact
parallel of `tests/test_e2e.py` on the Python side.

`src/test/factories.ts` is **one** parameterised factory, in the taste of
`fake_ticker`: it covers the shapes the real portfolio cannot show (N ≥ 3
accounts, a held position in a foreign currency, a held position with no price, a
quote with no currency). No fixture carries a real symbol, amount or label.

**Assertions are on the accessible rendering** — never a class, a component name,
or a DOM snapshot.

Three nets hold a rule nothing made true by construction:

- `src/readsInFlight.test.tsx` — for each of six surfaces, the routes actually
  requested are recorded off the MSW lifecycle, then replayed **one at a time with
  that read hanging for ever**, asserting an *absence*. It also fails when a route
  of `ROUTES` is visited by no surface. Since #777 it reads **every rendered
  phrase carrying a word**, not only the emptiness markers.
- `src/noSpinner.test.ts` — on the *source* as well, and for what no rendering
  test can see: a turning circle carries no word, so the net above walks straight
  past it. `animate-spin`, `animate-pulse`, a `progressbar`, an `aria-busy` and
  any reach for the registry's `Skeleton` are refused outside `ui/`.
- `src/inFlightShape.test.ts` — at the level of the *source*: it builds the app's
  own program from `tsconfig.app.json` and asks the checker what each slot was
  **declared** to hold. `tsc` does not close the `readonly X[] | null` shape
  (`?? []` satisfies it); this test is what closes it.

## The rules

- **A read in flight is not an absence** (ADR-0026). A block waiting on a *needed*
  read **renders nothing at all, title included** — no hand-written skeleton. The
  page passes `?? null` and never `?? []`; `?? []` survives only where an absent
  read *removes a line* instead of falsifying one.
- **Paginated, only the first flight is silent** (ADR-0031). The ledger's first page
  in flight renders nothing, headers included; *show more* and the count describe a
  table that has landed and may therefore speak — the paging is a **rendering
  budget** (`lib/ledger.ts`'s `PAGE` and `reveal`), never a second fetch, because
  `GET /api/events` answered once and with the ledger entire. No spinner in either
  case, and *end of the ledger* is never said before the last row has arrived. The
  three sections of ⌘K that read — shares, accounts, events — are **optional**: an
  absent one removes its section instead of holding the palette, and the palette
  reads on **open**, never on mount.
- **Four renderings of absence and no fifth** (`lib/absence.ts`, ADR-0021). The em
  dash says *there is nothing to compute*; anything merely missing is **named**.
  Zero is not absence (`lib/sign.ts`).
- **A rule is written once.** `lib/gain.ts` calls `absenceCase` rather than holding
  a second copy — written twice, the copy loses a branch (it did).
- **A convention is explained on the figure** (ADR-0016): `Explain`, the bubble
  that opens **on click and never on hover** (hover does not exist on a finger),
  closes on scroll, and links to the versioned, localised docs (`lib/docs.ts`).
  One icon per figure **and per surface**; never on a cell.
- **A total and its terms are never read at equal weight** (ADR-0016, amended by
  #787). Subordination is a **size** as much as a position: in a table the total
  is the header and in a panel it is a block containing its terms, and on a card
  it may sit beside them where the type tells them apart — `head` against `term`
  is a factor of three. A shared row is a defect only where neither cue is
  there.
- **A block with nothing in it does not exist.** The layout shifts when a notice
  appears.
- **A receipt lasts as long as the operation, never three seconds** (#796,
  `CONTEXT.md` § Receipt). The export is therefore a **fetch** and not an
  `<a download>`: a link hands the request to the browser, which settles at no
  observable moment, so anything said over it would be a guess with a timer on
  it. `lib/save.ts` is the two lines that hand the bytes to the reader's own
  *Save as*, and the file's **name is the server's** — which of the two names
  the events resource answers under is a fact about whether anything was held
  back. This is the one wait the product dresses, and it is not in contention
  with the spinner rule: that rule is about a **read**, whose subject nothing
  may be claimed about; this is the reader's own act.
- **One band on screen or none.** `lib/status.ts` holds the causal order between
  the shell's band (what is true of the installation) and a page's own (a read of
  its own that failed). Since #787 that order is **two conditions**, not three:
  the reconstruction left the band for the **dot**, which gained a fifth state
  for it, and its detail — the bar and the lagging account — is a block on the
  installation tab, where the dot leads.
- **Green means the quotes are read *and* the performance is up to date** (#787).
  The dot used to hold one predicate, the scheduler, and stayed green while a red
  band announced a rebuild on every page — two surfaces disagreeing about one
  installation. With the rebuild folded in, one glance answers *are the figures I
  am looking at any good*, which is why no page dates its own figures any more.
- **The theme, the language and the table density are the reader's three
  preferences, one mechanism** (ADR-0024 decided the first two): three states each
  for theme and language (`light|dark|auto`, `fr|en|auto`), **two** for density
  (`comfortable|compact` — there is no `auto` for a density), three
  `localStorage` keys of identical shape, **no dial in the store**. Numbers and
  dates follow the **language**, not the currency. ADR-0024 says *two* because
  density came later; a record is dated, and it is this line that carries the
  count.
- **`index.css` has exactly three blocks** (ADR-0023, whose preset ADR-0029
  replaced): the tweakcn primitives (**never hand-edited**, regenerated with
  `pnpm dlx shadcn@latest add https://tweakcn.com/r/themes/cmt32e2t8000304i51to693cn`
  — our own *Suivi Bourse* preset, since none of the registry's forty-two said
  midnight and mint, and **never a pasted JSON**), the domain layer (only what
  the preset cannot say — the three marks are aliases now, so only `--gain`,
  `--loss` and `--attention` are really added), and an `@theme inline` bridge.
  `src/themeCut.test.ts` holds all of that on the source, including that no
  theme JSON is versioned anywhere and that no third party is in the build.
- **`lib/api.ts` is the only module that knows a URL**, and the paths it exports
  are what the test handlers fake.
- The front branches on `problem.type` and renders `detail` nowhere.

## Module map

```
src/
├── app.tsx / router.tsx      # the providers, mounted identically by main.tsx and the tests
├── index.css                 # preset · domain · @theme inline bridge
├── i18n/{en,fr}.json         # ICU catalogues, semantic keys, English is the source
├── lib/
│   ├── api.ts                # the only module that knows a URL
│   ├── i18n.tsx theme.tsx    # language and theme: three states, localStorage
│   ├── density.tsx           # the third preference: two states, same key shape
│   ├── pageHeading.tsx       # what the header's `<h1>` says, declared by the page
│   ├── alloc.ts format.ts    # the twelve allocation stops · the nine Intl sites
│   ├── problem.ts status.ts  # problem.type → key · the dot's state, who says a band
│   ├── absence.ts sign.ts    # the four renderings of absence · the colour of a figure
│   ├── gain.ts               # ADR-0018's four terms and their sum
│   ├── shares.ts             # a row is a symbol; the carried value; the day-markers
│   ├── dashboard.ts          # the two readings, the twelve slices, the four states, the day
│   ├── accounts.ts           # the rebasing to 100, the weights, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses, the reveal · what a revocation removes
│   ├── advisories.ts         # what the block shows, what the badge counts
│   ├── installation.ts       # the cadence's reach, and only what moved is sent
│   ├── currencies.ts firstRun.ts receipts.ts docs.ts save.ts
├── components/
│   ├── Explain · Stat · EmptyState · Band · EntryPair · FirstRun · CurrencyField
│   ├── ChartTooltip           # what a chart answers the pointer (#787: the axes went)
│   ├── Shell · ContentHeader (the title, the dot, the three preferences)
│   ├── AppSidebar (the navigation, and the status card that develops the dot)
│   ├── dashboard/  # the hero head, the chart, the allocation, the movers, the accounts card
│   ├── shares/     # the head, the table, the fold of closed lines, the chart, the sheet
│   ├── data/       # tab 1: ledger, create form, drop zone, import and export menu
│   │               # tab 2: notices  ·  tab 3: settings, the store
│   │               # (the accounts declaration moved to accounts/ — ADR-0028)
│   └── accounts/   # the rail of weights, one account's detail, its curve, its form
└── test/           # setup · MSW server · payload factory · renderApp
```

## The four pages, one line each

- **Dashboard** (`/`) — a **plateau of two tracks** from `lg`, split *drawn*
  against *read down*: the head (which computes `Gain total` from its four terms
  and never reads `gain_absolu`), the chart slot with two readings (*Amounts* /
  *Performance*) and the allocation in twelve slices on the wide one; the movers
  and the **accounts card** in the rail. That card is where accounts are compared
  since ADR-0028, and it therefore holds ADR-0019's rule: one range for every
  figure on it, sparkline included. The head's two period figures sit with the
  total, never among its four terms. It is the dashboard **unconditionally**,
  zero events included.
- **Shares** (`/titres`) — ten columns since the weight bar, the header sums its
  lines, so the closed positions **fold** rather than being filtered (the fold is
  not a filter, and the header does not move when the section opens). Grouping by
  account puts each
  subtotal in the **group header**, never in a footer row: a total and its terms
  never share a row, one level down. One sheet per share, where a
  selection links the chart to the event list.
- **Accounts** (`/comptes`) — master-detail (ADR-0028): a sticky rail of weights
  and names, one account's detail beside it — the gain over its four terms, the
  composition, the annualised rate, the dividends, the lines and the last events.
  Which account is open is a **URL** (`?compte=`), and an id naming nothing falls
  back to the first declared one. **One** range control drives the detail's curve
  *and* the rate beside it, `MAX` not offered; the rail draws a share of a total
  on a stated day and no curve at all, which is the second half of ADR-0028's
  sparkline clause. The cross-account comparison is the dashboard's accounts card
  now, and ADR-0019's rule travelled with it. It is **also** where an account is
  declared (from the rail), renamed and removed (from the panel its own name
  opens) — the removal's three refusals being prose, which a table cell never had
  room for. The reassignment rides with the **declaration** where nothing is
  declared yet (#725, offered and never required), and stands on its own in the
  **seeded account's own detail** once something is: its subject is that
  account's events.
- **Data** (`/donnees`) — three tabs (ADR-0030): *The ledger* (the table — bounded,
  sticky-headed and revealed forty rows at a time since ADR-0031, reduced by two
  groups of chips and a search — and above it one band holding the drop zone, the
  export menu — **four entries** since #796: every event, a workbook with one
  sheet per year, the filtered selection and the accounts, the middle two
  server-side because the importable form belongs to `events/export.py` and a
  rule written twice loses a branch — and the imported files with their
  revocation), *The notices* —
  **always mounted**, saying so when there is nothing, because the status dot must
  have one destination — and *The installation* (settings, the store and its
  orphans).
