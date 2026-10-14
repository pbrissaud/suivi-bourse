"""Whether the store directory outlives the container."""

import os

PERSISTENT = 'persistent'
EPHEMERAL = 'ephemeral'
UNKNOWN = 'unknown'

MOUNTINFO = '/proc/self/mountinfo'


def store_persistence(store_dir, mountinfo_path: str = MOUNTINFO) -> str:
    """A directory on the root filesystem's device sits in the writable layer.

        # ponytail: st_dev against `/` — a tmpfs mount reads as persistent; parse
    """
    if not os.path.exists(mountinfo_path):
        return UNKNOWN
    try:
        same = os.stat(store_dir).st_dev == os.stat('/').st_dev
    except OSError:
        return UNKNOWN
    return EPHEMERAL if same else PERSISTENT
