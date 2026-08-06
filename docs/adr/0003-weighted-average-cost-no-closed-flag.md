# Weighted-average cost, and a closed position is not a flagged position

Cost is matched by **weighted average (PMP)** with no dial — it is the French tax rule
(CGI art. 150-0 D), and offering FIFO alongside would make the app carry two
conventions at once. A position is therefore one stock — a quantity and a **cost
basis stored as an amount** — with the unit price derived by division. A sale becomes
a subtraction, and a fully sold position reports zero invested *by construction*
(quantity 0 → basis 0), rather than by an `if closed` branch.

There is **no `closed` flag**, and the predicate is `quantity == 0`: "closed" and
"temporarily flat" differ only by a future event, so nothing computable separates
them. Filtering closed positions out of the scrape belongs in the list of held
symbols, never in the timeline itself.

## Consequences

- Acquisition fees are absorbed into the cost basis and disposal fees into the
  proceeds; dividends leave the profit-and-loss entirely. Three named figures —
  latent, realized, dividends — replace one composite whose terms had four different
  domains of definition.
- **Realized gain is a breakdown of the absolute gain, never a term added to it** —
  the proceeds are already in the cash balance. This is the rule a contributor will
  break.
- It follows that a zero-cost `GRANT` would break the identity, so a grant carries an
  optional unit price feeding contribution and cost basis together (absent = dilution,
  both zero).
- Realized gain is written by the event replay, not by the price scrape — the scrape's
  write path is removed at the exact moment the figure is born.

[Full argument: #672](https://github.com/pbrissaud/suivi-bourse/issues/672)
