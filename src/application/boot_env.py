"""The three things the environment still says, and the names it no longer says."""
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Tuple


STORE_DIR = 'SB_STORE_DIR'

WEB_PORT = 'SB_WEB_PORT'

LOG_LEVEL = 'LOG_LEVEL'

DEFAULT_STORE_DIR = '/data'
DEFAULT_WEB_PORT = 8080
DEFAULT_LOG_LEVEL = 'INFO'

INVENTORY: Tuple[Tuple[str, str], ...] = (
    (LOG_LEVEL, DEFAULT_LOG_LEVEL),
    (STORE_DIR, DEFAULT_STORE_DIR),
    (WEB_PORT, str(DEFAULT_WEB_PORT)),
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


def read(env: Mapping[str, str]) -> BootEnvironment:
    """The three boot values and the muted names, from a mapping like ``os.environ``."""
    return BootEnvironment(
        store_dir=directory(env, STORE_DIR, DEFAULT_STORE_DIR),
        web_port=integer(env, WEB_PORT, DEFAULT_WEB_PORT),
        log_level=text(env, LOG_LEVEL, DEFAULT_LOG_LEVEL),
        unread=unread(env),
    )


def effective(env: Mapping[str, str],
              log_level: Optional[str] = None) -> List[Dict]:
    """The read-only *effective configuration* ``/api/config`` publishes."""
    reported: List[Dict] = []
    for name, default in INVENTORY:
        raw = text(env, name)
        source, value = ('environment', raw) if raw is not None \
            else ('default', default)
        if name == LOG_LEVEL and log_level is not None:
            value = log_level
        reported.append({
            'name': name,
            'value': value,
            'set': raw is not None,
            'source': source,
        })
    return reported


__all__ = [
    'STORE_DIR', 'WEB_PORT', 'LOG_LEVEL',
    'DEFAULT_STORE_DIR', 'DEFAULT_WEB_PORT', 'DEFAULT_LOG_LEVEL',
    'INVENTORY', 'READ', 'PREFIXES', 'NEVER_READ',
    'BootEnvironment', 'read', 'unread', 'notice', 'effective',
    'text', 'integer', 'directory',
]
