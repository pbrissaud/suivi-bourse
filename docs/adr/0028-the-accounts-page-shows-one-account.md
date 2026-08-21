# The accounts page shows one account, and the comparison moves with its range control

[ADR-0019](./0019-a-comparison-stops-where-it-exists.md) built the page around a
question — *which of my accounts is actually working* — and answered it with an
eight-column table under one range control. The redesign replaces that table with a
master-detail: a sticky rail on the left carrying the accounts' weights and their names,
and on the right one account's composition, its annualised return, its dividends, its
lines and its last events.

The trade is stated plainly, because it is a loss before it is a gain: **a page showing
one account at a time cannot compare accounts.** That was the page's founding question,
and the master-detail answers it worse.

What buys the trade is that the comparison had already moved. The dashboard carries an
accounts card holding both accounts, their curves and their rates side by side — a
surface ADR-0019 did not have when it chose a table. The comparison is not lost; it
changes address, and it takes ADR-0019's rule with it.

## Consequences

- **ADR-0019's one range control is amended in its subject, never in its rule.** The
  control now drives the *detail's* chart and the rate beside it, and the dashboard's
  accounts card is where the cross-account reading happens — so that card carries the
  rule that the `perf` column used to: one range, one span for every figure drawn on it.
  A thirty-day sparkline beside a one-year percentage is the same defect ADR-0019
  measured, one surface further along.
- **`MAX` is still not offered**, and for the reason ADR-0019 gave rather than by
  inheritance: a time-weighted index has no bounded range, so one account's ancient
  volatility sets the scale for every other. The bound is the youngest account's
  opening, on the dashboard card as it was on the table.
- **The `Portefeuille` row is not orphaned by the table's removal.** ADR-0019 put the
  portfolio's performance there because the portfolio is not drawn on that page. It is
  drawn on the dashboard, whose head already carries the two rates — so the row's
  content has a home and the rail does not need a thirteenth entry for a thing that is
  not an account.
- **What the master-detail buys is what eight columns could not hold.** Composition
  between securities and cash, the dividends encashed, the account's own lines and its
  last events are five blocks per account; as columns they were never going to fit, and
  ADR-0019 already noted that at three accounts the table's naming problem returns.
- **The account is declared here now, and removed here.** The declaration leaves the
  data page (ADR-0030), the reassignment rides with it as issue #725 settled, and the
  removal moves into the edit dialog — where its three refusals, which are prose, have
  the room a table cell never gave them.
- **The rail's sparklines carry their period or carry no figure.** A curve with no stated
  span beside a total is the unbounded-window failure in miniature.

[The comparison it re-homes: ADR-0019](./0019-a-comparison-stops-where-it-exists.md) ·
[the width it must still hold: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the data page it takes the declaration from: ADR-0030](./0030-the-data-page-has-three-tabs.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
