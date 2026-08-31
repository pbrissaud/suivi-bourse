# Accounts are born in the app, and nowhere else

ADR-0013 made an account *user data with provenance*: declared from a file with its source
recorded, or from the UI, and revoked **file by file**. The first half goes. An account is
declared in the app, by a person, and that is the only way one comes into being — there is
no accounts import, and `account.source_id` goes with the table it pointed at.

The reason is ADR-0013's own, read to its end. Its argument was that *an account is user
data, with a source and a history, not a knob*; the file was how a **headless** install
declared one, since it had no UI to do it in
([ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) retires that
install). What is left is the sentence that mattered: an account is user data. A declared
account is a declared account, and how it was declared is not a property of it — the same
move [ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) makes for events, arriving
here for the same reason.

## Consequences

- **ADR-0013's other half is untouched, and it was always the load-bearing one**: an account
  is **undeletable while any event names it**, and the cascade is refused rather than
  performed. `reassignment.py` keeps its subject too — a year under the seeded `default` row
  followed by a real declaration is reached from the keyboard as readily as from a file.
- **The export drops its second file.** #710 refused to export events alone because *"the
  justification of the export is the round trip, and a partial file is not one"*. The round
  trip no longer exists for accounts, so an `accounts.csv` nothing can read back is a trap
  that **looks** like a restorable backup. The export writes the events, and the accounts are
  redeclared by hand.

  **Amended (#836): what this refuses is a declaration, not a report.** The clause above was
  read as forbidding any export that mentions an account, and it does not — it forbids a file
  that *offers itself as the way back in*. `suivi-bourse-portfolio.csv` is the other thing: a
  line per account carrying its balance and net contribution, then a line per position
  carrying quantity, average cost, cost, observed price and valuation. It is figures about a
  state, not the state itself, and three properties keep it that way. It is **not**
  `/api/export/accounts.csv`, which stays a `404`. The loader **refuses it by name**, having
  no `date` and no `event_type` — asserted on both sides. And the name promises nothing: a
  *portfolio* is what one reads, an *account* is what one declares.

  The test the clause actually states is therefore **round trip or not**, and it is the ledger
  that has one. A file the app cannot read back is a trap only when a reader could mistake it
  for the road home; a report that says so in its name, its columns and its refusal cannot be.
- **`coming-from-v4.mdx` loses a section rather than gaining one.** Its whole *"`alone` is
  the operative word"* paragraph exists to warn that an `accounts.csv` left beside the events
  takes a v4 install down. There is no longer an `accounts.csv` to leave anywhere.
- **An events file naming an undeclared account is refused, and the answer names the
  account.** Declaring accounts is the second passage of the first run
  ([ADR-0035](./0035-the-first-run-has-three-passages.md)), so the order the refusal asks for
  is the order the app already walked the owner through.
- **The twenty-line comment in `store.py` goes** — the one explaining why `account.source_id`
  carries no foreign key, because DuckDB executes an `UPDATE` on a key column as a delete and
  an insert and trips the incoming `event.account` reference. The column leaves and takes the
  hazard with it.

[The record it halves: ADR-0013](./0013-accounts-are-data-with-provenance.md) ·
[the same move on events: ADR-0032](./0032-the-import-is-a-gesture-not-a-mount.md) ·
[the install whose need it answered: ADR-0033](./0033-prometheus-leaves-and-the-api-stops-being-a-contract.md) ·
[where accounts are declared: ADR-0028](./0028-the-accounts-page-shows-one-account.md) ·
[map #669](https://github.com/pbrissaud/suivi-bourse/issues/669)
