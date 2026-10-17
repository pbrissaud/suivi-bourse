"""Atelier is a JSON in the repo, and block 1 of ``index.css`` is rendered from it (#1295)."""
import importlib.util
import json
import re
from pathlib import Path

from application import tweakcn

ROOT = Path(__file__).resolve().parents[1]
INDEX_CSS = ROOT / 'src' / 'web' / 'src' / 'index.css'
ATELIER = json.loads((ROOT / 'src' / 'web' / 'src' / 'theme' / 'atelier.json').read_text())

_spec = importlib.util.spec_from_file_location('sync_atelier', ROOT / 'scripts' / 'sync_atelier.py')
sync_atelier = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_atelier)


def _tokens(css: str) -> dict:
    """``{'light': {...}, 'dark': {...}}`` out of a ``:root`` and a ``.dark`` rule."""
    grounds = {}
    for name, selector in (('light', ':root'), ('dark', '.dark')):
        body = re.search(r'^' + re.escape(selector) + r'\s*\{\n(.*?)^\}', css, re.S | re.M).group(1)
        grounds[name] = dict(re.findall(r'^\s*--([\w-]+): (.*);$', body, re.M))
    return grounds


def test_block_1_is_rendered_from_atelier_json():
    source = INDEX_CSS.read_text()
    assert sync_atelier.sync(source) == source, 'run: uv run python scripts/sync_atelier.py'


def test_atelier_json_is_a_valid_stored_theme():
    assert tweakcn.validate(ATELIER) == ATELIER
    assert tweakcn.normalize(ATELIER) == ATELIER


def test_this_change_alters_no_colour():
    before = json.loads((ROOT / 'tests' / 'fixtures' / 'atelier-before-1295.json').read_text())
    after = _tokens(sync_atelier.render())
    for ground, values in before.items():
        # ``spacing`` is layout density, which a theme may not set (``ALLOWED``).
        for key, value in values.items():
            if key != 'spacing':
                assert after[ground][key] == value, f'{ground}: --{key}'
    # The only token the dark ground gains is the one tweakcn wrote on light alone.
    assert set(after['dark']) - set(before['dark']) == {'tracking-normal'}
    assert set(after['light']) == set(before['light']) - {'spacing'}
