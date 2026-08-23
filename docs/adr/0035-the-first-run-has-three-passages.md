# The first run has three passages, and its memory is the browser's

ADR-0021 settled that the app asks **one question** — the base currency, the only setting
with no default — and that *first run* is a predicate rather than a moment. The question
survives; the single screen does not. The first run now walks three passages in order: the
**required settings**, the **accounts**, and the **first events**.

**This reopens a decision that was argued and refused**, and the refusal is quoted here
rather than stepped over. `docs/v5-decisions.md`, issue #726: *"Three independent steps on
three predicates were refused for one reason: they reopen the onboarding screen, the
explanation of the product included, on somebody who has used the app for six months and
has just revoked their imports."*

The trigger it names is gone — revoking an import no longer exists
([ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md)) — but the **state** it feared is
not: the bulk delete that same record introduces empties a ledger just as thoroughly, six
months in. So the refusal is answered on its merits, not dismissed as obsolete. What
reopened the screen was never the number of steps; it was **deriving the screen's own
existence from the data it is about to collect**. Break that link and three passages cost
nothing.

## Consequences

- **The server keeps deriving; the browser keeps the memory.** The predicate stays what
  ADR-0021 made it — a required setting unanswered — and it is `localStorage`, the same
  mechanism already carrying the modal's dismissal, that records *this reader has been
  through*. A wiped store asks again, which is correct; a second browser sees it again,
  which ADR-0021 already accepted; and an emptied ledger does **not**, which is the whole
  point. No `onboarding_done` row: recording server-side what can be derived is what the
  predicate was written against.
- **The question generalises from one setting to a class.** *First run* becomes *a required
  setting is unanswered*. Today that is the base currency alone; `settings_registry` grows a
  `required` mark so the second one, whenever it comes, does not need this record reopened.
- **The third passage is named for the events, not for the import.** Its two doors are
  `EntryPair` mounted exactly as the ledger's own are — a file handed over, or an event
  typed — at equal weight and with no primary action. Naming it *first import* would say to
  a reader with no file that they cannot come in, and ADR-0005 decided the opposite when it
  removed manual mode: **typing a position is creating dated events**, and that is an
  onboarding path in its own right.
- **Mandatory means traversed, never answered.** A bare `docker run` is a trial run by
  ADR-0015's design, and a screen that will not release someone without a CSV in hand turns
  the trial into a wall. Each passage is walked; none extracts anything. The accounts
  passage is satisfied by the seeded `default` row, which is a declaration the owner may
  decline to add to.
- **The modal's other four decisions stand** (ADR-0021): it is mounted by the shell and not
  by a route, it closes on its cross with no *Later* button, it holds three sentences on
  what the app *is* and no rule of calculation, and it carries the ephemeral-store warning
  because it is the only surface every trial user meets.
- **The first passage is where the currency is still answered**, so ADR-0002's retroactive
  reinterpretation and ADR-0021's *mutable while the ledger is empty, immutable from the
  first event* are unaffected — the second passage writes no event and the third is where
  the first one can appear.

[The record it extends: ADR-0021](./0021-the-app-asks-one-question.md) ·
[the refusal it answers: #726](https://github.com/pbrissaud/suivi-bourse/issues/726) ·
[the deletion that re-arms the state: ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) ·
[typing a position is creating events: ADR-0005](./0005-every-position-is-historied.md) ·
[the trial run it must not wall in: ADR-0015](./0015-one-container-two-mounts-persistence-is-observed.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
