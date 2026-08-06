# Constraints go where the error enters, not where the rows pile up

The price-point table carries **no primary key and no foreign key**. This looks like
negligence and is not: in DuckDB an ART index is a second copy of the data whose
buffers are not buffer-managed, so a primary key costs +563 MB of *resident memory*
on a 319 MB base, a foreign key +153 MB more, and an integer surrogate key saves
nothing — the cost follows row count, not key width.

Uniqueness moves to the writers instead: delete the chunk, then insert it, measured at
3 ms. That is safe by the same argument that already bounds the forward gap-fill. And
the integrity the index would have bought is bought for free elsewhere — the price
table is the only one no human-written file feeds, so a typo'd ticker is caught on the
event row, where it enters.

## Consequences

- Small tables (accounts, positions, the performance series) **do** keep their keys —
  the memory cost follows row count, so a few thousand rows cost nothing and the
  constraint earns its place.
- The performance series' primary key is a *write mechanism* (upsert), not merely an
  integrity constraint — see ADR-0011.

[Full argument: #676](https://github.com/pbrissaud/suivi-bourse/issues/676)
