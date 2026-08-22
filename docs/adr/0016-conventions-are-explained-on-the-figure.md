# Conventions are explained on the figure, not written on the page

Three tickets each required a sentence on screen — the weighted-average cost, the
position carried at its cost, the returns computed from the owner's event dates — and
each left the placement to the page work. Two of them turn out to be **one sentence in
two halves**, which the ticket that came third did not see and counted as two.

None of them is written on a page. The convention lives on an **information icon beside
the figure it governs**, opening on click into a short text and a versioned link to the
project documentation. The page never explains itself: it shows figures, and each figure
carries its own account of the rule it rests on.

The instrument is what makes the difference, not the wording. A sentence placed on a
page has to be placed *somewhere*, and both the dashboard and the accounts page display
**both families of figure** — so any per-page rule stacks two sentences above their
numbers, which is the failure every one of those tickets warned against. Per figure,
they cannot stack: they distribute.

## Consequences

- **Click, never hover.** Hover does not exist on touch, and a convention readable on
  half the devices is a convention not stated. Click also keeps the bubble open while
  the reader moves to the link inside it.
- **One bubble, one text**: what the figure means, the rule it rests on, then the link.
  The two `title=` hints on XIRR and TWR are not discarded — they become the first
  sentence. The returns convention is the same sentence in both bubbles, deliberately.
- **Icons go on figures that rest on a convention** — cost, latent gain, realized gain,
  XIRR, TWR — and on **column headers**, never on cells: one per column rather than one
  per row. The single exception is a row whose price could never be fetched, whose text
  is a repair rather than a convention.
- **The documentation is the project website**, one page with an anchor per figure, and
  the link carries the version. An in-container copy buys only offline operation, which
  an app that polls Yahoo every cycle never has. It replaces `reading-the-dashboard.mdx`.
- **A carried-at-cost row keeps no marker of its own** (ADR-0004 held): the em dash in
  the price column is already the signal, and a rebuild makes that case common enough
  that a per-row marker would be noise across the whole page.
- **The gain is one total over three subordinate terms** — `Gain total`, then latent,
  realized and dividends — because their sum is an identity, and three figures aligned
  without their total is exactly what invites adding them to something else. In a table
  the form does not nest, so it is three columns whose sum is the header.
- **A total and its terms are never read at equal weight.** Mounted side by side and at
  the same size, `Gain total +942,37 €`, `latente +493,37 €` and `réalisée −659,98 €` are
  five numeric columns of equal weight, and nothing says the last four are *inside* the
  first — the form invites exactly the addition ADR-0003 says a contributor will attempt.
  So either the total is the **column header** over its terms (the shares table,
  ADR-0017), or the total is the cell and the terms live in a **block** elsewhere (the
  accounts table, ADR-0019). This is also why the shares sheet is the only surface where
  the form appears naked: a block is the only place it can.

  **Amended (#787): the rule is the weight, not the line.** It read *never share a row*,
  and that is the rule as a **table** made it — a row has only the horizontal axis, so
  there the two are the same sentence. Transposed to a card they stop being: the
  dashboard's head draws its total at `text-4xl` beside four terms at `text-base`, a
  factor of three, and nothing about that arrangement invites a sum. What the record buys
  is that the reader cannot add the terms to the total by accident; **a size buys it as
  surely as a position does**, and forbidding the position where the size already answers
  is the letter outliving its reason. Where neither is available — a table row, equal type
  — the original sentence stands unchanged, and it is the one that keeps holding the
  shares table's group headers up.
- **A bubble never outlives the figure it explains.** Click-to-open was chosen so the
  reader can walk to the link inside it, not so the bubble survives its subject leaving
  the screen — a pinned bubble floating over unrelated content is worse than no bubble.
  It closes on scroll, and it opens **beside** its figure rather than over it: the two
  boards that mounted it both had it covering the very numbers it was explaining.
- **Absence has four renderings under one rule**: the em dash means *there is nothing to
  compute*; anything missing is named instead. Waiting for a rate and never fetched are
  never the same glyph — the second is repairable, and the app knows the count of failed
  attempts rather than the impossibility.
- **Zero stops rendering as absence.** `signClass` greys `0` exactly as it greys `null`,
  and a closed row carries both side by side.
- **A per-row marker that does not discriminate is noise, however correct it is.** Two
  page tickets produced the same defect independently: a market-state pill rendering ten
  identical `Marché ouvert` out of eleven, and a read-only padlock rendering on 285 rows
  out of 285. Both were demoted — the first to an icon plus a header counter, the second
  to nothing at all, the provenance column already saying it. The test is not whether
  the marker is true but whether it varies across the rows it is shown on
  ([ADR-0020](./0020-the-line-is-no-longer-the-unit.md)).

[Full argument: #690](https://github.com/pbrissaud/suivi-bourse/issues/690) ·
[the sentences it retires: #672](https://github.com/pbrissaud/suivi-bourse/issues/672),
[#673](https://github.com/pbrissaud/suivi-bourse/issues/673),
[#674](https://github.com/pbrissaud/suivi-bourse/issues/674)
