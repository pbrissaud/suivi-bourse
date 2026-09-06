"""What this process is running — the build's own name (ADR-0014, ADR-0033)."""
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from application import boot_env


RELEASE_VERSION = 'RELEASE_VERSION'

SOURCE_COMMIT = 'SOURCE_COMMIT'


RELEASE = 'release'

COMMIT = 'commit'

CHECKOUT = 'checkout'

UNKNOWN = 'unknown'


@dataclass(frozen=True)
class Build:
    """Which SuiviBourse this is. Frozen: it is settled at ``execve``."""

    version: Optional[str]
    revision: Optional[str]
    source: str

    def to_dict(self) -> Dict[str, Any]:
        return {'version': self.version,
                'revision': self.revision,
                'source': self.source}


UNSTAMPED = Build(version=None, revision=None, source=UNKNOWN)


def describe(env: Mapping[str, str],
             checkout: Optional[str] = None) -> Build:
    """Read the stamp off ``env``, falling back to a checkout's own revision."""
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
    """The build in one line, for the boot log."""
    if build.version is not None and build.revision is not None:
        return f'{build.version} ({build.revision[:12]})'
    if build.version is not None:
        return build.version
    if build.revision is not None:
        return f'{build.source} {build.revision[:12]}'
    return UNKNOWN


def checkout_revision(start: Optional[Path] = None) -> Optional[str]:
    """The commit of the checkout this file lives in, or ``None``."""
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
