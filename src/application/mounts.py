"""Whether the store directory outlives the container.

Pure: no store, no network. ``store_persistence`` is read once at boot and
carried on the runtime (ADR-0015, #741).
"""

import os

PERSISTENT = 'persistent'
EPHEMERAL = 'ephemeral'
UNKNOWN = 'unknown'

#: Present on Linux alone; where it is absent (macOS, FreeBSD) the answer is
#: not observable and stays :data:`UNKNOWN`.
MOUNTINFO = '/proc/self/mountinfo'


def store_persistence(store_dir, mountinfo_path: str = MOUNTINFO) -> str:
    """A directory on the root filesystem's device sits in the writable layer.

    # ponytail: st_dev against `/` — a tmpfs mount reads as persistent; parse
    # the mount table if that ever matters.
    """
    if not os.path.exists(mountinfo_path):
        return UNKNOWN
    try:
        same = os.stat(store_dir).st_dev == os.stat('/').st_dev
    except OSError:
        return UNKNOWN
    return EPHEMERAL if same else PERSISTENT
