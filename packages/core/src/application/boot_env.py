"""What the environment still says (store, port, log level, the PIN's two), and the names it no longer says."""
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, Tuple
from urllib.parse import urlsplit


STORE_DIR = 'SB_STORE_DIR'

WEB_PORT = 'SB_WEB_PORT'

LOG_LEVEL = 'LOG_LEVEL'

#: ``1`` clears the PIN, the session secret and the MCP token at boot (#1203).
RESET_AUTH = 'SB_RESET_AUTH'

#: The proxies whose ``X-Forwarded-For``/``-Proto`` are believed. Empty: none.
FORWARDED_ALLOW_IPS = 'SB_FORWARDED_ALLOW_IPS'

#: The documentation site's root: the registry, the migration page and every link of the UI hang off it.
DOCUMENTATION_URL = 'SB_DOCUMENTATION_URL'

DEFAULT_STORE_DIR = '/data'
DEFAULT_WEB_PORT = 8080
DEFAULT_LOG_LEVEL = 'INFO'
DEFAULT_DOCUMENTATION_URL = 'https://pbrissaud.github.io/suivi-bourse'

INVENTORY: Tuple[Tuple[str, str], ...] = (
    (LOG_LEVEL, DEFAULT_LOG_LEVEL),
    (STORE_DIR, DEFAULT_STORE_DIR),
    (WEB_PORT, str(DEFAULT_WEB_PORT)),
    (RESET_AUTH, ''),
    (FORWARDED_ALLOW_IPS, ''),
    (DOCUMENTATION_URL, DEFAULT_DOCUMENTATION_URL),
)

READ: frozenset = frozenset(name for name, _ in INVENTORY)


def text(env: Mapping[str, str], name: str,
         default: Optional[str] = None) -> Optional[str]:
    """Read ``name``, treating a blank or whitespace-only value as unset."""
    raw = env.get(name)
    if raw is None:
        return default
    raw = str(raw).strip()
    return raw or default


def integer(env: Mapping[str, str], name: str, default: int) -> int:
    """Read an int, tolerating blanks and failing with a message that names it."""
    raw = text(env, name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(
            f"Invalid value for {name}: {raw!r} is not an integer") from None


def directory(env: Mapping[str, str], name: str, default: str) -> Path:
    """Read the one path. ``expanduser`` because a Docker-less install writes ``~/…`` and gets a literal ``~`` directory otherwise."""
    return Path(text(env, name, default)).expanduser()


def http_url(env: Mapping[str, str], name: str, default: str) -> str:
    """Read an absolute http(s) URL without its trailing ``/``, failing with a message that names it.

    Plain origin plus optional path only: the root is published to the browser and
    ``/taxation.json`` is appended to it, so credentials, a query, a fragment,
    whitespace or a backslash (parsed differently by Python and by browsers) are refused.
    """
    raw = text(env, name, default).rstrip('/')
    try:
        parts = urlsplit(raw)
        parts.port  # raises on a bad port
        absolute = parts.scheme in ('http', 'https') and bool(parts.hostname)
        bare = parts.username is None and parts.password is None
        plain = not any(c in raw for c in '?#\\')
        clean = not any(c.isspace() or not c.isprintable() for c in raw)
        valid = absolute and bare and plain and clean
    except ValueError:  # e.g. an unclosed IPv6 bracket
        valid = False
    if not valid:
        shown = re.sub(r'(?<=//)[^/@]*@', '', raw)  # a rejected value is logged: no credentials in it
        raise ValueError(
            f"Invalid value for {name}: {shown!r} is not an absolute http(s) URL "
            f"(no credentials, query, fragment or whitespace)")
    return raw


PREFIXES = ('SB_', 'INFLUXDB_')

NEVER_READ: frozenset = frozenset({
    'SB_VERSION', 'SB_CONFIG_DIR', 'SB_UID', 'SB_GID', 'INFLUXDB_PORT',
})


def unread(env: Mapping[str, str]) -> Tuple[str, ...]:
    """The product-prefixed names set (non-blank) and read by nothing, sorted."""
    set_ = (name for name, value in env.items() if str(value).strip())
    return tuple(sorted(n for n in set_ if n.startswith(PREFIXES) and n not in READ | NEVER_READ))


def notice(names: Tuple[str, ...]) -> Optional[str]:
    """One line naming every unread variable, or ``None`` when there is none."""
    if not names:
        return None
    return (f"These environment variables are set and not read: "
            f"{', '.join(names)}. Since v5 the dials live in the app: "
            f"the settings page, or PUT /api/settings.")


@dataclass(frozen=True)
class BootEnvironment:
    """What the process knows before it opens the store, and what it ignores."""

    store_dir: Path
    web_port: int
    log_level: str
    unread: Tuple[str, ...]
    reset_auth: bool = False
    forwarded_allow_ips: str = ''
    documentation_url: str = DEFAULT_DOCUMENTATION_URL


def read(env: Mapping[str, str]) -> BootEnvironment:
    """The boot values and the muted names, from a mapping like ``os.environ``."""
    return BootEnvironment(
        store_dir=directory(env, STORE_DIR, DEFAULT_STORE_DIR),
        web_port=integer(env, WEB_PORT, DEFAULT_WEB_PORT),
        log_level=text(env, LOG_LEVEL, DEFAULT_LOG_LEVEL),
        unread=unread(env),
        reset_auth=text(env, RESET_AUTH) == '1',
        forwarded_allow_ips=text(env, FORWARDED_ALLOW_IPS, ''),
        documentation_url=http_url(env, DOCUMENTATION_URL, DEFAULT_DOCUMENTATION_URL),
    )


__all__ = [
    'STORE_DIR', 'WEB_PORT', 'LOG_LEVEL', 'RESET_AUTH',
    'FORWARDED_ALLOW_IPS', 'DOCUMENTATION_URL',
    'DEFAULT_STORE_DIR', 'DEFAULT_WEB_PORT', 'DEFAULT_LOG_LEVEL',
    'DEFAULT_DOCUMENTATION_URL',
    'INVENTORY', 'READ', 'PREFIXES', 'NEVER_READ',
    'BootEnvironment', 'read', 'unread', 'notice',
    'text', 'integer', 'directory', 'http_url',
]
