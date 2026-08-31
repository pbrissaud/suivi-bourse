# A position with no price is carried at its cost

On a day where a held position has no price and never will, it is valued at its own
unit cost basis — its **carrying price** — not at its last execution price and not at
zero. The rule is keyed to the *absence of a price*, never to a calendar: a market
calendar would explain the hole without filling it, and the app polls listings whose
exchange it does not always know.

The consequence of choosing the cost basis rather than the execution price is that a
purchase day goes exactly cash-neutral and latent gain is identically zero while the
fallback holds — which is what makes the convention statable on screen in one
sentence.

## Consequences

- It is a **named helper**, deliberately invoked, because there is more than one
  implementation of "what was this worth on day D" and only one of them needs it.
- It is **never invoked while history is still being fetched** — see ADR-0009. Its
  domain is exactly "the symbol's backfill is terminal", so the predicate is *no
  price* **and** *no price is coming*, never *no price* alone.
- *No price* means **no quote**, not *no converted price*. Every figure the app draws
  is in the reporting currency, so the money columns read `price_converted`; a
  security whose quote is known and whose rate is not (ADR-0002's dial unanswered, or
  a pair that does not resolve) is therefore priceless to those reads while being
  perfectly well quoted. That state is *waiting*, a distinct kind of absence, and
  carrying it would publish a valuation the app does not have — durably, since the
  point keeps `price_converted NULL` until the lateral repair pass. The helper takes
  the quote's presence as its own argument for that reason.
- The first-purchase anchor that bounds backfill widens to include grants; anchoring
  on purchases alone silently carried a dilution grant at zero for years.

[Full argument: #673](https://github.com/pbrissaud/suivi-bourse/issues/673)
