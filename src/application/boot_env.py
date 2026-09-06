"""The three things the environment still says, and the names it no longer says.

The line between what the environment configures and what the store owns is
drawn by a **mechanical test** rather than by a judgement about nature
(ADR-0014, spec #730 § 1):

    the environment holds what the process must know **before** it can open the
    store; everything else is a dial and lives in the store.

It asks for no case-by-case arbitration, which is the whole reason it is written
as a rule rather than as a list of three opinions. Two notes have to stay written
down, because both names look like counter-examples until the test is applied to
them: the **web port** passes it twice — ``boot.py`` reads it before the store
is opened, to know what socket to bind, *and* a port changed from the interface
would cut the connection the interface arrived by, which is a nature and not only
a boot sequence — and **``LOG_LEVEL``** is here because the most likely failure of this
application is the store failing to open, and a level kept inside the store
cannot report that.

**There is no ``SB_WEB_ENABLED``** (ADR-0015). Headless is a *usage*, not a
setting: the page has no port of its own — it is served on the API's socket — so
a switch for it would be a dial **of the store**, in a product that has just
deleted its only restart-scoped dial. The one name that ever looked like the
counter-example decided a **socket to bind**, and the socket is bound once, when
the process starts — but ADR-0033 took that socket, and the flag and the port that
described it left with it. There is one bind, and the whole
application answers on it.

One of the three is a path (#740), and three rules come with it:

* **it is a directory, never a file.** The app names its own store file and
  its write-ahead log, so pointing at a path whose parent is not mounted stops
  being expressible at all — and that is also what makes the mount observation
  decidable, since it interrogates a *directory* rather than a file that does
  not exist yet;
* **the defaults describe the container**, and it is the deployment *without*
  Docker that overrides them. That is the reverse of v4, where compose always
  rendered every variable and made the app's own defaults dead code;
* **blank counts as unset**, because compose renders an undefined substitution
  as the empty string rather than omitting the variable.

Pure by construction, in the taste of :mod:`scheduling` and
:mod:`settings_registry`: every function here takes the mapping as an argument.
That is what lets the whole of it be tested against a dict, and it is also what
keeps *one* place reading ``os.environ`` in the process.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Tuple


# --------------------------------------------------------------------------- #
# The three names
# --------------------------------------------------------------------------- #

#: The directory the store lives in. The app owns the file name inside it, so
#: two installs pointed at one directory get two files rather than one silently
#: shared database.
STORE_DIR = 'SB_STORE_DIR'

#: The socket the app and its API are served on — the only one there is
#: (ADR-0033).
WEB_PORT = 'SB_WEB_PORT'

#: How loudly the app logs.
LOG_LEVEL = 'LOG_LEVEL'

#: The container's own path (ADR-0015, ADR-0032). ``/data`` is the named volume
#: and it is the **only** mount left, and it is a *default* rather than a
#: requirement: a bare ``docker run`` starts, and what it lacks is a volume
#: rather than a variable.
DEFAULT_STORE_DIR = '/data'
DEFAULT_WEB_PORT = 8080
DEFAULT_LOG_LEVEL = 'INFO'

#: Every variable that **configures** this application, with the value it takes
#: when nothing says otherwise — the list ``/api/config`` publishes. It is three
#: long and there is no fourth: what is not here lives in the store, the two
#: names the exporter answered for left with it (ADR-0033), and the drop
#: folder's own left with the mount (ADR-0032).
#:
#: *Configures* is doing work in that sentence, and it is the amendment
#: :mod:`build_info` made necessary. Two more names are read off the same
#: environment — ``RELEASE_VERSION`` and ``SOURCE_COMMIT``, the stamp the build
#: leaves on the image — and they are deliberately **not** here: nothing can be
#: done about them from anywhere, so publishing them as *what this container was
#: started with* would put one fact in two registers. They carry no ``SB_``
#: prefix either, which is what keeps them out of :func:`unread` by
#: construction rather than by an entry in a list — see that module.
#:
#: **No entry carries a secret flag any more** (#740). ``INFLUXDB_TOKEN`` was
#: the environment's only credential and it left with the database (#700), so
#: the redaction rule — redact *by name*, never by value (#654 trap 12) — has
#: no subject and dies with it rather than waiting, unexercised, for one. The
#: boolean reader left the same way with ADR-0033: **none of the three is a
#: flag**, and a reader kept for a name that may never come is a rule nothing
#: exercises.
INVENTORY: Tuple[Tuple[str, str], ...] = (
    (LOG_LEVEL, DEFAULT_LOG_LEVEL),
    (STORE_DIR, DEFAULT_STORE_DIR),
    (WEB_PORT, str(DEFAULT_WEB_PORT)),
)

#: The names the notice must never carry, because the app *does* read them.
READ: frozenset = frozenset(name for name, _ in INVENTORY)

# --------------------------------------------------------------------------- #
# Blank means unset
# --------------------------------------------------------------------------- #


def text(env: Mapping[str, str], name: str,
         default: Optional[str] = None) -> Optional[str]:
    """Read ``name``, treating a blank or whitespace-only value as unset.

    Compose substitutes an undefined variable as the **empty string** rather
    than omitting it, so ``SB_FOO=${FOO}`` with no ``FOO`` in ``.env`` hands the
    container ``SB_FOO=""``. A bare mapping lookup sees a set-but-empty value
    and every ``int()`` downstream blows up at boot; blank means *not answered*.
    """
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
    """Read the one path. ``expanduser`` because a Docker-less install
    writes ``~/…`` and gets a literal ``~`` directory otherwise."""
    return Path(text(env, name, default)).expanduser()


# --------------------------------------------------------------------------- #
# The names that went quiet
# --------------------------------------------------------------------------- #

#: The prefixes a v4 ``.env`` used. Anything set under one of them and not read
#: is **named** at boot — the gesture ``config.yaml`` and ``settings.yaml``
#: already get (ADR-0008, ADR-0014): name, do not read, do not decide.
PREFIXES = ('SB_', 'INFLUXDB_')

#: Carry the prefix and were never read by Python: the compose file's and the
#: docker daemon's own (#654 trap 13).
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
    """What the process knows before it opens the store, and what it ignores.

    Frozen, and produced by one call: the three values and the muted names are
    one reading of one mapping, so nothing downstream can hold two generations of
    an environment that cannot change under it anyway.
    """

    store_dir: Path
    web_port: int
    log_level: str
    unread: Tuple[str, ...]


def read(env: Mapping[str, str]) -> BootEnvironment:
    """The three boot values and the muted names, from a mapping like ``os.environ``.

    Takes the mapping rather than reading the process environment, which is what
    makes *"nothing set"*, *"a blank value"* and *"a v4 ``.env`` in full"* three
    ordinary test cases instead of three monkeypatched globals.
    """
    return BootEnvironment(
        store_dir=directory(env, STORE_DIR, DEFAULT_STORE_DIR),
        web_port=integer(env, WEB_PORT, DEFAULT_WEB_PORT),
        log_level=text(env, LOG_LEVEL, DEFAULT_LOG_LEVEL),
        unread=unread(env),
    )


def effective(env: Mapping[str, str],
              log_level: Optional[str] = None) -> List[Dict]:
    """The read-only *effective configuration* ``/api/config`` publishes.

    ``source`` is **factual, not helpful** (#654 trap 2): reporting a variable
    as "unset, using the default" *because it equals the default* would be a
    guess, so this reports what was found. ``log_level`` overrides the reported
    value for the one of these the app can change while it runs — the variable
    is merely where the level started.
    """
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
