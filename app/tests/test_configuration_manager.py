"""
Unit tests for main.ConfigurationManager.

These tests exercise ConfigurationManager in isolation:
  * mode selection priority (SB_CONFIG_MODE env > settings.yaml `mode:` >
    auto-detection from the events source > default 'manual')
  * events-source defaulting
  * _compute_cache_key behaviour (None in manual, mtime-based in events)
  * the caching contract of the snapshot build (identity reuse, force reload,
    invalidation on file change)
  * get_first_buy_date / get_events
  * publication (issue #658): one immutable snapshot, validated before it is
    published, swapped by a single rebind — the null window and the split-brain

Every ConfigurationManager is built with ``config_dir=str(tmp_path)`` so nothing
ever touches the real ~/.config/SuiviBourse. SB_CONFIG_MODE is managed strictly
through monkeypatch (an autouse fixture deletes it before every test) so it can
never leak between tests. No network, no real InfluxDB, no yfinance.
"""

import os
import threading
import time
from datetime import date

import pytest

import main
from main import ConfigurationManager
from events.validator import EventValidationError


# --------------------------------------------------------------------------- #
# Isolation: ensure SB_CONFIG_MODE never leaks in from the real environment or
# from a previous test. Tests that need it set do so with monkeypatch.setenv.
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _no_config_mode_env(monkeypatch):
    monkeypatch.delenv("SB_CONFIG_MODE", raising=False)


def _write_settings(config_dir, text):
    """Write a settings.yaml into the config dir."""
    (config_dir / "settings.yaml").write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Mode selection priority
# --------------------------------------------------------------------------- #
def test_default_mode_is_manual(tmp_path):
    """No env var and no settings.yaml -> default mode 'manual'."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL
    # Manual mode never populates an events source.
    assert cm._events_source is None


def test_env_overrides_settings_yaml(tmp_path, monkeypatch):
    """SB_CONFIG_MODE env wins over a conflicting settings.yaml mode."""
    _write_settings(tmp_path, "mode: events\nevents:\n  source: /nowhere\n")
    monkeypatch.setenv("SB_CONFIG_MODE", "manual")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL
    # The env var overrides the *mode* only; the events block is still parsed
    # (and simply unused in manual mode).
    assert cm._events_source == "/nowhere"


def test_env_mode_still_honours_events_block(tmp_path, monkeypatch):
    """Selecting events mode via env keeps settings.yaml's source and watch.

    Regression guard: the env branch used to short-circuit the whole
    settings.yaml read, so the documented compose path (SB_CONFIG_MODE=events)
    silently ignored a custom source and never started the file watcher despite
    `watch: true`.
    """
    src = str(tmp_path / "my_events")
    _write_settings(tmp_path, f"events:\n  source: {src}\n  watch: true\n")
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS
    assert cm._events_source == src
    assert cm._watch_enabled is True


def test_blank_env_mode_is_treated_as_unset(tmp_path, monkeypatch):
    """An empty SB_CONFIG_MODE falls through instead of selecting mode ''.

    Compose renders `SB_CONFIG_MODE=${SB_CONFIG_MODE}` as an empty string when
    the variable is absent from .env, which must not defeat settings.yaml.
    """
    _write_settings(tmp_path, "mode: events\n")
    monkeypatch.setenv("SB_CONFIG_MODE", "   ")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS


# --------------------------------------------------------------------------- #
# Mode auto-detection (lowest priority: nothing declared anywhere)
# --------------------------------------------------------------------------- #
def test_detects_events_mode_from_event_files(tmp_path):
    """No env and no settings.yaml, but event files present -> events mode."""
    events = tmp_path / "events"
    events.mkdir()
    (events / "2024.csv").write_text("date,event_type\n", encoding="utf-8")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS
    assert cm._events_source == str(tmp_path / "events")


def test_detects_manual_mode_when_events_dir_has_no_event_files(tmp_path):
    """An events dir holding no .csv/.xlsx does not trigger events mode."""
    events = tmp_path / "events"
    events.mkdir()
    (events / "README.md").write_text("drop your exports here\n", encoding="utf-8")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL


def test_detection_uses_declared_events_source(tmp_path):
    """Detection looks at settings.yaml's events.source, not just the default."""
    src = tmp_path / "broker_exports"
    src.mkdir()
    (src / "export.xlsx").write_bytes(b"")
    _write_settings(tmp_path, f"events:\n  source: {src}\n")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS


def test_explicit_manual_mode_beats_detection(tmp_path):
    """An explicit `mode: manual` wins even with event files sitting there."""
    events = tmp_path / "events"
    events.mkdir()
    (events / "2024.csv").write_text("date,event_type\n", encoding="utf-8")
    _write_settings(tmp_path, "mode: manual\n")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL


def test_env_value_is_lowercased(tmp_path, monkeypatch):
    """An upper-case env value is normalised to lower-case."""
    monkeypatch.setenv("SB_CONFIG_MODE", "EVENTS")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS


def test_settings_yaml_selects_events_mode(tmp_path):
    """With no env var, settings.yaml drives mode and reads events.source/watch."""
    src = str(tmp_path / "my_events")
    _write_settings(
        tmp_path,
        f"mode: events\nevents:\n  source: {src}\n  watch: true\n",
    )
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS
    assert cm._events_source == src
    assert cm._watch_enabled is True


def test_settings_yaml_manual_is_default_when_mode_absent(tmp_path):
    """settings.yaml present but without a 'mode' key -> defaults to manual."""
    _write_settings(tmp_path, "events:\n  watch: false\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL


def test_events_source_defaults_to_config_dir_events_via_env(tmp_path, monkeypatch):
    """In events mode with no explicit source, it defaults to <config_dir>/events."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS
    assert cm._events_source == str(tmp_path / "events")


def test_events_source_defaults_when_settings_omits_source(tmp_path):
    """settings.yaml events mode without a source falls back to <config_dir>/events."""
    _write_settings(tmp_path, "mode: events\nevents:\n  watch: false\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_EVENTS
    assert cm._events_source == str(tmp_path / "events")
    assert cm._watch_enabled is False


# --------------------------------------------------------------------------- #
# _compute_cache_key
# --------------------------------------------------------------------------- #
def test_cache_key_none_in_manual_mode(tmp_path):
    """Manual mode has no file-based cache key."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL
    assert cm._compute_cache_key() is None


def test_cache_key_reflects_event_file_mtimes(tmp_path, monkeypatch, events_dir):
    """In events mode the key references the event files and their mtimes."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_mode()  # populate _mode/_events_source

    key = cm._compute_cache_key()
    assert key is not None
    assert str(events_dir / "2024.csv") in key


def test_cache_key_changes_when_file_mtime_changes(tmp_path, monkeypatch, events_dir):
    """Touching an event file to a new mtime changes the cache key."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_mode()

    key_before = cm._compute_cache_key()

    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    key_after = cm._compute_cache_key()
    assert key_before != key_after


def test_cache_key_none_when_events_source_missing(tmp_path, monkeypatch):
    """No events directory on disk yields a None key (nothing to hash)."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_mode()
    # <config_dir>/events was never created.
    assert cm._compute_cache_key() is None


# --------------------------------------------------------------------------- #
# Caching contract of _load_from_events (real loader/validator/aggregator run)
# --------------------------------------------------------------------------- #
def test_events_load_produces_expected_shares(tmp_path, monkeypatch, events_dir):
    """The real events pipeline runs and yields AAPL + MSFT shares."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    shares = cm.load_shares()
    assert isinstance(shares, list)
    assert {s["symbol"] for s in shares} == {"AAPL", "MSFT"}


def test_second_load_returns_same_cached_object(tmp_path, monkeypatch, events_dir):
    """A second load with no file change returns the identical cached object."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()
    second = cm.load_shares()
    assert second is first


def test_force_reload_bypasses_cache(tmp_path, monkeypatch, events_dir):
    """force=True re-runs the pipeline, returning a fresh (equal) object."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()
    forced = cm.load_shares(force=True)
    assert forced is not first
    assert forced == first


def test_file_change_invalidates_cache(tmp_path, monkeypatch, events_dir):
    """A changed file mtime invalidates the cache on the next (non-forced) load."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()

    # Simulate an edit by bumping the file's mtime so the cache key differs.
    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    second = cm.load_shares()
    assert second is not first  # reloaded because the key changed
    assert second == first      # same content (file body unchanged)


# --------------------------------------------------------------------------- #
# get_first_buy_date
# --------------------------------------------------------------------------- #
def test_get_first_buy_date_earliest_buy(tmp_path, monkeypatch, events_dir):
    """Returns the earliest BUY date for a symbol (ignores later BUYs)."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()

    # AAPL has BUYs on 2024-01-15 and 2024-06-15 -> earliest is 2024-01-15.
    assert cm.get_first_buy_date("AAPL") == date(2024, 1, 15)
    assert cm.get_first_buy_date("MSFT") == date(2024, 2, 1)


def test_get_first_buy_date_none_when_no_events_loaded(tmp_path):
    """With nothing loaded (cached_events is None), returns None."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_first_buy_date("AAPL") is None


def test_get_first_buy_date_none_for_absent_symbol(tmp_path, monkeypatch, events_dir):
    """A symbol with no BUY events returns None."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()
    assert cm.get_first_buy_date("GOOG") is None


# --------------------------------------------------------------------------- #
# get_events
# --------------------------------------------------------------------------- #
def test_get_events_none_before_load(tmp_path):
    """Before any load, get_events returns None."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_events() is None


def test_get_events_returns_cached_events(tmp_path, monkeypatch, events_dir):
    """After an events load, get_events returns the published snapshot's events."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()

    events = cm.get_events()
    assert events is cm.current().events
    assert len(events) == 7  # matches the canonical events CSV in conftest


# --------------------------------------------------------------------------- #
# Publication: the snapshot is built off-line and published by one rebind
# (issue #658, design #653)
# --------------------------------------------------------------------------- #
def test_current_publishes_on_first_use_and_then_returns_the_same_object(
        tmp_path, monkeypatch, events_dir):
    """The read path is one attribute read, so it must be stable between loads."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.current()
    assert first is cm.current()
    assert {s["symbol"] for s in first.shares} == {"AAPL", "MSFT"}
    assert len(first.events) == 7
    assert first.cache_key is not None


def test_snapshot_is_swapped_whole_when_files_change(tmp_path, monkeypatch,
                                                     events_dir):
    """A reload replaces the snapshot; it never edits the published one."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    before = cm.current()
    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    after = cm.reload()
    assert after is not before
    assert after.shares == before.shares
    # The old snapshot is untouched — whoever still holds it holds a whole,
    # coherent configuration.
    assert before.events is not after.events
    assert len(before.events) == 7


def test_a_reload_never_exposes_a_half_built_configuration(
        tmp_path, monkeypatch, events_dir):
    """The null window: shares and events are published together or not at all.

    ``invalidate_cache()`` used to null the three cache fields *before*
    ``ingest()`` refilled them. A backfill cycle landing in that window read
    ``events = None``, so ``get_first_buy_date`` returned ``None`` and the whole
    backward pass was silently skipped for that cycle — no crash, no log. Here a
    reader hammers the read path while a writer rebuilds; every observation must
    be a complete configuration.
    """
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.current()  # first publication

    # Make the rebuild slow enough that the reader is guaranteed to observe the
    # window during which the candidate is being assembled.
    real_load = cm._load_from_events

    def slow_load(accounts):
        time.sleep(0.005)
        return real_load(accounts)

    cm._load_from_events = slow_load

    observations = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            snap = cm.current()
            observations.append(
                (len(snap.shares), snap.events, snap.first_buy_date("AAPL")))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for _ in range(20):
            cm.reload(force=True)
    finally:
        stop.set()
        thread.join(timeout=5)

    assert observations
    for share_count, events, first_buy in observations:
        assert share_count == 2
        assert events is not None and len(events) == 7
        assert first_buy == date(2024, 1, 15)


# --------------------------------------------------------------------------- #
# One published state: a rejected configuration changes nothing, anywhere
# --------------------------------------------------------------------------- #
class _AcceptingThenRejecting:
    """Accepts the first document, rejects every later one."""

    errors = {"shares": ["nope"]}

    def __init__(self):
        self.calls = 0

    def validate(self, document):
        self.calls += 1
        return self.calls == 1


def test_a_rejected_config_changes_nothing_anywhere(tmp_path, monkeypatch,
                                                    events_dir):
    """The split-brain, closed.

    The cache used to be written by the loader and validated afterwards by
    ``ingest()``, so a refused configuration was already sitting in it: scraping
    kept the old shares while **backfill and the performance recompute** read
    the very config the validator had just rejected. Validation now happens
    inside snapshot construction, so a rejected one is never published and there
    is nothing for anyone to read.
    """
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(
        config_dir=str(tmp_path), validator_=_AcceptingThenRejecting())
    published = cm.current()

    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    with pytest.raises(main.InvalidConfigFile):
        cm.reload()

    # Every read path — not just the one ingest() used to guard — still sees the
    # previous generation, and sees the *same* object.
    assert cm.current() is published
    assert cm.get_events() is published.events
    assert cm.get_first_buy_date("AAPL") == date(2024, 1, 15)
    assert cm.load_accounts() is published.accounts


def test_the_real_schema_is_the_gate(tmp_path, mocker):
    """A share list that fails schema.yaml is refused, with InvalidConfigFile."""
    fake_config = mocker.MagicMock()
    fake_config.__getitem__.return_value.get.return_value = [
        {"name": "Broken", "symbol": "BAD"}  # no purchase/estate blocks
    ]
    mocker.patch("main.Configuration", return_value=fake_config)

    cm = ConfigurationManager(config_dir=str(tmp_path))
    with pytest.raises(main.InvalidConfigFile):
        cm.reload()
    assert cm._config is None  # nothing was published


def test_an_empty_portfolio_is_not_a_rejection(tmp_path, monkeypatch):
    """`empty: False` in schema.yaml must not turn a fresh install into a crash.

    Events mode starts life with an empty events/ directory — the app is
    expected to run, warn, and pick up the first file that lands.
    """
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    (tmp_path / "events").mkdir()
    cm = ConfigurationManager(config_dir=str(tmp_path))

    snap = cm.current()
    assert snap.shares == []
    assert snap.events == []


def test_a_malformed_accounts_block_is_refused_before_publication(
        tmp_path, monkeypatch, events_dir):
    """`accounts:` is validated on the candidate too, not after publication."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    published = cm.current()

    _write_settings(tmp_path, "accounts:\n  - id: PEA\n    type: PEA\n")  # no currency

    with pytest.raises(ValueError, match="Invalid 'accounts' block"):
        cm.reload()
    assert cm.current() is published


# --------------------------------------------------------------------------- #
# The accounts block is re-read on every build (it used to be boot-only)
# --------------------------------------------------------------------------- #
def test_accounts_are_re_read_on_reload(tmp_path, monkeypatch, events_dir):
    """Editing `accounts:` used to need a restart: _load_settings ran once."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.current().accounts is None

    _write_settings(
        tmp_path,
        "accounts:\n  - id: PEA\n    type: PEA\n    currency: EUR\n")

    # Every event in the fixture omits `account`, which is only legal while no
    # account is declared — so a successful reload here proves the new block was
    # actually read and applied.
    with pytest.raises(EventValidationError):
        cm.reload()


def test_settings_yaml_mtime_invalidates_the_cache(tmp_path, monkeypatch,
                                                   events_dir):
    """settings.yaml joins the event files in the cache key.

    Without it an edited `accounts:` block would sit unnoticed behind an
    unchanged events directory, and the re-read above would never fire.
    """
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    _write_settings(tmp_path, "mode: events\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    key_before = cm.current().cache_key
    settings = tmp_path / "settings.yaml"
    st = settings.stat()
    os.utime(settings, (st.st_atime, st.st_mtime + 100))

    assert cm._compute_cache_key() != key_before


# --------------------------------------------------------------------------- #
# Manual mode loading (confuse is stubbed so no real config.yaml is read)
# --------------------------------------------------------------------------- #
def test_manual_load_returns_stub_shares(tmp_path, mocker):
    """Manual mode reads shares via confuse.Configuration, which we stub out."""
    stub_shares = [
        {
            "name": "Apple",
            "symbol": "AAPL",
            "purchase": {"quantity": 1, "fee": 2, "cost_price": 119.98},
            "estate": {"quantity": 2, "received_dividend": 2.85},
        }
    ]
    fake_config = mocker.MagicMock()
    fake_config.__getitem__.return_value.get.return_value = stub_shares
    mocker.patch("main.Configuration", return_value=fake_config)

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_mode() == ConfigurationManager.MODE_MANUAL

    shares = cm.load_shares()
    assert shares == stub_shares

    # Manual mode does not populate the events cache.
    assert cm.get_events() is None
    assert cm.get_first_buy_date("AAPL") is None
    # confuse was accessed for the 'shares' key.
    fake_config.__getitem__.assert_called_with("shares")


def test_manual_load_reloads_confuse_on_second_call(tmp_path, mocker):
    """A second manual load reuses the confuse config and calls reload()."""
    fake_config = mocker.MagicMock()
    fake_config.__getitem__.return_value.get.return_value = []
    ctor = mocker.patch("main.Configuration", return_value=fake_config)

    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()
    cm.load_shares()

    # Configuration constructed once; reload() used on the second load.
    assert ctor.call_count == 1
    fake_config.reload.assert_called_once()
