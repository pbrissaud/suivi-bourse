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
- The first-purchase anchor that bounds backfill widens to include grants; anchoring
  on purchases alone silently carried a dilution grant at zero for years.

[Full argument: #673](https://github.com/pbrissaud/suivi-bourse/issues/673)
