# A key names a row for as long as the row lives, and no longer

`event.id` and `import_source.id` are allocated as `max(id) + 1`, so deleting the
highest row frees its key for the next writer. The reuse is not exotic:
`import_file` takes its `max(id) + 1` *after* deleting its own source's rows, so
re-dropping a file typically reuses the very range it just released — and where
that file was the store's only source, numbering restarts at 1.

What made this a decision rather than a defect is that a **written argument
rested on the opposite**. `events/schemas.py` justifies retiring #662's opaque
token — the fingerprint in an `ETag`, its `409` — on the grounds that *"a key
does not go stale between the read and the write"*. That sentence is false, and
it is load-bearing.

**A key is an address, never an identity.** It names one row while that row
exists, and the store promises nothing about it afterwards. Everything else
already behaved that way and only the prose disagreed: the id is absent from the
CSV export, so an event exported and re-imported comes back under a new key by
construction; and an imported row's key is rewritten on every re-import.

**What replaces the false promise is a refusal, not an identity.** A write
aiming at a row that has gone must never silently succeed — which is a property
of the exchange, and `_require_typed`'s `UnknownEntry` already states it. What
was missing is that the key it lands on must not have been handed to something
else in the meantime, so the store hands out a **monotonic** key: one allocator,
seeded from `max(id)` on first use, which never descends when rows are deleted.

## Consequences

- **The guarantee is scoped to the life of the process**, and that is the whole
  of what was bought. The counter is memory, not a row: a restart re-seeds from
  `max(id)` and a key freed before it can be reissued. A client holding a key
  across a restart is holding it across an app that went down, which is not the
  window this record is about.
- **The reachable half was `import_source`, not `event`.** The interface carries
  both gestures that matter there — `forgetImport` on the imports panel, and the
  drop folder creating a source — while it carries no delete for an event at
  all. With a 30 s `staleTime` and no refetch on focus, a stale panel could
  forget a *different* import than the row it displayed, and what that destroys
  is a file of events rather than a line.
- **No sequence, and no thirteenth table.** `ledger.py`'s original reasoning
  survives — a sequence is a second thing to keep in step with a DDL that has no
  migration machinery — and it now carries the half it was missing. A durable
  high-water mark was available in `setting` and refused: the configuration path
  owns both tables so ADR-0006 was never the obstacle, but `CONTEXT.md` defines a
  setting as *a dial the owner turns*, and a counter is not one.
- **The retired token stays retired.** Making the client send back what it read
  would satisfy the same requirement and would be #662's apparatus under another
  name. It is still available if the scoped guarantee ever proves too small; it
  is not paid for now.
- **One allocator, held on the source.** The defect lived in an expression
  copied to three sites. A test reads `src/` for a second one, because a fourth
  writer would copy it again and nothing would say so.

[Full argument: #785](https://github.com/pbrissaud/suivi-bourse/issues/785) ·
[the token it re-examines: #662](https://github.com/pbrissaud/suivi-bourse/issues/662) ·
[the row that stopped being the unit: ADR-0020](./0020-the-line-is-no-longer-the-unit.md) ·
[one writer per table: ADR-0006](./0006-declaration-and-derived-state-never-share-a-row.md)
