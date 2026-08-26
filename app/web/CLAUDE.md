# app/web/ — the front

> **The shares table has its two gestures** (#791): it **sorts on any of its
> ten columns** and it **groups by account** with each subtotal in the group
> header. Neither removes a line: an order is a permutation and a grouping is a
> partition, so the header goes on stating the sum of what is under it, ADR-0017
> untouched. The grouping is offered only above one account,
> `accountBreakdown`'s own argument one surface over. Both are page **state**
> and not an address: nothing outside the page leads to *this table sorted by
> PRU*, where ⌘K does lead to `?titre=`.
>
> **`Poids` is the tenth column, and it is a bar** (#832). It shipped with #791
> as a percentage and was taken out again on sight — the figure read well and
> the column was not where it belonged — which is precisely what changed: what
> comes back is `ShareBar` under the figure, and the **drawing** is the whole
> reason. `15,99 %` against `11,39 %` is a reading; two bars are a glance
> (#800). It sits beside `Valorisation`, the cell it divides, and the divisor is
> **one whole for the whole table** — `placedValue` over every row of every
> group, so turning the grouping on re-cuts the lines and re-scales no
> percentage. The fill is chrome and not a ramp: ADR-0023 licenses the rank ramp
> over a *sorted, legended* list, and this table is sorted by whichever of ten
> columns was last pressed. `weightRendering` takes the valuation's own absence
> rather than deciding a second one, which is what keeps the four renderings
> four (ADR-0021).
>
> **And the content column may now be narrower than what is in it** (#832).
> `SidebarInset` is a flex item, so its `min-width` was `auto` — *never narrower
> than my content* — and a table wider than the column pushed the **whole page**
> sideways instead of scrolling inside itself: measured on `/titres` against a
> real API, the page overflowed by 256 px at 768 and by 238 px at 976, and the
> `overflow-x-auto` `components/ui/table.tsx` puts around every table was inert,
> its parent having grown to fit. `min-w-0` on the shell's column is the whole
> repair, it is the shell's rather than the table's, and `src/contentWidth.test.ts`
> holds both halves of the pair on the source. What it does **not** do is make
> ten columns fit 976 px: they measure 976 px comfortable and 896 px compact
> against the 672 px the column has there, so below 1 280 px the scroll is the
> table's own — assumed, and the third of the three answers #832 weighed.
>
> **The accounts page has no range control** (#833, ADR-0028 corrected). The
> detail carried a copy of ADR-0019's — four presets driving a windowed
> time-weighted rate *and* the curve beside it — and the record's clause is
> amended in its **address** this time: the rule is about several spans read side
> by side, and the detail draws one series on one axis. It lands on the
> dashboard's accounts card alone, which is the surface that compares accounts.
> What stands at the head of the detail instead is **`Performance totale`** —
> `gain ÷ versé net`, the total computed from its four terms over the
> contribution one line above it — a **cumulative ratio** of the same family as
> the *sur versé* under the dividends, covering the account's whole life and so
> implying no window at all. The rail's cards carry that same figure, divided out
> of `gain_absolu` (the fourth term is what makes the two telescope), which is why
> the maquette's `perf` can stand there now when ADR-0028 refused it: a ratio with
> no window needs no period stated. The curve is drawn over the whole history and
> its legend says so; `perf` and its bubble leave the product, the four-reversals
> warning being carried by the dashboard's own `TWR` bubble that the accounts card
> already leans on; and *depuis l'ouverture* stops naming two different days on
> two surfaces.
>
> **And the account's lines block draws the same share** (#833). `placedValue`,
> `weightShare` and `weightRendering` were written for #791's column, survived its
> removal held by their own unit tests, and now have two readers rather than one:
> the tenth column here, over every row of the table, and a dozen lines under a
> single account there — where a weight is a glance rather than a tenth column.
> One trio of functions, two divisors, and each surface states its own whole.
>
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
> **The bell is the app's one global indicator, and the band is gone** (#829,
> ADR-0037). `Banner.tsx`, `Band.tsx` and `StatusDot.tsx` no longer exist, the
> sidebar's status card left with them, and the notices tab left too: what
> carries all four is **one control in the content header** — its icon wears the
> health colour (`STATE_TONE`, declared once, in `Notifications.tsx`), its badge
> counts **every open entry**, and the panel behind it holds health, installation
> facts and advisories together, grouped by **subject** (Santé, Installation,
> Portefeuille, Comptes). The *register* — `health` · `fact` · `advisory` — is
> never a word on screen: it decides what a card offers. Health offers a link
> and no acknowledgement, an installation fact is acknowledged for good, an
> advisory is put to sleep for **thirty days** and the card says so.
> **The band is not replaced, and no component inherits its mounts.** Its three
> conditions are entries in the panel, and its *sentence* descends one floor:
> with no reporting currency the dashboard, the securities and the accounts
> render an empty state that **says why**, and the ledger stays readable — the
> events are declared, it is their valuation that waits. What the component was
> *also* used for splits in two, and the split is checkable on the source:
> `Refusal.tsx` answers **a gesture the server refused**, mounted beside the
> control that made it and never for a read; `Unreadable.tsx` is an
> **`EmptyState`** carrying the sentence of a read that did not answer, mounted
> **where the missing content would have been** — the page when the reads it is
> *made of* refuse, the block when its own read does. So no surface renders a
> strip across the top of the content column, and *empty* and *unreadable* are
> told apart by the sentence rather than by a colour somewhere else on screen.
> `readConditions` therefore no longer short-circuits on a `shellError`; its one
> remaining caller of that clause is the panel itself, whose health card already
> says it in prose.
> **A card's link lands on the figure**: the account selected, the security's
> sheet open, the ledger reduced — which is why the set of securities became
> **addressable** (`?symbol=`), the panel being mounted in the shell and reached
> from all five routes. And an **advisory is read twice**: as a chip beside the
> figure it comments on, which never offers the acknowledgement, and as a card in
> the panel, which is the only place it is acknowledged. The two are two
> questions about one instant and they answer differently once the window is
> open — the card goes, the chip stays, the condition still standing — so the
> chip reads `GET /api/advisories?asleep=include` (`advisories.standing`) while
> the panel reads the route bare (`advisories.listing`).
> **The shell opens to five** (#828, ADR-0038): the settings have an address of
> their own, `/reglages`, and the data page is called the **ledger** — `Grand
> livre` in French, the word `CONTEXT.md` and every French record already use,
> never a third one. The navigation groups **three and two**: the top is the
> portfolio, what the owner *looks at*; the foot is what they *act on*, and the
> ledger's claim to the top is declined on that count. **And the fold of the
> navigation is persisted for the first time**: `SidebarProvider` had always written the
> `sidebar_state` cookie and never read it, upstream reading it on a Next.js
> server this static bundle does not have, so `Shell` reads that same cookie for
> `defaultOpen` — the component's own memory, read back, and **not** a fourth
> `sb.*` key: the reader's preferences are three, and the fold of a menu is
> chrome.
>
> **And the tab bar is gone** (#830, ADR-0038): `components/settings/` is where
> the surface lives now, `DataPage` renders the table and nothing else, and
> `/reglages` is five cards rather than one block — *what you can change*, **the
> workloads**, the orphaned securities, the store, *what the container imposes*.
> The block used to be headed *Réglages* under a page whose `<h1>` read
> *Réglages*, which names the page twice and the card not at all; each card is
> named for what it holds instead. The **workloads** card is new and it is what
> the bell's health link now lands on: the three jobs `/health` folds its word
> out of, each with its last pass and its verdict said as a sentence — three and
> not the mock-up's four, ingestion being the boot or a write rather than a job
> with a pass to report. ADR-0038's three corrections of wording are done:
> *Dernière écriture du grand livre*, the currency's *fixée dès qu'elle est
> répondue* with no field left around it, and the poll cadence living in its own
> field on this page rather than on the sidebar card #829 removed.
>
> **The dashboard explains no rule of the product** (#831, ADR-0016). Its shape
> landed with #790 — the plateau, the hero card where the total dominates its
> four terms, the two period pills that stay **with** the total, the accounts
> card under ADR-0019's one range with no `MAX`, the ring carrying its total in
> its hole — and what was left was the other half of the same record: the page
> showing figures rather than explaining itself. Three sentences went, all three
> under the chart — *l'écart entre les deux courbes est votre gain total*, its
> latent variant, and *base 0 % au premier jour de la plage affichée*. Each was a
> convention **written on the page**, which is what the bubble on the figure
> exists to replace, and each is already stated by one of the four bubbles the
> head carries: ADR-0016 puts one icon per figure *and per surface*, so no fifth
> bubble inherits them. What is left under the plot is a legend, which names
> curves; what a **reading** needs in order to be read is said by marks and not
> by prose — the zero line the performance curve crosses, the range control that
> names its window, and, on the install with no cash ledger, the pair of names
> `Valorisation` / `Prix de revient`. The sentences that stay are the ones an
> **absence** owes: why a block that is empty is empty, which ADR-0021's
> replacement clause is about and which is a fact about the reader's install
> rather than a rule of the product. And the two period pills take the maquette's
> own tint and arrow: the sign was said in colour alone, and an arrow says it
> again without the hue.

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

Five nets hold a rule nothing made true by construction:

- `src/readsInFlight.test.tsx` — for each of eight surfaces, the routes actually
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
- `src/contentWidth.test.ts` — on the *source*, and for what jsdom cannot lay
  out at all: the shell's content column declares `min-w-0` and the table
  primitive keeps its `overflow-x-auto`. Either half alone is inert — without
  the first the page scrolls sideways, without the second the table is clipped —
  and neither failure carries a word.

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
  notice appears. The notifications panel keeps it one level up: *Rien à
  signaler* is said when the panel is **empty**, never over a pinned card, never
  over a read that failed, and never while one is in flight.
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
- **There is no band anywhere** (#829, ADR-0037), and the criterion is read off
  the **rendering**: on a `503` not one live region is raised on any route.
  What is left of the band is `Unreadable` — an `EmptyState`, not an `Alert` —
  standing **in the slot the missing content would have taken**. `lib/status.ts`
  keeps the causal order and `oneFailure` keeps the first, which is why a page
  whose two reads both refuse says it **once**.
- **Every read goes to the surface it would have filled** (#799, then #829).
  The page reads and the blocks render, so each read is declared at the page and
  handed down — a read declared inside the block that consumes it is a read
  whose failure nothing can name, which is how a `503` on a series took the
  chart off the dashboard on every load without a word. #799 answered that with
  a band above both tracks; ADR-0037 removes the strip and hands each read to
  its own block instead, which keeps the property that mattered: **a failed read
  never costs the reader a block that did answer.** What empties a page and what
  empties a block stay two lists — only the reads a page is *made of* reach
  `dashboardState`. Several empty slots may therefore carry a reason at once,
  and that is not *several announcers*: an empty state is not a live region, and
  what announces the **installation** is the bell, once. `/api/runtime` is in no
  list — it answers from process memory and never opens the store, so it fails
  only when everything else does, and `/health` is what the bell reads.
- **Green means the quotes are read *and* the performance is up to date** (#787).
  The indicator used to hold one predicate, the scheduler, and stayed green while
  a red band announced a rebuild on every page — two surfaces disagreeing about
  one installation. With the rebuild folded in, one glance answers *are the
  figures I am looking at any good*, which is why no page dates its own figures
  any more. **One fact has one announcer**: `rebuilding` is a colour of the bell
  *and* the subject of the `reconstruction_running` installation fact, so the
  panel raises a health card for `attention` and `unreachable` alone.
- **And it reads `/health`** (#819, ADR-0036), which is the one route the
  front reads with no `/api` prefix — the container's own probe, so `vite.config.ts`
  proxies it beside `/api` or the dev server answers it with `index.html`. It read
  `/api/runtime` until then, whose one *detectable* problem is a stopped
  scheduler: a scrape frozen since Tuesday left it green. The body's own
  word carries the four facts now, so **amber is a `200`**, and the trade is
  assumed — the body goes when the store goes, and the `503` under it is red,
  the one colour that needs no body to be true. Red also covers a route that
  answers with a body `installationState` cannot read; grey stays *nothing has
  run yet* and never *something is wrong*. `STATE_TONE` is declared **once**, in
  `Notifications.tsx`, and it has exactly one consumer since #829: the sidebar
  card that used to be its second reader is gone.
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
│   ├── problem.ts status.ts  # problem.type → key (+ values) · the bell's state, a failed read
│   ├── notifications.ts      # the panel's entries: two axes, four subjects, three counts
│   ├── absence.ts sign.ts    # the four renderings of absence · the colour of a figure
│   ├── gain.ts               # ADR-0018's four terms and their sum
│   ├── shares.ts             # a row is a symbol; the carried value; the day-markers
│   │                         # the ten orders, the partition by account, the weight
│   ├── dashboard.ts          # the two readings, the twelve slices, the four states, the day
│   ├── accounts.ts           # the rebasing to 100, the weights, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses, the reveal · what there is to export
│   ├── installationFacts.ts  # what the block shows, what the badge counts
│   ├── installation.ts       # the cadence's reach, and only what moved is sent
│   ├── palette.ts            # ⌘K's five sections · the reduction an event leads to
│   ├── currencies.ts firstRun.ts receipts.ts docs.ts save.ts
├── components/
│   ├── Explain · Stat · EmptyState · EntryPair · ShareBar
│   ├── Refusal                # a gesture the server refused, beside the control
│   ├── Unreadable             # a read that did not answer, where its content would be
│   ├── NoBaseCurrency         # the band's sentence, in each page's empty state
│   ├── FirstRun · CurrencyField
│   ├── ChartTooltip           # what a chart answers the pointer (#787: the axes went)
│   ├── Shell · ContentHeader (the title, the bell, ⌘K, the three preferences)
│   │                          # Shell also reads back the navigation's fold
│   ├── Notifications          # the bell and its panel: health · facts · advisories
│   ├── Palette                # ⌘K: five sections, three of them optional reads
│   ├── AppSidebar (the navigation, and nothing else since #829)
│   ├── dashboard/  # the hero head, the chart, the allocation, the movers, the accounts card
│   ├── shares/     # the head, the table, the fold of closed lines, the chart, the sheet
│   ├── data/       # the ledger, the create form, the drop zone, the export menu
│   │               # (UploadZone: the file in, the receipt under it)
│   │               # (the settings left for settings/ — #830, ADR-0038)
│   ├── settings/   # the dials, the workloads, the orphans, the store, the environment
│   │               # (RebuildBlock: where the bell's reconstruction card lands)
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
  zero events included. And it carries **four convention notes and no prose**
  (#831): the bubbles sit on `Gain total`, `Versé net`, `TRI` and `TWR`, and the
  three sentences that stated a rule under the chart are gone — an absence still
  says why it is absent, which is not the same thing.
- **Shares** (`/titres`) — ten columns since #832, the header sums its
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
  back to the first declared one. **No range control at all** since #833: the
  head figure is `Performance totale`, `gain ÷ versé net`, a cumulative ratio
  whose extent is the account's own life — so no window is implied and none has to
  be stated, which is what lets the rail's cards carry the same figure where
  ADR-0028 refused a windowed `perf`. The rail still draws a share of a total on a
  stated day and no curve at all, the second half of ADR-0028's sparkline clause;
  the first half is held by the curve itself, whose legend **states the extent it
  covers** — the account's whole history, there being nothing left to cut it to.
  The cross-account comparison is the dashboard's accounts card now, and
  ADR-0019's rule travelled with it — control, bound and all, that card being the
  one surface in the product that still has one. It is
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
- **Ledger** (`/donnees`) — **no tab bar at all** since #830, and the page is
  **named** for the one thing it holds (ADR-0038): the notices left with the
  banner and the status dot, into the panel behind the header's bell, the
  installation left for `/reglages`, and a bar holding a choice of one is not a
  bar. The `#installation` hash went with it — it was an address on a tab, and
  the surface it named has a path now. What is left is the table — bounded,
  sticky-headed and revealed forty rows at a time since ADR-0031, reduced by two
  groups of chips, a search, a **period** — two date fields since #810, both
  bounds inclusive, and a chip that shows up only once a bound is in force, to
  name the interval and be the way out of it — and, since #797, by an
  **address**: `q`, `type`, `account`, `since`, `until` and — since #829 —
  a repeated `symbol`, which are the **five** dimensions the export resource
  parses, so a reduced ledger's URL is the query string of its own export. The
  securities were the one dimension with no address until a card in the panel
  had to reach them from all five routes. A reduction that arrived that way names
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
  band is the zone and the menu.
- **Settings** (`/reglages`) — the fifth page (ADR-0038), and the only route of
  the five that reads nothing off its own address: a dial is not a reduction of
  anything, so there is nothing here for a search parameter to describe. **Five
  cards** since #830, in the mock-up's order and each named for what it holds:
  *what you can change* (the registry's six dials, **stale-price horizon
  included**, where `0` disables the sonde and the field says so; the currency
  stops being a field once it is answered and says it cannot be taken back),
  *the workloads* (the three jobs of `/health`, their last pass and their
  verdict in prose, with a stopped scheduler said above them as the cause it
  is), *the orphaned securities* (absent at zero, the count said and each one
  named, one purge), *the store* (the path, whether it outlives the container,
  the size with what a purge will not return, and the **last write of the
  ledger**), and *what the container imposes* (a description, and nothing in it
  is focusable). The rebuild card rides above them while a reconstruction is
  under way, which is where the bell's `reconstruction_running` card lands. The
  page is bounded at 880 px and centred — the shell's column is uncapped, and a
  row of label and value is the one thing that must not be stretched. The *why*
  of the page itself is that a two-tab bar is a bar that should not exist: it
  costs a control and a level of nesting to hold a choice between what the owner
  declared and what the installation is.
