"""
Unit tests for main.ConfigurationManager.

These tests exercise ConfigurationManager in isolation:
  * events-source resolution (settings.yaml `events.source`, else <dir>/events)
  * naming the v4 `config.yaml` this version no longer reads (issue #711)
  * _compute_cache_key behaviour (mtime-based, settings.yaml included)
  * the caching contract of the snapshot build (identity reuse, force reload,
    invalidation on file change)
  * get_first_buy_date / get_events
  * publication (issue #658): one immutable snapshot, validated before it is
    published, swapped by a single rebind — the null window and the split-brain

Every ConfigurationManager is built with ``config_dir=str(tmp_path)`` so nothing
ever touches the real ~/.config/SuiviBourse. No network, no real InfluxDB, no
yfinance.

There is **one loading path** since #711 — the event ledger — so no test here
selects a mode, and none can.
"""

import os
import threading
import time
from datetime import date

import pytest

import main
from main import ConfigurationManager
from events.validator import EventValidationError


def _write_settings(config_dir, text):
    """Write a settings.yaml into the config dir."""
    (config_dir / "settings.yaml").write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Where the events are read from
# --------------------------------------------------------------------------- #
def test_events_source_defaults_to_config_dir_events(tmp_path):
    """With no settings.yaml at all, the source is <config_dir>/events."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_events_source() == str(tmp_path / "events")


def test_events_source_honours_settings_yaml(tmp_path):
    """settings.yaml's events block still says where to read and whether to watch."""
    src = str(tmp_path / "my_events")
    _write_settings(tmp_path, f"events:\n  source: {src}\n  watch: true\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_events_source() == src
    assert cm._watch_enabled is True


def test_events_source_defaults_when_settings_omits_source(tmp_path):
    """A settings.yaml without a source falls back to <config_dir>/events."""
    _write_settings(tmp_path, "events:\n  watch: false\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_events_source() == str(tmp_path / "events")
    assert cm._watch_enabled is False


# --------------------------------------------------------------------------- #
# The v4 file that is found and not read (issue #711)
# --------------------------------------------------------------------------- #
def test_a_config_yaml_is_named_at_startup(tmp_path, mocker):
    """Four empty pages read as "the update erased my portfolio" without this.

    The file itself is left exactly where its owner put it: nothing is migrated,
    renamed or deleted (ADR-0008).
    """
    legacy = tmp_path / "config.yaml"
    legacy.write_text("shares:\n- name: Apple\n  symbol: AAPL\n", encoding="utf-8")
    warn = mocker.patch.object(main.app_logger, "warning")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.report_unread_files() == [str(legacy)]

    warn.assert_called_once()
    message = warn.call_args.args[0]
    assert "config.yaml" in message
    assert str(tmp_path / "events") in message   # says where it *does* look
    assert legacy.exists()                       # and touches nothing


def test_nothing_is_named_when_there_is_no_legacy_file(tmp_path, mocker):
    """An install that never ran a manual v4 gets no warning at all."""
    warn = mocker.patch.object(main.app_logger, "warning")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.report_unread_files() == []
    warn.assert_not_called()


# --------------------------------------------------------------------------- #
# _compute_cache_key
# --------------------------------------------------------------------------- #
def test_cache_key_reflects_event_file_mtimes(tmp_path, events_dir):
    """The key references the event files and their mtimes."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_events_source()  # populate _events_source

    key = cm._compute_cache_key()
    assert key is not None
    assert str(events_dir / "2024.csv") in key


def test_cache_key_changes_when_file_mtime_changes(tmp_path, events_dir):
    """Touching an event file to a new mtime changes the cache key."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_events_source()

    key_before = cm._compute_cache_key()

    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    key_after = cm._compute_cache_key()
    assert key_before != key_after


def test_cache_key_none_when_events_source_missing(tmp_path):
    """No events directory and no settings.yaml yields a None key (nothing to hash)."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.get_events_source()
    # <config_dir>/events was never created.
    assert cm._compute_cache_key() is None


# --------------------------------------------------------------------------- #
# Caching contract of _load_from_events (real loader/validator/aggregator run)
# --------------------------------------------------------------------------- #
def test_events_load_produces_expected_shares(tmp_path, events_dir):
    """The real events pipeline runs and yields AAPL + MSFT shares."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    shares = cm.load_shares()
    assert isinstance(shares, list)
    assert {s["symbol"] for s in shares} == {"AAPL", "MSFT"}


def test_second_load_returns_same_cached_object(tmp_path, events_dir):
    """A second load with no file change returns the identical cached object."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()
    second = cm.load_shares()
    assert second is first


def test_force_reload_bypasses_cache(tmp_path, events_dir):
    """force=True re-runs the pipeline, returning a fresh (equal) object."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()
    forced = cm.load_shares(force=True)
    assert forced is not first
    assert forced == first


def test_file_change_invalidates_cache(tmp_path, events_dir):
    """A changed file mtime invalidates the cache on the next (non-forced) load."""
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
def test_get_first_buy_date_earliest_buy(tmp_path, events_dir):
    """Returns the earliest BUY date for a symbol (ignores later BUYs)."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()

    # AAPL has BUYs on 2024-01-15 and 2024-06-15 -> earliest is 2024-01-15.
    assert cm.get_first_buy_date("AAPL") == date(2024, 1, 15)
    assert cm.get_first_buy_date("MSFT") == date(2024, 2, 1)


def test_get_first_buy_date_none_when_no_events_loaded(tmp_path):
    """With nothing loaded (cached_events is None), returns None."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_first_buy_date("AAPL") is None


def test_get_first_buy_date_none_for_absent_symbol(tmp_path, events_dir):
    """A symbol with no BUY events returns None."""
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


def test_get_events_returns_cached_events(tmp_path, events_dir):
    """After an events load, get_events returns the published snapshot's events."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()

    events = cm.get_events()
    assert events is cm.current().events
    assert len(events) == 7  # matches the canonical events CSV in conftest


# --------------------------------------------------------------------------- #
# Publication: the snapshot is built off-line and published by one rebind
# (issue #658, design #653)
# --------------------------------------------------------------------------- #
def test_current_publishes_on_first_use_and_then_returns_the_same_object(tmp_path, events_dir):
    """The read path is one attribute read, so it must be stable between loads."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.current()
    assert first is cm.current()
    assert {s["symbol"] for s in first.shares} == {"AAPL", "MSFT"}
    assert len(first.events) == 7
    assert first.cache_key is not None


def test_snapshot_is_swapped_whole_when_files_change(tmp_path, events_dir):
    """A reload replaces the snapshot; it never edits the published one."""
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


def test_a_reload_never_exposes_a_half_built_configuration(tmp_path, events_dir):
    """The null window: shares and events are published together or not at all.

    ``invalidate_cache()`` used to null the three cache fields *before*
    ``ingest()`` refilled them. A backfill cycle landing in that window read
    ``events = None``, so ``get_first_buy_date`` returned ``None`` and the whole
    backward pass was silently skipped for that cycle — no crash, no log. Here a
    reader hammers the read path while a writer rebuilds; every observation must
    be a complete configuration.
    """
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
def test_a_rejected_config_changes_nothing_anywhere(tmp_path, events_dir):
    """The split-brain, closed.

    The cache used to be written by the loader and validated afterwards by
    ``ingest()``, so a refused configuration was already sitting in it: scraping
    kept the old shares while **backfill and the performance recompute** read
    the very config the validator had just rejected. Everything fallible now
    happens on the candidate, before the rebind, so a rejected one is never
    published and there is nothing for anyone to read.

    The rejection is a refused *ledger* since #696 — the schema that checked the
    aggregated share list left with Cerberus — and the assertion is unchanged,
    because it was never about which check said no.
    """
    cm = ConfigurationManager(config_dir=str(tmp_path))
    published = cm.current()

    csv_file = events_dir / "2024.csv"
    st = csv_file.stat()
    os.utime(csv_file, (st.st_atime, st.st_mtime + 100))

    def _refuse(accounts):
        raise EventValidationError("row 4: SELL of 40 with 18 owned")

    cm._load_from_events = _refuse

    with pytest.raises(EventValidationError):
        cm.reload()

    # Every read path — not just the one ingest() used to guard — still sees the
    # previous generation, and sees the *same* object.
    assert cm.current() is published
    assert cm.get_events() is published.events
    assert cm.get_first_buy_date("AAPL") == date(2024, 1, 15)
    assert cm.load_accounts() is published.accounts


def test_nothing_is_published_when_the_first_build_fails(tmp_path):
    """A candidate that raises leaves ``_config`` untouched — here, at ``None``."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    def _refuse(accounts):
        raise EventValidationError("row 2: unknown event_type")

    cm._load_from_events = _refuse

    with pytest.raises(EventValidationError):
        cm.reload()
    assert cm._config is None  # nothing was published


def test_an_empty_portfolio_is_not_a_rejection(tmp_path):
    """A fresh install runs on nothing rather than refusing to boot.

    An install starts life with an empty events/ directory — the app is
    expected to run, warn, and pick up the first file that lands. (What used to
    make this worth a test was ``schema.yaml``'s ``empty: False``, written for a
    hand-edited share list; the schema is gone and the property is not.)
    """
    (tmp_path / "events").mkdir()
    cm = ConfigurationManager(config_dir=str(tmp_path))

    snap = cm.current()
    assert snap.shares == []
    assert snap.events == []


def test_a_malformed_accounts_block_is_refused_before_publication(tmp_path, events_dir):
    """`accounts:` is validated on the candidate too, not after publication."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    published = cm.current()

    _write_settings(tmp_path, "accounts:\n  - id: PEA\n    type: PEA\n")  # no currency

    with pytest.raises(ValueError, match="Invalid 'accounts' block"):
        cm.reload()
    assert cm.current() is published


# --------------------------------------------------------------------------- #
# The accounts block is re-read on every build (it used to be boot-only)
# --------------------------------------------------------------------------- #
def test_accounts_are_re_read_on_reload(tmp_path, events_dir):
    """Editing `accounts:` used to need a restart: _load_settings ran once."""
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


def test_settings_yaml_mtime_invalidates_the_cache(tmp_path, events_dir):
    """settings.yaml joins the event files in the cache key.

    Without it an edited `accounts:` block would sit unnoticed behind an
    unchanged events directory, and the re-read above would never fire.
    """
    _write_settings(tmp_path, "mode: events\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    key_before = cm.current().cache_key
    settings = tmp_path / "settings.yaml"
    st = settings.stat()
    os.utime(settings, (st.st_atime, st.st_mtime + 100))

    assert cm._compute_cache_key() != key_before
