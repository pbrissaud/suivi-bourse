"""
Unit tests for main.ConfigurationManager.

These tests exercise ConfigurationManager in isolation:
  * mode selection priority (SB_CONFIG_MODE env > settings.yaml > default 'manual')
  * events-source defaulting
  * _compute_cache_key behaviour (None in manual, mtime-based in events)
  * the caching contract of _load_from_events (identity reuse, force reload,
    invalidation on file change)
  * get_first_buy_date / get_events / invalidate_cache

Every ConfigurationManager is built with ``config_dir=str(tmp_path)`` so nothing
ever touches the real ~/.config/SuiviBourse. SB_CONFIG_MODE is managed strictly
through monkeypatch (an autouse fixture deletes it before every test) so it can
never leak between tests. No network, no real InfluxDB, no yfinance.
"""

import os
from datetime import date

import pytest

from main import ConfigurationManager


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
    # Because env short-circuits settings.yaml, its events settings are ignored.
    assert cm._events_source is None


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
    """After an events load, get_events returns the cached event list."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))
    cm.load_shares()

    events = cm.get_events()
    assert events is cm._cached_events
    assert len(events) == 7  # matches the canonical events CSV in conftest


# --------------------------------------------------------------------------- #
# invalidate_cache
# --------------------------------------------------------------------------- #
def test_invalidate_cache_clears_all_caches(tmp_path, monkeypatch, events_dir):
    """invalidate_cache wipes shares, events and the cache key."""
    monkeypatch.setenv("SB_CONFIG_MODE", "events")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    first = cm.load_shares()
    assert cm.get_events() is not None

    cm.invalidate_cache()
    assert cm._cached_shares is None
    assert cm._cached_events is None
    assert cm._cache_key is None
    assert cm.get_events() is None
    assert cm.get_first_buy_date("AAPL") is None

    # Next load re-runs the pipeline and yields a fresh object.
    second = cm.load_shares()
    assert second is not first
    assert second == first


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
