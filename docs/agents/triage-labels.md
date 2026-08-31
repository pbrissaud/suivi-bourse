# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

**All five exist**, since the triage of #844 — `needs-info` and `ready-for-human` were created there, on the owner's word. The right-hand column below is what `gh label list` knows.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. **A label absent from this table is not one to invent** — a taxonomy nobody agreed to is worse than a missing row, and `gh issue edit --add-label` fails on an unknown name rather than creating one. Say what you would have applied, in the issue or in your report, and leave the naming to the owner.

The category roles map onto this repo's conventional-commit vocabulary rather than onto `bug`/`enhancement`: a defect is `fix`, a feature is `feat`, and an optimisation at constant behaviour is `chore`. Those three, plus `docs` and `deps`, are the categories in use.

Edit the right-hand column to match whatever vocabulary you actually use — and re-check it against `gh label list` rather than against this file, which is a snapshot.
