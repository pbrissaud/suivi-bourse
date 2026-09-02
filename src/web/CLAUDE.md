# src/web/ — the front

> **The drawing was read again, point by point** (#838). The five pages were put
> beside `docs/design-revamp-v2-dark.html` **rendered** and brought onto it, and
> what came out of that pass is a *system* rather than a list of nudges — most of
> it lives in `index.css` and in three shared components, and the pages spend it.
>
> - **The type scale is the drawing's, and it is stated once.** `--text-*` is
>   redeclared over the whole ladder — 11 · 12 · 13 · 14 · 15 · 16 · 19 · 20 ·
>   26 · 28 · 34 · 42 · 52 — so a block goes on writing `text-sm` and lands on
>   13 px. Two rungs the framework has no name for are added (`text-2xs`,
>   `text-md`) and one is **fluid**: `--text-hero`, a `clamp` fitted to the
>   drawing's own four sizes for the one figure a page leads with. `--radius`
>   moves to `0.625rem`, which makes `rounded-lg` the drawing's 10 px control and
>   `rounded-xl` its 14 px card; `--font-weight-heavy` is the one weight above
>   semibold, and `--tracking-caps` the eyebrow's letter-spacing. `--gain` and
>   `--loss` take the drawing's own two values on the dark ground.
> - **`cn` had to be taught the ladder** (`lib/utils.ts`). `twMerge` reads an
>   unknown `text-…` as a **colour**, so `cn('text-hero', 'text-gain')` dropped
>   the size in silence and the dashboard's 52 px figure came out at 15. The
>   three added rungs and the added weight are declared there. A rung added to
>   `index.css` and not named there works until the day it meets a colour.
> - **One utility is composed** — `eyebrow` — because every card in the drawing
>   is headed the same way and six classes repeated two dozen times drift. It
>   declares no token, so ADR-0023's three blocks are untouched.
> - **`Segmented` is the segmented control, once** (`components/Segmented.tsx`):
>   the dashboard's period, the chart's two readings, the share sheet's window.
>   Two semantics, one look, and the caller says which — a period is a
>   `radiogroup`, a reading is `aria-pressed`.
> - **A figure inside a table is set in the mono face**, by one rule scoped to
>   the cell in `index.css`; a figure outside one — a statistic, a page's head —
>   stays in the sans. `.tabular` is unchanged and is still what every call site
>   writes.
> - **The 976 px reflow target is a breakpoint**, `wide:`. The accounts page
>   switches to master-detail exactly there, where `lg:` landed 48 px late.
> - **The navigation folds itself where nothing was chosen.** `Shell` reads the
>   `sidebar_state` cookie as three states now: folded, unfolded, and *never
>   answered* — and the last one is decided by the width, open from 1 024 px and
>   the rail below it, which is what the drawing does.
>
> And six things of shape, each of which cost a decision:
>
> - **The dashboard is a column, not a plateau** (see below), with **one** range
>   control on a row of its own between the head and the chart — it drives the
>   chart and the comparison, and the two controls that offered the same four
>   options one row apart are one.
> - **The movements are one list of five**, best first, each line carrying its
>   ticker as a badge: the two columns and their two *nothing went down* lines
>   paid for what a short list says by being short.
>   The ring is **seven arcs and the fold**, which the drawing caps it at and
>   which reverses a measurement of ours: at eight, the tail *Autres (4)* was
>   worth 10,1 % — more than four named slices together — and twelve was the
>   answer. The drawing answers it differently: the fold names its own count,
>   wears the ramp's last stop so it reads as a remainder, and every line it
>   hides is in the table directly under it. Its legend bars are drawn full at
>   the **largest** slice rather than at a hundred, which is what makes a column
>   of 26, 18 and 11 per cent legible.
> - **The shares page leads with the ring and frames its table**, whose header is
>   a strip of four totals — `Valorisation · Latente · Réalisée · Dividendes`,
>   the sums of four of its own columns. The 52 px `Gain total` that stood
>   between the two is not in the drawing: the ring already states the whole in
>   its hole.
> - **An account is one head card with its curve inside it**, and the editor is a
>   pencil beside the name rather than the name itself. Under 976 px the rail
>   becomes a **sticky bar of chips** at the top of the screen — the drawing's
>   own answer to a column of cards that, stacked above the detail, takes the
>   way back to the other accounts off the screen with it. It is mounted beside
>   the grid rather than inside the rail: a sticky element sticks within its
>   *containing block*, and the rail's column ends where the detail begins.
> - **The ledger's band is a band** — icon, sentence, picker and export menu on
>   one row — and the table is framed like the shares table.
> - **The settings read down a column**: every card headed by the eyebrow, a
>   quantity in a field the width of a quantity with its unit beside it, and the
>   workloads as three columns rather than three paragraphs.
>
> **And the addresses are English** (#838, second pass). `/titres`, `/comptes`,
> `/donnees` and `/reglages` are `/shares`, `/accounts`, `/ledger` and
> `/settings`; the search parameters that were French went with them —
> `?compte=` is `?account=`, `?titre=` is `?symbol=`, and the two *gestures* an
> address can carry, `?ouvrir=evenement` and `?ouvrir=compte`, are `?open=event`
> and `?open=account`. It leaves the product with **one** language in its URLs
> and the same one its source is written in (ADR-0024: English is decided
> first), where a reader was reaching a French path to open a page whose every
> identifier is English. The reduction's other four parameters were already
> English — `q`, `type`, `since`, `until` — so `/ledger?type=BUY&account=pea` is
> now one sentence rather than two. Nothing redirects from the old paths: they
> have never been released, `preview/v5` being what they have only ever run on.
>
> **And the copy was read again** (#838, third pass). The catalogues had drifted
> into the register of the records that produced them — a hint that explained
> the *mechanism* rather than the setting (*How long a stored price may stay
> frozen while the market moves before it is reported*), a bubble that argued
> for the app's own arithmetic (*the app adds the four up rather than computing
> a total separately and trusting that they agree*), a refusal that recited the
> rule it enforced. Some ninety strings were rewritten on one rule: **say what
> the reader is looking at or about to do, and stop**. What a figure *is* stays;
> why the product computes it that way goes to the docs the bubble already links
> to. `en.json` is still the source and `fr.json` is still kept in step by hand,
> so every rewrite landed in both.
>
> The one difference from the drawing that is **kept on purpose** is the fold of
> the navigation: the drawing puts its toggle at the foot of the sidebar, and the
> product keeps it in the content header, where it survives the drawer.

> **The ledger has its facets, and its two removals** (#834, ADR-0031,
> ADR-0032). The reduction is laid out in **three** places and they are three
> questions: `LedgerFacets.tsx` on the left, where an axis is *chosen* — type,
> account, period — and **every option carries the count it would leave**; the
> search above the table, the one dimension with no vocabulary to lay out; and
> the pastilles under it (`LedgerChips`), where the reduction is *read back and
> let go of*, one per dimension in force. **Each count excludes its own axis**,
> which is what a facet is: the number beside *Dividende* is *what is left if I
> press Dividende*, so it is the reduction run again with that axis replaced —
> `lib/ledger.ts`'s `typeFacets`/`accountFacets`/`yearFacets`/`monthFacets`,
> because a count that lived in the panel would be taken off the rows on screen
> and every option but the pressed one would read zero. The **period is one axis
> with three controls** writing to the same two bounds: the years are the
> vocabulary, the twelve months appear **only once the period fits inside a
> year** (`rangeYear`), and the two date fields stay for the interval neither
> spells. Under 768 px the panel **folds** — `hidden md:flex` on the body and
> `md:hidden` on the toggle, the pair held on the source in
> `contentWidth.test.ts` — and the account axis keeps #795's *N ≥ 2 only*.
>
> **The count and the end sentence say they are a reduction's** (ADR-0031):
> *Réduction · 47 événements* and *Fin de la réduction*, never *Fin du grand
> livre* over a reduced table. And **a row is corrected and removed like any
> other** (ADR-0032): the whole row opens the editor — the name stays a button,
> which is the keyboard's way in, the shares table's own gesture — and a ninth
> cell holds the row's removal, `RowDelete.tsx` naming the row in the box rather
> than asking *are you sure*. `BulkDelete.tsx` **recites** the reduction now
> rather than listing it (*« Supprimer les 47 événements de type Dividende, sur
> le compte pea, entre le … et le … ? »*), the clauses being the pastilles' own
> and joined by a comma because they are qualifiers stacked on one noun. **With
> nothing reduced the gesture is refused and points**: a different box, never
> the same one with a bigger number, naming *Vider le grand livre* — which has
> its own confirmation and reduces on the ledger's **oldest day**, `event.date`
> being `NOT NULL` and `DELETE /api/events` refusing an empty query string in as
> many words.
>
> **The shares table has its two gestures** (#791): it **sorts on any of its
> nine columns** and it **groups by account** with each subtotal in the group
> header. Neither removes a line: an order is a permutation and a grouping is a
> partition, so the header goes on stating the sum of what is under it, ADR-0017
> untouched. The grouping is offered only above one account,
> `accountBreakdown`'s own argument one surface over. Both are page **state**
> and not an address: nothing outside the page leads to *this table sorted by
> PRU*, where ⌘K does lead to `?symbol=`.
>
> **`Poids` is not a column, and the weight is answered by the `Répartition`**
> (#831). It was one at #791, taken out on sight, back as a bar at #832 — and
> that last decision was taken on the **source** of the maquette rather than on
> its rendering. Rendered, the drawing's table has nine headers and no tenth,
> and the word `Poids` never appears on that page at all: its three occurrences
> are the account's (*Poids des comptes*, and #833's sortable column). What the
> maquette answers *the weight of a line* with on `/shares` is the **ring above
> the table** — a figure of the whole rather than a tenth cell on every row —
> and that block is mounted there since #831. `weight` left `SortColumn` with
> the column: a sort key nobody can reach is a control that does not exist.
>
> **And the content column may now be narrower than what is in it** (#832).
> `SidebarInset` is a flex item, so its `min-width` was `auto` — *never narrower
> than my content* — and a table wider than the column pushed the **whole page**
> sideways instead of scrolling inside itself: measured on `/shares` against a
> real API, the page overflowed by 256 px at 768 and by 238 px at 976, and the
> `overflow-x-auto` `components/ui/table.tsx` puts around every table was inert,
> its parent having grown to fit. `min-w-0` on the shell's column is the whole
> repair, it is the shell's rather than the table's, and `src/contentWidth.test.ts`
> holds both halves of the pair on the source. The measurement that forced it was
> taken on ten columns and the table is back to nine, which **narrows** the case
> without closing it: the scroll inside the container is what the maquette itself
> does at 1 280 px, so it is the drawing's answer rather than a stopgap.
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
> **And the account's lines block draws the share** (#833). `placedValue`,
> `weightShare` and `weightRendering` were written for #791's column and have now
> outlived it twice, held between the two by their own unit tests. Their reader is
> a dozen lines under a single account — where a weight is a glance down a short
> list rather than a column — and the surface states its own whole.
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
> **And the forecast is a window since #835** (`ImportPreview.tsx`), because it
> stopped being a sentence: it collects **three** answers and the receipt alone
> is left under the zone. The new one is the **account correspondence** — a line
> per account the file names (`file_accounts`, the server's census), with its
> volume and a target chosen among the declared accounts *plus* **declare this
> one with the file**, which is what repairs the `422` that used to reject the
> whole file. A missing target **blocks the button in prose**, and every answer
> costs a fresh forecast: the duplicate key carries the account, so what is
> skipped changes with the answer (`?map=` + repeated `?declare=`, applied
> server-side before the split in both branches). It is **consumed and dropped**
> — a parameter of the gesture, never the persistent mapping ADR-0006 forbids,
> and the window says so. The two others were already served and never gathered:
> the **duplicates** named line by line with the ledger row each repeats
> (`duplicate_rows`, `duplicate_of`) — and the box **costs a forecast of its
> own**, for a harder reason than the correspondence's: writing the rows the
> ledger already holds is a different ledger to replay, so a file whose `SELL`
> only replays because its duplicate was skipped stops replaying once it is not,
> and left to arithmetic here that is a `409` *after* the button. `useEventUpload`
> therefore holds **two** receipts for one answer (`Forecast`): the file read with
> the duplicates skipped, which is the census every block is drawn from — the
> flag empties `duplicate_rows` server-side, so a block mounted on the other
> reading would take its own box away — and what the answer would really write,
> which is where the footer's count comes from. A refusal of the second lands
> *beside* the first, so the window says it before the button and the reader can
> untick. And the **currency** offered for adoption
> where the install has never answered (`?adopt_currency=0` declines) and refused
> in prose where it contradicts one — a `422` at both moments, so the window
> stands with the sentence in it and the button disabled beside it. **The simple
> case renders neither block**: one line of affirmation for the accounts, and no
> duplicates block at all. The arithmetic is `lib/imports.ts` (`accountLines`,
> `unanswered`, `correspondenceOf`), pure and asserted on the list rather than
> through a control.
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
>
> **And its own drawing was read** (`docs/design-revamp-v2-onboarding.html`),
> which decided four things the walk did not do. The passages are **drawn** and
> not merely counted: a rail of three marks joined by rules that fill as they are
> crossed, `aria-current="step"` saying which is standing and the eyebrow under
> it still saying *Passage 2 sur 3* — a rule filling with colour is not something
> a screen reader can be handed. The way out is **written** (`Échap pour fermer`)
> beside the control that walks on, and on the first passage alone, where a
> reader is still deciding whether to be here; the three ways out were always
> there and none of them was spelt. The body **holds one height**, the footer
> having jumped under the cursor between one `Continuer` and the next. And the
> accounts passage **offers what it was only naming**: a dashed control opens a
> three-field declaration, closed by default, that `Continuer` never waits on —
> it is not `AccountForm`, because that panel's removal has no row to act on here
> and #725's reassignment box states a count off the ledger, which this walk
> deliberately does not read (ADR-0026). The catalogue is shared with it key for
> key, so the two cannot drift. The forward control is `secondary` rather than
> `ghost`: *quieter than the answer* is what ADR-0021 asks for, and a ghost at
> the one corner every reader looks at reads as nothing at all.
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
> their own, `/settings`, and the data page is called the **ledger** — `Grand
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
> `/settings` is five cards rather than one block — *what you can change*, **the
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
>
> **And three things of form went with it, on the maquette read *rendered***
> (#831, reopened). The drawing had been compared on its source for five
> tickets — it renders its `{{ placeholders }}` raw without `docs/support.js`
> beside it — and rendering it answered three questions at once. The
> **`Répartition` is the shares page's**: ring and legend are in the `Titres`
> branch and in no other, and the arithmetic agrees, the whole it divides being
> what the header under it sums — so the total in the ring's hole and that
> header's `Valorisation` are one number said twice wherever every line on
> screen has a value, reduction and anomaly lens included, the block being
> handed the rows on screen. They part on one inherited case, an unresolved rate
> emptying the header while the ring divides what it could place, which was the
> `Poids` column's tension before it was this block's. The **`Poids` column
> goes**, the table returning to nine. And the **`Montants / Performance`
> selector stops being tabs**: the maquette draws it segmented like the range
> beside it, a tab is a *place* and the shell's navigation is what the product
> has of those, so it is a group of `aria-pressed` buttons and `ui/tabs.tsx` is
> gone with its last reader — there is not a `role="tab"` left in the front.

Vite + React 19 + TypeScript, Tailwind/shadcn, TanStack Query & Router, Recharts.
The tables are written by hand on the `components/ui/table.tsx` primitives:
TanStack Table was a dependency of the prototype and no file ever imported it.
Builds into `src/static/`, which Flask serves. It lives under `src/` beside the
two Python packages — it is **not** a pnpm workspace with
`website/`.

```bash
pnpm install
pnpm lint    # tsc -b --noEmit
pnpm test    # vitest, no network and no configuration
pnpm build   # → src/static/ (git-ignored)
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
- **The light ground is derived, and it was measured** (#837, ADR-0029). The
  maquette carries **one** artboard and it is the dark one, so the light theme
  is not a drawing to copy but two rules applied — the mint has its own value on
  white, and the two allocation ramps are opposite because rank 1 is the most
  contrasted **on each ground**. Both are held on the source
  (`themeCut.test.ts`, `lib/alloc.test.ts`), and the ramp's colour-blind
  criterion is asked of the **painted** colours rather than the declared ones:
  chroma falls with rank too and chroma emits light, so a ramp can be monotone
  in OKLCH and not monotone on a screen. What closed the pass is what it
  measured on the running app, and it is worth knowing **exactly how far it
  reached**: the five routes as they first render, on both grounds — no text
  under 4,5:1 there, and nothing overflowing sideways at 390, 768, 976, 1280 or
  1536. It did **not** open what a click opens, and the share sheet is where
  that shows: `PriceChart` mounted recharts' `CartesianGrid`, `XAxis` and
  `YAxis` with no colour of its own, so the library painted them from its own
  defaults — a `#666` tick text at 3,24:1 against `--card` on the dark ground,
  and an `#ccc` grid at 11,6:1 where the dashboard's is at 1,2:1. That one is
  **closed** by #841, and the bullet under this one is what closed it. The
  defect the pass itself found is the bullet four below — the controls the agent
  paints itself.
- **A chart's chrome is the theme's too** (#841, ADR-0023). The two greys above
  were the *same on both grounds*, which is what makes them not a light-ground
  defect at all but a chart with no ground: recharts has a theme of its own and
  it is not ours. The repair is not the dashboard's line pasted over, because
  recharts fills a tick label with the **axis' own `stroke`** — one token would
  either shout the grid or hide the figures. So the two are coloured apart on
  what they *are*: the grid and the axis lines are chrome and carry `--border`,
  the dashboard's `2 4` hair included (a grid is no more legible for hanging in
  a sheet than on a card); the gradations are **text** and carry
  `--muted-foreground`, which clears 4,5:1 against `--background` **and**
  `--card`, on both grounds. `src/chartChrome.test.ts` is the net, and it is
  three claims rather than one repair: no grid, axis or tooltip cursor anywhere
  in the front is mounted without a token or hidden — *one chart was fixed*
  becoming *no chart escapes*, which #837 could not have established by hand;
  the gradations' floor is **measured**, the token read off the component and
  its value off `index.css`; and the grid stays under the 3:1 a mark that
  *carried* meaning would have to reach. `themeCut.test.ts` holds the other
  half from below — **no colour literal in a component at all**, which #837
  verified by reading and nothing held. Its subject is the component, so it
  reads `.tsx` and nothing else: `accountColour` and `allocationRamp` fall
  outside by living in `.ts` modules, and they belong outside — both compute a
  colour from a rule, which is what no token can say. `ui/` alone is out by
  name, because it regenerates.
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
- **The controls the browser paints itself are the theme's too** (#837). The
  parity pass of the light ground found an object whose colour the product had
  not chosen at all: the settings page's rebuild bar. A
  `<progress>` and a checkbox are drawn by the user agent, and `accent-color`'s
  initial `auto` is the **reader's desktop accent** — so the bar wore whatever
  the machine was set to, the mint by coincidence, and its *track*, the half no
  accent reaches, came out a mid grey that read as a rule drawn across a white
  card. `color-scheme`, which `ThemeProvider` writes beside the `.dark` class,
  says *paint your light furniture or your dark one* and never *paint it in
  ours*. Both are stated in `@layer base` — `accent-color: var(--primary)` on
  `html`, and the two halves of `progress` from `--input` and `--primary` —
  which adds **no token**, so ADR-0023's three blocks and its sizing rule are
  untouched. The track is `--input` and not `--muted` because the bar sits on a
  `--card` and `--muted` *is* that card to within 1,16:1 (1,10:1 on the dark
  ground): a track nobody sees leaves a mint stroke with no extent to read the
  fraction against, and the proportion would survive in the `aria-label` alone.
  `themeCut.test.ts` holds the **separation** and not the two names, so a tidy
  that reaches back for `--muted` fails there. The two vendor pseudo-elements
  are two rules and never one
  selector list: a list holding a name the agent does not know is a list the
  agent drops whole, taking the half it does know with it.
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
│   ├── alloc.ts format.ts    # the twelve allocation stops · the ten Intl sites
│   ├── problem.ts status.ts  # problem.type → key (+ values) · the bell's state, a failed read
│   ├── notifications.ts      # the panel's entries: two axes, four subjects, three counts
│   ├── absence.ts sign.ts    # the four renderings of absence · the colour of a figure
│   ├── gain.ts               # ADR-0018's four terms and their sum
│   ├── shares.ts             # a row is a symbol; the carried value; the day-markers
│   │                         # the nine orders, the partition by account, the weight
│   │                         # and the twelve slices, since #831
│   ├── dashboard.ts          # the two readings, the four states, the day
│   ├── accounts.ts           # the rebasing to 100, the weights, the reassignment
│   ├── ledger.ts imports.ts  # a type's fields, the two parses, the reveal, the facets
│   │                         # and the reduction that covers the whole · what there is to export
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
│   ├── dashboard/  # the hero head, the chart, the movers, the accounts card,
│   │               # the investment rhythm (#751)
│   ├── shares/     # the allocation, the head, the table, the fold of closed lines,
│   │               # the chart, the sheet
│   ├── data/       # the ledger, its facets, the create form, the drop zone,
│   │               # the export menu, and the two removals (row and reduction)
│   │               # (UploadZone: the file in, the receipt under it)
│   │               # (the settings left for settings/ — #830, ADR-0038)
│   ├── settings/   # the dials, the workloads, the orphans, the store, the environment
│   │               # (RebuildBlock: where the bell's reconstruction card lands)
│   └── accounts/   # the rail of weights, one account's detail, its curve, its form
└── test/           # setup · MSW server · payload factory · renderApp
```

## The five pages, one line each

- **Dashboard** (`/`) — **one column** since #838, which is the drawing's own
  shape: the head (which computes `Gain total` from its four terms and never
  reads `gain_absolu`), then the page's **one** range control on a row of its
  own, then the chart with its two readings (*Amounts* / *Performance*, a group
  of buttons since #831 and never tabs), then the movements and the **accounts
  card** side by side from `md`. It was a plateau of two tracks from #790 to
  #838 — the rail carried the two blocks that are *read down* — and what
  replaced it is not a preference: the drawing lays the head and the chart
  across the full width and puts the two lists under them, and the range the
  rail's card carried was the second of two controls offering the same four
  options one row apart. The
  allocation was the wide track's third block until #831 sent it to `/shares`. That card is where accounts are compared
  since ADR-0028, and it therefore holds ADR-0019's rule: one range for every
  figure on it, sparkline included. The head's two period figures sit with the
  total, never among its four terms. It is the dashboard **unconditionally**,
  zero events included. And it carries **four convention notes and no prose**
  (#831): the bubbles sit on `Gain total`, `Versé net`, `TRI` and `TWR`, and the
  three sentences that stated a rule under the chart are gone — an absence still
  says why it is absent, which is not the same thing.
- **Shares** (`/shares`) — the **`Répartition`** since #831 — twelve slices, its
  total in the ring's hole, dividing exactly the lines the header under it sums —
  then the table, framed, whose **header is a strip of four totals** since #838
  — `Valorisation · Latente · Réalisée · Dividendes`, the sums of four of its own
  nine columns, closed lines counted in. The page's own 52 px `Gain total` went
  with the strip: the drawing has no such figure here, the ring already stating
  the whole in its hole one block up. The closed positions **fold** rather than
  being filtered (the fold is
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
  URL** (`?symbol=`) since #797, the same clause as the `?account=` reduction beside
  it, because ⌘K reaches a held title from any of the four routes.
- **Accounts** (`/accounts`) — master-detail from **976 px** (ADR-0028, the
  `wide:` breakpoint since #838): a sticky rail of weights and names, one
  account's detail beside it — one **head card** carrying what the account is
  worth, the contribution and the gain it is the difference of, the fees, the
  cumulative ratio and the curve *inside the same frame*; then the composition,
  the annualised rate with the time-weighted one under it, the dividends, the
  lines and the last events. The four-term list the head used to nest went with
  #838: the drawing states the dividends on a card of their own, the fees on the
  line under the gain, and the latent gain as a column of the lines table — so
  ADR-0018's identity is unchanged and the page no longer says it twice.
  Which account is open is a **URL** (`?account=`), and an id naming nothing falls
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
  places: *what it is worth against the contribution* sits under the figure
  itself, in the dividends block, and **which securities pay it** is a card of
  its own below the lines, stating the extent it was read over —
  `position.dividends` is a lifetime total, so that block says the account's
  whole history, which since #833 is the only extent the page has.
  The reassignment rides with the **declaration** where nothing is
  declared yet (#725, offered and never required), and stands on its own in the
  **seeded account's own detail** once something is: its subject is that
  account's events.
- **Ledger** (`/ledger`) — **no tab bar at all** since #830, and the page is
  **named** for the one thing it holds (ADR-0038): the notices left with the
  banner and the status dot, into the panel behind the header's bell, the
  installation left for `/settings`, and a bar holding a choice of one is not a
  bar. The `#installation` hash went with it — it was an address on a tab, and
  the surface it named has a path now. What is left is a **panel of facets and
  the table** — bounded, sticky-headed and revealed forty rows at a time since
  ADR-0031 — reduced since #834 from a panel on the left carrying type, account
  and period with **a count on every option, its own axis excluded**, the months
  showing only once the period fits inside a year, the two date fields of #810
  under them (both bounds inclusive), and the pastilles above the table, one per
  dimension in force, each stating what it retains and clearing itself. The
  panel folds under 768 px. And the reduction is also an **address** since #797:
  `q`, `type`, `account`, `since`, `until` and — since #829 — a repeated
  `symbol`, which are the **five** dimensions the export resource parses, so a
  reduced ledger's URL is the query string of its own export. The securities
  were the one dimension with no address until a card in the panel had to reach
  them from all five routes. A reduction that arrived that way names what it
  retains and offers the way out; the reader's first gesture takes the address
  back off, an address being a description of the table. The two sentences under
  the table are true of the **reduction** and say so (*Réduction · 47
  événements*, *Fin de la réduction*). Since #814 the reduction has a
  **destructive gesture of its own**, beside it: it deletes everything the
  reduction retains — the rows a file carried included — behind a box that
  **recites** the reduction since #834; with nothing reduced that gesture is
  **refused** and points at *Vider le grand livre*, which has a confirmation of
  its own and reduces on the ledger's oldest day. A row is corrected by a click
  anywhere on it and removed from a ninth cell, one at a time (ADR-0032). Above
  the table,
  one band holding the **upload zone** (a real target since #811: a file
  dropped on it or chosen from it is handed to `POST /api/events/import`, and the
  receipt is said under it), the export menu — **four entries** since #836:
  every event, a workbook with one sheet per year, the filtered selection and
  the **accounts with their positions**. The first three are server-side
  because the importable form belongs to `events/export.py` and a rule written
  twice loses a branch; the fourth is not on that axis at all — it is a
  **report** (balances, PMP, valuations) and not a backup, which is what lets it
  stand where ADR-0034 removed an `accounts.csv`: that file was a *declaration*
  nothing could read back, and this one the import refuses by name for want of
  `date` and `event_type`. It takes no reduction either — the five parameters
  are the ledger's dimensions, and a position has none of them. Each entry
  carries its perimeter under it and its format beside it, which is what lets
  the first two share a label. And **no third thing in the band** since #816:
  nothing persists that could be listed or revoked, so the band is the zone and
  the menu.
- **Settings** (`/settings`) — the fifth page (ADR-0038), and the only route of
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
