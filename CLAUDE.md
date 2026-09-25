# CLAUDE.md

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Shipping (release-please owns the version)

`/ship` must skip its version and changelog steps: never create `VERSION`, never touch
`version.txt`, `CHANGELOG.md` or `.release-please-manifest.json`. The PR title starts with
the conventional type (`fix(web): …`), never with a `vX.Y.Z` prefix. Commit with `-s`,
and put exactly one label on the PR: `fix`, `feat`, `chore` or `refactor`.
