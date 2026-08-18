# A read in flight is not an absence

*A read that has not landed is not a fact* was stated when #718 removed the default from
the dashboard's head. It has since been restated **six** times, in six spellings — `!positions.data
|| !totals.data`, `settled`, `positions === null`, `!accounts.data`, `!events.data`, and
one more — each with the same sentence recopied in a comment beside it. Four blocks written
in between missed it, and the pattern has a mechanical cause: the rule lived in **prose**,
so every block reimplemented it by hand, and nothing made it true by construction or false
in a test. The suite could not see it either — every block test `waitFor`s the value it
expects, so not one of them ever exercises the in-flight state.

The rule is therefore given a **name**, a **shape at the props boundary**, and a **test that
enumerates itself**. It is not given a primitive: the six sites that hold it are six correct
sites, not six competing conventions, and a component wrapping them would be the seventh
spelling — the exact disease, one level up.

## Consequences

- **A block waiting on a needed read renders nothing at all, title included.** No frame, no
  placeholder: a frame with an empty body *is* a skeleton written by hand, and this product
  has none — if one is ever owed it arrives once, in the shell, never per page. The cost is
  accepted and it is visible: a slow block appears by a jolt rather than fading in.
- **A read in flight never crosses a prop as `[]`.** The page passes `?? null`, never
  `?? []`, and the block decides; where the flattening happens upstream of the prop, the
  honesty goes upstream with it. The shape is `readonly X[] | null`, which `tsc` does **not**
  close — `?? []` satisfies it. That is the trade: the front keeps one idiom instead of
  gaining a second, and what closes the class is the **two tests** below rather than the
  compiler.
- **The test is driven by the routes, not by the blocks.** For each page, the routes it
  actually requests are recorded, then replayed one at a time with that single read left
  unresolved, asserting an **absence**. A block added later that reads an already-served
  route is covered the day it is written, by nobody's discipline. The test fails if a route
  of the client's own table is visited by no page — otherwise a request armed under a
  condition false by default leaves the net in silence.
- **And the one member the net cannot see is held on the source** (#778). *In flight* and
  *landed and empty* are identical on screen wherever a block renders nothing in both — the
  first consequence above crossed with *a block with nothing in it does not exist* — so no
  marker is emitted in either state and no assertion about what a reader perceives can tell
  them apart. Three of the four occurrences are held by the net; the fourth is held by
  neither support, and a contributor rewriting one `?? null` reintroduces it with every gate
  green. A second test therefore builds the app's own program and asks the checker what each
  slot was **declared** to hold: a slot of the family — `readonly X[] | null`, and nothing
  else in the union — handed a value that cannot be `null` is the defect, at **three doors**:
  a prop, a declared local and an argument, the last two being the same *upstream* clause as
  above, since a page can flatten one line before the prop or on the way into the very
  function that decides the state. It reads types rather than text, so it is blind to no
  spelling and fires on none of the optional `?? []`; it judges no property assignment, a
  slot wearing the shape for another reason (*no reduction* rather than *not read yet*)
  being something it cannot know. Its coverage half is **per door**, a total hiding two of
  the three. The two exits it was chosen
  against are refused where they stand: a **visible marker** on the landed-and-empty block
  would separate the two states for the net at the cost of a rendering this ADR and #724 both
  refuse, and a **type that closes at the compiler** (`Read<T>`) puts two idioms on one page
  for one rule — the second idiom this decision exists not to gain.
- **What it observes is the emptiness primitives**, marked by an attribute rather than a
  role: an empty state is a state, not a change to announce, and the banner already owns
  `status` on the page. Totals and counting sentences stay in the block's own test — they
  are too bound to the block's meaning to be seen from outside.
- **The distinction between a *needed* and an *optional* read (#718) is kept, and it is the
  reason a sweep is not a rewrite.** An optional read absent removes a line; it must never
  start withholding a block. So `?? []` survives where the read is optional — and it is
  **there** that the comment goes. The exceptions are annotated, never the compliant sites,
  which after repair all look alike.
- **N reads for one object are waited for together when the object *is* the comparison.**
  An account arriving late moves the window every curve is rebased on, so the chart and the
  column that shares its arithmetic wait for all of them; a panel about one account waits
  only for its own. A column of that table neither disappears nor fills with dashes while
  its read is in flight — its cells render nothing, and the two pure functions that decide
  a column's presence and a row's degraded reason both learn the state, without which
  repairing the column invents a false sentence on every row.
- **A `null` that meant two things stops meaning two things.** The gain's fourth term is
  `0` when a broker moves money for free and `null` when there is no day to bound it by;
  counted as zero, the second produced a four-term total rendered from three, with nothing
  on screen saying so. The sum now carries **its reason** — the shape it already had for an
  unresolved rate — and no fifth kind of absence is created: the unbounded term and the
  total above it wear the em dash, which is what *there is nothing to compute* is for.

[Full argument: #775](https://github.com/pbrissaud/suivi-bourse/issues/775) ·
[the member the net cannot see, held on the source: #778](https://github.com/pbrissaud/suivi-bourse/issues/778) ·
[the four absences it is not one of: ADR-0016](./0016-conventions-are-explained-on-the-figure.md) ·
[no fourth kind of absence: ADR-0021](./0021-the-app-asks-one-question.md) ·
[the total whose fourth term this repairs: ADR-0018](./0018-the-gain-has-four-terms.md)
