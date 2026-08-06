# A stored point's resolution is a function of its age

Price history is kept on a three-rung ladder: as written under one year, hourly from
one to two years, daily beyond. The collapse happens **in place**, as a step of the
backward backfill pass, with the last point of a collapsed day surviving — and there
is not a single setting.

The third rung costs 0,8 MB and buys the thing that matters: it makes reconstruction
and ageing implement **the same function of age**, one on each side of the present, so
a fresh install and a mature one *converge* instead of being declared similar.

The measured justification is not the one that was expected. A purge returns **no
disk**: 126,0 MB before and after deleting 79 % of the rows, where the same content
built fresh occupies 26,0. It **caps** rather than reclaims — blocks are reused. Its
real product is that everything becomes constant in the age of the install: at twenty
years, 34 MB and 584 ms for the daily pass instead of 500 MB and 6 673 ms.

## Consequences

- **The ladder is a ceiling, never a floor.** It says "no finer than X at age Y"; it
  fabricates nothing. A gap filled at nine months of age arrives hourly and stays
  hourly.
- **Fine resolution can only be obtained by having been there.** Yahoo sells nothing
  below hourly past 60 days, which makes sampling *at write time* the only
  irreversible decision available — and therefore the one that was refused.
- The API announces the **effective** resolution served, so a sparse chart does not
  read as an outage. The rung boundary itself is not marked on screen: it produces no
  wrong figure, only fewer points.
- Price points for a symbol no longer named by any event are **kept** — forgetting an
  import is reversible, a fine-grained series is not — and must be visible and purgeable
  on demand.

[Full argument: #688](https://github.com/pbrissaud/suivi-bourse/issues/688)
