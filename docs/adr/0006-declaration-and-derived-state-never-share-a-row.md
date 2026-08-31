# Declaration and derived state never share a row

The schema's organizing rule: a row is written by exactly one path. What the user
declared (imports, accounts, symbols, events), what the event replay derived
(positions, account state), what the scrape and backfill observed (quotes, price
points), and what the performance job computed (account and portfolio series) each
own their own tables. Where two writers appeared, the answer was two tables — never a
lock.

The rule settles several questions at once, and dissolves the same problem twice. Most
visibly, **the price series loses the account dimension entirely**: once position
fields leave the price point, nothing account-shaped is left on a market observation,
and the row count drops 25 % before any retention decision is taken.

## Consequences

- A market price belongs to no account. Any query joining prices *by account* is a bug.
- The `latest` row required by ADR-0001 merges into the per-symbol quote row under one
  maintenance rule that covers the live write, the forward gap-fill and the currency
  repair in a single sentence.
- Watermarks are **derived**, not stored — with one named exception (ADR-0009), where
  the argument "it recomputes itself" fails because no rows exist to recompute from.
- The runtime status of the scheduler stays in process memory and never enters the
  store: answering from memory is what lets it explain a query failure.

[Full argument: #676](https://github.com/pbrissaud/suivi-bourse/issues/676)
