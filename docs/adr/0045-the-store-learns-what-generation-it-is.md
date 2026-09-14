# The store learns what generation it is, and gains a way to move between two

Until [#926](https://github.com/pbrissaud/suivi-bourse/issues/926) the store had **no
notion of a schema generation**. No version column, no `schema_version` table, no
`user_version`; `prepare()` inferred one bit and no more — `is_new = 'account' not in
existing`. The stated rule was *"the DDL is applied with `IF NOT EXISTS` and there is no
migration machinery"*, and every schema change of v5 was shaped around that absence
rather than by what the model wanted.

**This record reverses that rule.** The decision was taken during
[ADR-0043](./0043-the-account-type-stops-being-a-question.md)'s grilling: #916 had just
removed the account type from every question the app asks, and the column stayed behind,
`NOT NULL`, written with a seeded word no reader had. The shortest way to remove a
column the app no longer reads turned out to be a mechanism the project will need for
its own sake anyway — so the rule went rather than the column staying.

## The rule that replaces it

- **The `IF NOT EXISTS` DDL is still the first answer**, and a new table still costs
  nothing on a store that predates it ([ADR-0044](./0044-a-new-fact-lands-in-a-new-table.md)).
- **What the DDL cannot express is a *step***: dropping a column, renaming one. Steps
  live in one ordered, append-only list, `store.STEPS`, and nowhere else.
  `.github/scripts/conventions.sh` holds that on the source — `ALTER TABLE` appears in
  `store.py` or the build fails.
- **A step's name is its identity forever.** Renaming one runs it a second time; a
  released step is never edited, because the stores that ran it will not run it again.
- **Forward only.** This app has one writer and no fleet, and a downgrade is a promise
  nobody can keep about data a newer version wrote.
- **Every step is a no-op where it is not needed**, so a file created today walks the
  same list, changes nothing and records the same marks as one brought forward. There is
  one generation, not two.

## Generation zero is unlabelled

Every store in the wild predates the marker and none will ever carry one retroactively,
so **the absence of a mark is the first generation** rather than a missing one. The
mechanics follow from that: `schema_step` is declared by the `IF NOT EXISTS` DDL like
any other table, and the steps are asked for a line later — so the question *what has
this store already run* is answerable on a file that had never heard of the table,
without a probe and without an error to catch.

The marker is **one row per applied step**, not a counter. A counter would have to be
reconciled with a list anyway, and a ledger of names says which steps ran, in a store
whose entire product is a ledger of what happened.

## Atomicity, and what a failure leaves

Each step runs **inside its own transaction, with its own mark inside it**. DuckDB's DDL
is transactional, so a step that raises rolls the schema and the record of it back
together, and the store is exactly what it was down to the mark. The failure then
propagates: `open_store` turns it into `StoreUnavailable`, because a store the app could
not bring forward is a store it must not serve from. The alternative — a store that
believes a step ran and carries half of it — is the one state this mechanism exists to
make impossible.

## The first step, and why it is that one

`drop_account_type`. #916 left the column written by the app and read by nobody, so the
step has **no reader to break**: it proves the mechanism before anything that matters is
handed to it.

It is not an `ALTER`, and that is the thing worth recording. DuckDB refuses to alter a
table another one references, and five point at `account`. So the tables holding a
foreign key on it are copied aside and dropped, the column goes, the DDL declares them
again with their keys, and the rows go back.

**That gesture is `store.rebuilding`, a context manager, and it is deliberately not part
of the step.** Almost every table worth altering here is referenced by something, so the
next step that touches one pays two lines rather than fifteen:

```python
with rebuilding(connection, 'account'):
    connection.execute('ALTER TABLE account RENAME COLUMN label TO name')
```

**Who depends on what is asked of the catalogue, never listed in the code.** A
hand-written list is right until the next table is declared, and it would be wrong on
exactly the stores a step runs on: old ones, opened once, by an app whose CI only
exercises fresh files where every step is a no-op. The failure would be permanent, too —
the rollback means the next boot fails identically.

Two consequences a later step will meet again:

- **The copies are real tables, not `CREATE TEMP`.** A temporary table lives outside the
  caller's transaction, so the rollback that makes the step atomic would leave the store
  without its ledger and the copy still holding it.
- **The derived tables are carried across rather than left to rebuild.** They would come
  back on the next replay, and between the boot and that replay the owner would read an
  empty product. A schema step is not a thing anybody should notice.

## What the next change costs

Worth stating, because the point of reversing a rule is what it makes cheap:

| The change | What it takes |
|---|---|
| A new table, a new column on a new table | Nothing — the `IF NOT EXISTS` DDL, as before |
| Drop or rename a column nothing references | One line in `STEPS` |
| Drop or rename a column on a referenced table | Two lines, inside `with rebuilding(...)` |
| A data repair | Not a step — a predicate that widens, as `fx.py` does |

There are no migration *files*, no generated revisions and no ordering graph, and that is
the trade: a list in one file is read in one glance and cannot drift out of order, and it
is a poor answer the day this project has a schema big enough to need a directory. It does
not, and the mechanism is small enough to replace when it does.

## What this does not buy

**No simplification wave.** The designs the old rule justified do not become wrong the
day steps exist: `twr_since`, `transfer_fees`, `ytd` and `closed_at` derived at read
time, the rhythm figures derived on every read, `advisory_ack` being a table rather than
a column. Deriving stays the better answer where it is used. **What changed is that *not
deriving* stopped being forbidden** — and a mechanism being available has never been a
reason to route through it.

`account.source_id` proves the point by staying: it is inert residue on older stores,
#926 wrote no step for it, and none was owed — nobody reads it and it constrains nobody.
`account.type` earned one because it was `NOT NULL`: the writer had to keep feeding it a
word no reader had.

**A rebuild is not that surgical, and the record says so rather than discovering it
later.** `event`'s three provenance columns are the same kind of residue, and they do not
survive `drop_account_type` — the step rebuilds `event` from the current DDL, and a table
recreated from the DDL is the DDL's table. So a step that reconstructs a dependent
carries that dependent to today's shape whether or not it meant to. That is the price of
the reconstruction the FKs impose; it is acceptable here because those columns have been
read by nothing since #816, and it is the first thing to check when the next step lands.

The corollary is the rule that makes the rows go back at all: **by shared column name,
never by position**. The oldest stores in the wild are the only ones a step runs on, and
they are exactly the ones whose tables are widest.

**No downgrade path**, stated above and stated here because it is the thing somebody will
ask for first.

## The records this amends

Five leaned on the old rule by name, and each is amended in place with *why* it changed
rather than only *what* to:

- [ADR-0008](./0008-no-upgrade-from-v4.md) — nothing migrates *from v4*, which is about a
  different product's data and is untouched by a mechanism that moves one v5 store
  forward.
- [ADR-0014](./0014-settings-live-only-in-the-store.md) — a later dial is still an insert
  at boot, not a step.
- [ADR-0027](./0027-a-key-names-a-row-for-as-long-as-the-row-lives.md) — the mark is
  still memory and not a row.
- [ADR-0037](./0037-notifications-have-a-space-and-the-banner-has-none.md) — the
  acknowledgement is still a table, and now for its own reasons alone.
- [ADR-0041](./0041-the-rhythm-is-measured-on-the-buys.md) — the rhythm figures are still
  derived.
- [ADR-0044](./0044-a-new-fact-lands-in-a-new-table.md) — which wrote its own amendment
  in advance, and this is it: the convenience paragraph stops being true, the three
  properties do not.

The pattern in all six is the same sentence. The old rule was a *constraint* that happened
to produce the right design; what is left is the design, standing on the argument that was
always underneath it.

## Consequences

- **Fifteen tables**, `schema_step` being the one that is about the store rather than
  about the portfolio.
- **`account` is two columns**, and the row the app writes and the row the store holds
  finally say the same thing.
- **`conventions.sh` gains its first clause on this rule**, which the rule it replaces
  never had — it was the one large rule of this project that lived only in prose.
