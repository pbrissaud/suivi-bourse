# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

**Three of the five exist.** The right-hand column below says what `gh label list` actually knows, and two roles have no label at all — they are not missing by accident, nothing in this tracker has ever applied them.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | — (does not exist)   | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | — (does not exist)   | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table. **When the row says the label does not exist, do not create it** — a label invented by an agent is a taxonomy nobody agreed to, and `gh issue edit --add-label` fails on an unknown name rather than inventing one. Say what you would have applied, in the issue or in your report, and leave the labelling to the owner.

Edit the right-hand column to match whatever vocabulary you actually use — and re-check it against `gh label list` rather than against this file, which is a snapshot.
