"""A theme laid over the bundled Atelier (#1130, #1248).

The theme is tweakcn's ``cssVars`` (``{theme?, light, dark}``), kept in the
store and edited in Settings; tweakcn is reached only when the owner imports
an id. Its standard shadcn tokens are served as a stylesheet that outranks the
bundle's ``:root`` and ``.dark``. The app's semantic tokens are aliases of
those standard ones, so the whole page follows.

Pure: the fetcher is injected, ``http_fetch`` is the one the app passes.
"""
import json
import math
import re
import urllib.request
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import quote_plus


#: The keys of a tweakcn ``cssVars.light``. ``src/web/lint/semantic-token-alias.grit``
#: lists the same names, and ``tests/test_tweakcn.py`` holds the two equal.
STANDARD: Tuple[str, ...] = (
    'background', 'foreground', 'card', 'card-foreground', 'popover',
    'popover-foreground', 'primary', 'primary-foreground', 'secondary',
    'secondary-foreground', 'muted', 'muted-foreground', 'accent',
    'accent-foreground', 'destructive', 'destructive-foreground', 'border',
    'input', 'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5',
    'sidebar', 'sidebar-foreground', 'sidebar-primary',
    'sidebar-primary-foreground', 'sidebar-accent', 'sidebar-accent-foreground',
    'sidebar-border', 'sidebar-ring',
    'radius', 'font-sans', 'font-serif', 'font-mono', 'letter-spacing',
    'spacing', 'tracking-normal', 'shadow-color', 'shadow-opacity',
    'shadow-blur', 'shadow-spread', 'shadow-offset-x', 'shadow-offset-y',
    'shadow-2xs', 'shadow-xs', 'shadow-sm', 'shadow', 'shadow-md', 'shadow-lg',
    'shadow-xl', 'shadow-2xl',
)

#: What a theme may set. Layout density stays DESIGN.md's.
ALLOWED = frozenset(STANDARD) - {'spacing'}

_ID = re.compile(r'^[a-z0-9-]{1,64}$')
_FAMILY = re.compile(r'^[A-Za-z0-9 ]{1,64}$')
#: Compared in lowercase: CSS function names are case-insensitive.
_FORBIDDEN = (';', '{', '}', '<', '>', '\\', '/*', '*/', '\n', '\r',
              'url(', 'image(', 'image-set(', 'src(')
#: A registry entry is a few kilobytes; anything far larger is not one.
MAX_BYTES = 256 * 1024
_GENERIC = {'sans-serif', 'serif', 'monospace', 'system-ui'}
_BUNDLED = {'Geist', 'Geist Variable', 'Geist Mono', 'Geist Mono Variable'}
_FONT_KEYS = ('font-sans', 'font-serif', 'font-mono')

URL = 'https://tweakcn.com/r/themes/{}'


def sanitize(value: object) -> Optional[str]:
    """A value safe to write inside a declaration, or ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value) if math.isfinite(value) else None
    if not isinstance(value, str) or len(value) > 300:
        return None
    lowered = value.lower()
    if any(bad in lowered for bad in _FORBIDDEN):
        return None
    return value


def _ground(entry: dict, name: str) -> Dict[str, object]:
    """``cssVars.theme`` overlaid with one ground."""
    css_vars = entry.get('cssVars') or {}
    theme = css_vars.get('theme')
    merged = dict(theme) if isinstance(theme, dict) else {}
    merged.update(css_vars.get(name) or {})
    return merged


def _declarations(values: Dict[str, object]) -> Dict[str, str]:
    kept = {key: sanitize(value) for key, value in values.items() if key in ALLOWED}
    return {key: value for key, value in kept.items() if value is not None}


def _rule(selector: str, values: Dict[str, str], keys) -> str:
    lines = [f'  --{key}: {values[key]};' for key in sorted(keys)]
    return selector + '{\n' + '\n'.join(lines) + '\n}\n'


def render_css(entry: dict) -> str:
    """Both grounds, at a specificity the bundle's ``:root``/``.dark`` cannot beat.

    A key is emitted only when **both** grounds say it: ``html:root`` outranks
    the bundle's ``.dark``, so a light-only value would paint the dark ground.
    """
    light = _declarations(_ground(entry, 'light'))
    dark = _declarations(_ground(entry, 'dark'))
    keys = light.keys() & dark.keys()
    return _rule('html:root', light, keys) + _rule('html:root.dark', dark, keys)


def font_imports(entry: dict) -> List[str]:
    """One Google Fonts ``@import`` per family the theme names first and the bundle lacks.

    Both grounds are read: ``render_css`` lets the dark one name its own face.
    """
    grounds = (_ground(entry, 'light'), _ground(entry, 'dark'))
    families: List[str] = []
    for value in (ground.get(key) for ground in grounds for key in _FONT_KEYS):
        if not isinstance(value, str):
            continue
        name = value.split(',')[0].strip().strip('\'"').strip()
        skipped = name in _GENERIC or name in _BUNDLED or name in families
        if skipped or not _FAMILY.match(name) or name.startswith(('ui-', '-apple')):
            continue
        families.append(name)
    return [f'@import url("https://fonts.googleapis.com/css2?family={quote_plus(name)}'
            f':wght@400;500;600;700&display=swap");' for name in families]


class InvalidTheme(ValueError):
    """A theme body the store will not keep; ``key`` names what is refused."""

    def __init__(self, key: Optional[str], message: str):
        super().__init__(message)
        self.key = key


class InvalidId(ValueError):
    """A tweakcn id outside ``^[a-z0-9-]{1,64}$``: never sent anywhere."""


class FetchFailed(Exception):
    """tweakcn did not hand back a theme; ``reason`` says what happened."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


_GROUNDS = ('theme', 'light', 'dark')


def normalize(css_vars: object) -> Dict[str, Dict[str, str]]:
    """Keep what a theme may say, drop the rest, refuse what is not a theme.

    Dropped: a key outside ``ALLOWED``, a value ``sanitize`` refuses, and a key
    on one ground only and not in ``theme`` (``render_css`` would never emit
    it). The exception is a light-only ``tracking-normal``, which tweakcn
    writes there and nowhere else: it moves into ``theme``.
    """
    if not isinstance(css_vars, dict):
        raise InvalidTheme(None, 'a theme is a JSON object')
    for ground in ('light', 'dark'):
        if not isinstance(css_vars.get(ground), dict):
            raise InvalidTheme(ground, f"a theme has a {ground!r} object")
    if not isinstance(css_vars.get('theme', {}), dict):
        raise InvalidTheme('theme', "a theme's 'theme' is an object")
    theme, light, dark = (_declarations(css_vars.get(ground) or {}) for ground in _GROUNDS)
    if 'tracking-normal' in light.keys() - dark.keys() - theme.keys():
        theme['tracking-normal'] = light.pop('tracking-normal')
    shared = (light.keys() & dark.keys()) | theme.keys()
    return {'theme': theme,
            'light': {key: value for key, value in light.items() if key in shared},
            'dark': {key: value for key, value in dark.items() if key in shared}}


def validate(body: object) -> Dict[str, Dict[str, str]]:
    """``normalize``, refusing by name the first key it would have dropped."""
    kept = normalize(body)
    if len(json.dumps(body)) > MAX_BYTES:
        raise InvalidTheme(None, f'a theme is at most {MAX_BYTES} bytes')
    for key in body:
        if key not in kept:
            raise InvalidTheme(key, f'a theme has no {key!r}')
    for ground in _GROUNDS:
        for key in body.get(ground) or {}:
            if key not in kept[ground]:
                raise InvalidTheme(key, f'{ground}: {key!r} is not a value a theme may set')
    return kept


def _valid(raw: bytes) -> Optional[dict]:
    try:
        entry = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(entry, dict):
        return None
    css_vars = entry.get('cssVars')
    if not isinstance(css_vars, dict):
        return None
    if not isinstance(css_vars.get('light'), dict) or not isinstance(css_vars.get('dark'), dict):
        return None
    return entry


def fetch(theme_id: object, fetcher: Callable[[str], bytes]) -> dict:
    """The ``cssVars`` of a tweakcn registry entry: the one outbound call, on click."""
    if not isinstance(theme_id, str) or not _ID.match(theme_id):
        raise InvalidId(theme_id)
    try:
        raw = fetcher(URL.format(theme_id))
    except Exception as exc:  # the fetcher is injected; anything it raises is a failed fetch
        raise FetchFailed(f'{type(exc).__name__}: {exc}') from exc
    entry = _valid(raw)
    if entry is None:
        raise FetchFailed('invalid theme JSON')
    return entry['cssVars']


def http_fetch(url: str) -> bytes:
    """The registry entry, or an exception."""
    with urllib.request.urlopen(url, timeout=5) as response:
        if response.status != 200:
            raise OSError(f'HTTP {response.status}')
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise OSError('theme larger than MAX_BYTES')
    return raw


__all__ = ['STANDARD', 'ALLOWED', 'MAX_BYTES', 'sanitize', 'render_css', 'font_imports',
           'InvalidTheme', 'InvalidId', 'FetchFailed', 'normalize', 'validate', 'fetch',
           'http_fetch']
