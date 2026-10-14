"""The agent's conversations, one JSON file each (#1114).

``<store dir>/agent/threads/<id>.json``, written outside the store and outside
its write lock: a thread is the agent's memory, not the portfolio's. Every
function here does file I/O and is called from a worker thread.
"""
import contextlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from application import agent  # noqa: F401 - sets PYDANTIC_AI_NO_BANNER first
from application import instants
from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest

VERSION = 1

ID = re.compile(r'[A-Za-z0-9_-]{1,64}')

TITLE_MAX = 80


def directory(store_path) -> Path:
    """The threads' directory, beside the store file."""
    return Path(store_path).parent / 'agent' / 'threads'


def valid_id(thread_id) -> bool:
    """Can ``thread_id`` name a file in the directory, and only there?"""
    return isinstance(thread_id, str) and ID.fullmatch(thread_id) is not None


def read(root: Path, thread_id: str) -> Optional[dict]:
    """The thread, or ``None`` when there is none by that id.

    A file that is not a thread raises ``ValueError``, as :func:`messages`
    does on messages this version cannot read.
    """
    try:
        thread = json.loads((root / f'{thread_id}.json').read_text('utf-8'))
    except FileNotFoundError:
        return None
    if not isinstance(thread, dict):
        raise ValueError('the file holds no thread')
    return thread


def remove(root: Path, thread_id: str) -> bool:
    """Delete the thread's file; ``False`` when there was none.

    An ``OSError`` other than a missing file is the caller's to report.
    """
    try:
        (root / f'{thread_id}.json').unlink()
    except FileNotFoundError:
        return False
    return True


def listing(root: Path) -> List[dict]:
    """Every thread's id, title and dates, the most recent first."""
    if not root.is_dir():
        return []
    threads = []
    for path in root.glob('*.json'):
        try:
            thread = json.loads(path.read_text('utf-8'))
        except (OSError, ValueError):
            continue
        threads.append({key: thread.get(key) for key in
                        ('id', 'title', 'created_at', 'updated_at')})
    return sorted(threads, key=lambda t: t['updated_at'] or '', reverse=True)


def messages(thread: Optional[dict]) -> list:
    """The thread's model messages, or none."""
    if thread is None:
        return []
    return ModelMessagesTypeAdapter.validate_python(thread.get('messages'))


def answered(history: list) -> list:
    """``history`` without a trailing request no response followed.

    A turn that failed left its user message in the file; the next turn takes
    its place rather than stacking a second unanswered one on it.
    """
    history = list(history)
    while history and isinstance(history[-1], ModelRequest):
        history.pop()
    return history


def title_of(text: str) -> str:
    """The first characters of the first user message."""
    return ' '.join(text.split())[:TITLE_MAX]


def saved(thread: Optional[dict], thread_id: str, title: str,
          history: list, provider: str, model: str) -> dict:
    """``thread`` (or a new one) holding ``history``."""
    stamp = instants.iso(datetime.now(timezone.utc))
    return {
        'version': VERSION,
        'id': thread_id,
        'title': (thread or {}).get('title') or title,
        'created_at': (thread or {}).get('created_at') or stamp,
        'updated_at': stamp,
        'provider': provider,
        'model': model,
        'messages': ModelMessagesTypeAdapter.dump_python(history, mode='json'),
    }


def write(root: Path, thread: dict) -> None:
    """Replace the thread's file whole: a temp file, ``fsync``, ``os.replace``.

    An ``OSError`` (read-only volume, full disk) is the caller's to report.
    """
    root.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=root, prefix='.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(thread, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, root / f"{thread['id']}.json")
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
