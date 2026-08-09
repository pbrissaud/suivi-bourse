# Wave orchestration

The v5 map (#669) hands off ~45 implementation tickets whose blockers are already
machine-readable — native GitHub dependencies on the back-end and packaging trees,
a `## Blocked by` section in every ticket body. That graph is nine levels deep,
which is what makes running it as **waves** worth the machinery: everything at one
level is independent, and nothing below it can start early.

`.claude/workflows/` holds the two scripts that do it. They run under the
`Workflow` tool and are versioned here because they are the only written trace of
the rules that stopped three bad merges out of three.

| Script | Job |
| ------ | --- |
| `v5-wave.js` | implement a wave — one agent per ticket, verify, repair minors, merge |
| `v5-repair.js` | take the branches a wave held, repair them against the findings, re-verify, merge |

```
Workflow({scriptPath: '.claude/workflows/v5-wave.js',
          args: {wave: [696], base: 'preview/v5'}})
```

Every branch leaves from and lands on `preview/v5`. Nothing is pushed and nothing
is written to the tracker by an agent.

## The frontier

A ticket is ready when every blocker is closed and nobody is assigned:

```bash
gh api repos/pbrissaud/suivi-bourse/issues/<n> --jq .issue_dependencies_summary.blocked_by
```

`blocked_by` counts **open** blockers only, so closing a blocker unblocks its
children with no further bookkeeping. A decision ticket — one that fixes names
rather than writing code, like #745 — is published and closed in the same gesture:
it had to *exist* before its children, not stay open.

## The rules the scripts encode

Each one is here because a wave went wrong without it.

- **The base is the first gesture, and it is verified.** The harness may place a
  worktree on a `master` head where `docs/adr/` does not exist. An agent that
  cannot branch from the base stops and produces nothing, rather than implementing
  a v5 ticket blind.
- **`major` holds as hard as `blocking`.** A `major` is *an acceptance criterion
  that is not met* — the apparent size of the offending line does not enter into
  it. One scaffold line slipped through as `minor` on the pilot.
- **A `major` routed to another ticket holds too**, until a human writes it there.
  Otherwise "routed" quietly means "forgotten": that is how #713 merged with its
  ICU criterion unmet. Re-run with `acknowledgedRouting: [<n>]` once written.
- **Scope is not widened silently.** A defect belonging to another ticket is
  reported with its owner, never repaired in place — repairing another ticket's
  file here dissolves the decomposition the map is made of.
- **Gates are run, never dressed up.** No disabled test, no `--no-verify`, no link
  turned into text to quiet a build. Whatever the diff touches gets its gate:
  `pnpm build` for `website/`, `flake8` + `pytest` for `app/src/`, `pnpm lint` +
  `build` + `test` for `app/web/` — and a real `docker build` when the diff touches
  the `Dockerfile`, a lockfile or `pnpm-workspace.yaml`. That last one exists
  because a walking-skeleton branch broke the image while all four of its declared
  gates stayed green.
- **Verification is adversarial and re-run from source.** The verifier reads the
  criteria from `gh issue view`, not from the implementer's summary, and runs the
  checkable ones itself.

## Reading a ticket

Every ticket opens on a `## Parent` line naming its spec (#695 store, #712 front,
#730 packaging), the map, and its ADRs. All of them are required reading, and the
arbitration rule is fixed: **`CLAUDE.md` describes v4 as it stands, the ADRs
describe the destination — where they contradict, the ADR wins.**

These tickets are dense because each criterion encodes an investigation already
done; the body says *why* each one is what it is. A criterion applied without its
why is a criterion missed.

## Merging

Merges are serialised and each re-runs its gates **on the merged base** — a
sibling from the same wave may have landed something incompatible. A gate that
breaks after the merge and is not a one-line fix aborts it.

Worktrees live under `.claude/worktrees/`, git-ignored: they are full copies of the
repository, and a `git add -A` would otherwise sweep them in.
