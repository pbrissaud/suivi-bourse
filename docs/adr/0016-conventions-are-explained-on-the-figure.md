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
- **Absence has four renderings under one rule**: the em dash means *there is nothing to
  compute*; anything missing is named instead. Waiting for a rate and never fetched are
  never the same glyph — the second is repairable, and the app knows the count of failed
  attempts rather than the impossibility.
- **Zero stops rendering as absence.** `signClass` greys `0` exactly as it greys `null`,
  and a closed row carries both side by side.

[Full argument: #690](https://github.com/pbrissaud/suivi-bourse/issues/690) ·
[the sentences it retires: #672](https://github.com/pbrissaud/suivi-bourse/issues/672),
[#673](https://github.com/pbrissaud/suivi-bourse/issues/673),
[#674](https://github.com/pbrissaud/suivi-bourse/issues/674)
