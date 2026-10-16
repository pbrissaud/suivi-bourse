"""Whether a newer release is out (#1237).

The server asks GitHub, never the browser: one process, so one memo caps the
cadence for every tab, and the install's hostname never leaves in an
``Origin`` header. One attempt every :data:`EVERY`, whatever its outcome.

Pure but for the fetcher and the clock, both injected; ``http_fetch`` is the
one the app passes.
"""
import json
import threading
import urllib.request
from datetime import datetime, timedelta
from typing import Callable, Optional

from logfmt_logger import getLogger
from packaging.version import InvalidVersion, Version

logger = getLogger("update_check")

URL = 'https://api.github.com/repos/pbrissaud/suivi-bourse/releases/latest'
#: Where a release's notes live; any other ``html_url`` is not a link we draw.
NOTES = 'https://github.com/pbrissaud/suivi-bourse/releases/'
EVERY = timedelta(hours=6)
#: A release body is a few kilobytes of notes; anything far larger is not one.
MAX_BYTES = 1024 * 1024


def newer(release: object, running: Optional[str]) -> Optional[dict]:
    """``{version, url}`` when ``release`` is a stable release above ``running``."""
    if not isinstance(release, dict) or not isinstance(running, str):
        return None
    tag, url = release.get('tag_name'), release.get('html_url')
    if not isinstance(tag, str) or not isinstance(url, str) or not url.startswith(NOTES):
        return None
    try:
        published, mine = Version(tag), Version(running)
    except InvalidVersion:
        return None
    if published.is_prerelease or published <= mine:
        return None
    return {'version': str(published), 'url': url}


def http_fetch(url: str) -> bytes:
    """The body GitHub answers, or an exception."""
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json', 'User-Agent': 'suivi-bourse'})
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise OSError(f'HTTP {response.status}')
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise OSError('release larger than MAX_BYTES')
    return raw


class Checker:
    """The last answer, kept :data:`EVERY` — a failure included."""

    def __init__(self, fetch: Callable[[str], bytes]):
        self._fetch = fetch
        self._lock = threading.Lock()
        self._asked: Optional[datetime] = None
        self._release: object = None

    def latest(self, running: Optional[str], now: datetime) -> Optional[dict]:
        """The newer release, or ``None``. Asks GitHub at most once per :data:`EVERY`."""
        with self._lock:
            due = self._asked is None or now - self._asked >= EVERY
            if due:
                self._asked = now
        # Outside the lock: a slow GitHub holds one request thread, not all
        # four; the others answer with the previous release meanwhile.
        if due:
            release = self._ask()
            with self._lock:
                self._release = release
        return newer(self._release, running)

    def _ask(self) -> object:
        try:
            release = json.loads(self._fetch(URL))
            if not isinstance(release, dict):
                raise ValueError('not a release')
            return release
        except Exception as exc:  # the fetcher is injected; anything it raises is a failed check
            logger.warning(f"release check failed, next try in 6 h: {type(exc).__name__}")
            return None


__all__ = ['URL', 'NOTES', 'EVERY', 'newer', 'http_fetch', 'Checker']
