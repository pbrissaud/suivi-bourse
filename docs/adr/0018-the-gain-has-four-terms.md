# The gain has four terms, and their sum is its definition

ADR-0017 states the identity `Σ latent + Σ realized + Σ dividends == gain_absolu` and calls
it exact. It is exact only on a portfolio whose transfers are free. Six `DEPOSIT` rows in
the dev's real files — *Apple Pay Top up* — carry a `fee`, and `aggregator.py:146-152`
takes it out of cash while `net_contributed` records the gross amount. The fee therefore
lands inside `gain_absolu` and inside **none** of the three position terms:

```
gain_absolu  957,48 €        Σ of three terms  971,43 €        gap  13,95 €
```

No position can carry it. It is not an acquisition cost (ADR-0003 absorbs those into the
basis), not a disposal cost (absorbed into the proceeds), not a dividend, and it belongs to
no security — so the shares page, whose header sums its rows, can never show it.

The gain therefore has a **fourth term, the fees taken from your transfers**. With it the
sum telescopes exactly, and the check becomes a definition: the head **computes**
`Gain total` from its four terms rather than reading `portfolio_totals.gain_absolu`, which
is the same number written down.

## Consequences

- **The alternative was to absorb the fee into `net_contributed`**, which restores three
  terms and makes 13,95 € vanish from the product entirely. Refused: the money left the
  owner's pocket, and `gain_absolu` was the only figure that knew.
- **The term renders only when it is non-zero**, so an install whose broker charges nothing
  for a transfer still reads three terms and never learns the fourth exists.
- **ADR-0017's identity gains that fourth term.** Its two headers agree on a portfolio with
  free transfers and differ by the fees otherwise — which is why the dashboard's `Gain
  total` bubble states its scope and the shares page's states that it sums *positions*.
- **`gain_absolu` no longer needs an external flow to be written.** With no `DEPOSIT` at
  all, `cash = −invested` and `net_contributed = 0`, so `gain_absolu = holdings − invested`
   — exact. What genuinely has no meaning without an external flow is `xirr`, and the
  opt-in guard travelled with it by accident.
- **Because the head computes, a field absent for one account never blanks the headline.**
  A global figure is written only where it is writable for *every* account; the four terms
  are not, so the page keeps its subject when `portfolio_totals` cannot.
- **Colour goes only to the terms that can change sign.** Dividends received are never
  negative and transfer fees never positive; colouring them is decoration that steals the
  signal from latent and realized gain, which do carry it.
- **A total and its subordinate terms are one figure, not five.** ADR-0016's rule applied
  literally puts nine icons in one head block; this reading leaves four — the total, net
  contributed, and the two rates.

[Full argument: #683](https://github.com/pbrissaud/suivi-bourse/issues/683) ·
[the three terms it extends: #672](https://github.com/pbrissaud/suivi-bourse/issues/672) ·
[the identity it corrects: ADR-0017](./0017-a-closed-position-leaves-the-table-never-the-total.md) ·
[the form it takes on screen: ADR-0016](./0016-conventions-are-explained-on-the-figure.md)
