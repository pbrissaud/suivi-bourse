"""Atelier is a JSON in the repo, and block 1 of ``index.css`` is rendered from it (#1295)."""
import importlib.util
import json
import re
from pathlib import Path

import pytest

from application import tweakcn

ROOT = Path(__file__).resolve().parents[1]
INDEX_CSS = ROOT / 'src' / 'web' / 'src' / 'index.css'
ATELIER = json.loads((ROOT / 'src' / 'web' / 'src' / 'theme' / 'atelier.json').read_text(encoding='utf-8'))

_spec = importlib.util.spec_from_file_location('sync_atelier', ROOT / 'scripts' / 'sync_atelier.py')
sync_atelier = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_atelier)


def _tokens(css: str) -> dict:
    """``{'light': {...}, 'dark': {...}}`` out of a ``:root`` and a ``.dark`` rule."""
    grounds = {}
    for name, selector in zip(('light', 'dark'), sync_atelier.SELECTORS):
        rule = re.search(r'^' + re.escape(selector) + r'\s*\{\n(.*?)^\}', css, re.S | re.M)
        assert rule, f'no {selector} rule'
        grounds[name] = dict(re.findall(r'^\s*--([\w-]+): (.*);$', rule.group(1), re.M))
    return grounds


def test_block_1_is_rendered_from_atelier_json():
    source = INDEX_CSS.read_text(encoding='utf-8')
    assert sync_atelier.sync(source) == source, 'run: uv run python scripts/sync_atelier.py'


def test_atelier_json_is_a_valid_stored_theme():
    assert tweakcn.validate(ATELIER) == ATELIER
    assert tweakcn.normalize(ATELIER) == ATELIER


def test_this_change_alters_no_colour():
    """The migration guard: the first transcription equals the block it replaced.

    It pins that first version, so the first intentional colour edit (#1283)
    retires it, together with ``fixtures/atelier-before-1295.json``.
    """
    before = json.loads((ROOT / 'tests' / 'fixtures' / 'atelier-before-1295.json').read_text(encoding='utf-8'))
    after = _tokens(sync_atelier.render())
    for ground, values in before.items():
        # ``spacing`` is layout density, which a theme may not set (``ALLOWED``).
        for key, value in values.items():
            if key != 'spacing':
                assert after[ground][key] == value, f'{ground}: --{key}'
    # The only token the dark ground gains is the one tweakcn wrote on light alone.
    assert set(after['dark']) - set(before['dark']) == {'tracking-normal'}
    assert set(after['light']) == set(before['light']) - {'spacing'}


def test_sync_refuses_a_stylesheet_without_markers():
    with pytest.raises(SystemExit):
        sync_atelier.sync('body {}')


def test_every_self_referencing_bridge_entry_has_a_value_in_block_1():
    """``@theme inline { --x: var(--x) }`` with no ``--x`` declared is a cycle.

    The property goes invalid and everything built on it collapses: a missing
    ``--spacing`` zeroed every spacing utility, and no text-level test saw it.
    """
    css = INDEX_CSS.read_text(encoding='utf-8')
    bridge = re.search(r'^@theme inline \{\n(.*?)^\}', css, re.S | re.M).group(1)
    declared = _tokens(sync_atelier.render())
    for name in re.findall(r'^\s*--([\w-]+): var\(--\1\);$', bridge, re.M):
        for ground, tokens in declared.items():
            assert name in tokens, f'{ground}: bridge says --{name}: var(--{name}) and block 1 never declares it'
