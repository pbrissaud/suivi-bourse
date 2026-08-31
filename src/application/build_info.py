"""What this process is running — the build's own name (ADR-0014, ADR-0033).

An owner opening a ticket has to be able to say *which* SuiviBourse broke, and
until now nothing in the product could answer: ``version.txt`` is written by
release-please and copied into no image, ``pyproject.toml`` is bumped by the
same release and reaches the builder stage alone, and the OCI labels the release
workflow stamps are readable by ``docker inspect`` and by nothing running inside
the container. So the build is **stamped at build time and read at boot**, and
this module is where the two ends meet.

**Two facts and a derived word, and the split is the whole design.** A *release
version* is what the registry published the image under; a *revision* is the
commit the build came from. Neither implies the other — an image built from a
tag has both, a PaaS building the branch on every push has only the second —
and ``source`` is read off the pair rather than stored beside it, because a
third stamp is a third thing that can disagree with the other two.

**Neither is invented.** A build nobody stamped answers ``None`` twice and
``unknown`` once; there is no ``"dev"``, no ``"0.0.0"`` and no ``"unknown"``
sitting in the *version* field. That is #845's rule applied one edge further
out: a word fabricated for a fact the payload does not carry is a word somebody
eventually branches on.

**The names carry no ``SB_`` prefix, and that is load-bearing rather than a
taste.** :func:`boot_env.unread` filters on the prefix alone, so an
``SB_BUILD_VERSION`` would land in the computed complement of names *set and no
longer obeyed* — arming the ``unread_environment`` installation fact, and
putting a permanent badge on the bell of every correctly stamped deployment, to
say that a variable the app has just read is read by nothing. The only exit for
a prefixed name would be :data:`boot_env.INVENTORY`, which is the list
``/api/config`` publishes as *what this container was started with*: the build
is not configuration, nothing can be done about it from anywhere, and it would
then be published in two registers at once.

``SOURCE_COMMIT`` is not a name this project chose either. It is what Coolify
injects as a build argument for a Dockerfile build pack, and what a platform
injects cannot be renamed from in here — so the Dockerfile's ``ARG`` carries
that name, the ``ENV`` beside it carries the same, and a deployment from git
stamps itself with nothing configured at all.

**Blank counts as unset**, through :func:`boot_env.text` rather than a private
copy of the rule. It is not a nicety here: the Dockerfile declares
``ARG SOURCE_COMMIT=""`` so that a plain ``docker build`` still works, which
means the variable is *always set* in the image and usually empty. A bare
mapping lookup would report every hand-built image as stamped with the empty
string.

Pure by construction, in the taste of :mod:`mounts` and :mod:`boot_env`: the
mapping is an argument and the revision of a checkout arrives as one, so the
whole of the reading is testable against a dict. Reading it off the working tree
is one function, at the bottom, and it is the only impure line in the module.
"""
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from application import boot_env

# --------------------------------------------------------------------------- #
# The two names the build stamps
# --------------------------------------------------------------------------- #

#: The version the registry published this image under — the release workflow
#: passes the tag ``docker/metadata-action`` computed, so it is the string an
#: operator can compare with the tag they pulled.
RELEASE_VERSION = 'RELEASE_VERSION'

#: The commit the build came from. **Coolify's own name** for its predefined
#: build argument, kept identical end to end so a deployment from git needs no
#: configuration to be identified.
SOURCE_COMMIT = 'SOURCE_COMMIT'


# --------------------------------------------------------------------------- #
# The four answers
# --------------------------------------------------------------------------- #

#: An image built from a release: it carries the version it was published under.
RELEASE = 'release'

#: An image built from a commit and not from a tag — what a PaaS building the
#: branch on every push produces. There is a revision and no version, and that
#: is a complete state rather than a missing half.
COMMIT = 'commit'

#: Not an image at all: a checkout, served by ``uv run python -m
#: application.boot``. Distinguished from :data:`COMMIT` because a working tree
#: may differ from the commit it names — the revision is where the code *came
#: from*, not proof of what is running.
CHECKOUT = 'checkout'

#: Nothing stamped this build and no checkout answered. A test's runtime, and an
#: image somebody built by hand with no build argument.
UNKNOWN = 'unknown'


@dataclass(frozen=True)
class Build:
    """Which SuiviBourse this is. Frozen: it is settled at ``execve``."""

    #: The published release, or ``None``.
    version: Optional[str]
    #: The commit, or ``None``. Full, never shortened — abbreviating is the
    #: reader's business and a truncated hash cannot be lengthened again.
    revision: Optional[str]
    #: Which of the four this is, derived from the pair above.
    source: str

    def to_dict(self) -> Dict[str, Any]:
        return {'version': self.version,
                'revision': self.revision,
                'source': self.source}


#: The build nobody stamped — the honest reading of a runtime nobody observed,
#: and the default :class:`main.Runtime` carries, in the taste of
#: :data:`mounts.UNKNOWN`.
UNSTAMPED = Build(version=None, revision=None, source=UNKNOWN)


def describe(env: Mapping[str, str],
             checkout: Optional[str] = None) -> Build:
    """Read the stamp off ``env``, falling back to a checkout's own revision.

    The order is *stamp, then checkout*, and it only ever matters in one place:
    a contributor running the image's own environment against a source tree.
    What the build says about itself wins, because that is what shipped.
    """
    version = boot_env.text(env, RELEASE_VERSION)
    stamped = boot_env.text(env, SOURCE_COMMIT)
    revision = stamped or (checkout.strip() or None if checkout else None)

    if version is not None:
        source = RELEASE
    elif stamped is not None:
        source = COMMIT
    elif revision is not None:
        source = CHECKOUT
    else:
        source = UNKNOWN
    return Build(version=version, revision=revision, source=source)


def said(build: Build) -> str:
    """The build in one line, for the boot log.

    The first line of ``docker logs`` is where *which version is this* is asked
    most often and answered most cheaply, so the sentence exists — and it says
    the two facts rather than the derived word, which is for a client that
    branches.
    """
    if build.version is not None and build.revision is not None:
        return f'{build.version} ({build.revision[:12]})'
    if build.version is not None:
        return build.version
    if build.revision is not None:
        return f'{build.source} {build.revision[:12]}'
    return UNKNOWN


# --------------------------------------------------------------------------- #
# The one impure function
# --------------------------------------------------------------------------- #

def checkout_revision(start: Optional[Path] = None) -> Optional[str]:
    """The commit of the checkout this file lives in, or ``None``.

    **Gated on a ``.git`` existing**, which is what makes it cost nothing in the
    image: the runtime layer copies two Python packages and no repository, so
    the subprocess is never spawned there and the container's stamp comes from
    its ``ENV`` alone.

    ``git rev-parse`` rather than a hand-rolled read of ``.git/HEAD``: this
    repository's own waves run in **worktrees**, where ``.git`` is a file, the
    refs live in the common directory and a branch may be packed — three shapes
    a private parser gets wrong one at a time, against six lines that get all
    three right. Every failure is the same answer: git absent, a repository in a
    state it will not talk about, a timeout — ``None``, which is
    :data:`UNKNOWN`, which is true.
    """
    here = (start or Path(__file__)).resolve()
    root = next((parent for parent in here.parents if (parent / '.git').exists()),
                None)
    if root is None:
        return None
    try:
        done = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            cwd=str(root), capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout.strip() or None


__all__ = [
    'RELEASE_VERSION', 'SOURCE_COMMIT',
    'RELEASE', 'COMMIT', 'CHECKOUT', 'UNKNOWN',
    'Build', 'UNSTAMPED', 'describe', 'said', 'checkout_revision',
]
