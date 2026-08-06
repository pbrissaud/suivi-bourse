# The performance series is a cache, not a record

The account and portfolio performance series are a **pure function** of the ledger,
the price points and the declared accounts — all three in the store since ADR-0006 —
and a full recompute costs about 460 ms at five years (0,4 % of a 120-second cycle).
They are therefore treated as a cache: recomputed and rewritten in full on every
cycle, with no change-detection gate and no incremental write window.

Both mechanisms that existed to avoid this were workarounds for InfluxDB and both lost
their subject: the gate existed because recomputing was expensive (ADR-0010 made the
read 365 ms and *constant in age*), and the incremental write existed because the file
grew without bound (ADR-0001 made it an upsert on a primary key, 3 ms). Naming the
series a cache also dissolves the one argument for keeping the incremental write —
that it bounds what a faulty recompute can damage. One does not protect a cache; one
rebuilds it.

## Consequences

- **The write is an upsert plus a bounded prune**, never a delete-then-insert. Measured
  over 1 000 cycles, a full replace grows the file to 44,8 MB for a 1,6 MB table
  (~11 GB/year, and a checkpoint does not return it); the upsert caps at 1,1 MB and is
  3,6× faster. The prune removes only what falls outside the written set, catching the
  deleted account along with the orphaned day.
- **The write must be a bulk statement, not a loop.** The same 5 478-row upsert does not
  finish in two minutes row by row, and takes 3 ms in bulk.
- The series is **dense over calendar days**, weekends included. The "no point on a
  non-trading day" property belongs to observed prices, not to a derived daily series —
  and time-weighted return chains over consecutive days, so a weekend deposit needs
  somewhere to land.
- A rebuild needs no gesture: delete the rows and the next cycle rewrites them.
- Performance is written for **every** account, and the opt-in guard is replaced by a
  per-field condition — holdings value always, cash-derived fields only where a cash
  ledger exists. A Prometheus gauge for an absent field is **not published**; zero
  would make "no ledger" indistinguishable from "an empty ledger".
- The recompute interval stops being a setting.

[Full argument: #687](https://github.com/pbrissaud/suivi-bourse/issues/687)
