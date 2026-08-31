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

  **Amended (#833): the control is the dashboard card's alone, and the detail has
  none.** The clause above moved ADR-0019's rule to two surfaces at once, and one
  of the two has no subject for it. The rule is about **several spans read side by
  side** — one account's ancient volatility setting the scale for every other —
  and the detail draws *one* series on *one* axis, where that failure cannot
  happen. What the control bought there was a choice, at the price of a second
  announcer for *how did this period go*: the maquette this page takes its form
  from defines its range presets and renders them nowhere, which is the reading
  the correction follows rather than a taste. The dashboard's accounts card keeps
  the control, the bound and the whole of the rule.

  **What stands at the head of the detail instead is not a rate.** It is
  `Performance totale` — the account's whole gain divided by what was paid into
  it — a **cumulative ratio** of the same family as the *sur versé* under the
  dividends, not of the family of the two rates. Its extent is the account's own
  life, which is what *totale* says, so it implies no window and none has to be
  stated beside it. The two gestures are one: taking the control away changes what
  the figure *is*, and a windowed rate left standing with nothing saying its
  window would be exactly the defect this record was written about.

  Three things fall out of it. The detail's curve is drawn over the whole history
  and its legend states that extent. **`perf` leaves the product**: the figure it
  named was the windowed rate under that control, and the warning its bubble
  carried — the same two accounts changing places four times over seven windows —
  is stated by the dashboard's own `TWR` bubble, which is where the accounts card
  has leaned since it was written. And *depuis l'ouverture* stops naming two
  different days on two surfaces: on the dashboard card the preset is the youngest
  account's opening, and the detail says *de ce compte*.
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
  removal moves into the edit dialog — where its refusals, which are prose, have the room
  a table cell never gave them.
- **There are two refusals, and this record first said three.** The third was *a file
  declares this account*, and it stopped being knowable when
  [ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) removed `account.source_id`
  along with the rest of the provenance apparatus: `account` carries `id`, `type` and
  `label`, and nothing in the store can say which account came from a file. What survives
  is the seed row, which is renamed rather than removed, and the count of events that
  name the account. The correction is recorded rather than silently applied, because a
  refusal that a reader looks for and cannot find reads as a defect.
- **The rail's sparklines carry their period or carry no figure.** A curve with no
  stated span beside a total is the unbounded-window failure in miniature.

  **Amended (#833): the rail carries the detail's own figure, and the clause is
  satisfied rather than waived.** The maquette puts a `perf` on every account card
  and this record refused it, the rail having no range control with which to state
  a period. What it carries now is `Performance totale`, and a cumulative ratio
  implies no window at all — so there is no period to state and none is missing.
  The **sparklines** are still not drawn there: a curve would need a control of its
  own, and one control per surface is what is left of ADR-0019's rule. The weights'
  legend carries neither figure: its one number is the share, and a second
  unlabelled percentage on that row would be two figures a reader has to tell apart
  by guessing.

[The comparison it re-homes: ADR-0019](./0019-a-comparison-stops-where-it-exists.md) ·
[the width it must still hold: ADR-0022](./0022-the-navigation-is-a-sidebar.md) ·
[the data page it takes the declaration from: ADR-0030](./0030-the-data-page-has-three-tabs.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
