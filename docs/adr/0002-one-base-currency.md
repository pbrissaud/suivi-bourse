# One base currency, set once and never changed

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

- **The base currency is immutable once it is set** — amended by ADR-0014, which found
  that "immutable once any event exists" locks an owner who imports before answering out
  of their own currency for good. The unrecoverable act is *changing* it, not answering
  late: while the key is unset no amount has ever been interpreted. Getting it wrong is
  still repaired by editing files, not by a setting.
- **It has no default, and nothing refuses while it is unset.** Prices are still
  fetched, natively, with a `NULL` conversion the lateral pass repairs once the currency
  is answered; no performance series is written at all — not zeros, not `NULL`s — and
  the app says so on screen.
- A missing rate writes a `NULL` converted price rather than failing, which is only
  viable because a **lateral backfill pass** exists to repair it later.
- `GBp` (London pence) must be normalised as `GBP ÷ 100`, or London positions are
  wrong by a factor of 100.

[Full argument: #671](https://github.com/pbrissaud/suivi-bourse/issues/671)
