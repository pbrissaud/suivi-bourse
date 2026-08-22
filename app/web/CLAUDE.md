# app/web/ — the front

> **ADR-0028, ADR-0030 and ADR-0031 are decided and not yet built.** Where this
> file cites one of them — the accounts page, the data page's three tabs, the
> paginated ledger — it describes the destination, and the code has not been
> there yet. That is the one place `docs/adr/README.md`'s rule for `preview/v5`
> is suspended, and it ends when the tickets from that design session merge.
> **ADR-0029 has landed** (#788): the preset below is the one the app runs on.

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

**`lint` is the type-checker and nothing else** — there is no ESLint here. Two
`// eslint-disable-next-line react-hooks/exhaustive-deps` survive from the
prototype (`AccountsPage`, `AccountsBlock`); they document a deliberate
dependency and **enforce nothing**, so a hook's dependency array is held by
review alone. Both sit on a `useMemo` keyed by a hand-built stamp, and the
stamp is the thing to read when touching either.

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

Two nets hold a rule nothing made true by construction:

- `src/readsInFlight.test.tsx` — for each of six surfaces, the routes actually
  requested are recorded off the MSW lifecycle, then replayed **one at a time with
  that read hanging for ever**, asserting an *absence*. It also fails when a route
  of `ROUTES` is visited by no surface. Since #777 it reads **every rendered
  phrase carrying a word**, not only the emptiness markers.
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
  in flight renders nothing, headers included; *load more* and the count describe a
  table that has landed and may therefore speak. No spinner in either case, and
  *end of the ledger* is never said before the last row has arrived. The three
  sections of ⌘K that read — shares, accounts, events — are **optional**: an absent
  one removes its section instead of holding the palette, and the palette reads on
  **open**, never on mount.
- **Four renderings of absence and no fifth** (`lib/absence.ts`, ADR-0021). The em
  dash says *there is nothing to compute*; anything merely missing is **named**.
  Zero is not absence (`lib/sign.ts`).
- **A rule is written once.** `lib/gain.ts` calls `absenceCase` rather than holding
  a second copy — written twice, the copy loses a branch (it did).
- **A convention is explained on the figure** (ADR-0016): `Explain`, the bubble
  that opens **on click and never on hover** (hover does not exist on a finger),
  closes on scroll, and links to the versioned, localised docs (`lib/docs.ts`).
  One icon per figure **and per surface**; never on a cell.
- **A total and its terms never share a row.** Subordination is vertical: in a
  table the total is the header; in a panel it is a block containing its terms.
- **A block with nothing in it does not exist.** The layout shifts when a notice
  appears.
- **One band on screen or none.** `lib/status.ts` holds the causal order between
  the shell's band (what is true of the installation) and a page's own (a read of
  its own that failed).
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
│   ├── accounts.ts           # the rebasing to 100, the vanishing column, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses · what a revocation removes
│   ├── advisories.ts         # what the block shows, what the badge counts
│   ├── installation.ts       # the cadence's reach, and only what moved is sent
│   ├── currencies.ts firstRun.ts receipts.ts docs.ts
├── components/
│   ├── Explain · Stat · EmptyState · Band · EntryPair · FirstRun · CurrencyField
│   ├── Shell · ContentHeader (the title, the dot, the three preferences)
│   ├── AppSidebar (the navigation, and the status card that develops the dot)
│   ├── dashboard/  # the hero head, the chart, the allocation, the movers, the accounts card
│   ├── shares/     # the head, the table, the fold of closed lines, the chart, the sheet
│   ├── data/       # tab 1: ledger, create form, drop zone, import and export
│   │               # tab 2: notices  ·  tab 3: settings, the store
│   │               # (accounts moved to accounts/ — ADR-0028)
│   └── accounts/   # the rail of weights, one account's detail, its form
└── test/           # setup · MSW server · payload factory · renderApp
```

## The four pages, one line each

- **Dashboard** (`/`) — the head computes `Gain total` from its four terms and
  never reads `gain_absolu`; under it, one chart slot with two readings (*Amounts*
  / *Performance*), the allocation in twelve slices, the movers, and the **accounts
  card** — which since ADR-0028 is where accounts are compared, and therefore holds
  ADR-0019's rule: one range for every figure on it, sparkline included. The head's
  two period figures sit with the total, never among its four terms. It is the
  dashboard **unconditionally**, zero events included.
- **Shares** (`/titres`) — ten columns since the weight bar, the header sums its
  lines, so the closed positions **fold** rather than being filtered (the fold is
  not a filter, and the header does not move when the section opens). Grouping by
  account puts each
  subtotal in the **group header**, never in a footer row: a total and its terms
  never share a row, one level down. One sheet per share, where a
  selection links the chart to the event list.
- **Accounts** (`/comptes`) — master-detail (ADR-0028): a sticky rail of weights and
  names, one account's detail beside it. It is also where an account is declared,
  renamed and removed — the reassignment rides with the **declaration** (#725,
  offered and never required), and the removal's three refusals live in the edit
  dialog. The cross-account comparison is the dashboard's accounts card now, and
  ADR-0019's rule travels with it: **one range for every figure drawn on that
  card**, `MAX` still not offered.
- **Data** (`/donnees`) — three tabs (ADR-0030): *The ledger* (the table, and above
  it one band holding the drop zone, the export menu and the imported files with
  their revocation), *The notices* — **always mounted**, saying so when there is
  nothing, because the status dot must have one destination — and *The
  installation* (settings, the store and its orphans).
