"""A tweakcn theme over the bundled Atelier (#1130): what is let through, and from where."""
import json
import re
from pathlib import Path

from application import tweakcn

ROOT = Path(__file__).resolve().parents[1]
CLAUDE = json.loads((ROOT / 'tests' / 'fixtures' / 'tweakcn-claude.json').read_text())


def _never(url):
    raise AssertionError(f'fetched {url}')


def _raises(url):
    raise ConnectionError(url)


def test_the_grit_rule_and_the_server_agree_on_the_standard_names():
    text = (ROOT / 'src' / 'web' / 'lint' / 'semantic-token-alias.grit').read_text()
    block = re.search(r'not or \{([^}]*)\}', text).group(1)
    assert re.findall(r'"--([a-z0-9-]+)"', block) == list(tweakcn.STANDARD)
    assert len(tweakcn.STANDARD) == 53


def test_sanitize_keeps_numbers_and_plain_strings_and_drops_the_rest():
    assert tweakcn.sanitize(0) == '0'
    assert tweakcn.sanitize(0.5) == '0.5'
    assert tweakcn.sanitize('oklch(0.5 0.1 160)') == 'oklch(0.5 0.1 160)'
    for bad in (None, True, [], {}, 'red;}body{display:none', 'a<b', 'a\\b',
                'url(https://x)', 'x' * 301):
        assert tweakcn.sanitize(bad) is None, bad


def test_render_css_lays_the_theme_under_each_ground():
    css = tweakcn.render_css(CLAUDE)
    light, dark = css.split('html:root.dark{')
    assert light.startswith('html:root{')
    light_primary = CLAUDE['cssVars']['light']['primary']
    dark_primary = CLAUDE['cssVars']['dark']['primary']
    assert f'--primary: {light_primary};' in light
    assert f'--primary: {dark_primary};' in dark
    for ground, rule in (('light', light), ('dark', dark)):
        for key in ('radius', 'font-sans'):
            value = CLAUDE['cssVars'][ground].get(key, CLAUDE['cssVars']['theme'][key])
            assert f'--{key}: {value};' in rule


def test_render_css_emits_only_allowed_keys_and_no_injection():
    entry = {'cssVars': {
        'theme': {'tracking-tight': '-0.02em', 'radius': '1rem'},
        'light': {'primary': 'red;}body{display:none', 'spacing': '1rem', 'gain': 'red',
                  'background': 'white'},
        'dark': {},
    }}
    css = tweakcn.render_css(entry)
    keys = set(re.findall(r'--([a-z0-9-]+):', css))
    assert keys <= tweakcn.ALLOWED
    assert '--spacing' not in css and '--tracking-tight' not in css and '--gain' not in css
    assert 'display:none' not in css
    assert '--background: white;' in css
    assert css.count('--radius: 1rem;') == 2


def test_render_css_treats_a_missing_theme_block_as_empty():
    css = tweakcn.render_css({'cssVars': {'theme': 'nope', 'light': {'ring': 'blue'}, 'dark': {}}})
    assert css == 'html:root{\n  --ring: blue;\n}\nhtml:root.dark{\n\n}\n'


def test_font_imports_names_only_a_family_the_bundle_lacks():
    def imports(sans):
        return tweakcn.font_imports({'cssVars': {'light': {'font-sans': sans}, 'dark': {}}})

    assert imports('Outfit, sans-serif') == [
        '@import url("https://fonts.googleapis.com/css2?family=Outfit'
        ':wght@400;500;600;700&display=swap");']
    assert imports("'Geist Variable', Geist, sans-serif") == []
    assert imports('ui-sans-serif, system-ui') == []
    assert imports('"Open Sans", serif')[0].count('family=Open+Sans:') == 1
    assert tweakcn.font_imports({'cssVars': {
        'light': {'font-sans': 'Lora', 'font-serif': 'Lora, serif', 'font-mono': 42}},
        'dark': {}}) == imports('Lora')


def test_load_refuses_a_bad_id_before_any_fetch(tmp_path):
    for bad in ('../x', 'a' * 65, 'Claude', ''):
        assert tweakcn.load(bad, tmp_path, _never) == (None, 'invalid id')


def test_load_fetches_and_caches_then_falls_back_to_the_cache(tmp_path):
    raw = json.dumps(CLAUDE).encode()
    cache = tmp_path / 'theme'

    assert tweakcn.load('claude', cache, lambda url: raw) == (CLAUDE, None)
    assert (cache / 'tweakcn-claude.json').read_bytes() == raw

    assert tweakcn.load('claude', cache, _raises) == (
        CLAUDE, 'fetch failed: ConnectionError; served from cache')
    assert tweakcn.load('claude', cache, lambda url: b'<html>') == (
        CLAUDE, 'invalid theme JSON; served from cache')


def test_load_with_neither_a_theme_nor_a_cache_says_why(tmp_path):
    assert tweakcn.load('claude', tmp_path, _raises) == (None, 'fetch failed: ConnectionError')
    assert tweakcn.load('claude', tmp_path, lambda url: b'{"cssVars": {"light": {}}}') == (
        None, 'invalid theme JSON')
    (tmp_path / 'tweakcn-claude.json').write_text('[]')
    assert tweakcn.load('claude', tmp_path, _raises) == (None, 'fetch failed: ConnectionError')
