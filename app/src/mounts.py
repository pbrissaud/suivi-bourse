"""Is the store on something that outlives the container? (issue #741, ADR-0015)

**Persistence is observed and said, never demanded.** #677/D12 refused to boot
without an explicit store location, the error message being the guide; ADR-0015
amends it, and ``docker run ghcr.io/pbrissaud/suivi-bourse`` starts with no
volume at all — the store simply lives in the container's writable layer and
dies with it. An ephemeral container is then a **trial run**: type three
positions, look at what it gives, lose it all on the way out.

What makes that amendment *safe* rather than merely convenient is one fact,
**asserted false in session before it was verified**: ``/proc/self/mountinfo``
distinguishes a mounted path — named volume *or* bind — from the writable layer
with certainty. The predicate of #677/D12 was in the wrong place. It refused at
boot what it is enough to **observe and state**.

The fixtures under ``tests/fixtures/mountinfo/`` are that verification, captured
in a real container and versioned with the ``docker run`` that produced each of
them: they are the proof, not an illustration.

Four things about the shape are decisions rather than defaults:

* **The function takes the *text*, never a path under ``/proc``.** That is what
  makes the whole of it testable without a container, against samples committed
  to the repository. Reading the file is one function, at the bottom, and it is
  the only impure line in the module.
* **The match is on the longest mount point that *prefixes* the path, never on
  equality.** A bind of ``/data`` and a bind of an ancestor both answer
  *persistent*; the store directory is not required to be a mount point of its
  own. Longest wins, so a volume mounted *inside* a bind is read as the volume.
* **What the longest match then decides is its filesystem, not its name.** A
  bare container is the reason: ``/data`` does not figure in ``mountinfo`` — as
  the ticket says — but ``/`` always does, and it *is* the writable layer. The
  naive rule *"the longest match is ``/``, therefore ephemeral"* is right in a
  container and **false on a Docker-less install**, where ``/`` is an ordinary
  filesystem that survives everything. So the discriminant is the one field
  already parsed beside the mount point: a **volatile** filesystem
  (:data:`VOLATILE_FILESYSTEMS`) is the writable layer or a RAM disk, anything
  else outlives the process that mounted it.
* **Off Linux the answer is *unknown*, and unknown prints nothing.** The
  observation is a property of the kernel; an absent ``/proc`` must not
  manufacture a false *ephemeral* on a macOS developer's machine — the one
  platform this application cannot run natively on at all (#657).

Pure by construction, in the taste of :mod:`scheduling` and :mod:`boot_env`:
``resolve`` is injected the way ``now`` is there, so the symlink resolution the
comparison needs is a fake in a test and ``os.path.realpath`` in production.
"""
import os
import posixpath
import re
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

# --------------------------------------------------------------------------- #
# The three answers
# --------------------------------------------------------------------------- #

#: The path is on a mount that outlives this container — a named volume, a
#: bind, or the ordinary filesystem of a Docker-less install.
PERSISTENT = 'persistent'

#: The path is on the container's writable layer (or a RAM disk): whatever is
#: written there dies with the container.
EPHEMERAL = 'ephemeral'

#: Not observable from here. ``/proc/self/mountinfo`` is absent or unreadable,
#: or it says nothing about this path. **Nothing is printed** on this answer,
#: and the resources publish ``unknown`` rather than one of the two real states.
UNKNOWN = 'unknown'

#: Where the kernel publishes this process's mount table.
MOUNTINFO = '/proc/self/mountinfo'

#: Filesystems whose contents do not outlive the container that mounted them.
#:
#: ``overlay`` is the one the amendment rests on and the one measured: it is
#: what Docker's default storage driver makes the container root, and a bare
#: ``docker run`` therefore lands ``/data`` there. ``overlayfs``, ``aufs`` and
#: ``fuse.fuse-overlayfs`` are the same union filesystem under the three other
#: names a storage driver has used — the last being what a **rootless** Docker
#: or Podman container reports for its own root, so leaving it out would have a
#: bare rootless container publish ``persistent``, i.e. state that a store
#: nothing keeps *is* kept. ``tmpfs``/``ramfs`` are here for a different
#: reason and not for symmetry: a store on ``--tmpfs /data`` **is** a mount, so
#: the mount test alone would call it persistent while it is the most ephemeral
#: thing there is.
VOLATILE_FILESYSTEMS = frozenset({
    'overlay', 'overlayfs', 'aufs', 'fuse.fuse-overlayfs', 'tmpfs', 'ramfs',
})

# --------------------------------------------------------------------------- #
# Reading one mount table
# --------------------------------------------------------------------------- #

#: ``mountinfo`` escapes exactly four characters in its path fields, in octal.
#: Substituted in **one pass**, because replacing them one after another turns a
#: literal backslash followed by ``040`` into a space.
_ESCAPES = {'040': ' ', '011': '\t', '012': '\n', '134': '\\'}
_ESCAPE_RE = re.compile(r'\\(040|011|012|134)')


@dataclass(frozen=True)
class Mount:
    """One line of ``mountinfo``, reduced to the two fields that decide.

    ``point`` is where it is mounted (field 5, unescaped) and ``filesystem`` the
    type the kernel gives it (the first field after the ``-`` separator). Every
    other field — the mount id, the propagation flags, the source, the super
    options — is deliberately dropped: nothing here reads them, and a dataclass
    carrying them would invite a rule that does.
    """

    point: str
    filesystem: str


def _unescape(value: str) -> str:
    """Undo ``mountinfo``'s octal escaping of space, tab, newline, backslash."""
    return _ESCAPE_RE.sub(lambda match: _ESCAPES[match.group(1)], value)


def parse(text: Optional[str]) -> Tuple[Mount, ...]:
    """Every mount in ``text``, in the order the kernel listed them.

    The order is kept because it carries a fact: two mounts may share one point,
    and the later one is the one you reach. :func:`enclosing` relies on it.

    A line that cannot be read is **skipped rather than raised on**. This runs in
    the gunicorn master, before anything has been forked, and a kernel that grew
    a field must not be able to take the boot down over a diagnostic.
    """
    mounts = []
    for line in (text or '').splitlines():
        fields = line.split(' ')
        # The six fixed fields, then optional ones, then ``-``, then the type.
        # Searching for the separator **from index 6** is not a micro-detail: a
        # directory literally named ``-`` is a legal mount point, and a search
        # from the start would find it and read the mount options as a
        # filesystem type.
        try:
            separator = fields.index('-', 6)
        except ValueError:
            continue
        if separator + 1 >= len(fields):
            continue
        mounts.append(Mount(point=_unescape(fields[4]),
                            filesystem=fields[separator + 1]))
    return tuple(mounts)


def _prefixes(point: str, path: str) -> bool:
    """Does ``point`` contain ``path`` — on **components**, never on characters.

    ``/srv`` contains ``/srv/data`` and does not contain ``/srvo``, which a bare
    ``startswith`` gets wrong in the direction that matters: it would report a
    store in the writable layer as persistent because some unrelated volume's
    name happens to start with the same letters.
    """
    if point == '/':
        return True
    return path == point or path.startswith(point + '/')


def enclosing(mounts: Tuple[Mount, ...], path: str) -> Optional[Mount]:
    """The mount ``path`` actually lives on, or ``None``.

    The **longest** point that prefixes it, and on a tie the **last** listed —
    which is what a second mount over the same point means: it shadows the first.
    """
    found: Optional[Mount] = None
    for mount in mounts:
        if not _prefixes(mount.point, path):
            continue
        if found is None or len(mount.point) >= len(found.point):
            found = mount
    return found


# --------------------------------------------------------------------------- #
# The observation
# --------------------------------------------------------------------------- #


def observe(mountinfo: Optional[str], path,
            resolve: Optional[Callable[[str], str]] = None) -> str:
    """``(the text of mountinfo, a path)`` → :data:`PERSISTENT` / :data:`EPHEMERAL` / :data:`UNKNOWN`.

    ``mountinfo`` is the **text**, so the whole of this is exercised against the
    samples in ``tests/fixtures/mountinfo/``; ``None`` is the reading of a
    kernel that publishes no such file and answers :data:`UNKNOWN`.

    ``resolve`` turns the path into the one the kernel would compare against —
    symlinks followed, ``..`` collapsed — and is injected rather than called
    directly so a test can hand over a mapping instead of building a tree.
    ``os.path.realpath`` is the production one; ``..`` is collapsed here as well,
    so an identity resolver still compares something meaningful.
    """
    if mountinfo is None:
        return UNKNOWN

    resolver = os.path.realpath if resolve is None else resolve
    resolved = posixpath.normpath(str(resolver(str(path))))
    if not resolved.startswith('/'):
        # A relative path names nothing a mount table can be asked about. The
        # production resolver never returns one; a fake may.
        return UNKNOWN

    mount = enclosing(parse(mountinfo), resolved)
    if mount is None:
        return UNKNOWN
    return EPHEMERAL if mount.filesystem in VOLATILE_FILESYSTEMS else PERSISTENT


# --------------------------------------------------------------------------- #
# The one impure line
# --------------------------------------------------------------------------- #


def read_mountinfo(mountinfo_path: str = MOUNTINFO) -> Optional[str]:
    """The text of the mount table, or ``None`` when there is not one.

    Absent (macOS, FreeBSD), unreadable (a hardened runtime), or a directory:
    every one of those is *not observable from here* and none of them is an
    error worth a line of its own — the caller already says nothing on
    :data:`UNKNOWN`.
    """
    try:
        with open(mountinfo_path, 'r', encoding='utf-8',
                  errors='replace') as handle:
            return handle.read()
    except OSError:
        return None


def store_persistence(store_dir, mountinfo_path: str = MOUNTINFO) -> str:
    """Observe the directory the store lives in. One call, made once at boot.

    Made **once**, in the gunicorn master, and carried on ``Runtime`` across the
    fork: a mount namespace does not change under a running process, so asking
    again per request would be a query whose answer is fixed at ``execve``.
    """
    return observe(read_mountinfo(mountinfo_path), store_dir)


__all__ = [
    'PERSISTENT', 'EPHEMERAL', 'UNKNOWN', 'MOUNTINFO', 'VOLATILE_FILESYSTEMS',
    'Mount', 'parse', 'enclosing', 'observe',
    'read_mountinfo', 'store_persistence',
]
