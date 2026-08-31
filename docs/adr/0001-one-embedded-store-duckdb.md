# One embedded store, and it is DuckDB

InfluxDB 3 Core caps a query at 432 Parquet files and leaves compaction to Enterprise;
a dev stack with two symbols had accumulated 4 057 files for 40 MB, at which point a
90-day query failed and an unwindowed one failed hardest — including the "current
holdings" query the UI is built on. v5 therefore replaces both InfluxDB *and* the
configuration files with a single embedded store, and the bake-off chose **DuckDB**:
measured at up to 17 M rows it was 5–30× faster on every analytical read and 18 vs
77 bytes per row on disk, and its supposed weak axis — small frequent writes, 2,17 ms
p50 — has four orders of magnitude of margin against a scheduler committing 0,42
times a second.

## Consequences

- **DuckDB refuses a second process**, even read-only. That is a real operability
  cost the project accepts: no `duckdb` shell against a running install.
- Finding the newest row per series is a **scan**, growing with history, so a `latest`
  row per series maintained by the writer is a hard constraint on the schema — not an
  optimisation to add later.
- A declared-but-never-written column reads as `NULL`, not as absent, which retires
  the whole class of "select only the columns that exist" defensive reading.

[Full argument: #670](https://github.com/pbrissaud/suivi-bourse/issues/670)
