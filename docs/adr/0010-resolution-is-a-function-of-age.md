# A stored point's resolution is a function of its age

Price history is kept on a three-rung ladder: as written under one year, hourly from
one to two years, daily beyond. The collapse happens **in place**, in one statement
over the whole table, with the last usable point of each bucket surviving — and there
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

- **The pass belongs to the backfill job, and runs before its window check rather
  than inside its loop** ([#705](https://github.com/pbrissaud/suivi-bourse/issues/705)).
  Its subject is the **table**, not this cycle's holdings: the rows that most need
  keeping are those of a symbol no event names any more, and those are exactly the ones
  the loop never visits — a ladder inside it would leave the finest series in the store
  the one nobody can see. `price_point` carries no index (ADR-0007) either, so
  `WHERE symbol = ?` is a full scan and N symbols would be N scans of the same rows;
  one statement partitioned by `(symbol, bucket)` pays for one. It stays in this job
  rather than becoming a fifth because it **writes `price_point`**, which is the past
  this job already owns. It is idempotent and carries no watermark, which is what lets
  it ride a sixty-second cycle and what makes a failed pass cost nothing but a series
  that stays too fine for another minute.
- **The survivor of a bucket is its last *usable* point**, and the qualifier is the
  rule. The bucket is the hour on the `hour` rung and the UTC day beyond it. Ranked
  flat by instant, a bucket holding a converted point at 10:00 and an unconverted one
  at 17:00 keeps the unconverted one — and the day then vanishes from every reader that
  means *money* by *the price then*, which moves a symbol's earliest converted day
  forward, widens its block in the horizon and has the prune drop days. So the ranking
  is **converted first, then the latest instant**: `price_series` and `daily_closes`
  are preserved to the value, and the chart gains a point where it drew a gap. A bucket
  with no converted point at all keeps its last one, native price and all — throwing it
  away would be the ladder deciding a conversion will never land.
- **The ladder is a ceiling, never a floor.** It says "no finer than X at age Y"; it
  fabricates nothing. A gap filled at nine months of age arrives hourly and stays
  hourly.
- **Fine resolution can only be obtained by having been there.** Yahoo sells nothing
  below hourly past 60 days, which makes sampling *at write time* the only
  irreversible decision available — and therefore the one that was refused.
- **A reconstruction buys the hourly band only if it asks for it on the right side of
  the ceiling.** The interval is chosen once per fetched chunk, off its oldest day,
  so a chunk straddling Yahoo's 729-day ceiling is bought entirely in daily bars —
  which is what the default chunk on an anchor starting at today did, missing the
  ceiling by a single day and returning the whole 1–2 year band daily (#783). Both
  fetching passes therefore **cut a straddling window on the ceiling** — the
  backward one by raising its start, the forward one by lowering its end, the two
  walking opposite ways — for no extra request and one more cycle for the symbol.
  The forward pass needs it whenever the gap it closes is wider than two years: an
  install rallied after a long stop, or a line bought back after years out of the
  portfolio, whose backward pass is terminal and which nothing else fills. **The
  repair is worth only the reconstructions still to come**: the ladder is a ceiling
  and never a floor, so it fabricates nothing, and past 729 days the hour is no
  longer sold — what an install has already reconstructed daily stays daily, for
  good.
- The API announces the **effective** resolution served, so a sparse chart does not
  read as an outage. The rung boundary itself is not marked on screen: it produces no
  wrong figure, only fewer points.
- Price points for a symbol no longer named by any event are **kept** — forgetting an
  import is reversible, a fine-grained series is not — and must be visible and purgeable
  on demand.

[Full argument: #688](https://github.com/pbrissaud/suivi-bourse/issues/688) ·
[where the pass runs, and which point survives: #705](https://github.com/pbrissaud/suivi-bourse/issues/705) ·
[the straddling window: #783](https://github.com/pbrissaud/suivi-bourse/issues/783)
