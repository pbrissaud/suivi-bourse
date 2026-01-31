"""
File watcher for hot-reload of event files.
"""

import threading
from pathlib import Path
from typing import Callable, Optional

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent


class EventFileHandler(FileSystemEventHandler):
    """Handler for event file changes."""

    def __init__(self, callback: Callable[[], None], debounce_seconds: float = 1.0):
        """
        Initialize the handler.

        Args:
            callback: Function to call when files change.
            debounce_seconds: Minimum time between callback invocations.
        """
        super().__init__()
        self.callback = callback
        self.debounce_seconds = debounce_seconds
        self._timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

    def _schedule_callback(self):
        """Schedule the callback with debouncing."""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self.debounce_seconds, self._run_callback)
            self._timer.start()

    def _run_callback(self):
        """Run the callback."""
        with self._lock:
            self._timer = None
        self.callback()

    def on_created(self, event: FileSystemEvent):
        """Handle file creation."""
        if not event.is_directory and self._is_event_file(event.src_path):
            self._schedule_callback()

    def on_modified(self, event: FileSystemEvent):
        """Handle file modification."""
        if not event.is_directory and self._is_event_file(event.src_path):
            self._schedule_callback()

    def on_deleted(self, event: FileSystemEvent):
        """Handle file deletion."""
        if not event.is_directory and self._is_event_file(event.src_path):
            self._schedule_callback()

    def _is_event_file(self, path: str) -> bool:
        """Check if the path is an event file."""
        suffix = Path(path).suffix.lower()
        return suffix in ('.csv', '.xlsx')


class EventWatcher:
    """Watches event files for changes and triggers reloads."""

    def __init__(self, watch_path: str, callback: Callable[[], None],
                 debounce_seconds: float = 1.0):
        """
        Initialize the watcher.

        Args:
            watch_path: Path to watch for changes.
            callback: Function to call when files change.
            debounce_seconds: Minimum time between callback invocations.
        """
        self.watch_path = Path(watch_path).expanduser()
        self.callback = callback
        self.debounce_seconds = debounce_seconds
        self._observer: Optional[Observer] = None
        self._running = False

    def start(self):
        """Start watching for file changes."""
        if self._running:
            return

        if not self.watch_path.exists():
            raise FileNotFoundError(f"Watch path does not exist: {self.watch_path}")

        handler = EventFileHandler(self.callback, self.debounce_seconds)
        self._observer = Observer()
        self._observer.schedule(handler, str(self.watch_path), recursive=False)
        self._observer.start()
        self._running = True

    def stop(self):
        """Stop watching for file changes."""
        if not self._running or self._observer is None:
            return

        self._observer.stop()
        self._observer.join()
        self._observer = None
        self._running = False

    @property
    def is_running(self) -> bool:
        """Check if the watcher is running."""
        return self._running
