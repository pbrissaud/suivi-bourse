# A closed position leaves the table, never the total

The shares page header states the sum of the rows it sits above — anything else is
read as a lie by the reader, who takes a figure over a table as that table's summary.
That decision looks harmless until it meets a *hide closed positions* switch, and the
two together manufacture a second figure that is also correct: on the dev's real
portfolio, hiding seven closed rows moves the total from **+977,61 €** to
**+1 686,53 €**, and nothing on screen says which one equals the dashboard's.

So closed positions never leave the table. They **fold**: a collapsed section below
the live table, closed on load, its summary line carrying the realized total. The
fold is a fold, not a filter — the header does not move, and the identity below holds
without the reader having to know it exists.

```
Σ latent + Σ realized + Σ dividends  ==  gain_absolu
        (closed positions included)
```

That identity is exact — acquisition fees are absorbed into the cost basis and
disposal fees into the proceeds, and a `GRANT` with no price feeds contribution and
basis together — and it was written down in none of the tickets that produced its
three terms.

**Corrected by [ADR-0018](./0018-the-gain-has-four-terms.md):** exact on a portfolio whose
transfers are free, and short by the fees taken from deposits and withdrawals otherwise —
which no position can carry, so this page can never show that term.

## Consequences

- **The folded section is not the live table with empty cells.** It has its own
  columns — `Titre · Soldée le · Réalisée · Dividendes · Compte` — because price,
  quantity, cost and latent gain are an em dash on every one of its rows.
- **It sorts by closing date, descending.** Market value is zero across the whole
  section, and a column of zeros orders nothing. The live table has no such column;
  this is not the same table, it is the same vocabulary.
- **The `Gain total` icon says so.** The one bubble on the page that must state a
  scope: the total counts closed positions, and that is what makes it agree with the
  accounts.
- **A closed position is still a derivation over `quantity`** (ADR-0003) — but the
  predicate only survives contact with a broker export once ingestion normalises it:
  a sale that empties a position to within `10⁻⁹ × Σ bought` sets `quantity` **and**
  `cost_basis` to exactly zero. One real file nets a sold-out ETF to `4 × 10⁻¹⁷`,
  and the noise is in the file, not in the arithmetic.
- **Realized gain is not a closed-position column.** A partly sold position carries
  one while it is still held, which is why the three gain columns all live in the
  live table.

[Full argument: #684](https://github.com/pbrissaud/suivi-bourse/issues/684) ·
[the three figures: #672](https://github.com/pbrissaud/suivi-bourse/issues/672) ·
[the form they take on screen: ADR-0016](./0016-conventions-are-explained-on-the-figure.md)
