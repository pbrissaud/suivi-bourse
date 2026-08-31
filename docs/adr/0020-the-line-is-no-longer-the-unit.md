# The line is no longer the unit: the data page revokes rather than repairs

The administration page was built around the faulty row. The inline editor, the opaque
token over `(file, sheet, row)`, the content fingerprint as an `ETag` and its `409` all
existed because a malformed line lived *in* the truth, and the page was where it got
repaired.

With the store as the truth there is never a malformed row in it — a bad file is not
imported at all — so that whole apparatus loses its subject at once. What replaces it is
not another per-row gesture: it is **the import as a unit**. The page stops being a
repair surface and becomes a revocation surface.

Three separate decisions followed from that shift, and all three were settled in front
of a mockup built on the real 285-event portfolio, **against** what the interview had
concluded:

- **The padlock is not a column.** Read-only was to be shown per row; rendered, 285 rows
  out of 285 carried an identical lock. A row that carries a provenance came from a
  file; a row that carries none came from the UI. The information was already there, in
  the one column that actually discriminates.
- **"Forget this import" is not offered from a row.** Three consecutive rows showed the
  same red *Forget this import (214)* button. The subject of the gesture is the source;
  repeating it on 214 rows makes a bulk action read as a row action, and someone deletes
  214 events believing they are removing one. Provenance becomes a link to the import
  block, where the single button lives.
- **The identity column is not the security.** 278 of 285 rows carry a free-text label
  (median 36 characters), and on a deposit or a withdrawal **there is no symbol at all** —
  the label *is* the identity. One column does the identity work for both families of
  event, and the full-text search beside it stops being a convenience: on nineteen
  identical purchases of the same ETF, the label is the only discriminant the row has.

## Consequences

- **A per-row marker that does not discriminate is noise, however correct it is.** Two
  independent page tickets produced this same defect under two names — a market-state
  pill per row, a read-only padlock per row. The rule now lives in
  [ADR-0016](./0016-conventions-are-explained-on-the-figure.md).
- **The page is two tabs under one route**, split by what the user *declared* against
  what the installation *is* — ADR-0014's boot test transposed to the render. A tab is
  not a page, so the four-page cut holds. A block with nothing in it does not exist:
  neither the notices, nor the orphan list, nor an empty ledger — which is replaced by
  two entries of equal weight, the create form being the onboarding (ADR-0005).
- **Provenance is worth a label and a revocation unit, never an address.** The file's
  presence on disk is never shown: the drop folder is an optional read-only bind
  (ADR-0015), so "file not found" would be a permanent false defect on any install
  without one. For the same reason a forget is never announced as reversible — the app
  cannot know whether the user still holds the file.
- **An imported event's account column is writable exactly once**, when the first
  account is declared. This is not a hole in the read-only rule but its counterpart: the
  file was *right* under the rule in force when it was imported, and the app changed the
  rule underneath it. A mapping layer beside the events was refused — it is a second
  truth about which account an event names, which ADR-0006 forbids.
- **Settings are one surface, not two.** The registry draws the form and the effective
  configuration alike, so the separate effective-configuration card disappears. The
  environment half is a description, not a disabled form.
- **The store states its size and what that size will not do**: purging returns rows,
  not bytes — measured at 79 % of rows deleted for zero bytes recovered. Hiding the
  figure does not remove it, only its explanation.

[Full argument: #686](https://github.com/pbrissaud/suivi-bourse/issues/686) ·
[the apparatus it retires: #662](https://github.com/pbrissaud/suivi-bourse/issues/662) ·
[the constraint it discharges: #685](https://github.com/pbrissaud/suivi-bourse/issues/685)
