# The ledger loads in pages, and only the first one is silent

The ledger tab is one table and one band above it. On the dev's real portfolio that
table is 285 rows, which renders whole without anyone feeling it — and rendering it
whole was the alternative, argued and refused. The table reveals forty rows at a time
instead, with a sticky header, a bounded scroll, a *load more* control and a count of
what is shown.

**The paging is a rendering budget, not a fetch, and that is the whole of why it is
safe.** `GET /api/events` answers from the published snapshot in process memory rather
than from the store — which is why it has no `503` and why its three states are `200` +
rows and `200` + `[]` — and it answers with the ledger entire. There is one read, and
after it lands nothing further is requested. Paging the resource was never considered:
it would give the shares page's chart markers, its second consumer, a contract they read
no ledger about.

This is still the product's **first paginated surface**, and it lands beside the one rule
that has already been broken six times.
[ADR-0026](./0026-a-read-in-flight-is-not-an-absence.md) says a block waiting on a needed
read renders nothing at all, title included, and `readsInFlight.test.tsx` enforces it by
replaying each route with that read hanging for ever and reading **every rendered phrase
carrying a word** — not only the emptiness markers. A spinner, a *40 of 176 loaded* and
an *end of the ledger* are three sentences about the reader's own data, and the net sees
all three.

The distinction that makes the two compatible is **which flight it is**.

## Consequences

- **The first page in flight renders nothing, headers included.** There is no skeleton
  here as there is none anywhere: a frame with an empty body *is* a hand-written
  skeleton. The table appears by a jolt, and the cost is accepted as ADR-0026 accepted it.
- **Once the read has landed, the table may speak freely.** *Load more* and the count
  describe rows the app already holds, so they are not claims made on a silence and the
  in-flight rule is not even in contention. The distinction is *the read* against *the
  reveal*, and only the first of the two is a fact about the reader's data.
- **There is no spinner anywhere in this.** `_Avoid_: loading, pending, spinner,
  skeleton` is not softened by the surface being paginated, and here there is not even a
  wait to dress: the next forty rows are already in memory.
- **The count and the end-of-ledger sentence are true of the reduction, not of the
  store.** The type and account chips are a *reduction*: it states itself with what it
  names and offers the way out, so both sentences count what the reduction holds and move
  when it moves. A table silently shorter than expected stays the defect it always was.
- **The alternative was to render all 285 rows**, which costs nothing at this size and
  which this record refuses to pretend was wrong. It was traded for a table that stays
  fast at ten thousand events, on a page whose only function is that table — and the
  trade is worth writing down precisely because the rendering rule above is the kind that
  breaks in silence when the next contributor adds a spinner back.
[The rule it extends and the net that holds it: ADR-0026](./0026-a-read-in-flight-is-not-an-absence.md) ·
[the tab it lives in: ADR-0030](./0030-the-data-page-has-three-tabs.md) ·
[the repair surface it replaced: ADR-0020](./0020-the-line-is-no-longer-the-unit.md) ·
[the spec that carries it: #787](https://github.com/pbrissaud/suivi-bourse/issues/787) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
