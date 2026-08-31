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
described it went into :data:`DELETED` with it. There is one bind, and the whole
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

from application import settings_registry

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

#: Every variable this application reads, with the value it takes when nothing
#: says otherwise — the list ``/api/config`` publishes. It is three long and
#: there is no fourth: what is not here lives in the store, the two names the
#: exporter answered for left with it (ADR-0033), and the drop folder's own left
#: with the mount (ADR-0032).
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

#: Carried the prefix and were **never read by Python** — they belonged to the
#: compose file and the docker daemon (#654 trap 13). They are a *fourth*
#: category and stay out of the notice entirely: naming them would introduce
#: names the app has never obeyed into a sentence about names it has stopped
#: obeying.
#:
#: The compose file left with #743 and this list did **not**, which is the whole
#: point of it: the environment it guards against is not this repository's, it
#: is the one a v4 install still sources its own ``.env`` into. Deleting the
#: tuple would not remove the four names from the product — it would move them
#: into the notice, which is the one place spec #730 § 3 forbids them.
NEVER_READ: frozenset = frozenset({
    'SB_VERSION', 'SB_CONFIG_DIR', 'SB_UID', 'SB_GID',
    # v4's ``.env.example`` line 42, a port published by compose and read by
    # the daemon. It carries the prefix, so without it here the notice tells a
    # v4 install that ``INFLUXDB_PORT`` is *a setting this application has
    # stopped reading* — which is the one sentence the paragraph above forbids
    # about a name the application has never read.
    'INFLUXDB_PORT',
})

#: Deleted outright, with **no successor**. This one has to be written down:
#: where a name's subject went is *history*, and nothing derives history. Its
#: cost of being wrong is not cosmetic — an operator told that
#: ``SB_EXECUTOR_POOL`` "lives in the app now" goes looking for a field that has
#: never existed and for a ``PUT`` that answers ``422``.
#:
#: ``SB_STATIC_DIR`` is the fifteenth name and not one of the fourteen a v4
#: ``.env`` carries: it never appeared in one. It leaves with #740 all the same,
#: because *three* is the complete list of what the environment says and an
#: escape hatch for serving the bundle from elsewhere has no user left — one
#: image, one path, and a checkout resolves it from the package.
#:
#: The three last are the newest, and the ones an owner is likeliest to still
#: have written down. *No successor* is the whole of what there is to say about
#: them: the gauges did not become a dial, they became the health body and the
#: runtime tab (ADR-0033), and ``SB_IMPORT_DIR`` did not become a dial either —
#: the folder it named is gone and a file is **handed** to the app instead
#: (ADR-0032). Reported as *moved* they would send their owner looking for a
#: field to re-enable, and left out of the notice altogether they would read as a
#: typo — which is exactly the mistake this list exists to prevent. This is the
#: whole of the service the list renders: a variable still set is **named** as
#: read by nothing, rather than believed to act.
DELETED: frozenset = frozenset({
    'SB_EXECUTOR_POOL', 'SB_DYNAMIC_EXECUTOR_POOL', 'SB_PERF_INTERVAL',
    'SB_INGESTION_INTERVAL', 'SB_CONFIG_MODE', 'SB_STATIC_DIR',
    'INFLUXDB_HOST', 'INFLUXDB_TOKEN', 'INFLUXDB_DATABASE',
    'SB_PROMETHEUS_ENABLED', 'SB_METRICS_PORT', 'SB_IMPORT_DIR',
})

#: The one name whose dial is not its own name lower-cased: v4's deprecated
#: fallback for the poll cadence. Everything else is read off the registry
#: below, which is why this dict has exactly one entry and not six.
MOVED_ALIASES: Dict[str, str] = {
    'SB_SCRAPING_INTERVAL': 'regular_interval',
}


def moved_dial(name: str) -> Optional[str]:
    """The dial ``name`` became, or ``None``.

    **Read off :mod:`settings_registry`**, never off a second list. That is the
    invariant the notice rests on: adding a dial to the registry takes
    ``SB_<KEY>`` out of the *"this application has never read that"* clause and
    into the *"it lives in the app now"* one, with nothing here edited. Two
    lists of dials agree on the day they are written and not much longer, and
    this one would be the copy nobody re-reads at release time.
    """
    if name in MOVED_ALIASES:
        return MOVED_ALIASES[name]
    if not name.startswith('SB_'):
        return None
    key = name[len('SB_'):].lower()
    return key if key in settings_registry.BY_KEY else None


def unread(env: Mapping[str, str]) -> Tuple[str, ...]:
    """The ``SB_*``/``INFLUXDB_*`` names that are set and no longer read.

    A **computed complement** — what is present, minus the three it reads, minus
    the four it never read — and never a literal of fourteen, which would drift at
    the first rename: #701 removed one from the dials while this was being
    written. The day a name is added to :data:`INVENTORY` it leaves this list by
    construction, and the day a dial is added to the registry it changes clause
    by construction.
    """
    def is_unread(name: str, value: str) -> bool:
        if not name.startswith(PREFIXES):
            return False
        if name in READ or name in NEVER_READ:
            return False
        # Blank counts as unset here too, or a v4 compose file left in place
        # reports every variable it forwards as *set*.
        return bool(str(value).strip())

    return tuple(sorted(name for name, value in env.items()
                        if is_unread(name, value)))


def notice(names: Tuple[str, ...]) -> Optional[str]:
    """The **one** grouped sentence naming ``names``, or ``None`` for none.

    One line per variable would put fourteen warnings in front of an operator
    upgrading from v4 and bury the sentence that matters — which is not *which*
    name was ignored but *where the setting went*.

    And *where it went* has three answers, so the notice has three clauses. A
    variable that became a dial is worth following up; one that was deleted
    outright has no successor to look for; and a name the app has simply never
    read — a typo, a leftover from another tool — deserves neither instruction.
    """
    if not names:
        return None

    moved = [f"{name} → the {moved_dial(name)} dial" for name in names
             if moved_dial(name)]
    deleted = [name for name in names
               if name in DELETED and not moved_dial(name)]
    unknown = [name for name in names
               if not moved_dial(name) and name not in DELETED]

    # "not read" rather than "no longer read": the header covers all three
    # groups, and one of them is names this application has never read at all.
    parts = [f"These environment variables are set and not read: "
             f"{', '.join(names)}."]
    if moved:
        parts.append(
            f"These settings live in the app since v5 ({', '.join(moved)}) — "
            f"turn them on the settings page, or with one PUT /api/settings.")
    if deleted:
        parts.append(
            f"These were removed and have no replacement: "
            f"{', '.join(deleted)}.")
    if unknown:
        parts.append(
            f"These are not settings this application has ever read: "
            f"{', '.join(unknown)}.")
    return ' '.join(parts)


# --------------------------------------------------------------------------- #
# The whole of it, in one read
# --------------------------------------------------------------------------- #


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
    'INVENTORY', 'READ', 'PREFIXES', 'NEVER_READ', 'DELETED', 'MOVED_ALIASES',
    'BootEnvironment', 'read', 'unread', 'notice', 'moved_dial', 'effective',
    'text', 'integer', 'directory',
]
