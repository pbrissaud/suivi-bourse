# App screenshots

One command regenerates every screenshot the documentation uses:

```bash
node website/scripts/screenshots/capture.mjs
```

It writes `website/static/img/app/{en,fr}/<name>.png` (light theme, 1280×800 at
2×, downscaled to 1600 px) and refreshes the home/README images
`website/static/img/app-{dashboard,shares,accounts,ledger}-{light,dark}.png`
(English, 1440×1000 at 2×, downscaled to 1920 px). It takes about five minutes,
most of it the price history being fetched.

## What it does

1. Builds the front (`pnpm build` in `src/web`, output under
   `packages/app/src/api/static/`). `--skip-build` reuses the last build.
2. Boots a throwaway instance (`uv run python -m application.boot`) on a **new
   temporary store** and a free port. It refuses to go on if that store already
   has a base currency, so it can never write to an existing install.
3. Captures the first-launch walk while the store is empty, then seeds it:
   base currency EUR, three French taxation models from the registry, three
   accounts, `events.csv` (61 made-up events priced at real Yahoo closes), two
   access tokens, the S&P 500 as the comparison reference, and an agent provider
   pointing at a **local stub** (an OpenAI-compatible gateway served by the
   script itself: no key, nothing sent anywhere). It waits for the history
   rebuild to finish before capturing.
4. Drives headless Chrome over the DevTools protocol, page by page, in English
   then French (account labels, token names and the agent thread are rewritten
   in each language). For `notifications` it records, for two captures only, a
   free grant of 0.001 BTC with the staleness horizon at 10 s, so the bell lists
   a late price whatever day it is; both are undone right after. The access
   code is turned on last, for `lock` and `settings-security`.

The instance runs with `HOME` set to the temporary directory, so its journal
never names a path of the machine it runs on.

Screens that fail are listed at the end and the exit code is 1; the others are
still written. `ONLY=dashboard,ledger node …/capture.mjs` captures a subset
(`home` for the home images, `lock` for the PIN phase). `--keep` leaves the
temporary directory (store with its journal under `store/logs/`, raw captures) in place.

## Needs

- Node ≥ 22 (global `fetch` and `WebSocket`), `pnpm`, `uv` — the repo's usual
  tooling. No dependency is installed for the script.
- Google Chrome at its macOS path, or `CHROME=/path/to/chrome`.
- `sips` (macOS) for the downscale; `oxipng` if present (`mise use -g oxipng`)
  for the optimisation.
- Network access to Yahoo Finance and to the documentation site (the taxation
  registry is read from `https://suivi-bourse-docs.pbrissaud.net/suivi-bourse`).

## The fixture

`events.csv` is committed so a run does not depend on today's prices. To
rebuild it (other dates, other symbols), edit `build_fixture.py` and run:

```bash
uv run python website/scripts/screenshots/build_fixture.py
```

`import-preview.csv` is the small file shown in the import preview; it is
never written to the ledger.
