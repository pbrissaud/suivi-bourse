# SuiviBourse config directory

This folder is the template for **your** config directory. Copy it once, then
never touch the shipped files again:

```bash
cp -r data.example data      # or: make init
```

`data/` is git-ignored, and the compose stack mounts it whole at
`/home/appuser/.config/SuiviBourse` inside the app container. Point the stack at
a different location with `SB_CONFIG_DIR` in `.env`.

| File | Purpose |
|------|---------|
| `settings.yaml` | Events options and the opt-in `accounts:` block |
| `events/` | Your broker exports (`.csv` / `.xlsx`) — the portfolio itself |

**A portfolio is a ledger of dated events and nothing else** (issue #711). There
is no mode to pick and no static portfolio file: drop a `.csv` or `.xlsx` into
`events/` and it is loaded on the next ingestion cycle — see
`../examples/events-example.csv` for the columns.

Coming from a v4 install, a `config.yaml` left in this folder is **named at
startup and never read**. Nothing is migrated: typing a position means creating
dated events, because an aggregated position carries no dates.
