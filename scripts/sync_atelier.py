"""Write block 1 of ``src/web/src/index.css`` from ``src/web/src/theme/atelier.json`` (#1295).

    uv run python scripts/sync_atelier.py

Atelier is the same JSON a stored theme is. It goes through ``tweakcn.normalize``
and ``tweakcn.render_css``, so the bundled theme and a stored one are rendered
by one function; only the selectors differ (``:root``/``.dark`` here, one notch
stronger in the served stylesheet).
"""
import json
import re
from pathlib import Path

from application import tweakcn

ROOT = Path(__file__).resolve().parents[1]
ATELIER = ROOT / 'src' / 'web' / 'src' / 'theme' / 'atelier.json'
INDEX_CSS = ROOT / 'src' / 'web' / 'src' / 'index.css'

BEGIN = '/* atelier:begin */\n'
END = '/* atelier:end */\n'
#: Both markers and everything between them.
SPAN = re.compile(re.escape(BEGIN) + r'.*?' + re.escape(END), re.S)


def render() -> str:
    """Block 1's generated span, markers included."""
    theme = tweakcn.normalize(json.loads(ATELIER.read_text()))
    css = tweakcn.render_css({'cssVars': theme}, (':root', '.dark'))
    # Biome formats a rule as `:root {`; render_css writes `:root{` (no `{` can occur in a value).
    return BEGIN + css.replace('{\n', ' {\n') + END


def sync(source: str) -> str:
    """``source`` with its generated span rewritten."""
    if not SPAN.search(source):
        raise SystemExit('index.css has no atelier:begin / atelier:end markers')
    return SPAN.sub(lambda _: render(), source)


if __name__ == '__main__':
    INDEX_CSS.write_text(sync(INDEX_CSS.read_text()))
