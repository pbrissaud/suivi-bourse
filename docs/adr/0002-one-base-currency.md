# One base currency, chosen once and never changed

A portfolio holding securities quoted in several currencies has three plausible
answers — refuse it, convert it, or report per currency. v5 **converts**, into a
single base currency chosen on first run, and deletes the per-account currency
rather than guarding it: there are two currency levels (the base currency, and the
security's quote currency), not three, so "an account whose positions disagree with
its currency" stops being a sentence with a referent.

Events record **the debit, in the base currency** — which makes the cost basis exact
rather than estimated from a historical rate, and removes historical FX from the past
entirely. Only prices are converted, at write time, and a price point stores the
native price, the converted price *and* the rate used: a read-time join is
unaffordable given the `latest`-row constraint of ADR-0001, and at 18 bytes per row
the redundancy is cheaper than the join it avoids.

## Consequences

- **The base currency is immutable once any event exists.** It is the one figure whose
  change is unrecoverable, so getting it wrong is repaired by editing files, not by a
  setting.
- A missing rate writes a `NULL` converted price rather than failing, which is only
  viable because a **lateral backfill pass** exists to repair it later.
- `GBp` (London pence) must be normalised as `GBP ÷ 100`, or London positions are
  wrong by a factor of 100.

[Full argument: #671](https://github.com/pbrissaud/suivi-bourse/issues/671)
