# A comparison never outruns the period where it exists

The accounts page exists to answer *which of my accounts is actually working*. Run on
the dev's two real accounts, the stored `twr_index` answers `pea 171,5` against
`TR 115,0` — a figure computed from **30 October 2019** compared with one computed from
**26 February 2024**. It is not a comparison; it is two numbers with the same unit.

Rebasing both series to 100 at the start of the visible window fixes that, and the same
window then drives the table's scalar column, so the chart and the table stop being two
announcers that contradict each other. What it does *not* fix is the window itself:

```
1 semaine   TR  +3,05 %  >  pea  +0,95 %          1 an     pea  −4,83 %  >  TR −21,62 %
1 mois      pea +2,23 %  >  TR   +1,33 %          2 ans    TR  +34,93 %  >  pea −12,54 %
YTD         pea +1,12 %  >  TR   −6,97 %          commun   TR  +15,00 %  >  pea −23,80 %
```

Four reversals across seven windows, every figure correct. The page therefore carries
**one** range control — never two, per ADR of the dashboard's own lesson — and the
`perf` bubble is the one place in the product that warns against its own figure.

**The longest window is the youngest account's opening, not `MAX`.** Mounted, `MAX`
fails: `pea` spiked to `+542 %` in February 2022, the axis runs `−58 %` to `+542 %`, and
both accounts' recent history is crushed into the bottom sixth of the plot. The failure
is not the differing bases — an account entering mid-chart reads perfectly, with a
dated marker — it is that a time-weighted index has **no bounded range**, so one
account's ancient volatility sets the scale for every other.

## Consequences

- **The table's `perf` column inherits the bound, and that is half the reason.** At `MAX`
  it renders `+71,49 %` beside `+15,00 %` with nothing saying they cover 6,8 years and
  2,4 years. Bounding the window makes every cell in that column cover the same span,
  which no annotation could have achieved.
- **Nothing is hidden by the bound.** An account's full history is its own subject, and
  it already has two homes — the dashboard's single series, which has no scale problem,
  and the account's own sheet.
- **The entry marker survives** and keeps its subject: an account opened three weeks ago
  still enters mid-chart on a one-year window. It is a dated dot and a label, never a
  reason to move the window.
- **The scalar strip carries one figure per drawn curve.** The portfolio is not drawn —
  its own curve is the dashboard's — so its performance lives only in the table's
  `Portefeuille` row.
- **`Portefeuille`, never `Total`.** Six of its eight columns are sums; `TRI` and `perf`
  are not, and they are not em dashes either — the app holds both at portfolio level.
  Naming the row for its subject makes it true across all eight at once. On the
  unbounded window it read `+102,72 %` above both accounts; bounding the window happens
  to retire that case, and the naming is kept because at three accounts it returns.

[Full argument: #685](https://github.com/pbrissaud/suivi-bourse/issues/685) ·
[the invariance it rests on: #683](https://github.com/pbrissaud/suivi-bourse/issues/683) ·
[the form its figures take: ADR-0016](./0016-conventions-are-explained-on-the-figure.md)
