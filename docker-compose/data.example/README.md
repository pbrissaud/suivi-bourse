# SuiviBourse config directory

This folder is the template for **your** config directory. Copy it once, then
never touch the shipped files again:

```bash
cp -r data.example data      # or: make init
```

`data/` is git-ignored, and the compose stack mounts it whole at
`/home/appuser/.config/SuiviBourse` inside the app container. Point the stack at
a different location with `SB_CONFIG_DIR` in `.env`.

| File | Used in | Purpose |
|------|---------|---------|
| `settings.yaml` | both modes | Mode override, events options, opt-in accounts |
| `config.yaml` | manual mode | Your static portfolio |
| `events/` | events mode | Your broker exports (`.csv` / `.xlsx`) |

**Switching to events mode is a copy, not a config change**: drop a `.csv` or
`.xlsx` into `events/` and the app detects it on the next boot. Nothing else to
edit — see `../examples/events-example.csv` for the format.
