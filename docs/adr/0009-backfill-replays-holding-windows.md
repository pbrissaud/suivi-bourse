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
only over a **sliding horizon**: per account, the earliest day on which every security
it held has a price. There is no gate on completeness — today's figures are correct
from the first cycle, and a page filling in leftward is the best progress bar
available.

## Consequences

- The horizon must be **bounded by each symbol's holding window**, or a sold security
  whose backfill has barely started blocks the whole account. A symbol whose backfill
  is *terminal* contributes nothing to it — that is where ADR-0004 applies, knowingly.
- This is what fixes the domain of ADR-0004: the boundary between "no price yet" and
  "no price ever" is the backfill watermark, not the leading edge of the series.
- The global series is written only where **every** account is, so one slow account
  delays the whole overview. The alternative draws a step that no event caused.
- Reconstruction takes roughly 25 minutes for 30 symbols over 5 years, and there is no
  accelerated mode — the rate limit is a courtesy to Yahoo at the moment the app makes
  more requests than at any other time in its life.

[Full argument: #677](https://github.com/pbrissaud/suivi-bourse/issues/677) ·
[horizon reformulated: #687](https://github.com/pbrissaud/suivi-bourse/issues/687)
