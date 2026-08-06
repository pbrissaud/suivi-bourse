# Accounts are user data with provenance, not a setting

An account was inherited as a block of the settings file, and that inheritance was
wrong: an account is user data, with a source and a history, not a knob. It is
therefore declared like events are — from a file, with its provenance recorded, or
from the UI — and revoked **file by file**, which closes an impasse the prototype left
open, where a file-provisioned row could never be removed by anything.

An account is **undeletable while any event names it**. This retires, by construction,
the "historical residue" the earlier design merely tolerated.

## Consequences

- There is always at least one account; when the user has declared none it is called
  `default`. Opt-in survives as ergonomics, not as a discriminant — nothing branches on
  "are accounts declared".
- That in turn means the performance job cannot gate on "accounts declared" (ADR-0011),
  and the empty account column in an imported file means `default` until a real account
  exists (ADR-0008).
- Accounts leave the scope of the settings work entirely.

[Full argument: #676](https://github.com/pbrissaud/suivi-bourse/issues/676) ·
[undeletable while named: #675](https://github.com/pbrissaud/suivi-bourse/issues/675)
