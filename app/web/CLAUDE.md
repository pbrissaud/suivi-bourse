# app/web/ — the front

> **The shares table has its two gestures** (#791): it **sorts on any of its
> nine columns** and it **groups by account** with each subtotal in the group
> header. Neither removes a line: an order is a permutation and a grouping is a
> partition, so the header goes on stating the sum of what is under it, ADR-0017
> untouched. The grouping is offered only above one account,
> `accountBreakdown`'s own argument one surface over. Both are page **state**
> and not an address: nothing outside the page leads to *this table sorted by
> PRU*, where ⌘K does lead to `?titre=`.
>
> **`Poids` was a third gesture and is not one any more.** The column shipped
> with #791 and was taken out again on sight: the figure reads well and the
> column was not where it belonged. `placedValue`, `weightShare` and
> `weightRendering` stay in `lib/shares.ts`, held by their own unit tests since
> the column's rendering tests left with it. **What reads them is the account's
> lines block** (#833): a dozen lines under one account is where a weight is a
> glance rather than a tenth column, and it is drawn there as a bar with the
> percentage written beside it.
> **A share is drawn now, and by one component** (#800): `ShareBar` puts a bar
> under every line that carries a share of a total — the allocation's legend,
> the accounts rail, the account's composition split and, since #833, the
> account's own lines and the securities that pay it. It takes a share and a fill and decides neither
> the colour nor the order, so ADR-0023's rank ramp and the rail's identity
> wheel each stay the business of the surface that earned them.
> `src/shareBar.test.ts` is what keeps the count at one.
> **The upload has landed** (#811, ADR-0032): the rectangle above the ledger is
> a **target** rather than the name of a folder — dropped on, or chosen from the
> picker — and the empty state's first entry carries the same gesture, so an
> install that mounted nothing is not an install missing half the product. The
> receipt is rendered under the zone and lasts as long as the gesture. The drop
> folder left with #815 and **the list of sources with its revocation left with
> #816**: the band above the ledger is the zone and the export menu, and nothing
> else.
> **One population of lines** (#816, ADR-0032): the `Provenance` column and the
> link it carried are gone, `isEditable` asks only for a key, and **every row
> opens the editor** — a line that came out of a file is corrected and removed
> exactly like a typed one. `lib/imports.ts` is down to `exportable`, and
> `/api/imports` is not a route the front knows.
> **And the receipt is now said twice** (#813): handing a file over **previews**
> it (`?dry_run=1`) — the same sentence, tense apart, plus how many of its lines
> the ledger already holds — and the reader presses *Importer* or puts the file
> down. Confirming **re-uploads the same file**: `useEventUpload` holds the
> `File` for as long as the forecast stands, because the server remembers no
> import and a pending-import id would be `import_source` under another name.
> Duplicates are skipped by default and a checkbox — offered only when the file
> has some — writes them anyway.
> **The reduction can be deleted** (#814, ADR-0032): `BulkDelete.tsx` sits
> beside the chips — under the reduction it consumes, never in the band above —
> sends the five export parameters to `DELETE /api/events`, and renders nothing
> at all while nothing is reduced or nothing is retained. Its confirmation
> **names the reduction and counts its rows**, dimension by dimension, and never
> asks *are you sure* on its own; the receipt says the server's count, which is
> what actually left. It is what makes losing the revocation by file survivable —
> which is what #816 then did.
> **The ⌘K palette has landed** (#797): it reads **on open** and never on mount,
> its three data sections are optional — an absent read removes one instead of
> holding the palette — and an event result leads to a ledger reduced by an
> **address**, which names what it retains and offers the way out. It is
> ADR-0026's optional read applied to a surface, not a new decision, and it is
> the last clause of the record that was still ahead of the code: the suspension
> of `docs/adr/README.md`'s rule that this file carried for `preview/v5` ends
> here.
> **ADR-0031 has landed for the ledger** (#795): the table reveals forty rows at
> a time, its header is sticky and its body bounded, the two filters are chips,
> and the count and the end-of-ledger sentence are true of the reduction.
> **ADR-0030 has landed** (#794): the data page is the three tabs described
> below, and the imports are one band above the ledger table. **Its exception is
> withdrawn** (#821, ADR-0036): the notices were kept mounted because the status
> dot was said to ask *is there anything to report*, and it does not — it leads
> to the installation tab, where one repairs. The block is ordinary again, so *a
> block with nothing in it does not exist* has no exception anywhere, and
> acknowledging the last fact takes the surface away rather than leaving a
> permanent *Rien à signaler* behind. What does **not** move is ADR-0026:
> nothing is rendered, title included, while the read is in flight.
> **The first run walks three passages** (#823, ADR-0035): the required
> settings, the accounts, the first events — in that order, the last opening by
> either of its two doors. The modal is still **armed by one predicate** (a
> required dial with nothing stored, read off the registry's mark since #822)
> and it is now **latched**: answering makes the predicate false, and the answer
> is the *first* passage, so `FirstRun` holds a `walking` flag or the two after
> it would be unreachable to everybody who answers. *Mandatory* means
> **traversed, never answered** — the accounts passage is satisfied by the
> seeded row and offers no field, and a bare `docker run` walks all three with
> **no write at all leaving the browser**, which is how *no `onboarding_done`
> row* is asserted. The memory is `localStorage`, written whichever way the
> reader leaves — the cross, a door, or the last control — and it holds **two
> things**: that they have been through, *and what was still unanswered when
> they left*. The second half is what makes a wiped volume ask again in the very
> browser that answered, instead of only in some other one; `unanswered` is
> still stored as `dismissed`, because a new spelling would reopen the walk on
> every browser that has already closed the old modal. Nothing in the predicate
> reads the data the walk collects, which is what answers #726's refusal: an
> emptied ledger reopens nothing.
> **ADR-0029 has landed** (#788): the preset below is the one the app runs on.
> **ADR-0028 has landed whole** (#792, #793): the accounts page is the
> master-detail described below, and it is where an account is declared, renamed
> and removed.
> **The shell opens to five** (#828, ADR-0038): the settings have an address of
> their own, `/reglages`, and the data page is called the **ledger** — `Grand
> livre` in French, the word `CONTEXT.md` and every French record already use,
> never a third one. The navigation groups **three and two**: the top is the
> portfolio, what the owner *looks at*; the foot is what they *act on*, and the
> ledger's claim to the top is declined on that count. What `/reglages` renders
> is `Installation` unchanged — the page is the address, and the tab bar around
> that block, its move out of `components/data/` and ADR-0038's three
> corrections of wording are #830's. **And the fold of the navigation is
> persisted for the first time**: `SidebarProvider` had always written the
> `sidebar_state` cookie and never read it, upstream reading it on a Next.js
> server this static bundle does not have, so `Shell` reads that same cookie for
> `defaultOpen` — the component's own memory, read back, and **not** a fourth
> `sb.*` key: the reader's preferences are three, and the fold of a menu is
> chrome.

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
prototype; it documents a deliberate dependency and **enforces nothing**, so a
hook's dependency array is held by review alone. It sits on a `useMemo` keyed by
a hand-built stamp, and the stamp is the thing to read when touching it. It moved
with the read it guards, from `AccountsCard` to `DashboardPage` (#799): the N
account series are the page's now, and the stamp is what makes the array it hands
down a stable dependency for the card's own memo — which needs no such comment.

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

Four nets hold a rule nothing made true by construction:

- `src/readsInFlight.test.tsx` — for each of nine surfaces, the routes actually
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
- `src/shareBar.test.ts` — on the *source*, and for the same blind spot as the
  spinner's: a bar is `aria-hidden` and carries no word. A percentage width
  written into a `style` is what a hand-written share bar is made of, and it is
  refused outside `ShareBar.tsx` — the rail's **stacked** bar apart, which the
  net names one by one so that a second bar in that same file fails like a bar
  anywhere else.

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
  reads on **open**, never on mount (`enabled: open`, and the client's thirty
  seconds make a second opening free). Its five sections are `lib/palette.ts`, and
  its two entries named after a **gesture** arm one: *record an event* landing on
  the data page with the form shut would be a page entry wearing an action's name.
- **Four renderings of absence and no fifth** (`lib/absence.ts`, ADR-0021). The em
  dash says *there is nothing to compute*; anything merely missing is **named**.
  Zero is not absence (`lib/sign.ts`).
- **A rule is written once.** `lib/gain.ts` calls `absenceCase` rather than holding
  a second copy — written twice, the copy loses a branch (it did).
- **One component draws a share** (#800, `components/ShareBar.tsx`). A share of a
  total gets a bar under the name it is written beside — the percentage is exact
  and comparing two of them is arithmetic, the bar is the glance. It is
  `aria-hidden` on every surface, because the figure is written out one line up;
  a **null** share draws nothing at all where a **zero** share draws an empty
  track, which is ADR-0021's difference and not a nicety; and it **chooses no
  colour and no order** — the allocation hands it a rank stop (ADR-0023, the
  ramp only being licensed by a sorted, legended list), the rail hands it the
  identity wheel. The rail's
  **stacked** bar is not the same figure and stays beside the per-line ones: it
  says *these parts close this whole*, which no per-line bar claims, and it is
  the one thing the net exempts.
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
- **A block with nothing in it does not exist**, and since #821 there is **no
  exception anywhere** — the notices held the last one. The layout shifts when a
  notice appears.
- **A receipt lasts as long as the operation, never three seconds** (#796,
  `CONTEXT.md` § Receipt). Two gestures have one and they render it two ways,
  which is a property of what they answer rather than an inconsistency: the
  export says one sentence and says it in a toast, while the **import** says
  what it produced — rows, period, accounts, securities — under the zone that
  made it (`UploadZone`), and says it **twice** since #813: once as a forecast
  the reader may refuse, once as the fact. Same members, same order, only the
  tense moves (`lib/receipts.ts`), so the reader recognises afterwards what they
  read before. The export
  is therefore a **fetch** and not an `<a download>`: a link hands the request to the browser, which settles at no
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
- **A page's band belongs to the page, above its blocks** (#799). Mounted inside
  a block it renders *instead* of it, so it can only ever name the reads that
  block is made of — and the dashboard's four other reads therefore entered no
  condition at all: a `503` on a series took the chart, or the comparison, off
  the page on every load without a word. The page reads and the blocks render;
  `readConditions` is handed **every** read, and `oneBand` after it is why an
  unreadable store is still one sentence. What empties a page and what is merely
  named stay two lists: only the reads a page is *made of* reach
  `dashboardState`.
- **Green means the quotes are read *and* the performance is up to date** (#787).
  The dot used to hold one predicate, the scheduler, and stayed green while a red
  band announced a rebuild on every page — two surfaces disagreeing about one
  installation. With the rebuild folded in, one glance answers *are the figures I
  am looking at any good*, which is why no page dates its own figures any more.
- **And the dot reads `/health`** (#819, ADR-0036), which is the one route the
  front reads with no `/api` prefix — the container's own probe, so `vite.config.ts`
  proxies it beside `/api` or the dev server answers it with `index.html`. It read
  `/api/runtime` until then, whose one *detectable* problem is a stopped
  scheduler: a scrape frozen since Tuesday left the dot green. The body's own
  word carries the four facts now, so **amber is a `200`**, and the trade is
  assumed — the body goes when the store goes, and the `503` under it is red,
  the one colour that needs no body to be true. Red also covers a route that
  answers with a body `installationState` cannot read; grey stays *nothing has
  run yet* and never *something is wrong*. `STATE_TONE` is declared **once**, in
  `StatusDot.tsx`, and the sidebar card reads it: the card is the dot's
  development, never a second opinion on what *attention* covers.
- **The theme, the language and the table density are the reader's three
  preferences, one mechanism** (ADR-0024 decided the first two): three states each
  for theme and language (`light|dark|auto`, `fr|en|auto`), **two** for density
  (`comfortable|compact` — there is no `auto` for a density), three
  `localStorage` keys of identical shape, **no dial in the store**. Numbers and
  dates follow the **language**, not the currency. ADR-0024 says *two* because
  density came later; a record is dated, and it is this line that carries the
  count.
- **`en.json` is the source, and `fr.json` is kept in step by hand until
  Crowdin's first import.** `crowdin.yml` covers this catalogue alongside the
  site (ADR-0024) and declares `fr.json` to be Crowdin's output — but that
  import has never run, so every key since #713 has landed in both files in the
  same commit, and a ticket that renames a label renames it twice. The half that
  is not a stopgap is the order: English is decided first, and a key exists in
  `en.json` or it does not exist at all. The hand stops here when the first
  import lands, and not before.
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
- The front branches on `problem.type` and renders `detail` nowhere. A refusal
  whose sentence needs **values** — the oversell, which names a security and two
  quantities (#824) — reads them off the problem's *extension members*, never off
  the server's prose: `problemMessage` is `problemMessageKey`'s sibling and
  returns `{ message, values }` on `receiptMessage`'s model, `problemSentence`
  renders it, and a caller with nothing to interpolate goes on using the key
  alone.

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
│   ├── problem.ts status.ts  # problem.type → key (+ values) · the dot's state, who says a band
│   ├── absence.ts sign.ts    # the four renderings of absence · the colour of a figure
│   ├── gain.ts               # ADR-0018's four terms and their sum
│   ├── shares.ts             # a row is a symbol; the carried value; the day-markers
│   │                         # the nine orders, the partition by account, the weight
│   ├── dashboard.ts          # the two readings, the twelve slices, the four states, the day
│   ├── accounts.ts           # the rebasing to 100, the weights, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses, the reveal · what there is to export
│   ├── installationFacts.ts  # what the block shows, what the badge counts
│   ├── installation.ts       # the cadence's reach, and only what moved is sent
│   ├── palette.ts            # ⌘K's five sections · the reduction an event leads to
│   ├── currencies.ts firstRun.ts receipts.ts docs.ts save.ts
├── components/
│   ├── Explain · Stat · EmptyState · Band · EntryPair · ShareBar
│   ├── FirstRun · CurrencyField
│   ├── ChartTooltip           # what a chart answers the pointer (#787: the axes went)
│   ├── Shell · ContentHeader (the title, the dot, ⌘K, the three preferences)
│   │                          # Shell also reads back the navigation's fold
│   ├── Palette                # ⌘K: five sections, three of them optional reads
│   ├── AppSidebar (the navigation, and the status card that develops the dot)
│   ├── dashboard/  # the hero head, the chart, the allocation, the movers, the accounts card
│   ├── shares/     # the head, the table, the fold of closed lines, the chart, the sheet
│   ├── data/       # tab 1: ledger, create form, drop zone, import and export menu
│   │               # (UploadZone: the file in, the receipt under it)
│   │               # tab 2: notices  ·  tab 3: settings, the store
│   │               # (the accounts declaration moved to accounts/ — ADR-0028)
│   └── accounts/   # the rail of weights, one account's detail, its curve, its form
└── test/           # setup · MSW server · payload factory · renderApp
```

## The five pages, one line each

- **Dashboard** (`/`) — a **plateau of two tracks** from `lg`, split *drawn*
  against *read down*: the head (which computes `Gain total` from its four terms
  and never reads `gain_absolu`), the chart slot with two readings (*Amounts* /
  *Performance*) and the allocation in twelve slices on the wide one; the movers
  and the **accounts card** in the rail. That card is where accounts are compared
  since ADR-0028, and it therefore holds ADR-0019's rule: one range for every
  figure on it, sparkline included. The head's two period figures sit with the
  total, never among its four terms. It is the dashboard **unconditionally**,
  zero events included.
- **Shares** (`/titres`) — nine columns, the header sums its
  lines, so the closed positions **fold** rather than being filtered (the fold is
  not a filter, and the header does not move when the section opens). **Every
  column sorts** since #791 — the control is the label, the state is `aria-sort`
  on the cell, and an absence never rises whichever way the column is pointed,
  a line with no value having no rank. Grouping by account puts each
  subtotal in the **group header**, never in a footer row: a total and its terms
  never share a row, one level down — and the split is over the **symbols on
  screen**, so an account that sold out keeps the realised gain it carries
  rather than dropping it off a page whose header still counts it. One sheet per share, opened by a
  click **anywhere on the row** (the name stays a button, which is the
  keyboard's way in), where a
  selection links the chart to the event list — and **which sheet is open is a
  URL** (`?titre=`) since #797, the same clause as the `?compte=` reduction beside
  it, because ⌘K reaches a held title from any of the four routes.
- **Accounts** (`/comptes`) — master-detail (ADR-0028): a sticky rail of weights
  and names, one account's detail beside it — the gain over its four terms, the
  composition, the annualised rate, the dividends, the lines and the last events.
  Which account is open is a **URL** (`?compte=`), and an id naming nothing falls
  back to the first declared one. **One** range control drives the detail's curve
  *and* the rate beside it, `MAX` not offered; the rail draws a share of a total
  on a stated day and no curve at all, which is the second half of ADR-0028's
  sparkline clause — and the first half is held by the curve itself since #833,
  whose legend **states the span it was cut to**, a control saying what was asked
  for where a legend says what is drawn. The cross-account comparison is the
  dashboard's accounts card now, and ADR-0019's rule travelled with it. It is
  **also** where an account is declared (from the rail), renamed and removed
  (from the panel its own name opens) — the removal's **two** refusals being
  prose, which a table cell never had room for; the third was *a file declares
  this account* and it left with `account.source_id` (ADR-0032), ADR-0028
  recording the correction rather than applying it in silence. The lines block
  carries the **weight** of each line since #833 — `lib/shares.ts`'s three
  functions, which outlived the shares column that read them — and the two
  questions the encashed figure raises and cannot answer are answered in two
  places, because they do not obey the same window: *what it is worth against
  the contribution* sits under the figure itself, in the dividends block, and
  **which securities pay it** is a card of its own below the lines, stating the
  extent it was read over — `position.dividends` is a lifetime total, so that
  block says the account's whole history rather than borrowing the range control
  above it.
  The reassignment rides with the **declaration** where nothing is
  declared yet (#725, offered and never required), and stands on its own in the
  **seeded account's own detail** once something is: its subject is that
  account's events.
- **Ledger** (`/donnees`) — still ADR-0030's three tabs, and the page is
  **named** for the one it is about to be alone with (ADR-0038): the notices
  leave with #829 and the tab bar with #830. *The ledger* (the table — bounded,
  sticky-headed and revealed forty rows at a time since ADR-0031, reduced by two
  groups of chips, a search, a **period** — two date fields since #810, both
  bounds inclusive, and a chip that shows up only once a bound is in force, to
  name the interval and be the way out of it — and, since #797, by an
  **address**: `q`, `type`, `account` and, since #810, `since` and `until`, which
  are the five the export resource already parses, so a reduced ledger's URL is
  the query string of its own export. A reduction that arrived that way names
  what it retains and offers the way out; the reader's first gesture on the chips
  takes the address back off, an address being a description of the table. Since
  #814 the reduction also has a **destructive gesture of its own**, beside the
  chips: it deletes everything the reduction retains — the rows a file carried
  included — behind a box that names the five dimensions in force and counts
  them, and it is not offered at all while nothing is reduced. Above the table,
  one band holding the **upload zone** (a real target since #811: a file
  dropped on it or chosen from it is handed to `POST /api/events/import`, and the
  receipt is said under it), the export menu — **three entries** since #817:
  every event, a workbook with one sheet per year and the filtered selection,
  all three server-side because the importable form belongs to
  `events/export.py` and a rule written twice loses a branch; the fourth was the
  accounts, and it left with the file nothing could read back (ADR-0034) — and
  **no third entry** since #816: nothing persists that could be listed or revoked, so the
  band is the zone and the menu), *The notices* — an **ordinary block** since
  #821: the tab is always there, what is on it is not, and an installation with
  nothing to report renders nothing at all — and *The installation* (settings,
  the store and its orphans), which `/reglages` now renders too.
- **Settings** (`/reglages`) — the fifth page (ADR-0038), and the only route of
  the five that reads nothing off its own address: a dial is not a reduction of
  anything, so there is nothing here for a search parameter to describe. It
  renders the installation block — the settings, the store with its size and its
  last write, the orphaned securities, the rebuild — and the *why* of it is that
  a two-tab bar is a bar that should not exist: it costs a control and a level
  of nesting to hold a choice between what the owner declared and what the
  installation is.
