# The app asks one question, and not at boot

v5 has exactly one thing it must be told: the **base currency**, the only setting with no
default. Everything a first run might otherwise have asked has been removed or answered
elsewhere — the mode is gone (ADR-0005), accounts are seeded and reassignable (ADR-0013),
the store location is observed rather than demanded (ADR-0015), and a drop folder may
legitimately not exist.

So "first run" is not a moment in the boot sequence but a **predicate**: the base currency
is absent, which is to say nobody has ever answered here. A modal carries the question and
closes on its cross alone — no *Later* button, which would give the way out the weight of
the answer. Closing it leaves a working app that fetches prices natively and computes
nothing, which is the state ADR-0002 already designed. Nothing refuses.

## Consequences

- **The currency is mutable while the ledger is empty**, immutable from the first event.
  This is the third formulation and the first that coincides with its own argument: with no
  event there is no held symbol and therefore no price point, so nothing has been
  interpreted and nothing can be reinterpreted. It **amends ADR-0002**, whose escape hatch —
  *repaired by editing files* — has had no subject since files stopped being the truth.
- **Three surfaces, three jobs, one sentence each.** A **receipt** says what your gesture
  produced, and lasts as long as the operation does. The **banner** says why what you are
  looking at is wrong or empty, and **never shows more than one thing at a time**. The
  **installation panel** holds what is true of the install. What does not fit the banner's
  single slot goes to the panel, which holds it anyway — so capping the banner loses nothing.
- **The banner's order is causal, not a ranking.** A missing currency and a running
  reconstruction can never both need to speak: while the currency is unset no performance is
  written and no price converted, so the reconstruction has no figure to excuse. Answering
  frees the slot for it.
- **The header indicator is a state, not a count.** A counter stuck at one is the noise the
  badge rule was written against; a dot indicates without demanding, and it is the only
  global hold an ephemeral install has on its own condition once its modal is closed.
- **A missing base currency is a live condition, not an advisory**, which settles a
  contradiction three closed decisions carried between them: it was declared
  unacknowledgeable, counted among the acknowledgement table's keys, and rendered as an
  advisory with a gesture — together producing a permanent badge. The rule that separates
  them: **the banner shows conditions the owner can end; the badge counts facts they can
  only acknowledge.** The acknowledgement table therefore holds **five** keys, not six.
- **The exported ledger states its currency**, so a round trip cannot silently reinterpret
  every amount. An import that declares one where the store has none **sets** it — the app
  reads a declaration rather than asserting one, and that is what makes the headless round
  trip work without a single `curl`. On a disagreement it refuses, and offers to adopt the
  file's currency only while the ledger is still empty.
- **Nothing new in the API, and no route changes.** The two predicates are already
  published; a fourth kind of absence would make every page depend on one preamble, and a
  landing route that varies with the data is the one thing a bookmark cannot survive.

[Full argument: #681](https://github.com/pbrissaud/suivi-bourse/issues/681) ·
[the currency it guards: ADR-0002](./0002-one-base-currency.md) ·
[the onboarding it inherits: ADR-0005](./0005-every-position-is-historied.md)
