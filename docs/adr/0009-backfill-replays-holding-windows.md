# Backfill replays holding windows, and performance writes on a sliding horizon

Backfill iterates over **what the portfolio has ever held**, each symbol over its own
holding window — not over what it holds today. Iterating current positions means a
security bought in 2020 and sold in 2022 has no reconstructed price at all, and the
account's returns are wrong *permanently*. This was invisible in v4, where the live
series accumulated while the security was held; it is fatal the moment history is
reconstructed from nothing. It is also the point where backfill and scrape stop
sharing one set of symbols.

Pursuing a sold security then exposes a live v4 defect: the backward anchor is the
oldest *stored* point, so a delisted symbol re-fetches the same window every 60
seconds forever, in silence — an empty return is classified as a gap, not a failure,
so no failure counter ever rises. The anchor therefore becomes the oldest window
**attempted**, and it is *persisted* — the one named exception to ADR-0006's "watermarks
stay derived", whose argument fails precisely when no rows exist.

Because reconstruction advances one chunk per cycle, the performance series is written
only over a **sliding horizon**. There is no gate on completeness — today's figures are
correct from the first cycle, and a page filling in leftward is the best progress bar
available.

**The horizon is not a date; it is a run of days left over by blocks.** Each symbol
blocks the closed interval `[acquired(s), unpriced(s)]`, with
`unpriced(s) = min(oldest_price(s) − 1, last_held_day(s))`, and the series is the
**latest run of days no block covers**, inside `[start, ceiling]`. The first
formulation — *the earliest day on which every security the account held has a price* —
is that same rule with the blocks flattened onto a single left bound, and flattening is
what made it wrong on the two shapes below.

## Consequences

- The block must be **bounded by each symbol's holding window**, or a sold security
  whose backfill has barely started blocks the whole account. Bounded by the window's
  *two* ends: a day before a position was acquired holds nothing of it, so there is no
  crater to avoid and the symbol simply does not constrain that day. A symbol whose
  backfill is *terminal* contributes nothing at all — that is where ADR-0004 applies,
  knowingly.
- **A block that reaches the ceiling caps the series rather than bounding it**
  ([#765](https://github.com/pbrissaud/suivi-bourse/issues/765)). Read as a left bound,
  a symbol held today and quoted nowhere pushes the bound *past* the ceiling and the
  cycle writes nothing: the dashboard loses its whole history over one line the
  backfill has not reached yet. Treated where it is, the series **stops the day before
  the block** instead of starting the day after it — the history stays, the last point
  is a day old, and the next cycle catches up. The right edge walks left repeatedly,
  since stepping over one block can land inside another.
- **A horizon is one interval, and that is a decision rather than a shape**
  ([#766](https://github.com/pbrissaud/suivi-bourse/issues/766)). A block sitting
  wholly in the past cuts the timeline into two computable runs; only the one holding
  today survives, and the days before that symbol's own acquisition fall with it — not
  because a block covers them, it does not, but because there is one interval to
  render. What settles it is the TWR: the chain multiplies over consecutive *elements
  of the series*, never over consecutive calendar days, so a series with a hole chains
  across it and an external flow landing inside the gap is reported as performance
  (measured: +10 % of real return read as +120 %). Rendering one interval is what keeps
  the index honest; the residue is measured at **zero days** on the real staging ledger,
  and is transitory wherever it is not.
- This is what fixes the domain of ADR-0004: the boundary between "no price yet" and
  "no price ever" is the backfill watermark, not the leading edge of the series.
- The global series is written only where **every** account is, so one slow account
  delays the whole overview. The alternative draws a step that no event caused.
- Reconstruction takes roughly 25 minutes for 30 symbols over 5 years, and there is no
  accelerated mode — the rate limit is a courtesy to Yahoo at the moment the app makes
  more requests than at any other time in its life.

[Full argument: #677](https://github.com/pbrissaud/suivi-bourse/issues/677) ·
[horizon reformulated: #687](https://github.com/pbrissaud/suivi-bourse/issues/687) ·
[the block, and the cap that keeps the history: #765](https://github.com/pbrissaud/suivi-bourse/issues/765) ·
[one interval, settled by the TWR: #766](https://github.com/pbrissaud/suivi-bourse/issues/766)
