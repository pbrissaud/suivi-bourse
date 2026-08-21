# app/web/ — the front

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
- **The theme and the language are the reader's two preferences, one mechanism**
  (ADR-0024): three states each (`light|dark|auto`, `fr|en|auto`), two
  `localStorage` keys of identical shape, **no dial in the store**. Numbers and
  dates follow the **language**, not the currency.
- **`index.css` has exactly three blocks** (ADR-0023): the tweakcn `Vercel`
  primitives (**never hand-edited**, regenerated with
  `pnpm dlx shadcn@latest add https://tweakcn.com/r/themes/vercel.json`), the
  domain layer (only what the preset cannot say), and an `@theme inline` bridge.
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
│   ├── alloc.ts format.ts    # the twelve allocation stops · the nine Intl sites
│   ├── problem.ts status.ts  # problem.type → key · the dot's state, who says a band
│   ├── absence.ts sign.ts    # the four renderings of absence · the colour of a figure
│   ├── gain.ts               # ADR-0018's four terms and their sum
│   ├── shares.ts             # a row is a symbol; the carried value; the day-markers
│   ├── dashboard.ts          # the two readings, the twelve slices, the four states
│   ├── accounts.ts           # the rebasing to 100, the vanishing column, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses · what a revocation removes
│   ├── advisories.ts         # what the block shows, what the badge counts
│   ├── installation.ts       # the cadence's reach, and only what moved is sent
│   ├── currencies.ts firstRun.ts receipts.ts docs.ts
├── components/
│   ├── Explain · Stat · EmptyState · Band · EntryPair · FirstRun · CurrencyField
│   ├── dashboard/  # the head, the one chart slot, the allocation, the movers
│   ├── shares/     # the head, the table, the fold of closed lines, the chart, the sheet
│   ├── data/       # tab 1: ledger, create form, accounts, import and export
│   │               # tab 2: notices, settings, the store
│   └── accounts/   # the rebased chart, the eight columns, an account's panel
└── test/           # setup · MSW server · payload factory · renderApp
```

## The four pages, one line each

- **Dashboard** (`/`) — the head computes `Gain total` from its four terms and
  never reads `gain_absolu`; under it, one chart slot with two readings (*Amounts*
  / *Performance*), the allocation in twelve slices, and the movers. It is the
  dashboard **unconditionally**, zero events included.
- **Shares** (`/titres`) — nine columns, the header sums its lines, so the closed
  positions **fold** rather than being filtered (the fold is not a filter, and the
  header does not move when the section opens). One sheet per share, where a
  selection links the chart to the event list.
- **Accounts** (`/comptes`) — a comparison does not outrun the period where it
  exists (ADR-0019): one range control drives the chart **and** the `perf` column,
  and `MAX` is not offered. Pointing previews, clicking opens.
- **Data** (`/donnees`) — two tabs: *The ledger* (what the owner declared: events,
  accounts, imports and export) and *The installation* (what the installation
  *is*: notices, settings, the store).
