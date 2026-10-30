---
# gstack: design-md-format=spec
name: SuiviBourse
description: A warm, tidy workshop where you read how you invest — what you put in, how regularly, where it went, what it cost — and whether it is building wealth.
colors:
  background: "oklch(0.9741 0.0074 80.7212)"
  foreground: "oklch(0.2193 0.0208 56.376)"
  card: "oklch(0.9947 0.0045 78.2986)"
  muted: "oklch(0.9445 0.0132 82.4018)"
  muted-foreground: "oklch(0.5003 0.0199 61.6482)"
  border: "oklch(0.9012 0.0129 86.8337)"
  input: "oklch(0.8207 0.0145 88.7)"
  accent: "oklch(0.92 0.0145 84.5845)"
  primary: "oklch(0.3 0.03 60)"
  primary-foreground: "oklch(0.9947 0.0045 78.2986)"
  destructive: "oklch(0.5498 0.2096 25.1372)"
  gain: "oklch(0.4825 0.1032 163.7504)"
  chart-1: "oklch(0.5 0.14 255)"
  chart-3: "oklch(0.47 0.16 305)"
  chart-4: "oklch(0.58 0.09 215)"
  chart-5: "oklch(0.38 0.06 45)"
  dark-background: "oklch(0.1687 0.0117 60.5255)"
  dark-foreground: "oklch(0.95 0.0074 80.7208)"
  dark-card: "oklch(0.2047 0.0112 60.7853)"
  dark-muted: "oklch(0.2287 0.0145 57.4561)"
  dark-muted-foreground: "oklch(0.68 0.0142 71.2595)"
  dark-border: "oklch(0.2982 0.0113 55.9114)"
  dark-input: "oklch(0.3614 0.0141 62.9858)"
  dark-accent: "oklch(0.265 0.0141 67.1532)"
  dark-primary: "oklch(0.92 0.012 80)"
  dark-primary-foreground: "oklch(0.1687 0.0117 60.5255)"
  dark-destructive: "oklch(0.7008 0.1902 25.1101)"
  dark-gain: "oklch(0.8001 0.1297 165.0822)"
  dark-chart-1: "oklch(0.7 0.12 255)"
  dark-chart-3: "oklch(0.66 0.15 305)"
  dark-chart-4: "oklch(0.82 0.06 220)"
  dark-chart-5: "oklch(0.55 0.08 50)"
typography:
  hero:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 60px
    lineHeight: 64px
    letterSpacing: -0.03em
  figure:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 28px
    lineHeight: 32px
  page-title:
    fontFamily: Geist
    fontWeight: 500
    fontSize: 15px
    lineHeight: 22px
  section-title:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 20px
    lineHeight: 28px
  term:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 16px
    lineHeight: 24px
  prose:
    fontFamily: Geist
    fontSize: 15px
    lineHeight: 22px
  body:
    fontFamily: Geist
    fontSize: 14px
    lineHeight: 20px
  label:
    fontFamily: Geist
    fontWeight: 500
    fontSize: 12px
    lineHeight: 16px
    letterSpacing: 0em
  table:
    fontFamily: Geist
    fontSize: 13px
    lineHeight: 18px
  ticker:
    fontFamily: Geist Mono
    fontSize: 11px
    lineHeight: 16px
rounded:
  md: 8px
  card: 14px
  section: 18px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  section: 20px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 64px
components:
  section:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.section}"
    padding: 20px 24px
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.card}"
    padding: 14px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
  button-secondary:
    borderColor: "{colors.border}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  chip:
    borderColor: "{colors.border}"
    rounded: "{rounded.full}"
  agent-thread-column:
    backgroundColor: "{colors.muted}"
    width: 240px
  sidebar:
    width: 200px
  content-column:
    maxWidth: 720px
  content-settings:
    maxWidth: 1040px
  content-reading:
    maxWidth: 768px
---

# SuiviBourse

## Overview

**Creative North Star:** "Atelier". A warm, tidy workshop where the user reads **how
they invest**, not why they picked a stock: what they put in, how regularly, where it
went, what it cost, and whether it is building wealth.

**What we want remembered:** « Je comprends comment je me constitue un patrimoine. »

**Product context:** an open-source, self-hosted portfolio tracker for French retail
investors holding a PEA, a compte-titres and a few positions. Its subject is the
user's investment strategy (rhythm, amounts, allocation, costs, comparison with an
index), never their investment thesis. The tax model per account wrapper is one
reading among others. Release 5.3 adds an agent page, `/agent` (Vercel AI SDK, `useChat`).

**Mode per surface:** every screen is Operate (an app UI: finish a task, read figures).
The website under `website/` is out of scope for this file.

**Page names:** this file names the pages in English; the interface, the mockups and the
issues use the French ones. Dashboard = *Tableau de bord*, Shares = *Titres*, Accounts =
*Comptes*, Ledger = *Grand livre*, Benchmark = *Référence*, Agent = *Agent*, System =
*Système*, Settings = *Réglages*.

**Reference sites (studied 10/10/2026):** wealthfolio.app (cream ground, italic serif,
the generic look we avoid), kubera.com (dark balance-sheet spreadsheet), sharesight.com
(classic holdings table). Direction chosen against three rendered alternatives
("Le relevé", "Atelier", "Instrument"), see the Decisions Log.

**Key characteristics:**
- The value is the hero, with the cash it holds named under it, then the total gain on
  its own line, then one plain row: since 1 January, today, IRR.
- Sections are warm tinted planes, never boxes; Atelier carries no shadow.
- Cards exist only where you decide something.
- Colour means something: ink for action, mint for money made, red for money lost, and the
  chart hues to tell the parts of a drawing apart.
- Avoid unnecessary supporting text, descriptive copy, and redundant UI microcopy

## Content

- **French first, in the reader's words.** Interface copy is French, in sentence case,
  with no jargon: « Valeur du portefeuille », « de gain total », « Saisir un événement »,
  « Cours au 2 mars 2026, 13:00 ». English mirrors it in the same register.
- **Say less.** No supporting text, descriptive copy or microcopy that repeats what the
  screen already shows. A label names; a figure answers; a fact is said once, where it is
  decided.
- **Verbs on actions, the past on receipts.** A button says what happens (« Déclarer un
  compte », « Importer »); its toast says it happened (« Événement enregistré »).
- **Errors say what and how to fix**, beside the control that earned them, without
  apology: « Cette vente dépasse les 10 titres ZZA détenus au 10/02/2026. Corrigez la
  quantité ou la date. »
- **One word per thing**, everywhere: the three return measures of *Return figures*
  below, and one term per page, action and figure across the app, the docs and the agent.
- **Numbers in the French locale:** `2 800,00 €`, `+3,22 %`, `−5,00 €` (a real minus,
  U+2212), compact axis amounts `17,5 k€`, dates `2 mars 2026` (`02/03/2026` in a
  table's date column, see *Return figures*).
- **An emptiness says why** and what will fill it (« Aucun événement », « Aucune devise
  de base », « Lecture impossible »). It is never said over a read still in flight.
- No emoji, no exclamation marks, no uppercase letter-spaced overlines, no kicker above a
  heading.

## Colors

**Strategy:** restrained. Warm neutrals carry the page and a warm ink owns action. Mint is
the colour of a gain and red the colour of a loss, and they colour only signs and figures.
The chart hues tell categories apart inside a drawing.

**Names:** the colours are named as the theme's tokens are, the standard shadcn names
that `atelier.json`, `index.css` and the design system use. Earlier revisions of this file
called them `tint` (now `muted`, the section plane), `surface` (`card`), `text`
(`foreground`), `text-muted` (`muted-foreground`), `rule` (`border`) and `on-primary`
(`primary-foreground`). `gain` is the role of `chart-2`. The front matter's values are
`atelier.json`'s (`stylesheet.test.ts` holds them within 0.01 ΔE_ok).

**Light or dark:** both ship. The use scene is a person checking their own money at a
desk or on a phone, often in the evening: light is the default, dark follows the
system setting. Dark keeps the hierarchy by stepping the same warm neutrals (background,
card, muted) rather than inverting lightness, and lifts the ink and the mint so they
keep their contrast.

- `primary`, the ink, is the colour of interaction: primary buttons, focus rings, the caret,
  the selection, a pressed control. The current navigation item is the `sidebar-accent`
  surface with its foreground, a hover held down. A link is `primary` and underlined at
  rest. A weight bar is `muted-foreground`.
- `gain` and `loss` colour the sign and the digits of a figure, never a row background,
  a pill fill or a whole card.
- Only a figure that can change sign takes `gain` or `loss`. A term whose sign is fixed by
  its nature (dividends received, always positive; transfer fees, always negative) stays
  neutral, `foreground` in its figure: colouring a sign known in advance tells nothing and
  dilutes the red of a real loss. The predicate is `termCarriesSign` in
  `src/web/src/lib/gain.ts`.
- A gap against the benchmark reference is neither money made nor money lost: it is written with its sign in `foreground`, on the Benchmark page, in its per-account rows and on the dashboard card, and its bars and the band between the two curves are `muted-foreground`. Each side's own return keeps its sign colour (#1282).
- The dashboard's *Performance* curve is the one drawing coloured by its sign: `gain` above
  the 0 % line, `loss` below it, split exactly at zero. The 0 % line and the axis carry the
  same information without colour. Both colours are the `--gain` and `--loss` tokens.
- `muted` is the section plane; `card` is reserved for cards and inputs that sit on it.
- `border` separates rows inside a section, or in a page's own table, and nothing else.
- A job's history bar (System page, #1236) is the one place a status colours a mark: an
  hour with a failed pass is `destructive` with ✕, one that needs a look `foreground`
  with ▲, a good one `muted-foreground`; an idle hour is a `border` stub, an hour with no pass a
  dashed `border` outline; an hour before the process started draws nothing. The glyph
  carries the meaning, the colour repeats it.
- Secondary text on a tinted plane uses `muted-foreground`, which is derived from the same
  warm hue, never a neutral gray.
- Gain is `chart-2` and loss is `destructive`: `--gain` and `--loss` point at them. Nothing
  else reads `chart-2`, so on Atelier the colour of a gain is not the colour of an action
  (#1283). On another theme this is best-effort: `chart-2` is the author's own choice and
  may equal `primary` (stock modern-minimal, dark), which brings gain and action back
  together. The +/− sign and the 0 % line carry the direction either way.
- A category in a drawing (an allocation slice, an account's identity) takes a chart hue:
  `chart-1`, `chart-3`, `chart-4`, `chart-5` in that order, and `muted-foreground` for a
  fold. On Atelier, each clears 3:1 against `background`, `muted` and `card` on both
  grounds, and two neighbours on the ring are at least 0.12 ΔE_ok apart
  (`src/web/src/palette.test.ts`). Slices are separated by a 2 px `background` gap and each
  is named in its legend, so a theme with weaker chart hues still reads.
- A mark that carries information in a drawing (a bar, a curve, a slice, a month of the
  rhythm strip) keeps 3:1 against the plane it sits on (WCAG 1.4.11). It is drawn at full
  opacity: a token at partial opacity is a new colour that no test measures.
- A status, an event's kind and a fixed-sign figure carry no hue: an event marker is
  `foreground`, a ledger type is a `muted` pill, a job that ran well is `foreground` with
  its glyph.
- A semantic token (`--gain`, `--loss`, `--price`, `--attention`, `--alloc-*`…) is
  always an alias of a standard shadcn token, never a value of its own
  (`lint/semantic-token-alias.grit`, #1130).
- The theme is replaceable: its tokens are a JSON kept in the store and edited in
  Settings › Thème, imported from tweakcn by id or pasted from
  `tweakcn.com/r/themes/<id>`. The server lays its colours, fonts, radius and shadows
  over Atelier; with nothing stored, Atelier is served. Atelier itself is
  `src/web/src/theme/atelier.json`, the same JSON as a stored theme; block 1 of
  `index.css` is generated from it by `scripts/sync_atelier.py`.

## Typography

Geist and Geist Mono stay. They are already self-hosted through `@fontsource-variable`
and used everywhere. Geist is on the list of overused display faces; we accept it
because in this app the display voice is the figure, not the font, and replacing a
shipped face would cost every screen for no reader benefit.

- **Hero (60/64, 600, -0.03em):** the one figure a screen leads with. One per screen. Fluid from 36 px on a narrow screen.
- **Figure (28/32, 600):** a secondary figure that stands alone (an account in the dashboard's accounts section, a term of the accounts page's figures row).
- **Page title (15/22, 500):** the page's `<h1>`, in the header bar, followed by its dated subtitle in Label-muted after a `·`. The same size at every width. Quiet on purpose: the bar is chrome and the navigation already says where the reader is; the page leads with its hero, not its name.
- **Section title (20/28, 600):** sentence case. No uppercase, letter-spaced overlines,
  no kicker above a heading. Also the rung of a figure that heads a section (its subtotal)
  or stands under the hero.
- **Term (16/24, 600):** a term under a figure (a sheet's price, average cost, quantity; the
  benchmark's two returns). A figure inside a line takes its line's size.
- **Prose (15/22):** the agent's answers and any explanatory paragraph.
- **Body (14/20):** controls and labels in forms. Below the usual 16 px rule
  on purpose: this is a dense tool UI; long reading text uses Prose.
- **Table (13/18):** the cells of a table and the dense lines that read like one (a
  ruled list on a phone). `text-sm` in the app,
  `.table-text` in the design system.
- **Label (12/16, 500):** meta and column headers, `muted-foreground`, never letter-spaced.
- **Mono, the Ticker rung (11/16, Geist Mono):** every figure, in a table or not, is Geist with
  `font-variant-numeric: tabular-nums` (#1281, which reverses the table half of #838).
  Geist Mono is for identifiers only: tickers and account ids, at 11 px beside the name
  they identify. Mono in the middle of a sentence, on a figure or on a version number is
  a bug.

These ten rungs are the whole ladder: a size that is not one of them is a bug, in the app
and in a mockup alike. A mockup names the rung (the design system's `.section-title`,
`.prose`, `.table-text`…) rather than writing a literal size.

## Layout

- **The shell:** a 200 px navigation (a 64 px rail when folded, a drawer under 768 px), then a 56 px header bar holding, in order, the fold, the page title with its dated subtitle, the search and the bell. Nothing else lives in the bar: language, light or dark, and table density are set in Settings › On this device.
- **Navigation:** two groups and no group label. The top holds what the owner reads and records: Dashboard, Shares, Accounts, Ledger, Benchmark, Agent. The foot holds the administration: System, Settings.
- **Content width is set per kind of content, never by one cap:**
  - a table or a chart takes the full width of the content column;
  - a form is one start-aligned column of 720 px (`max-w-column`);
  - the Settings page is 1 040 px (`max-w-settings`), start-aligned, one sequence of titled sections: from 1 024 px each section is a `220px | 1fr` grid with a 40 px gap, the title and one sentence in the gutter (sticky) and the rows on the right; under 1 024 px it is one column under a one-line anchor index;
  - the agent's conversation is described below (`max-w-column`, `lg:max-w-reading`);
  - a paragraph keeps its measure, 65 characters (`max-w-prose`), inside any of these;
  - a statement (a label on the left, its amount on the right) is never stretched: a grid gains a track instead. The dashboard grid gains its third track from 1 600 px (#1325).

  The widths are tokens in `index.css` (`--container-column`, `--container-settings`, `--container-reading`, `--breakpoint-3xl`), out of a theme's reach. A page uses them and never writes a width of its own.
- A table's totals are its last row, under the columns they sum (#1281).
- A table page's table sits on the background, with no plane and no frame (#1273). The header, the `border` rows and the totals row are its structure; the closed shares are a disclosure row under the Shares total.
- **< 768 px:** single column.
- Under 768 px the Shares table is a list on the background (#1338): one ruled item per held line, the name and valuation on the first line, the ticker and the latent gain on the second, the totals as four ruled rows, and a sort select with a direction button in the toolbar. The closed lines and the sheet's per-account breakdown are lists too.
- A table page has no side panel: its filters are a toolbar above the table, its
  selection's actions appear only with a selection.
- The Benchmark page names its period in the header subtitle, « Comparé du … au … », and its reference picker is the content's first row, « Comparer à » and the select, in every state that offers it. What shortens the period is said under the verdict. The head reads like the dashboard's: the gap, the verdict, then the two returns on one row. It sits on the ground; the chart, the rebuild status and the per-account table are sections.
- The agent is a page, `/agent`: from 1 024 px a 240 px thread rail, full height and
  flush with the navigation, and the conversation centred in the rest at most 768 px (`max-w-reading`);
  below 1 024 px, the conversation alone, centred at most 720 px (`max-w-column`).
- The accounts page: the accounts are a sticky bar of chips over the detail, at every width, each chip naming the account, its value and its share. The detail reads like the dashboard's head (one label, the account value as the hero, a line naming its cash and net contribution, the total gain on its own line, then one plain row with the IRR, the curve; no pills, as on the dashboard since #1280), then one row of secondary figures on the Figure rung, then its sections. Every row of the detail is shared equally by the blocks present, so an absent block never leaves a hole.
- **Rhythm:** 20 px between sections, 24 px around the content, 12 px between a section
  title and its content. Large gaps (40, 64) only separate the hero from the first
  section and the page from its footer.

### The section (replaces "everything is a card")

A section is a tinted plane: `muted` background, `rounded.section`, padding 20 px 24 px, no
border, no shadow of its own. Its first row holds the title on the left and the section's own
subtotal on the right, like a line of a statement. Rows inside are separated by `border`.

A section never contains another section. A long page is a sequence of sections; the
dashboard alone lays its sections out on a grid the owner arranges (below).

### The dashboard grid

Under the hero, the dashboard's sections sit on a grid of **two widths**: half or full,
20 px apart, one column under 768 px and three tracks from 1 600 px (a half section takes
one track and a full section the whole row, so a statement gains a neighbour rather than a
longer row). It is an ordered list of sections, each with a
width, never a free two-dimensional placement, so the reading order is the focus order.
The stored list is the same at every viewport: the track count only decides how it is drawn,
and no width is ever written because of the screen.

- **Packing (#1325).** Consecutive halves fill a row, two at two tracks and three at three.
  A row that is not full keeps one track per half; a lone half that accepts the full width is
  drawn across the row (its menu says why), and every other leftover track is a free cell:
  blank when reading, a dashed "Place libre" outline per track when editing. A full section,
  and a lone half drawn full, takes the whole row (`col-span-full`). No `grid-auto-flow:
  dense`.
- **Move and drag (#1325).** "Monter" / "Descendre" and the drag are one rule. A full section
  jumps a whole row (a row of two or three halves moves as one); a half swaps with the
  previous or next half in reading order, skipping full sections. The drop takes the menu's
  result and the cards keep the spans they had when the drag began. A phone moves by rows of
  two, as it always did.

- A section takes the full width only if it **shows more** there (the movers: five
  lines on half, ten across two tracks, fifteen across three, in columns of five, the first
  line of each unruled; the allocation: a one-column legend on
  half, the ring and the amounts across the full width, the legend in one column, two from
  1 280 px and three from 1 600 px). A section that would only stretch is
  half-only: the gain breakdown and the investment rhythm.
- The default sections: the allocation, the gain breakdown and the investment rhythm, then
  the movers (half). At three tracks that is three halves and the movers across the row; at
  two, two rows of two. The benchmark waits under "Cartes masquées" on a fresh
  install, without "Nouveau": nothing is new to an owner who arranged nothing. A card that
  arrives later is appended hidden, with "Nouveau", to a layout the owner saved only.
- The investment rhythm's month strip fills the height its row gives it, between 56 and
  160 px, so a section beside a taller one does not read as empty.
- The allocation's account view ends on a link, "Voir les comptes →", to the accounts page.
- The gain breakdown is a statement: four ruled rows and a ruled-off total, like an
  account section. No drawing, no window.
- Two halves share a row and end on one line: the shorter one's last line (a total)
  is pushed to the bottom. A half that accepts the full width and is alone on its
  row is drawn full; a half-only section alone leaves the other half empty.
- A section whose read is in flight holds its place as an empty plane, with nothing
  in it (#795).

**Edit mode** ("Modifier le tableau de bord", a Label link closing the grid, start-aligned,
followed by "· N nouvelles cartes disponibles" when a card is new): the
link's line gives way to a bar opening at the top of the grid, the title "Modifier le tableau de bord" in Section title on
the left, "Réinitialiser" (ghost), "Annuler" (secondary) and "Terminé" (primary) on the
right; under 768 px the bar sticks to the top. Each section's ⋯ menu sits at the end of
its own title row, a 28 px ghost button (44 px on touch), `muted-foreground` turning
`foreground` on hover and focus. On a desktop with a fine pointer, a ⠿ drag handle with
the same look (and `cursor: grab`) sits before the title; dragging follows the menu's
rule (a full section lands between two rows, a half takes another half's place) and
keeps every section's width until the drop. Phones have the menu only. The sections'
content is inert; the hero is neither dimmed nor movable. Hidden sections are listed in
a "Cartes masquées" section under the grid, a chip "Nouveau" on the ones a release
added. The empty half beside a half-only section shows "Place libre" in Label on a 1 px
dashed `border` outline, in edit mode only. Resetting is confirmed in a card (a
destructive confirmation).

An account section reads like a statement and ends with the net:

```
Compte-titres                                        18 902,10 €
Titre               Poids        Détenu   PRU   Valorisation   Latente
...rows...
Valorisation                                       18 902,10 €   +2 443,40 €
Impôt latent, flat tax 30 %                          −733,02 €
Ce qu'il vous resterait                            18 169,08 €
```

### The hero

The portfolio value (decision 1A, #1099), then one line "dont X de liquidités" (drawn
only with a cash ledger), then the total gain on its own line: the arrow and the signed
amount on the Section title rung, coloured by sign, then "de gain total" in `text-sm`
`muted-foreground`. Under it one row of three figures with no ground, no radius and no
padding: gain since 1 January, today, IRR per year, each a muted label and its signed
figure. An absent figure is left out, and with none the row is not drawn. No
net-of-tax line on the dashboard. The time-weighted return, named *Performance*, lives
behind the IRR's `ⓘ`, always with the day it counts from and the sentence that bridges the
two. One performance figure per screen.

Under them, the portfolio's chart across the hero's full width, with its readings and
its range on one control bar: the reading on the left, the legend between, the range on
the right (the French range label is "1ᵉʳ janv."). The real chart, never a decorative sparkline beside a
dialog holding the real one.

No statistics row under the chart: net contributions are the chart's dashed curve, and
the securities are the value less the cash.

### Return figures

Three measures, one name each, in the UI, the docs and the agent: *TRI* / *Money-weighted
return* (per year, since the first deposit), *Performance* (time-weighted, of the
holdings), and *Gain sur l'argent investi* / *Gain on the money invested* (the benchmark's
ratio, not per year). "TWR", "index" and "base 100" are not words for the reader. A return
that does not count from the first deposit states its period in words. Two returns of
opposite signs on one screen carry the sentence that explains them. The *Performance* curve
is in percent from the start of the visible window, never in base 100.

**The other terms, one word each (#1433):**

- *Frais* / *Fee*: the fee on one event (the ledger's column, the event form, an agent
  proposal). *Frais de virement* / *Fees on transfers*: the sum of the fees on deposits
  and withdrawals, the gain's fourth term (the dashboard's breakdown, an account's head).
  A buy's or a sale's fee sits in the cost and the realised gain, never a figure of its own.
- *Aujourd'hui* / *Today*: the day's move, in the hero's row and over the movers.
- *Liquidités* / *cash*: the money an account holds uninvested; never « cash » in French.
- Dates: `2 mars 2026`, the locale's medium form (`1ᵉʳ oct. 2026`), in prose, headings,
  receipts and agent proposals; `02/03/2026` in a table's date column only, where the
  digits line up.
- A security is named by the symbol the owner recorded (`CW8.PA`), beside its name where
  it has one; the movers' badge cuts it to `CW8`. A page names the fund it is about once.
- *Aller au grand livre* / *Go to the ledger*: the one link an empty page offers to the
  ledger.

## Elevation & Depth

Flat. Atelier's shadow opacity is 0, so depth comes from the step between
`background`, `muted` and `card`, not from shadows. Components still carry shadcn's
`shadow-*` utilities (a card `shadow-sm`, a menu `shadow-md`), so a replacement theme's
shadows show. Atelier draws none. No zero-offset glow, in either theme.

## Shapes

- `rounded.section` (18 px): sections.
- `rounded.card` (14 px): cards. A card sits on a section, so 18 − 4 keeps the curves
  concentric.
- `rounded.md` (8 px): buttons, inputs, menus.
- `rounded.full`: chips only.
- In code these are `--radius-section`, `--radius-card` and `--radius-md`, all derived from
  the theme's `--radius`; a mockup uses them and no other radius.
- A dashed `border` outline marks a place where something can be put (a free grid slot, a
  drop zone, the slot for a new account). An empty state is text on its plane, never
  outlined. Marks inside a drawing (a chart's grid and curves, a job hour with no pass)
  are exempt.

## Iconography

- Lucide icons, 16 px in controls and navigation, stroke 2, coloured by the text they sit
  with (`currentColor`). No emoji.
- The navigation's set, one icon per page and reused wherever that page's object appears
  (the palette, the first run): LayoutDashboard (Dashboard), CircleDollarSign (Shares),
  Wallet (Accounts), Database (Ledger), Scale (Benchmark), Sparkles (Agent), Server
  (System), Settings (Settings).
- An icon-only button carries an `aria-label`; a decorative icon is `aria-hidden`.
- The product's mark is drawn in Components › Mark, not from Lucide (#1337).

## Components

- **Section:** see Layout. No hover state; the section itself is not interactive. In
  the dashboard's edit mode its title row carries the ⋯ menu (see The dashboard grid).
- **Card:** `card`, `rounded.card`, 14 px padding. Allowed only for something the
  user decides (an agent proposal, a profile fact to confirm, a first-run step, a
  destructive confirmation) or selects (an account tile). Never a card inside a card.
  A decided proposal loses its buttons **and its frame**: one status line (decision 5A).
- **Weight bar:** a 6 px `muted-foreground` bar with its percentage in Label, inside holding
  rows and in a legend drawn without a ring (the dashboard's allocation at half width). In
  an account's own rows it takes the account's identity hue.
- **Chart axes (#1265):** the dashboard's chart, an account's curve and the benchmark chart draw their scale: three to five value ticks on a 1, 2, 2.5 or 5 step (amounts in compact currency, `17,5 k€`; returns in percent without trailing zeros, `+20 %`), and time ticks on calendar boundaries, the finest of days, weeks, months or years that fits (a January written as its year). Ticks are Label size, `muted-foreground`, tabular numerals; no axis line, no tick mark; the dashed `border` grid sits on the value ticks. Under 768 px the time ticks thin to four, never to none. The axis gives the scale, the tooltip and the reading give the figure.
- **Buttons:** primary (filled `primary`), secondary (outlined `border`), both 32 px high,
  44 px on touch. Focus-visible: 2 px `primary` ring, 2 px offset. Disabled: 50 %
  opacity, no pointer events, the reason given in text next to it. A submit disabled only
  because its own field is empty needs no sentence: the field's placeholder says what to enter.
- **Chips (agent profile facts):** outlined, Label size; each opens a popover with
  the value, its confirmation date, "Modifier" and "Oublier" (decision 13A).
- **Agent page:** `/agent` and `/agent/<thread>`. Header: the provider and model;
  "Nouveau fil" and "Fils récents" head the `muted` thread rail (a `border` on its right, no radius) from 1 024 px, and are
  the header's buttons below. Tool calls are one muted shadcn `trace` line in plain
  words, shimmering while the call runs; its chevron opens the raw call in a `code-block`, its JSON
  coloured by shiki (2A). The CIF line "Simulations à partir de vos données
  déclarées, pas un conseil en investissement." stays fixed under the input (3A).
  States follow decision 4A. The conversation is the page's `<main>` content, its
  `<h1>` and document title "Agent"; answers announced once complete (11A), the
  announcement ending on the facts to confirm when the turn proposed some. An assistant turn
  reads trace lines, then the answer, then its proposal cards (a proposal call keeps its trace
  line). While a turn streams, one thing moves at a time: a running tool line, the pending
  line "Préparation de la réponse…" (a running trace line, no chevron), or the growing text.
- **PIN screen and Accès block (#1203):** the PIN screen is a single 360 px column on a
  `muted` plane (`rounded.section`, no border, no shadow) centred on `background`: the product
  name in Label `muted-foreground`, the heading "Entrez votre code" in Section title, six 44 px
  slots (`card`, 1 px `border`, `rounded.md`, a dot for a filled slot) in one real
  numeric input, and a full-width 44 px primary "Déverrouiller". The code is sent at the
  sixth digit; a wrong code clears the slots and says so in `destructive`; a throttled
  wait counts down from `Retry-After`, announced at its start and end only. "Code
  oublié ?" is a collapsible naming `SB_RESET_AUTH`. Under 768 px there is no plane: the
  column sits on the background, 14 px gutter, in the top third; under 340 px the slot gap
  narrows to 4 px. A session that ends inside the app opens the same form in a modal,
  non-dismissable dialog over the mounted page. The *Accès* settings section carries a
  `Switch` in its title row that flips only once its card's action succeeds; with the PIN
  on, three `border`-separated rows (Code, Jeton MCP, Cet appareil) each open a `card`
  card under them, one at a time, Escape closing it — except the token card, which only
  "J'ai copié le jeton" closes.
- **Mark (#1337):** a 28 px `sidebar-primary` tile, its corners 8/28 of its side (the buttons' `md` at 28 px, scaling with the mark), where the value (a solid line
  ending on a dot) rises away from the net contributions (dotted, 60 %), both strokes in
  `sidebar-primary-foreground`: the dashboard chart in one gesture, the gap between the two
  being the wealth built. It owns no colour, so a replacement theme repaints it. Under 24 px
  the strokes thicken and the contributions become a faint solid line (45 %), dots not
  reading there. It heads the sidebar beside the wordmark ("SuiviBourse", Term rung) and
  stands alone in the folded 64 px rail. The favicon (`favicon.svg`, 32 px and 180 px PNGs)
  is drawn from the small variant; a tab reads no CSS variable, so it keeps Atelier's ink
  (with a dark variant in an `@media (prefers-color-scheme: dark)`, which follows the operating
  system's scheme, not the browser's tab bar or the app's own) and does not follow an imported
  theme.
- **Browser surfaces:** selection colour is `primary` at 25 %; caret and focus rings
  are `primary`; scrollbars are thin and use `border`.

## States

Every block ships its four states:

- **Nominal.**
- **In flight:** the block holds its place as an empty plane, with nothing in it (#795).
- **Empty:** an `EmptyState`, a title, why, and **one** action, as text on its plane
  (never outlined).
- **Failed:** « Lecture impossible » where the content would have been, never a band; the
  outage toast echoes the bell.

Figures from a failed recompute carry one `StaleFigures` sentence above the page. A
refused write shows a `Refusal` beside its button and keeps what was typed.

## Do's and Don'ts

- Do keep one hero figure per screen and one performance figure (IRR) visible.
- Do end every account section with the tax line and "Ce qu'il vous resterait".
- Do set every figure, in a table or not, in Geist with tabular numerals; Geist Mono is
  for tickers and account ids (#1281).
- Do give every new component its empty, loading and error states before it ships.
- Don't put a card on a page for anything the user does not decide or select.
- Don't nest a section in a section or a card in a card.
- Don't colour a row, a pill or a tile with `gain` or `loss`; colour the figure.
- Don't use uppercase letter-spaced overlines or a kicker above a heading.
- Don't go back to cream with a serif display (the category's generic look), and don't
  give Atelier's tokens shadows for depth (component `shadow-*` classes are fine).

## Motion

- **Approach:** minimal-functional.
- **Easing:** enter ease-out, exit ease-in, move ease-in-out.
- **Duration:** micro 80 ms, short 200 ms, medium 300 ms.
- **The one authored moment:** the hero value recomposes from the old value to
  the new one (250 ms, ease-out). One movement, two triggers: a merged proposal
  and a refreshed value (the figures poll every minute, #1180). A change under
  0.1 % of the value is instant, so the cents do not twitch all day. Nothing
  else animates on entry: the pills change instantly. `prefers-reduced-motion`
  turns it into an instant change.
- **Dragging a dashboard section:** only the gesture moves; the other sections slide to
  their new place (short, ease-in-out), and not at all under `prefers-reduced-motion`.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-10 | Initial design system created ("Atelier") | Created by /design-consultation from the 5.3 design doc, the staging audit of 2026-10-09, and research on Wealthfolio, Kubera and Sharesight. Chosen over "Le relevé" (judged too austere) and "Instrument" (too dense for the non-technical users the agent targets). |
| 2026-10-10 | Keep Geist and Geist Mono, keep #838 | Already shipped and self-hosted; the figure is the display voice. |
| 2026-10-10 | Warm neutrals replace the cool ones | Serves "Enfin mes vrais chiffres" with a calmer, less clinical surface. |
| 2026-10-10 | Sections are tinted planes; cards only for decisions and selections | Resolves point 8C of the 5.3 design review (no stacked cards). |
| 2026-10-10 | Net-of-tax line under the hero, value stays the hero | Keeps decision 1A and #1099 while showing the product's argument first. |
| 2026-10-10 | Semantic tokens are aliases; the theme is replaceable (#1130) | Gain becomes `primary` and loss `destructive` so any tweakcn theme repaints the app; attention loses its hue and the icon carries the meaning. |
| 2026-10-11 | The dashboard is a grid of sections the owner arranges | Two widths, an ordered list rather than a 2D grid; full width only where a section shows more; the menu in the title row; designed through office hours, eng and design reviews on 11/10/2026. |
| 2026-10-11 | The hero draws the real chart, full width | Reverses the sparkline-and-dialog of #1099 (direction 1a): one chart, readable by everyone, instead of a large mute picture plus a dialog. |
| 2026-10-12 | The IRR is the third pill; the year-to-date gain moves to the statistics row (#1149) | Keeps the one performance figure next to the value on a phone; no figure leaves the page. |
| 2026-10-12 | The statistics row names the cash, one column per figure (#1151) | `Titres` + `Liquidités` is the value to the cent, so the gap under the hero has a name; a missing figure shrinks the row instead of leaving an empty quarter. |
| 2026-10-12 | Strategy, not tax, is the subject; the hero is lightened (#1174) | Reverses the 2026-10-10 « Net-of-tax line under the hero » row, the year-to-date half of the #1149 row and the #1151 statistics row: the cash is a line under the value, the year-to-date a pill, and the stat row repeated what the chart already draws. |
| 2026-10-12 | The hero recomposes on a refreshed value too (#1180) | The figures poll every minute; one movement with two triggers (a merged proposal, a refreshed value), at or above 0.1 % of the value, rather than a second animation. No refresh indicator: the header's quote date already moves. |
| 2026-10-12 | Colour only the terms that can change sign | Dividends and transfer fees have a fixed sign, so colouring it carries no information and steals the signal from a realised loss; the bar follows the same rule (#1144). |
| 2026-10-12 | Gain breakdown is a statement (#1175) | Reverses the cascade (#1143/#1161) and the in-card window (#1156/#1173): with four terms the figures are the content, the bars read as progress bars, and the year-to-date gain has its own pill. |
| 2026-10-14 | The agent is a page, `/agent`, not a side panel (#1196) | Docked at 380 px the panel left a 13" laptop about 840 px of the 1 040 the content is designed for, and charts and tables broke; it bought one line of context (the route) that the agent reads through its tools anyway. Its user-facing name becomes "Agent", the same word in both languages. |
| 2026-10-15 | The agent's threads are a full-height rail, the conversation centred at 768 px | The staging audit of /agent: the 720 px conversation pinned beside a floating column left about 170 px empty on the right of a 1 440 px screen, and filling that width ran lines past 110 characters. Chosen by the owner over a full-width conversation and over a centred floating column, after the pattern of the chat apps. |
| 2026-10-16 | Tool calls are shadcn Trace lines, the raw call a Code Block | Chosen by the owner when shadcn shipped Trace and Code Block for agentic interfaces (October 2026): the chevron replaces the word "détail", a running call shimmers (not under `prefers-reduced-motion`), the panel opens with the collapsible's short slide, and the JSON is coloured by shiki (github-light/dark, loaded on the first opening). |
| 2026-10-16 | An optional PIN behind one screen, off by default (#1203) | The app is reached on a local network by anyone who can reach the port; the PIN closes that door without a login page of accounts and passwords. One centred column rather than a card on a card, and the in-app 401 is a dialog over the page so a typed form survives it. |
| 2026-10-16 | A job's failed pass colours its history bar (#1236) | The System page draws each job's last 24 hours, one bar an hour; telling a job that failed once from one failing since yesterday is the whole point, so the error owns `destructive` there, always doubled by a glyph. |
| 2026-10-16 | The theme is a JSON in the store, edited in Settings (#1248) | Replaces `SB_TWEAKCN_THEME`: no restart to change it, tweakcn reached only on an explicit import, and pasting the JSON serves an instance with no way out. |
| 2026-10-18 | The charts draw their scale (#1265) | Without axes, the scale, the origin and the month of a step were a hover away (audit of 17/10). Ticks computed by the app rather than Recharts, whose nice ticks graduated −35 %, 35 %, 70 % or stretched the domain; compact euros so the axis stays narrow on a phone; no axis line, so `rule` stays the only line in a section. |
| 2026-10-18 | Return figures reconciled (#1263) | Four figures audited against an independent recomputation: no calculation bug. One name per measure; windows stated rather than aligned; the TWR dated in the IRR's bubble; the agent says the same words. Percent replaces base 100 on the Performance curve (#1263, #1265). |
| 2026-10-18 | The Performance curve is coloured by its sign (#1263) | The one curve that crosses zero: drawn in `foreground` it fell outside the palette, drawn in the mint it painted a loss as a gain. `gain` above zero, `loss` below, the 0 % line kept as the colour-free channel. |
| 2026-10-18 | Atelier is a JSON in the repo, no longer a published tweakcn theme (#1295) | A colour change was a republish on tweakcn outside the repo, unreviewable; it is now a reviewed diff of `atelier.json`, rendered into `index.css` by the same function that renders a stored theme. |
| 2026-10-18 | One layout system for the shell (#1276) | Three choices made by the owner: the page title stays in the header bar on the Figure rung (over moving it into the content or keeping it at 20 px); language, theme and density move to Settings › On this device (over a header menu or table toolbars); a statement gains a third grid track from 1 600 px (over a page bounded at 1 280 px). Also: the sidebar goes back to the 200 px this file always said; the ledger joins the pages the owner reads, and the foot keeps the administration; one 1 040 px cap gives way to a width per kind of content, because a cap starves tables while a statement stretched to 800 px stops reading as a statement. |
| 2026-10-18 | The page title goes quiet (supersedes the title rung of #1276) | Seen on screen, a 28 px title in a 56 px bar filled the bar, stacked a second display size 60 px above the hero, and stranded its 12 px subtitle. The owner chose the quiet bar: 15/22 at 500, the subtitle after a `·`. |
| 2026-10-18 | Gain leaves the primary; action becomes ink (#1283) | The 17/10 audit found the mint on buttons, the current nav item, links, the first account, the eight allocation stops and every gain: a green figure read as a link and a green button as a gain. `--gain` moves to `chart-2`, which nothing else reads and which differs from `primary` on 14 of 16 stock tweakcn theme/ground pairs, against 0 of 16 when it is `primary`. Atelier's `primary` becomes a warm ink. The allocation and the account identities take the other chart hues, measured in CI. Amends the 2026-10-10 row "Semantic tokens are aliases": its alias rule stands, its `gain → primary` does not. |
| 2026-10-19 | The Benchmark page states its period and its reference first; a shortfall is not a loss (#1282) | The period was an orphan line and the picker sat in the chart's corner while the whole page depends on it. The period joins the header subtitle like « Cours au … », and the picker becomes the first row, since the bar is closed to controls. A gap behind the reference drawn in 60 px red read as money lost; it is money not made, so the gap takes no sign colour anywhere, and the returns, which are gains or losses, keep theirs. |
| 2026-10-19 | The accounts page reads like the dashboard's head (#1277) | The left rail was mostly empty while the detail scrolled, and the detail's rows were ragged (*Latest events* took half a row when no line paid a dividend). Three choices: the accounts become a sticky bar of chips over the detail at every width, chosen by the owner after comparing both mockups, and the rail is removed; the secondary figures are one row, *Dividends received · Fees paid · Projected tax* (the tax only with a declared model), *Composition* goes and the cash becomes a line under the hero, as on the dashboard (#1174); every row of the detail is shared equally by the blocks present, so an absent block gives its share to the others. The head leaves its card for the ground, and the detail keeps one card, the reassignment, because it asks for a decision. |
| 2026-10-19 | The agent's proposals come under the answer, and the wait is a line (#1271) | The server already streamed each word; the page drew nothing while the model read a tool result, thought or wrote its proposals (4 to 13 s), and drew each card where its call sat, above the answer that says nothing is saved until confirmed. Cards go after the text, the call keeps its trace line; a pending line fills the gap, so a single thing moves at a time; a decided proposal loses its frame (supersedes the card of 5A). |
| 2026-10-20 | Figures in tables are Geist with tabular numerals (#1281) | The owner's choice, reversing the table half of #838: a column of amounts reads as a column through tabular numerals, and Geist Mono set on every cell read like a terminal. Geist Mono stays for tickers and account ids. The Shares page also draws its allocation once (bars, in a section), moves its toggle into a toolbar above the table, and ends the table on a total row. |
| 2026-10-20 | The dashboard's composition (#1280) | Seen on screen, four equal pills read as filter chips and the total gain weighed no more than today's move: it takes its own line, the other three become a plain row. The chart's reading, legend and range share one bar; the edit link closes the grid; the rhythm's strip fills its row. A fresh install now shows the allocation and keeps the benchmark hidden without "Nouveau" (a `hiddenByDefault` flag, apart from `arrivesHidden`, which concerns saved layouts only); the movers go half. Saved layouts are untouched. Three-track packing is #1325. |
| 2026-10-20 | Tables sit on the page background; the Benchmark head sits on the ground; markers merge (#1273) | Seen on screen, the Shares and Ledger tables in a white bordered card, the Benchmark head, chart and rebuild status in cards, and the share sheet's three gain terms in boxes broke the rule that a card is for a decision. The owner's choices: a page's own table has no plane and no frame (the closed shares become a disclosure row under the total); the Benchmark head reads like the dashboard's, on the ground, with its chart, rebuild status and per-account table as sections; the sheet's terms are a row of Label over figure. Days that land on one plotted point, or within 0.04 of the plot, share one marker whose click selects the lines of all its days. `lint/card-for-decisions.grit` keeps the `Card` for decisions. |
| 2026-10-20 | Four figure rungs, a dashed outline for a place to put something, dark neutrals pinned (#1284) | The re-audit still counted six standalone figure sizes and figures in Geist Mono. Hero 60, Figure 28, Section title 20 (`Stat`'s `stat` moves from 19) and a named Term 16 are the whole ladder; a figure inside a line takes its line's size. A dashed outline meant both "empty" and "put something here": the empty state loses its border. The dark neutrals already matched the warm values above (within 0.005 ΔE_ok), so the tokens stay and CI now checks every colour on both grounds, with a warmth threshold on the dark ones. |
| 2026-10-28 | DESIGN.md speaks the tokens' names and states what the design system said alone (#1436) | The UX/UI review of the Design canvas found DESIGN.md, the design system README and the canvas disagreeing. The colours take the shadcn names `atelier.json` uses, with `atelier.json`'s values, plus `input`, `accent`, `destructive` and the chart hues; the radii and the section gap take the tokens' names (`rounded.md` was 14 px here and 8 px in the tokens); the `mono` rung becomes `ticker` (11/16) and the ladder gains `table` (13/18), both already in the app; the accounts head loses its pills, as the dashboard did in #1280; *Content*, *Iconography* and *States* come over from the design system README; a page-name glossary and a 3:1 rule for marks in a drawing are added. The decisions #1436 lists (the mark, the account statement, the pill radius, the Settings anatomy against #1279, the field border's contrast) are left to the owner. |
| 2026-10-29 | The product's mark: the value rising away from the contributions (#1337) | The letter in a tile read like a starter template. The drawing reuses the one image the app already has, the dashboard chart (value over contributions), chosen over a monogram or rising bars; it takes the sidebar's tokens so a theme repaints it. The favicon is the one copy that cannot follow a theme and keeps Atelier's ink. |
| 2026-10-30 | The dashboard's third track (#1325) | Packing, move and drag rules for three tracks: consecutive halves fill rows of three; a lone half that accepts the full width is drawn across the row, other leftover tracks are free cells ("Place libre" in edit mode, one outline per track); a full section takes the whole row and jumps a whole row when moved; the stored list and `LAYOUT_VERSION` are untouched. The default order becomes allocation, gain breakdown, rhythm, movers, so three tracks show three halves then the movers across the row (saved layouts are untouched). The movers show fifteen lines in columns of five across three tracks, the allocation's legend a third column. |
