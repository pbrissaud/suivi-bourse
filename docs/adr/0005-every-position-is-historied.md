# Every position is historied: manual mode is removed

v4 offered two mutually exclusive configuration modes — a static list of aggregated
positions (`config.yaml`), or a ledger of dated events. v5 keeps **only the ledger**:
six event types, `date` mandatory everywhere, and no unhistoried position at all.
Whoever does not know their dates writes a purchase at their best estimate.

The middle path — a single ledger where a position with no events is a position with
no history — was refused, because it cannot be built without either an undated opening
entry or a third writer on a position row that already has two.

## Consequences

- **The price is stated rather than hidden.** An estimated date is indistinguishable
  from a known one, so money- and time-weighted returns can be wrong with no way for
  the app to know or say. Its counterweight is one sentence on screen: *returns are
  computed from the dates of your events*.
- "Manual" survives as an **input method**, not a mode: typing a position means
  creating dated events, so the create form stops being a convenience and becomes the
  onboarding.
- Removing the mode deletes four degraded page states, not one loader branch.
- This is the one v5 simplification that does **not** also fix a wrong figure — it
  moves a correctness burden onto the user.

[Full argument: #674](https://github.com/pbrissaud/suivi-bourse/issues/674)
