---
# gstack: design-md-format=spec
name: SuiviBourse
description: A warm, quiet workshop for your own figures, where every account shows what you would really keep, net of tax.
colors:
  background: "oklch(0.975 0.008 85)"
  surface: "oklch(0.995 0.004 85)"
  tint: "oklch(0.945 0.014 85)"
  text: "oklch(0.22 0.02 60)"
  text-muted: "oklch(0.5 0.02 60)"
  rule: "oklch(0.9 0.012 85)"
  primary: "oklch(0.48 0.11 165)"
  on-primary: "oklch(0.995 0.004 85)"
  dark-background: "oklch(0.17 0.012 60)"
  dark-surface: "oklch(0.205 0.012 60)"
  dark-tint: "oklch(0.23 0.014 60)"
  dark-text: "oklch(0.95 0.008 85)"
  dark-text-muted: "oklch(0.68 0.015 70)"
  dark-rule: "oklch(0.3 0.012 60)"
  dark-primary: "oklch(0.8 0.13 165)"
  dark-on-primary: "oklch(0.17 0.012 60)"
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
  section-title:
    fontFamily: Geist
    fontWeight: 600
    fontSize: 20px
    lineHeight: 28px
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
  mono:
    fontFamily: Geist Mono
    fontSize: 13px
    fontFeature: tnum
rounded:
  sm: 8px
  md: 14px
  lg: 18px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  section-gap: 20px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 64px
components:
  section:
    backgroundColor: "{colors.tint}"
    rounded: "{rounded.lg}"
    padding: 20px 24px
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: 14px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
  button-secondary:
    borderColor: "{colors.rule}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  chip:
    borderColor: "{colors.rule}"
    rounded: "{rounded.full}"
  agent-panel:
    backgroundColor: "{colors.tint}"
    width: 380px
---

# SuiviBourse

## Overview

**Creative North Star:** "Atelier". The app should feel like a warm, tidy workshop
where your own figures are laid out to be read: calm surfaces, real numbers, and the
one figure nobody else shows, what you would keep net of tax.

**What we want remembered:** "Enfin mes vrais chiffres", finally my real numbers.
Every decision below serves that sentence: the net figure sits under the hero, tax
appears as a visible line in each account, and nothing is decorated to look better
than it is.

**Product context:** an open-source, self-hosted portfolio tracker for French retail
investors holding a PEA, a compte-titres and a few positions. Its moat is the net
figure: the tax model per account wrapper, the projected tax, the comparison with an
index. Release 5.3 adds an analyst side panel (Vercel AI SDK, `useChat`).

**Mode per surface:** every screen is Operate (an app UI: finish a task, read figures).
The website under `website/` is out of scope for this file.

**Reference sites (studied 10/10/2026):** wealthfolio.app (cream ground, italic serif,
the generic look we avoid), kubera.com (dark balance-sheet spreadsheet), sharesight.com
(classic holdings table). Direction chosen against three rendered alternatives
("Le relevé", "Atelier", "Instrument"), see the Decisions Log.

**Key characteristics:**
- The value is the hero, and the net-of-tax line sits right under it.
- Sections are warm tinted planes, never boxes; Atelier carries no shadow.
- Cards exist only where you decide something.
- Colour means something: accent for action, gain and loss for the sign of a figure.

## Colors

**Strategy:** restrained. Warm neutrals carry the page; one mint accent owns action;
gain and loss colour only signs and figures.

**Light or dark:** both ship. The use scene is a person checking their own money at a
desk or on a phone, often in the evening: light is the default, dark follows the
system setting. Dark keeps the hierarchy by stepping the same warm neutrals (background,
surface, tint) rather than inverting lightness, and lifts the accent so it keeps its
contrast.

- `primary` is the only colour for interaction: primary buttons, the current nav item,
  focus rings, weight bars.
- `gain` and `loss` colour the sign and the digits of a figure, never a row background,
  a pill fill or a whole card.
- `tint` is the section plane; `surface` is reserved for cards and inputs that sit on it.
- `rule` separates rows inside a section and nothing else.
- Secondary text on a tinted plane uses `text-muted`, which is derived from the same
  warm hue, never a neutral gray.
- Gain is `primary` and loss is `destructive`: `--gain` and `--loss` point at them.
- A semantic token (`--gain`, `--loss`, `--price`, `--attention`, `--alloc-*`…) is
  always an alias of a standard shadcn token, never a value of its own
  (`lint/semantic-token-alias.grit`, #1130).
- The theme is replaceable: `SB_TWEAKCN_THEME` names a tweakcn theme whose colours,
  fonts, radius and shadows the server lays over Atelier. Unset, Atelier is served.

## Typography

Geist and Geist Mono stay. They are already self-hosted through `@fontsource-variable`
and used everywhere. Geist is on the list of overused display faces; we accept it
because in this app the display voice is the figure, not the font, and replacing a
shipped face would cost every screen for no reader benefit.

- **Hero (60/64, 600, -0.03em):** the one figure a screen leads with. One per screen.
- **Figure (28/32, 600):** a secondary figure that stands alone (an account's value).
- **Section title (20/28, 600):** sentence case. No uppercase, letter-spaced overlines,
  no kicker above a heading.
- **Prose (15/22):** the analyst's answers and any explanatory paragraph.
- **Body (14/20):** controls, table text, labels in forms. Below the usual 16 px rule
  on purpose: this is a dense tool UI; long reading text uses Prose.
- **Label (12/16, 500):** meta and column headers, `text-muted`, never letter-spaced.
- **Mono (13, `tnum`):** the rule from #838 stays: every figure **inside a table**
  (`td`, `th`) is Geist Mono; every figure **outside a table** is Geist with
  `font-variant-numeric: tabular-nums`. Tickers are Geist Mono at 11 to 12 px. Mono in
  the middle of a sentence is a bug.

## Layout

- **Desktop ≥ 1440 px:** sidebar 200 px, content up to 1040 px, analyst panel docked
  right at 380 px; the content shrinks to make room.
- **768 to 1439 px:** the analyst panel is a right `sheet` over the content.
- **< 768 px:** single column; the analyst panel is a full-screen `sheet` with a back
  button.
- **Rhythm:** 20 px between sections, 24 px around the content, 12 px between a section
  title and its content. Large gaps (40, 64) only separate the hero from the first
  section and the page from its footer.

### The section (replaces "everything is a card")

A section is a tinted plane: `tint` background, `rounded.lg`, padding 20 px 24 px, no
border, no shadow of its own. Its first row holds the title on the left and the section's own
subtotal on the right, like a line of a statement. Rows inside are separated by `rule`.

A section never contains another section. A long page is a sequence of sections; the
dashboard alone lays its sections out on a grid the owner arranges (below).

### The dashboard grid

Under the hero, the dashboard's sections sit on a grid of **two widths**: half or full,
20 px apart, one column under 768 px. It is an ordered list of sections, each with a
width, never a free two-dimensional placement, so the reading order is the focus order.

- A section takes the full width only if it **shows more** there (the movers: five
  lines on half, ten across the full width). A section that would only stretch is
  half-only: the gain breakdown and the investment rhythm.
- Two halves share a row and end on one line: the shorter one's last line (a total)
  is pushed to the bottom. A half that accepts the full width and is alone on its
  row is drawn full; a half-only section alone leaves the other half empty.
- A section whose read is in flight holds its place as an empty plane, with nothing
  in it (#795).

**Edit mode** ("Modifier le tableau de bord", a Label link on the grid's top edge): the
link's line becomes a bar, the title "Modifier le tableau de bord" in Section title on
the left, "Réinitialiser" (ghost), "Annuler" (secondary) and "Terminé" (primary) on the
right; under 768 px the bar sticks to the top. Each section's ⋯ menu sits at the end of
its own title row, a 28 px ghost button (44 px on touch), `text-muted` turning
`foreground` on hover and focus. On a desktop with a fine pointer, a ⠿ drag handle with
the same look (and `cursor: grab`) sits before the title; dragging follows the menu's
rule (a full section lands between two rows, a half takes another half's place) and
keeps every section's width until the drop. Phones have the menu only. The sections'
content is inert; the hero is neither dimmed nor movable. Hidden sections are listed in
a "Cartes masquées" section under the grid, a chip "Nouveau" on the ones a release
added. The empty half beside a half-only section shows "Place libre" in Label on a 1 px
dashed `rule` outline, in edit mode only. Resetting is confirmed in a card (a
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

The portfolio value (decision 1A, #1099), then one line "Il vous resterait X € net
d'impôt", then the pills: total gain, today, IRR per year. The TWR lives behind an `ⓘ`
that explains why it differs from the IRR. One performance figure per screen.

Under them, the portfolio's chart across the hero's full width, with its readings and
the page's one range control: the real chart, never a decorative sparkline beside a
dialog holding the real one.

Under the chart, one row of statistics: Versé net, Titres, gain since 1 January.

## Elevation & Depth

Flat. Atelier's shadow opacity is 0, so depth comes from the step between
`background`, `tint` and `surface`, not from shadows. Components still carry shadcn's
`shadow-*` utilities (a card `shadow-sm`, a menu `shadow-md`), so a replacement theme's
shadows show. The only shadow Atelier draws is the right `sheet` of the analyst panel below
1440 px: 8 px horizontal offset, 24 px blur, 8 % black, so it reads as lying over the
page. No zero-offset glow, in either theme.

## Shapes

- `rounded.lg` (18 px): sections and the analyst panel's inner planes.
- `rounded.md` (14 px): cards. A card sits on a section, so 18 − 4 keeps the curves
  concentric.
- `rounded.sm` (8 px): buttons, inputs, menus.
- `rounded.full`: chips only.

## Components

- **Section:** see Layout. No hover state; the section itself is not interactive. In
  the dashboard's edit mode its title row carries the ⋯ menu (see The dashboard grid).
- **Card:** `surface`, `rounded.md`, 14 px padding. Allowed only for something the
  user decides (an analyst proposal, a profile fact to confirm, a first-run step, a
  destructive confirmation) or selects (an account tile). Never a card inside a card.
  A decided proposal loses its buttons and shows one status line (decision 5A).
- **Weight bar:** a 6 px `primary` bar with its percentage in Label, inside holding rows.
- **Buttons:** primary (filled `primary`), secondary (outlined `rule`), both 32 px high,
  44 px on touch. Focus-visible: 2 px `primary` ring, 2 px offset. Disabled: 50 %
  opacity, no pointer events, the reason given in text next to it.
- **Chips (analyst profile facts):** outlined, Label size; each opens a popover with
  the value, its confirmation date, "Modifier" and "Oublier" (decision 13A).
- **Analyst panel:** `tint` plane, 380 px docked. Header: "Analyste", the provider and
  model, "Nouveau fil", "Fils récents". Tool calls are one muted line in plain words
  with a "détail" disclosure (2A). The CIF line "Simulations à partir de vos données
  déclarées, pas un conseil en investissement." stays fixed under the input (3A).
  States follow decision 4A. Region `complementary` named "Analyste", ⌘/Ctrl + J,
  answers announced once complete (11A).
- **Browser surfaces:** selection colour is `primary` at 25 %; caret and focus rings
  are `primary`; scrollbars are thin and use `rule`.

## Do's and Don'ts

- Do put the net-of-tax figure where the user looks first on any screen that shows
  money in an account.
- Do keep one hero figure per screen and one performance figure (IRR) visible.
- Do end every account section with the tax line and "Ce qu'il vous resterait".
- Do set every figure in a table in Geist Mono and every other figure in Geist with
  tabular numerals (#838).
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
- **The one authored moment:** after a proposal is merged, the net figure under the
  hero recomposes from the old value to the new one (250 ms, ease-out). Nothing else
  animates on entry. `prefers-reduced-motion` turns it into an instant change.
- **Dragging a dashboard section:** only the gesture moves; the other sections slide to
  their new place (short, ease-in-out), and not at all under `prefers-reduced-motion`.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-10 | Initial design system created ("Atelier") | Created by /design-consultation from the 5.3 design doc, the staging audit of 2026-10-09, and research on Wealthfolio, Kubera and Sharesight. Chosen over "Le relevé" (judged too austere) and "Instrument" (too dense for the non-technical users the analyst targets). |
| 2026-10-10 | Keep Geist and Geist Mono, keep #838 | Already shipped and self-hosted; the figure is the display voice. |
| 2026-10-10 | Warm neutrals replace the cool ones | Serves "Enfin mes vrais chiffres" with a calmer, less clinical surface. |
| 2026-10-10 | Sections are tinted planes; cards only for decisions and selections | Resolves point 8C of the 5.3 design review (no stacked cards). |
| 2026-10-10 | Net-of-tax line under the hero, value stays the hero | Keeps decision 1A and #1099 while showing the product's argument first. |
| 2026-10-10 | Semantic tokens are aliases; the theme is replaceable (#1130) | Gain becomes `primary` and loss `destructive` so any tweakcn theme repaints the app; attention loses its hue and the icon carries the meaning. |
| 2026-10-11 | The dashboard is a grid of sections the owner arranges | Two widths, an ordered list rather than a 2D grid; full width only where a section shows more; the menu in the title row; designed through office hours, eng and design reviews on 11/10/2026. |
| 2026-10-11 | The hero draws the real chart, full width | Reverses the sparkline-and-dialog of #1099 (direction 1a): one chart, readable by everyone, instead of a large mute picture plus a dialog. |
| 2026-10-12 | The IRR is the third pill; the year-to-date gain moves to the statistics row (#1149) | Keeps the one performance figure next to the value on a phone; no figure leaves the page. |
