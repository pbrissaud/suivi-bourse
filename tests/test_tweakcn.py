"""A theme over the bundled Atelier (#1130, #1248): what is let through, and from where."""
import json
import re
import urllib.request
from pathlib import Path

import pytest

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
    # The value regex names them a second time, as the alias targets it admits.
    targets = re.findall(r'var\\\(--\(\?:([a-z0-9|-]+)\)', text)
    assert targets and all(t.split('|') == list(tweakcn.STANDARD) for t in targets)
    assert len(tweakcn.STANDARD) == 53


def test_sanitize_keeps_numbers_and_plain_strings_and_drops_the_rest():
    assert tweakcn.sanitize(0) == '0'
    assert tweakcn.sanitize(0.5) == '0.5'
    assert tweakcn.sanitize('oklch(0.5 0.1 160)') == 'oklch(0.5 0.1 160)'
    assert tweakcn.sanitize("'Open Sans', calc(var(--x) * 2)") == "'Open Sans', calc(var(--x) * 2)"
    for bad in (None, True, [], {}, float('nan'), float('inf'), 'red;}body{display:none',
                'a<b', 'a\\b', 'url(https://x)', 'URL(https://x)', 'image-set("x" 1x)',
                'red /*', 'a\nb', 'x' * 301, 'calc(1px', 'var(--x))', '"Open Sans', "a'b"):
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
        'dark': {'primary': 'blue', 'spacing': '1rem', 'gain': 'red', 'background': 'black'},
    }}
    css = tweakcn.render_css(entry)
    keys = set(re.findall(r'--([a-z0-9-]+):', css))
    assert keys <= tweakcn.ALLOWED
    assert '--spacing' not in css and '--tracking-tight' not in css and '--gain' not in css
    assert 'display:none' not in css
    assert '--background: white;' in css and '--background: black;' in css
    assert css.count('--radius: 1rem;') == 2
    # The light primary was refused, so the dark one goes too: a key on one
    # ground only would leak light onto dark, `html:root` outranking `.dark`.
    assert '--primary' not in css


def test_render_css_treats_a_missing_theme_block_as_empty():
    css = tweakcn.render_css({'cssVars': {
        'theme': 'nope', 'light': {'ring': 'blue', 'input': 'grey'}, 'dark': {'ring': 'teal'}}})
    assert css == 'html:root{\n  --ring: blue;\n}\nhtml:root.dark{\n  --ring: teal;\n}\n'


def test_font_imports_names_only_a_family_the_bundle_lacks():
    def imports(sans):
        return tweakcn.font_imports({'cssVars': {'light': {'font-sans': sans}, 'dark': {}}})

    assert tweakcn.font_imports({'cssVars': {'light': {'font-sans': 'Geist, sans-serif'},
                                             'dark': {'font-sans': 'Lora, serif'}}}) == imports('Lora')
    assert imports('Outfit, sans-serif') == [
        '@import url("https://fonts.googleapis.com/css2?family=Outfit'
        ':wght@400;500;600;700&display=swap");']
    assert imports("'Geist Variable', Geist, sans-serif") == []
    assert imports('ui-sans-serif, system-ui') == []
    assert imports('"Open Sans", serif')[0].count('family=Open+Sans:') == 1
    assert tweakcn.font_imports({'cssVars': {
        'light': {'font-sans': 'Lora', 'font-serif': 'Lora, serif', 'font-mono': 42}},
        'dark': {}}) == imports('Lora')


class _Response:
    def __init__(self, status, body):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, size=-1):
        return self.body if size < 0 else self.body[:size]


def test_http_fetch_raises_on_a_refusal_and_on_an_oversized_body(monkeypatch):
    replies = iter([_Response(200, b'{}'), _Response(404, b''),
                    _Response(200, b'x' * (tweakcn.MAX_BYTES + 1))])
    monkeypatch.setattr(urllib.request, 'urlopen', lambda url, timeout: next(replies))
    assert tweakcn.http_fetch('https://tweakcn.com/r/themes/x') == b'{}'
    for _ in range(2):
        try:
            tweakcn.http_fetch('https://tweakcn.com/r/themes/x')
        except OSError:
            continue
        raise AssertionError('no exception')


def _theme(theme=None, light=None, dark=None):
    body = {'light': light or {}, 'dark': dark or {}}
    if theme is not None:
        body['theme'] = theme
    return body


def test_normalize_drops_what_a_theme_may_not_say():
    kept = tweakcn.normalize(_theme(
        theme={'radius': '1rem', 'spacing': '1rem', 'gain': 'red'},
        light={'primary': 'red;}body{display:none', 'background': 'white', 'ring': 'blue'},
        dark={'primary': 'blue', 'background': 'black'}))
    # `primary` is unsafe in light, so dark loses it too; `ring` is light-only.
    assert kept == {'theme': {'radius': '1rem'},
                    'light': {'background': 'white'}, 'dark': {'background': 'black'}}


def test_normalize_keeps_a_one_sided_key_the_theme_covers():
    kept = tweakcn.normalize(_theme(theme={'radius': '1rem'}, light={'radius': '0'}))
    assert kept == {'theme': {'radius': '1rem'}, 'light': {'radius': '0'}, 'dark': {}}


def test_normalize_moves_a_light_only_tracking_normal_into_theme():
    kept = tweakcn.normalize(CLAUDE['cssVars'])
    assert kept['theme']['tracking-normal'] == CLAUDE['cssVars']['light']['tracking-normal']
    assert 'tracking-normal' not in kept['light']
    assert kept['light'].keys() == kept['dark'].keys()


@pytest.mark.parametrize('bad', [[], {'light': {}}, {'light': {}, 'dark': []},
                                 {'light': {}, 'dark': {}, 'theme': 'nope'}])
def test_normalize_refuses_what_is_not_a_theme(bad):
    with pytest.raises(tweakcn.InvalidTheme):
        tweakcn.normalize(bad)


def test_normalize_is_what_validate_keeps():
    kept = tweakcn.normalize(CLAUDE['cssVars'])
    assert tweakcn.validate(kept) == kept


@pytest.mark.parametrize('body, key', [
    (_theme(light={'background': 'red; } body { display:none'}, dark={'background': 'x'}),
     'background'),
    (_theme(light={'gain': 'red'}, dark={'gain': 'red'}), 'gain'),
    (_theme(light={'tracking-normal': '0em'}), 'tracking-normal'),
    ({**_theme(), 'name': 'x'}, 'name'),
])
def test_validate_names_the_first_key_it_would_drop(body, key):
    with pytest.raises(tweakcn.InvalidTheme) as refused:
        tweakcn.validate(body)
    assert refused.value.key == key


def test_validate_bounds_the_size(monkeypatch):
    monkeypatch.setattr(tweakcn, 'MAX_BYTES', 10)
    with pytest.raises(tweakcn.InvalidTheme) as refused:
        tweakcn.validate(_theme(theme={'radius': '1rem'}))
    assert refused.value.key is None


def test_fetch_refuses_a_bad_id_before_any_fetch():
    for bad in ('../x', 'a' * 65, 'Claude', '', None):
        with pytest.raises(tweakcn.InvalidId):
            tweakcn.fetch(bad, _never)


def test_fetch_returns_the_css_vars():
    raw = json.dumps(CLAUDE).encode()
    assert tweakcn.fetch('claude', lambda url: raw) == CLAUDE['cssVars']


@pytest.mark.parametrize('fetcher, reason', [
    (_raises, 'ConnectionError'),
    (lambda url: b'<html>', 'invalid theme JSON'),
    (lambda url: b'{"cssVars": {"light": {}}}', 'invalid theme JSON'),
])
def test_fetch_says_why_it_failed(fetcher, reason):
    with pytest.raises(tweakcn.FetchFailed) as failed:
        tweakcn.fetch('claude', fetcher)
    assert reason in failed.value.reason
