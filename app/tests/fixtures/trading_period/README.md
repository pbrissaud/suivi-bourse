# A real `currentTradingPeriod`, read after the close

`bnp-pa-2026-08-12.json` is the observation issue #769 rests on, and it is here
rather than inline in the test for the reason `fixtures/mountinfo/` exists: the
defect is a **field that means something other than what its name suggests**, and
a hand-written dict says whatever the person writing it already believed.

It is the reading taken on `BNP.PA` on **2026-08-12 at 20:47 UTC**, Paris closed
since 15:30 UTC, transcribed from the ticket's measurement:

| Field | Value | Relative to the reading |
|---|---|---|
| `marketState` | `POSTPOST` | ∈ `scheduling.CLOSED_STATES` |
| `currentTradingPeriod.pre.start` | `1786518000` — 07:00 UTC | past |
| `currentTradingPeriod.regular.start` | `1786518000` — 07:00 UTC | **past** — what `_current_regular_open` reads |
| `currentTradingPeriod.post.start` | `1786548600` — 15:30 UTC | past |

The two halves are keyed as `extract_market_context` takes them — the `info`
mapping and the `history()` metadata — so a test hands the file straight to the
function under test with nothing composed on the way.

Three things about the file are deliberate:

* **Only the three fields the reading recorded are in it.** `regular.end`,
  `post.end` and the fundamentals of the quote would all be plausible and none
  of them was measured; a capture that invents its surroundings is a
  hand-written dict again. The parser is defensive by design, so their absence
  exercises the file exactly as the real payload would.
* **The reading is *after the close*, which is the side of `now` the suite never
  had.** `test_extract_prefers_exact_next_open_from_history_meta` pinned
  `ts = 1_700_000_000` — 2023-11-14, *before* the test's `NOW` of 2024-01-15 —
  and asserted the returned `next_open` equalled it: a past date, handed to
  `decide`, is `SHORT_RETRY`. The case was not outside the sweep; it was inside
  it with the defect pinned as the expected answer. Which is why the successor
  test reads **one** capture at **two** instants rather than adding a case beside
  the old one.
* **The dates are in the future of the repository, not of the reader.** The
  reading was taken on the day the ticket was written; the test injects its own
  `now` either side of that day's open, so nothing here goes stale.
