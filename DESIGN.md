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
    fontFamily: Geist Mono
    fontWeight: 500
    fontSize: 56px
    lineHeight: 1.05
    letterSpacing: -0.02em
  figure:
    fontFamily: Geist Mono
    fontWeight: 500
    fontSize: 28px
    lineHeight: 32px
  statement:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 28px
    lineHeight: 34px
    letterSpacing: -0.01em
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
  mono:
    fontFamily: Geist Mono
    fontVariantNumeric: tabular-nums
    wordSpacing: -0.32em
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
    height: 32px
    heightInForm: 36px
  button-secondary:
    borderColor: "{colors.border}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: 32px
    heightInForm: 36px
  sheet:
    width: 460px
  dialog:
    width: 440px
    rounded: 14px
  popover:
    rounded: 14px
  agent-thread-column:
    backgroundColor: "{colors.muted}"
    width: 240px
  sidebar:
    width: 200px
  content-column:
    maxWidth: 720px
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

**Direction since November 2026: « Relevé ».** Atelier's warm planes stay; what changes is
the voice of the figures and the economy of the page. Every figure is set in Geist Mono with
tabular numerals, like a bank statement; tables and lists sit on the ground, separated by
1 px `border` rules; text tabs replace segmented controls; one filled button per screen;
and the copy follows one rule, **« l'état, pas l'explication »**: a screen states what is,
it does not explain itself. The mockups are the *Refonte* page of the Design canvas
(`docs/refonte/mockups/`), one row per page of the navigation.

**Key characteristics:**
- The value is the hero in mono, then its variation over the chart's period, then the
  total gain on one line with the net contribution; the figures on the right are the first
  deposit, the cash and the net if everything were sold today.
- Sections are warm tinted planes, never boxes; Atelier carries no shadow, floating
  surfaces neither.
- Cards exist only where you decide something; a destructive decision is a centred dialog.
- Colour means something: ink for action, mint for money made, red for money lost, and the
  chart hues to tell the parts of a drawing apart.
- No supporting text, no page subtitle that is not a dated fact, no help sentence, no ⓘ,
  no pill, no arrow glyph but the « ← » of a back link.

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
  The glossary (November 2026): a **titre** is the instrument, a **ligne** is what the
  owner holds of it (never « position ») ; **grand livre**, never « registre » ; a
  **compte** has an **identifiant** (short, shown in the ledger and the imports), an
  optional **libellé** and a **modèle d'imposition** — it has no type ; **Libellé** names
  anything the owner names, never « Nom » ; **prix moyen d'achat**, never « PRU » ;
  **Comparaison** is the page that compares the portfolio with a fund (formerly
  *Référence*) ; the background jobs are **Mise à jour des cours**, **Reconstruction de
  l'historique**, **Calcul de la performance**, **Relecture du grand livre** ; a
  **relevé** is a broker's file one imports ; **jeton d'accès** is an API/MCP token and
  **tokens** are what a language model counts. Creating is **Ajouter X** (« Ajouter un
  compte », « Ajouter un fonds », « Ajouter un fournisseur »), except « Saisir un événement »
  and « Importer un relevé ». A period selector speaks in words: « 1 mois · Cette année ·
  1 an · Tout ».
- **« L'état, pas l'explication ».** A page title is fixed (« Système », never « Un titre à
  vérifier ») ; the header's subtitle is a dated fact (« Cours au 6 nov. 2026, 17:35 »,
  « Comparé du … au … ») or nothing ; a section has no subtitle unless it names a period or
  an active filter ; no sentence tells the reader what a control does or what will happen.
  The exceptions, all of them: the effect line under an event form (« 450,00 € arrivent sur
  le PEA · liquidités 1 490,00 € »), the one-line « Irréversible. … » of a destructive
  dialog, the sentence that says what is sent to an LLM provider, and the one-clause
  description with its default under each *Avancé* setting.
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
  surface with its foreground, a hover held down. A link is `foreground`, underlined (offset 4) at rest; a text action is
  `muted-foreground` underlined in `border`. A weight bar is `muted-foreground`.
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
  `foreground`, a ledger type is a word in `muted-foreground`, a job that ran well is a
  `muted-foreground` tick in its strip.
- A semantic token (`--gain`, `--loss`, `--price`, `--attention`, `--alloc-*`…) is
  always an alias of a standard shadcn token, never a value of its own
  (`lint/semantic-token-alias.grit`, #1130).
- The theme is replaceable: its tokens are a JSON kept in the store and edited in
  Settings › Thème, imported from tweakcn by id or pasted from
  `tweakcn.com/r/themes/<id>`. The server lays its colours, fonts, radius and shadows
  over Atelier; with nothing stored, Atelier is served. Atelier itself is
  `src/web/src/theme/atelier.json`, the same JSON as a stored theme; block 1 of
  `index.css` is generated from it by `scripts/sync_atelier.py`.
  Settings › Thème is closed at rest (the two palettes as swatch strips and a **Modifier**
  button) and opens in place as a form: 16 colours in three groups, then radius, shadows,
  letter spacing and the text and code fonts. Every change is previewed over the whole app
  through one `<style id="theme-preview">`; nothing is saved until **Appliquer**, and leaving
  with edits asks. A figure is always Geist with tabular numerals, so there is no figure-font
  field: the second font is the code face (`font-mono`). The tweakcn import and the JSON
  are dialogs, hidden while the form is open.

## Typography

Geist and Geist Mono stay. They are already self-hosted through `@fontsource-variable`
and used everywhere. Geist is on the list of overused display faces; we accept it
because in this app the display voice is the figure, not the font, and replacing a
shipped face would cost every screen for no reader benefit.

**Every figure is Geist Mono** (« Relevé », November 2026, reversing #1281 and the figure
half of #838): amounts, percentages, quantities, dates in a table column, times, versions,
identifiers. The mono class carries `font-variant-numeric: tabular-nums` and
`word-spacing: -0.32em`, so the thin spaces of `42 658,79 €` close up; a figure never wraps.
A figure inside a sentence is mono too, at the sentence's size. Words stay in Geist.

- **Hero (56 px fluid from 36, Geist Mono 500, −0.02em, line-height 1.05):** the one
  figure a screen leads with. One per screen.
- **Statement (28/34, Geist 600, −0.01em):** the one sentence a screen leads with when the
  answer is a sentence, not a figure (Comparaison: « 837,20 € de moins qu'en plaçant le même
  argent dans le MSCI World. »). Its figures are mono at the same size. Hero and Statement
  never share a screen.
- **Figure (28/32, Geist Mono 500):** a secondary figure that stands alone (an account's
  value, a section's own total).
- **Page title (15/22, 500):** the page's `<h1>`, in the header bar, fixed, followed by a
  dated subtitle in Label-muted after a `·` or by nothing.
- **Section title (20/28, 600):** sentence case.
- **Prose (15/22):** the agent's answers.
- **Body (14/20):** controls, labels, row names.
- **Table (13/18):** cells, dense lists, secondary rows, filters, text actions.
- **Label (12/16, 500):** field labels and column headers, `muted-foreground`, never
  letter-spaced.
- **Mono:** not a size but a face; the rung above says which size.

These rungs are the whole ladder: a size that is not one of them is a bug, in the app
and in a mockup alike.

## Layout

- **The shell:** a 200 px navigation (a 64 px rail when folded, a drawer under 768 px), then a 56 px header bar holding, in order, the fold, the page title with its dated subtitle or nothing, the search (⌘K) and the bell. Nothing else lives in the bar.
- **Navigation:** two groups and no group label. The top holds what the owner reads and records: Tableau de bord, Titres, Comptes, Grand livre, Comparaison, Agent. The foot holds the administration: Système, Réglages. Journal is reached from Système › Installation, Statistiques from the agent's rail, Thème from Réglages › Affichage; each is a page with its own title and a « ← Parent » text link on its first line.
- **The page's envelope** is `32px 32px 56px` of padding on every page. The first line of the content is the page's control line: on the left the tabs, the back link or the file name; on the right the page's actions (outline buttons, then the one filled button). A table page's filters share that line or the one under it. Page actions never get a row of their own.
- **Content width is set per kind of content:** a table or a chart takes the full width; a form is a 460 px sheet on the right; Réglages takes the full width, each section a `220px | 1fr` grid inside its plane; the agent's conversation is centred at 768 px; a paragraph keeps 65 characters.
- **Tables sit on the ground**, with no plane and no frame: a header row in Label, `border` rules under every row including the last, totals as the last row. Row heights: 40 px for one line of text, 48 px for a name with a sub-line and for totals. Figures right-aligned in mono. A sortable column is `foreground` 500 with `aria-sort`, no glyph. A clickable row underlines its name on hover (offset 4); no row background, no chevron.
- **Lists inside a setting** (tokens, funds, tax models, providers, notification channels) are ruled rows directly in the section's plane under their name, ending on a « + Ajouter … » text row. Never a nested plane.
- **A table page has no side panel**: its filters are text buttons on the control line (`muted-foreground`, 13 px, the chosen value in `foreground`, a ChevronDown 14 px), its selection's actions appear only with a selection.
- **< 768 px:** single column; the Titres table becomes a ruled list; the sheets take the full width.
- **Rhythm:** 20 px between sections, 12 px between a section title and its content.

### The section

A section is a tinted plane: `muted` background, `rounded.section`, padding 20 px 24 px 24 px,
no border, no shadow. Its first row holds the title on the left and, on the right, only a
period or an active filter (« 12 derniers mois », « Dernières 24 h ») — never a figure that
repeats the content, never a sentence. Rows inside are separated by `border`. A section never
contains another section or a card. Réglages uses the same plane, its title in the 220 px
gutter.

### The dashboard

The dashboard is fixed (decision of 7 November 2026): no arrangeable grid, no edit mode, no
hidden cards, no widths to choose. Its layout is the hero, the chart, then two half sections,
*Rythme d'investissement* and *Valeur des titres*. *Mouvements* left the dashboard: the day's
move reads in Titres, under the price. *Répartition* became *Valeur des titres*: the top four
lines and « N autres lignes », no account view.

### The hero

« Valeur du portefeuille » in Body-muted, the value in Hero mono, and under it the variation
over the chart's period in mono, coloured by sign: « +5 021,10 € (+11,6 %) depuis un an ». On
the right, a three-row statement in Label over mono: *Premier versement*, *Liquidités*, *Net
si tout vendu* (the net of the estimated tax of the accounts that carry a model; the accounts
without one count gross). Under them a 10 px two-colour bar, then one line: *Versé net*, *Gain
total* (signed, coloured, with its percentage) on the left, *TRI x % par an* alone on the
right. The chart follows, full width, with its two readings (Montants · Performance) as text
tabs on the left and the period as a segmented control in words on the right; the variation
line and the chart share that period.

The **gain total** of the hero is the one official gain of the app: latent + realised +
dividends − fees, over the net contribution. Every other gain figure names its base beside it
(« Plus-value des titres … · hors dividendes et liquidités » on Titres; « titres seuls » where
the cash is excluded), and no screen shows two percentages of the same thing.

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
- Dates: `6 nov. 2026`, the locale's medium form (`1ᵉʳ oct. 2026`), everywhere, tables
  included (in mono the digits line up anyway); date and time as `6 nov. 2026, 09:14`;
  a time alone as `17:35`. Never `06/11/2026`.
- A security is named by the symbol the owner recorded (`CW8.PA`) in mono 500, with its
  name under it in Table-muted — on Titres, in Système's list of followed titles, in an
  import preview alike. In the ledger the name leads and « CW8 · libellé du courtier » is
  the sub-line. A page names the fund it is about once.
- *Aller au grand livre* / *Go to the ledger*: the one link an empty page offers to the
  ledger. The ledger's first-import state is not an empty state but `EntryPair`: two doors,
  one gesture each (the file picker; *Saisir un événement*), plus a quiet docs link.

## Elevation & Depth

Flat. Atelier's shadow opacity is 0, so depth comes from the step between
`background`, `muted` and `card`, not from shadows. Floating surfaces (the ⌘K palette, a
dialog, the notifications popover, a picker) are `background` with a 1 px `border` and a
14 px radius, and draw no shadow of their own either. Components still carry shadcn's
`shadow-*` utilities so a replacement theme's shadows show. No zero-offset glow.

## Shapes

- `rounded.section` (18 px): sections.
- `rounded.card` (14 px): cards, and every floating surface (dialog, popover, palette).
- `rounded.md` (8 px): buttons, inputs, menus, the code block of a token snippet.
- `rounded.full`: nothing in the Relevé direction — there are no pills and no chips. A
  type or a status is a word in `muted-foreground`.
- In code these are `--radius-section`, `--radius-card` and `--radius-md`, all derived from
  the theme's `--radius`; a mockup uses them and no other radius.
- A dashed `border` outline marks a place where something can be put (a free grid slot, a
  drop zone, the slot for a new account). An empty state is text on its plane, never
  outlined. Marks inside a drawing (a chart's grid and curves, a job hour with no pass)
  are exempt.

## Iconography

- Lucide icons, 16 px in a button, a field, the search and the navigation; 14 px inside a
  13 px line of text (a filter's ChevronDown, a disclosure's ChevronRight, the
  TriangleAlert of a title to check); stroke 2, `currentColor`. No emoji, no ⓘ, no arrow
  glyph in text except the « ← » of a back link and the ↑ of the agent's send button.
- The navigation's set, one icon per page and reused wherever that page's object appears
  (the palette, the first run): LayoutDashboard (Dashboard), CircleDollarSign (Shares),
  Wallet (Accounts), Database (Ledger), Scale (Benchmark), Sparkles (Agent), Server
  (System), Settings (Settings).
- An icon-only button carries an `aria-label`; a decorative icon is `aria-hidden`.
- The product's mark is drawn in Components › Mark, not from Lucide (#1337).

## Components

- **Section:** see Layout. Not interactive.
- **Card:** `card`, `rounded.card`, 14 px padding. Allowed only for something the user
  decides (an agent proposal, a first-run step). Never a card inside a card or a section.
- **Buttons:** on a page, 32 px high, 13/500, padding 0 12, `rounded.md`; in a sheet, a
  dialog or the first run, 36 px, 14/500, padding 0 14. Outline (`border`, transparent) for
  every secondary action; **one filled `primary` button per screen**; `destructive` filled
  only in a destructive dialog, where it replaces the ink. A button carries no icon except
  Importer (Upload), Exporter / Télécharger (Download) and « + Ajouter » rows (Plus), all
  16 px. No ghost buttons on a page.
- **Text action (`.act`):** an action on a row or in a footer that is not the row's main
  one — « Modifier », « Régénérer », « Révoquer », « Journal », « Tout marquer lu » —
  is a 13 px `muted-foreground` link, underlined (offset 3, `border` colour),
  `foreground` on hover. One action per row at most; a row with nothing to do has none.
- **Text tabs:** on a page, 15/22/500, gap 24, a 2 px `foreground` underline on the active
  one sitting on the container's 1 px `border`; in a sheet, 14/20, gap 18, active 500,
  inactive 400. They choose a view (Montants · Performance, Écart · Montants, Tout ·
  Avertissements · Erreurs) or a type (Achat · Vente · Dividende…). No segmented control
  except the chart's period and a setting's values (Verrouillage automatique, Apparence).
- **Filter:** a text button, 13 px `muted-foreground`, value only (« Tous les comptes »,
  « 7 derniers jours »), ChevronDown 14 px; the chosen value in `foreground`. Opens a
  listbox popover (`background`, `border`, radius 14, no shadow) with a search field when
  the list is long (the fund picker).
- **Search field:** a framed `input` (1 px `input` border, `rounded.md`), 32 px on a page,
  36 px in a sheet, Search icon inside, placeholder « Rechercher ». Never an underline.
- **Fields (`.fld` / `.lbl`):** label 12/16/500 `muted-foreground`, field 36 px, `input`
  border, `rounded.md`; an optional field says « Libellé · facultatif » with the suffix in
  400; a date field shows `6 nov. 2026` in mono with CalendarDays 16 px; a select shows its
  value with ChevronDown 16 px.
- **Sheet (side panel):** 460 px, full height, `border-left`; header 20/28/600 + X;
  body `gap 24`, `overflow-y: auto`; footer with the destructive text link on the left
  (« Supprimer ce compte »), then Annuler and the filled button. Title « Modifier X » in
  edition, the creating verb otherwise. The event sheet ends its body on the effect line.
- **Destructive dialog:** centred, 440 px, radius 14, `border`, no shadow: a question as
  title (« Purger 2 historiques ? »), a ruled list of what goes (key in Geist, value in
  mono muted), one line « Irréversible. … » or « Immédiat. … », Annuler and a filled
  `destructive` button carrying the verb. Used for purging histories, deleting a thread, an
  event, an account, revoking a token.
- **Notifications (the bell):** a 400 px popover under the bell, radius 14, no shadow. It
  holds only what concerns the owner's figures, in plain French: a late price (« Le cours
  d'Amundi PEA Nasdaq-100 n'a pas bougé depuis 16:25 · la valeur affichée peut être
  légèrement en retard »), a finished import, an installed update. TriangleAlert 14 px on
  the ones to look at, read ones in `muted-foreground`, time in mono on the right, « Tout
  marquer lu » in the header, « L'état des tâches est dans Système » in the footer.
  Technical facts (series rebuilt, orphans, tokens) never reach the bell.
- **⌘K palette:** centred, 600 px, radius 14: a 16 px search line with `esc`, groups in
  Label (Titres, Événements, Fils de l'agent; or Récents, Actions, Pages), rows 40 px with
  a 16 px lucide icon (the sidebar's for a page), the match in 600, a sub-line in Table-muted,
  the amount in mono on the right. No « G puis X » navigation shortcuts; « Verrouiller » locks. « Rien pour « x » » when empty.
- **Chart axes (#1265):** unchanged: three to five value ticks, compact euros, dashed
  `border` grid, Label mono ticks, no axis line.
- **Agent page:** a 240 px `muted` rail (« Nouveau fil ⌘N », search, threads grouped by
  day, « Statistiques » at the foot), the conversation centred at 768 px. The user's turn
  has no bubble. A trace is a `<details>` line; hypotheses are a line of underlined values
  the owner can change; proposals come under the answer as ruled rows with a checkbox, a
  duplicate unchecked and marked « déjà dans le grand livre »; one filled button « Ajouter
  N événements ». The composer is a plane with « Joindre un relevé », « @ une ligne ou un
  compte », the provider · model picker and the ↑ send button, which never turns
  `primary`. Under it, fixed: « Simulations à partir de vos données, jamais un conseil.
  Vos chiffres sont envoyés à {fournisseur}. » (« restent sur ce serveur » only when the
  provider's host is local). *Statistiques* is a page: a hero of tokens exchanged, a cache /
  new / output bar, weekly stacked bars, Par modèle and Par fil tables; no price.
- **Réglages:** sections Sécurité, Portefeuille, Agent, Notifications, Affichage, Avancé,
  each a plane with its title in the 220 px gutter and no lead sentence. A switch is a
  section's first row where it exists (« Agent activé »). *Sécurité*: Code d'accès (state +
  Changer le code · Désactiver), Verrouillage automatique (15 min · 1 h · 1 jour · 7 jours ·
  30 jours), Jetons d'accès · API et MCP as a ruled list (name, scopes and last use in
  Table-muted, Régénérer · Révoquer as text actions, « + Créer un jeton »). *Portefeuille*:
  Devise (fixed at first run), Fonds de comparaison list, Modèles d'imposition list.
  *Agent*: Agent activé, Fournisseurs list (name, « Par défaut », Modifier), Réflexion.
  *Notifications*: Dans l'application (switch), Canaux list (ntfy, e-mail, webhook,
  Apprise: name · target, scope, Tester, Modifier, « + Ajouter un canal »). *Affichage*:
  Apparence, Langue, Densité, Thème (« Personnaliser » opens the Thème page: the token list
  with a modified marker and Rétablir, a side preview of real pages under tabs). *Avancé*:
  each row a name, a one-clause description ending on « Par défaut X », a 32 px mono input
  with its unit (min · sec · jours), Rétablir when modified.
- **Système:** fixed title; *Tâches* (one ruled row per job: name and short state, a 24-tick
  hour strip, « 17:35 · prochain 17:40 » in mono, one outline « Lancer »); under it the
  followed titles, collapsible, in two columns (symbol mono + name, state: « à jour » muted
  or « ⚠ figé depuis 16:25, 6 passages » in `foreground`), no action per title; *Données*
  (cours conservés, événements, base de données, « Historiques orphelins · N » with Purger
  in the sub-head) and *Installation* (version, « Signaler les nouvelles versions » switch,
  en marche depuis, source des cours, Journal) side by side. No pause, no backup row.
- **Journal:** a page: « ← Système », « ● En direct », Télécharger; tabs Tout ·
  Avertissements · Erreurs, filters Toutes les tâches · 7 derniers jours, a search field;
  ruled rows of time mono · level (info muted, ⚠ avert., ⚠ erreur) · task · raw message in
  mono, day separators, a « détail » disclosure opening the traceback in a `muted` block.
  A recovered retry is a warning, not an error.
- **Import preview:** a page under Grand livre titled « Importer »: « ← Grand livre | file
  name · N lignes », Autre fichier and the filled « Importer N événements »; tabs Tout ·
  Nouveaux · Déjà présents · Illisibles, filters « Importer dans PEA » and the format;
  the ledger's columns plus an *Issue* column (« Nouveau » muted, « Déjà présent · même
  ISIN, date, quantité, prix », « ⚠ Titre inconnu » with an outline « Associer »).
- **First run:** four centred steps (520 px, « n sur 4 » in mono): the currency (a select,
  « Ne se change plus ensuite. »), the tax models of a country as checkboxes (« Écrire mon
  propre modèle » as a link), the first account (Identifiant, Libellé · facultatif, Modèle
  d'imposition), then three ruled doors: Importer un relevé (CSV ou Excel) · Saisir à la
  main · Plus tard. One filled « Continuer », « ← Retour » as text.
- **PIN screen:** centred, six 44 × 52 slots (`input` border, dot when filled), one line
  under them: « Code d'accès », « Code incorrect · dernier essai » (`destructive` borders),
  « Trop d'essais · réessayez dans 4:52 » with the reset command in a mono block. No plane,
  no button: the code is sent at the sixth digit.
- **Mark (#1337):** unchanged.
- **Browser surfaces:** selection colour is `primary` at 25 %; caret and focus rings are
  `primary`; scrollbars are thin and use `border`.

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

- Do keep one hero figure (or one statement) per screen, and one gain percentage per screen
  with its base written beside it.
- Do set every figure in Geist Mono with tabular numerals, right-aligned in a column.
- Do put every page's actions on its first control line, outline buttons then the one
  filled one.
- Do give every list inside a setting its « + Ajouter … » row and one text action per row
  at most.
- Do give every new component its empty, loading and error states before it ships.
- Don't write a page subtitle that is not a dated fact, a section subtitle that is not a
  period or a filter, or a sentence that explains a control.
- Don't put a card on a page for anything the user does not decide; don't nest planes.
- Don't colour a row, a pill or a tile with `gain` or `loss`; colour the figure. Don't
  draw a pill or a chip at all.
- Don't use a glyph arrow (↓ ↑ → ▾) in text; the only exceptions are « ← » on a back
  link and the agent's send button.
- Don't show the technical state of the server in the bell: it belongs to Système.
- Don't give a floating surface a shadow, and don't go back to cream with a serif display.

## Motion

- **Approach:** minimal-functional.
- **Easing:** enter ease-out, exit ease-in, move ease-in-out.
- **Duration:** micro 80 ms, short 200 ms, medium 300 ms.
- **The one authored moment:** the hero value recomposes from the old value to
  the new one (250 ms, ease-out). One movement, two triggers: a merged proposal
  and a refreshed value (the figures poll every minute, #1180). A change under
  0.1 % of the value is instant, so the cents do not twitch all day. Nothing
  else animates on entry. `prefers-reduced-motion`
  turns it into an instant change.

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
| 2026-10-31 | The theme is edited as a form with a live preview (#1314) | A textarea of JSON asked the owner to know 40 token names and to apply blind. The form names the 16 colours the design reads, previews them on the real app before anything is saved, and keeps the JSON as an expert escape hatch for the keys it does not show. The preview is one stylesheet, not inline variables, so both grounds keep their own palette; the dark palette is previewed in dark whatever the device is set to. |
| 2026-10-30 | The dashboard's third track (#1325) | Packing, move and drag rules for three tracks: consecutive halves fill rows of three; a lone half that accepts the full width is drawn across the row, other leftover tracks are free cells ("Place libre" in edit mode, one outline per track); a full section takes the whole row and jumps a whole row when moved; the stored list and `LAYOUT_VERSION` are untouched. The default order becomes allocation, gain breakdown, rhythm, movers, so three tracks show three halves then the movers across the row (saved layouts are untouched). The movers show fifteen lines in columns of five across three tracks, the allocation's legend a third column. |
| 2026-11-04 | The Sécurité and agent sections follow #1279 (#1436, item 17) | The owner settled the conflict #1436 left open: #1279 wins over the title-row switch and the cards under the rows. A section's switch is its first row, never in its title row; a procedure opens a Dialog or a Sheet; « Accès » becomes « Sécurité ». The agent's connection moves into a Sheet, and its model becomes a value saved on change without the key. |
| 2026-11-07 | Direction « Relevé » adopted on the dashboard, then propagated (Design canvas, page *Refonte*) | The owner liked Atelier but found it « generated »: every figure moves to Geist Mono with tabular numerals (reversing #1281's table half and #838's figure half), tables and lists sit on the ground with 1 px rules, text tabs replace segmented controls, one filled button per screen. Validated first on the dashboard (« Relevé C »), then on every page. |
| 2026-11-07 | The dashboard is fixed; the arrangeable grid, its edit mode and hidden cards are removed | Reverses the rows of 2026-10-11, 2026-10-20 (#1280) and 2026-10-30 (#1325). The owner chose a fixed composition: hero, chart, *Rythme d'investissement* and *Valeur des titres* (top four lines + « autres »). *Mouvements* leaves the dashboard; the day's move reads in Titres under the price. |
| 2026-11-07 | Titres is the table alone; a security's sheet becomes a page | The toggle by title / by account, the closed lines, the fees and the note under the table were rejected as a « ticket de caisse ». The sheet (`ShareSheet`) becomes the page `/shares/<symbol>`. |
| 2026-11-08 | « L'état, pas l'explication » | Applied to every page after the Système review: a fixed page title (no dynamic verdict), no subtitle but a dated fact, no help sentence, no section subtitle that repeats its content, one action per row. The exceptions are listed under *Content*. |
| 2026-11-08 | A compte has no type | A compte is an identifiant, an optional libellé and a modèle d'imposition. « Déclarer un compte » becomes « Ajouter un compte ». The first run gains a step that imports the tax models of a country before the first account. |
| 2026-11-08 | Système: no pause, no backup, no action per title; alerts are a mark and a notification | Successive owner decisions: Lancer/Pause text (misaligned), play/pause icons (« how can one both play and pause? ») and a « Planifiée » switch (« not clearer ») were rejected for one « Lancer » per job; « nobody pauses the scraping »; « Relever » on a frozen title does nothing the next pass would not do. The frozen title keeps a ⚠ in the followed-titles list and the bell carries the notice. The app has no backup, so no backup row. Journal becomes a page. |
| 2026-11-08 | Coherence pass over the 27 refonte sources | An independent audit found four page-button styles, four tab grammars, three envelope paddings, seven row heights, two section grammars. Unified: `32px 32px 56px`; page buttons 32 px / sheet 36 px; page tabs 15/22 with a 2 px rule; filters as text + chevron; rows 40 / 48; Réglages on the same planes as the other pages; links in `foreground`; floating surfaces radius 14 without shadow; one TokenCreated source. Full report: `claude/coherence-refonte.md` in the project. |
| 2026-11-08 | Four personas reviewed the refonte; eight changes applied | Théo (first PEA), Hélène (multi-wrapper, spreadsheet), Mehdi (homelab SRE), Claire (monthly reader). Common findings: several totals and gains that did not reconcile, a « −837,20 € » hero read as a loss, jargon without a net, contradictory tax rates in the mockups, no reassurance before a write, technical alerts in the bell. Applied: *Référence* becomes *Comparaison* with a sentence hero; the dashboard gains the variation over the period, the cash and « Net si tout vendu »; one official gain (the dashboard's) and labelled bases elsewhere; « prix moyen d'achat », periods in words, « Ajouter un compte »; the effect line in the event sheet; the import names its account, its matching criterion and offers « Associer »; the bell speaks French and keeps the technical state in Système; a *Notifications* section in Réglages; mock data aligned (prices of 6 Nov. 2026, PS 18,6 %, CTO 31,4 %). Report: `claude/personas-retours-refonte.md`. |
| 2026-11-09 | Staging feedback, first pass | The owner's staging walk: Réglages and the Thème preview take the full width (the 1 040 px cap goes); the palette loses the « G puis X » shortcuts and « Revoir la mise en route » and gains an icon per entry; « Se déconnecter » becomes « Verrouiller »; the PIN is set with the same six cells as the lock screen; no password-manager suggestion outside the unlock; the broker import profiles go (written without real statements), only the app's own layout is read, each row keeping its own account. |
