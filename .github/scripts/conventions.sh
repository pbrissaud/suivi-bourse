#!/usr/bin/env sh
# The rules held on the source (CLAUDE.md, "The rules that are expensive to
# break"), as grep. Runs in CI before the suite and by hand from the root.
set -u
cd "$(dirname "$0")/../.."
SRC="src/application src/api"
ok=0
rule() { echo "convention broken: $1" >&2; ok=1; }

# One clock, and every read of it is UTC-qualified.
grep -rnE --include='*.py' '\.(today|utcnow|localtime)\s*\(|\.now\s*\(\s*\)' $SRC tests && rule "a local clock is read"
grep -rnE --include='*.py' '\.fromtimestamp\s*\(' $SRC tests | grep -vE 'tz|UTC|utc' && rule "fromtimestamp without a zone"

# One repair of an instant, in instants.py, and it imports the stdlib alone.
grep -rnE --include='*.py' '^def _(utc|iso|stamp_value)\s*\(' $SRC | grep -v 'instants.py' && rule "a private copy of instants.utc/iso"
grep -E '^(from|import) ' src/application/instants.py | grep -vE '^(from|import) (datetime|typing)\b' && rule "instants.py imports the project"

# The market is reached through one door, and no sentinel is written for a missing field.
[ "$(grep -rlE --include='*.py' '^\s*(import|from)\s+yfinance\b' $SRC tests | sort | tr '\n' ' ')" = "src/application/market.py " ] || rule "yfinance imported outside market.py"
grep -rnE --include='*.py' "['\"]undefined['\"]" $SRC tests && rule "the sentinel 'undefined' is written"

# One writer per table.
[ "$(grep -rlE --include='*.py' '(INSERT INTO|UPDATE|DELETE FROM) event\b' $SRC | sort | tr '\n' ' ')" = "src/application/entries.py src/application/reassignment.py " ] || rule "a third writer of the event table"
[ "$(grep -rliE --include='*.py' '(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(position|account_state)\b' $SRC | tr '\n' ' ')" = "src/application/positions.py " ] || rule "a second writer of position/account_state"

# One allocator, and it is Store.reserve (ADR-0027, #785).
[ "$(grep -rliE --include='*.py' 'max\(id\)' $SRC tests | sort | tr '\n' ' ')" = "src/application/store.py " ] || rule "a key allocated outside Store.reserve"

# The pure modules import neither the store nor the market.
PYTHONPATH=src uv run python -c '
import sys, importlib
for name in ("scheduling", "performance", "carrying", "retention", "fx", "boot_env", "mounts", "market_info", "build_info", "rhythm"):
    importlib.import_module("application." + name)
heavy = sorted(m for m in sys.modules if m.split(".")[0] in ("duckdb", "yfinance", "pandas", "openpyxl"))
sys.exit("pure modules pulled: " + ", ".join(heavy)) if heavy else None
' || rule "a pure module pulls a heavy edge"

exit $ok
