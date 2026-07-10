"""Tests for events.watcher.

Fast and deterministic: no real filesystem-event timing, no real threads, no
real watchdog Observer. ``threading.Timer`` and ``Observer`` are monkeypatched
so the debounce logic and the watcher lifecycle can be driven manually.
"""

import pytest

import events.watcher as watcher_mod
from events.watcher import EventFileHandler, EventWatcher


# --------------------------------------------------------------------------- #
# Test doubles                                                                #
# --------------------------------------------------------------------------- #

class FakeEvent:
    """Stand-in for watchdog.events.FileSystemEvent."""

    def __init__(self, src_path, is_directory=False):
        self.src_path = src_path
        self.is_directory = is_directory


@pytest.fixture
def fake_timer_cls(monkeypatch):
    """Replace ``events.watcher.threading.Timer`` with a manual fake.

    Records interval + callback for every timer created, tracks start/cancel,
    and lets a test fire the callback by hand. Returns the class; created
    instances are on ``fake_timer_cls.instances`` (fresh list per test).
    """
    instances = []

    class FakeTimer:
        def __init__(self, interval, function, args=None, kwargs=None):
            self.interval = interval
            self.function = function
            self.args = args or []
            self.kwargs = kwargs or {}
            self.started = False
            self.cancelled = False
            instances.append(self)

        def start(self):
            self.started = True

        def cancel(self):
            self.cancelled = True

        def fire(self):
            self.function(*self.args, **self.kwargs)

    FakeTimer.instances = instances
    monkeypatch.setattr(watcher_mod.threading, "Timer", FakeTimer)
    return FakeTimer


# --------------------------------------------------------------------------- #
# EventFileHandler._is_event_file                                             #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("path", [
    "file.csv",
    "file.xlsx",
    "FILE.CSV",
    "FILE.XLSX",
    "Data.Csv",
    "Data.XlSx",
    "/some/nested/dir/2024.csv",
    "/some/nested/dir/broker-export.xlsx",
])
def test_is_event_file_true(path):
    handler = EventFileHandler(callback=lambda: None)
    assert handler._is_event_file(path) is True


@pytest.mark.parametrize("path", [
    "file.txt",
    "file.xls",          # xls (old excel) is NOT accepted, only xlsx
    "file.csvx",
    "file",              # no suffix
    "archive.csv.gz",    # final suffix is .gz
    "/dir/README.md",
    "notes.yaml",
])
def test_is_event_file_false(path):
    handler = EventFileHandler(callback=lambda: None)
    assert handler._is_event_file(path) is False


# --------------------------------------------------------------------------- #
# on_created / on_modified / on_deleted dispatch                              #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("method_name", ["on_created", "on_modified", "on_deleted"])
def test_event_methods_schedule_for_event_files(mocker, method_name):
    handler = EventFileHandler(callback=lambda: None)
    spy = mocker.patch.object(handler, "_schedule_callback")

    method = getattr(handler, method_name)
    method(FakeEvent("/watch/2024.csv", is_directory=False))
    method(FakeEvent("/watch/broker.xlsx", is_directory=False))

    assert spy.call_count == 2


@pytest.mark.parametrize("method_name", ["on_created", "on_modified", "on_deleted"])
def test_event_methods_ignore_directories(mocker, method_name):
    handler = EventFileHandler(callback=lambda: None)
    spy = mocker.patch.object(handler, "_schedule_callback")

    # A directory whose name would otherwise match an event-file suffix must
    # still be ignored because is_directory is True.
    method = getattr(handler, method_name)
    method(FakeEvent("/watch/some.csv", is_directory=True))

    spy.assert_not_called()


@pytest.mark.parametrize("method_name", ["on_created", "on_modified", "on_deleted"])
def test_event_methods_ignore_non_event_files(mocker, method_name):
    handler = EventFileHandler(callback=lambda: None)
    spy = mocker.patch.object(handler, "_schedule_callback")

    method = getattr(handler, method_name)
    method(FakeEvent("/watch/notes.txt", is_directory=False))

    spy.assert_not_called()


# --------------------------------------------------------------------------- #
# Debounce behaviour (_schedule_callback / _run_callback)                     #
# --------------------------------------------------------------------------- #

def test_schedule_callback_records_debounce_delay(fake_timer_cls):
    handler = EventFileHandler(callback=lambda: None, debounce_seconds=7.5)
    handler._schedule_callback()

    assert len(fake_timer_cls.instances) == 1
    timer = fake_timer_cls.instances[0]
    assert timer.interval == 7.5
    assert timer.started is True
    assert timer.cancelled is False


def test_rapid_events_cancel_previous_timer_and_fire_once(fake_timer_cls):
    calls = []
    handler = EventFileHandler(callback=lambda: calls.append(1),
                               debounce_seconds=5.0)

    # Simulate several rapid file events.
    for _ in range(4):
        handler.on_modified(FakeEvent("/watch/2024.csv", is_directory=False))

    timers = fake_timer_cls.instances
    assert len(timers) == 4

    # Every timer except the last was cancelled by the following schedule call.
    for t in timers[:-1]:
        assert t.cancelled is True
    last = timers[-1]
    assert last.cancelled is False
    assert last.started is True

    # No callback has run yet (nothing fired).
    assert calls == []

    # Fire only the surviving timer -> callback runs exactly once.
    last.fire()
    assert calls == [1]


def test_run_callback_clears_timer_and_invokes_callback(fake_timer_cls):
    calls = []
    handler = EventFileHandler(callback=lambda: calls.append("run"),
                               debounce_seconds=1.0)

    handler._schedule_callback()
    assert handler._timer is not None

    fake_timer_cls.instances[-1].fire()

    # _run_callback resets the stored timer and calls the user callback.
    assert handler._timer is None
    assert calls == ["run"]


# --------------------------------------------------------------------------- #
# EventWatcher lifecycle                                                       #
# --------------------------------------------------------------------------- #

@pytest.fixture
def mock_observer(mocker):
    """Patch ``events.watcher.Observer`` with a MagicMock class.

    Returns the single instance that ``Observer()`` yields, so tests can assert
    on ``.schedule`` / ``.start`` / ``.stop`` / ``.join`` calls.
    """
    observer_cls = mocker.patch.object(watcher_mod, "Observer")
    return observer_cls.return_value


def test_start_schedules_and_starts_observer(mock_observer, tmp_path):
    watcher = EventWatcher(str(tmp_path), callback=lambda: None,
                           debounce_seconds=2.0)
    assert watcher.is_running is False

    watcher.start()

    assert watcher.is_running is True
    mock_observer.schedule.assert_called_once()
    # schedule(handler, path, recursive=False)
    args, kwargs = mock_observer.schedule.call_args
    assert isinstance(args[0], EventFileHandler)
    assert args[1] == str(tmp_path)
    assert kwargs.get("recursive") is False
    mock_observer.start.assert_called_once()


def test_start_is_idempotent(mock_observer, tmp_path):
    watcher = EventWatcher(str(tmp_path), callback=lambda: None)

    watcher.start()
    watcher.start()  # second call must be a no-op

    assert watcher.is_running is True
    assert mock_observer.start.call_count == 1
    assert mock_observer.schedule.call_count == 1


def test_stop_stops_and_joins_observer(mock_observer, tmp_path):
    watcher = EventWatcher(str(tmp_path), callback=lambda: None)
    watcher.start()

    watcher.stop()

    assert watcher.is_running is False
    mock_observer.stop.assert_called_once()
    mock_observer.join.assert_called_once()


def test_stop_without_start_is_noop(mock_observer, tmp_path):
    watcher = EventWatcher(str(tmp_path), callback=lambda: None)

    watcher.stop()  # never started

    assert watcher.is_running is False
    mock_observer.stop.assert_not_called()
    mock_observer.join.assert_not_called()


def test_start_missing_path_raises(mock_observer, tmp_path):
    missing = tmp_path / "does-not-exist"
    watcher = EventWatcher(str(missing), callback=lambda: None)

    with pytest.raises(FileNotFoundError):
        watcher.start()

    assert watcher.is_running is False
    # Observer must never be scheduled/started for a missing path.
    mock_observer.schedule.assert_not_called()
    mock_observer.start.assert_not_called()
