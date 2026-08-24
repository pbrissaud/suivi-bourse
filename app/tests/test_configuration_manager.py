"""
Unit tests for main.ConfigurationManager.

These tests exercise ConfigurationManager in isolation:
  * naming the two v4 files this version no longer reads — `config.yaml`
    (issue #711) and `settings.yaml` (issue #698)
  * _compute_cache_key behaviour (the store's stamp, and no file at all)
  * the caching contract of the snapshot build (identity reuse, force reload,
    invalidation on file change)
  * get_first_acquisition_date / get_events
  * publication (issue #658): one immutable snapshot, validated before it is
    published, swapped by a single rebind — the null window and the split-brain

Every ConfigurationManager is built with ``config_dir=str(tmp_path)`` so nothing
ever touches the real ~/.config/SuiviBourse. No network, no real InfluxDB, no
yfinance.

There is **one loading path** since #711 — the event ledger — so no test here
selects a mode, and none can.

And since ADR-0032 the manager **reads no directory at all**: a file is handed
to the app, written through ``entries``, and the manager replays the store. The
three tests that asked *where does it look* and *can a v4 file move it* went
with the question; what a v4 ``settings.yaml`` must not be able to do is still
held, on the ledger it would change (``test_a_v4_accounts_block_declares_nothing``)
and on the cache key it must not move. ``seeded`` below is how a test that wants
a populated ledger gets one.
"""

import os
import threading
import time
from datetime import date

import pytest

import entries
import main
from events import EventLoader
from main import ConfigurationManager
from events.validator import EventValidationError


def _write_settings(config_dir, text):
    """Write a settings.yaml into the config dir."""
    (config_dir / "settings.yaml").write_text(text, encoding="utf-8")


def seeded(config_dir, drop=None):
    """A manager over its own store, holding whatever ``drop`` contains.

    The rows are put in the **store**, because that is where the manager reads
    them from and, since ADR-0032, the only place they can come from: a file is
    handed to the app and written through ``entries``, and nothing scans a
    directory on a build. Which door wrote the rows is not this file's subject —
    every test below is about what a snapshot does with a ledger that is there.
    """
    cm = ConfigurationManager(config_dir=str(config_dir))
    if drop is not None:
        for path in sorted(drop.iterdir()):
            entries.create_many(cm.store, EventLoader(str(path)).load())
    return cm


def _correct_one_row(cm, symbol='AAPL', quantity=11.0):
    """Rewrite the ledger's first row of ``symbol``, as ``PATCH`` would.

    The gesture that replaced *re-drop the corrected file* (ADR-0032): a
    correction addresses **one row by its key** now, whatever laid it down.
    """
    import ledger as ledger_module
    row = next(event for event in ledger_module.read_events(cm.store)
               if event.symbol == symbol)
    from dataclasses import replace
    entries.update(cm.store, row.id, replace(row, quantity=quantity))


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
    # It names no folder any more (ADR-0032): there is nowhere to look, so the
    # sentence says what a portfolio is made of instead of where it is found.
    assert str(tmp_path / "events") not in message
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
def test_cache_key_reflects_the_ledger_not_the_files(tmp_path, events_dir):
    """The key fingerprints the **store** now (issue #697).

    Its subject moved with the truth. An mtime key described the files, which
    are no longer what a snapshot is built from — so a key that still named
    them would invalidate on a ``touch`` and miss a re-drop that changed
    content under an older timestamp.
    """
    cm = seeded(tmp_path, events_dir)
    cm.load_shares()

    key = cm._compute_cache_key()
    assert key is not None
    assert str(events_dir / "2024.csv") not in key
    # And no file at all is named in it since #698: settings.yaml's mtime left
    # with the accounts block it used to carry, so the store alone decides
    # whether a published snapshot is stale.
    assert str(tmp_path) not in key


def test_cache_key_follows_the_rows_and_nothing_else(tmp_path, events_dir):
    """A rebuild that wrote nothing changes nothing; **one edited cell does**.

    The second half is what #816 makes load-bearing: a correction in place moves
    no count and no source, so a key built from either would republish the ledger
    as it was. It is built from the rows.
    """
    cm = seeded(tmp_path, events_dir)
    cm.load_shares()
    key_before = cm._compute_cache_key()

    cm.reload()
    assert cm._compute_cache_key() == key_before

    _correct_one_row(cm)
    cm.reload()
    assert cm._compute_cache_key() != key_before


def test_cache_key_none_when_the_ledger_is_empty(tmp_path):
    """Nothing imported and no settings.yaml yields a None key."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    # Nothing was ever written to this store, so there is nothing to fingerprint.
    assert cm._compute_cache_key() is None


# --------------------------------------------------------------------------- #
# Caching contract of _load_from_store (real loader/validator/aggregator run)
# --------------------------------------------------------------------------- #
def test_events_load_produces_expected_shares(tmp_path, events_dir):
    """The real events pipeline runs and yields AAPL + MSFT shares."""
    cm = seeded(tmp_path, events_dir)

    shares = cm.load_shares()
    assert isinstance(shares, list)
    assert {s["symbol"] for s in shares} == {"AAPL", "MSFT"}


def test_second_load_returns_same_cached_object(tmp_path, events_dir):
    """A second load with no ledger change returns the identical cached object."""
    cm = seeded(tmp_path, events_dir)

    first = cm.load_shares()
    second = cm.load_shares()
    assert second is first


def test_force_reload_bypasses_cache(tmp_path, events_dir):
    """force=True re-runs the pipeline, returning a fresh (equal) object."""
    cm = seeded(tmp_path, events_dir)

    first = cm.load_shares()
    forced = cm.load_shares(force=True)
    assert forced is not first
    assert forced == first


def test_a_corrected_row_invalidates_the_cache(tmp_path, events_dir):
    """One row rewritten in place, and the next load rebuilds on it.

    This is *re-drop the corrected file* after #816: a typo is repaired where it
    is, so the cache has to notice a change that moves neither the row count nor
    anything about a source.
    """
    cm = seeded(tmp_path, events_dir)

    first = cm.load_shares()
    aapl_before = next(s for s in first if s["symbol"] == "AAPL")

    _correct_one_row(cm)

    second = cm.load_shares()
    assert second is not first
    aapl_after = next(s for s in second if s["symbol"] == "AAPL")
    # Corrected, not doubled: 10 BUY + 5 BUY + 1 GRANT - 3 SELL = 13 became 14.
    assert aapl_before["quantity"] == 13.0
    assert aapl_after["quantity"] == 14.0


# --------------------------------------------------------------------------- #
# get_first_acquisition_date
# --------------------------------------------------------------------------- #
def test_get_first_acquisition_date_earliest_acquisition(tmp_path, events_dir):
    """Returns the earliest acquisition date for a symbol (ignores later ones)."""
    cm = seeded(tmp_path, events_dir)
    cm.load_shares()

    # AAPL has BUYs on 2024-01-15 and 2024-06-15 -> earliest is 2024-01-15.
    assert cm.get_first_acquisition_date("AAPL") == date(2024, 1, 15)
    assert cm.get_first_acquisition_date("MSFT") == date(2024, 2, 1)


def test_get_first_acquisition_date_none_when_no_events_loaded(tmp_path):
    """With nothing published yet, returns None."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_first_acquisition_date("AAPL") is None


def test_get_first_acquisition_date_none_for_absent_symbol(tmp_path, events_dir):
    """A symbol the ledger never acquired returns None."""
    cm = seeded(tmp_path, events_dir)
    cm.load_shares()
    assert cm.get_first_acquisition_date("GOOG") is None


def test_a_grant_is_an_acquisition_and_opens_the_window(tmp_path):
    """``BUY`` **and** ``GRANT`` (issue #703).

    A granted share is held from the day it lands, so it has a history to
    reconstruct. Reading only ``BUY`` left a portfolio held entirely by grant
    with no backfill target at all — which is the state the retired ``no_buy``
    terminal was reporting rather than fixing.
    """
    events = tmp_path / "events"
    events.mkdir()
    (events / "grants.csv").write_text(
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2021-03-04,GRANT,GRT,Granted Co,10,,,,\n",
        encoding="utf-8")
    cm = seeded(tmp_path, events)
    cm.load_shares()

    assert cm.get_first_acquisition_date("GRT") == date(2021, 3, 4)


# --------------------------------------------------------------------------- #
# get_events
# --------------------------------------------------------------------------- #
def test_get_events_none_before_load(tmp_path):
    """Before any load, get_events returns None."""
    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.get_events() is None


def test_get_events_returns_cached_events(tmp_path, events_dir):
    """After an events load, get_events returns the published snapshot's events."""
    cm = seeded(tmp_path, events_dir)
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
    cm = seeded(tmp_path, events_dir)

    first = cm.current()
    assert first is cm.current()
    assert {s["symbol"] for s in first.shares} == {"AAPL", "MSFT"}
    assert len(first.events) == 7
    assert first.cache_key is not None


def test_snapshot_is_swapped_whole_when_the_ledger_changes(tmp_path, events_dir):
    """A reload replaces the snapshot; it never edits the published one."""
    cm = seeded(tmp_path, events_dir)

    before = cm.current()
    after = cm.reload(force=True)
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
    ``events = None``, so ``first_acquisition_date`` returned ``None`` and the whole
    backward pass was silently skipped for that cycle — no crash, no log. Here a
    reader hammers the read path while a writer rebuilds; every observation must
    be a complete configuration.
    """
    cm = seeded(tmp_path, events_dir)
    cm.current()  # first publication

    # Make the rebuild slow enough that the reader is guaranteed to observe the
    # window during which the candidate is being assembled.
    real_load = cm._load_from_store

    def slow_load(opened_store):
        time.sleep(0.005)
        return real_load(opened_store)

    cm._load_from_store = slow_load

    observations = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            snap = cm.current()
            observations.append(
                (len(snap.shares), snap.events,
                 snap.first_acquisition_date("AAPL")))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for _ in range(20):
            cm.reload(force=True)
    finally:
        stop.set()
        thread.join(timeout=5)

    assert observations
    for share_count, events, first_acquisition in observations:
        assert share_count == 2
        assert events is not None and len(events) == 7
        assert first_acquisition == date(2024, 1, 15)


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
    because it was never about which check said no. Since #697 the refusal is
    reached with ``force``: the ledger's own fingerprint is what invalidates a
    snapshot now, and this test is about the rebind, not about the key.
    """
    cm = seeded(tmp_path, events_dir)
    published = cm.current()

    def _refuse(opened_store):
        raise EventValidationError("row 4: SELL of 40 with 18 owned")

    cm._load_from_store = _refuse

    with pytest.raises(EventValidationError):
        cm.reload(force=True)

    # Every read path — not just the one ingest() used to guard — still sees the
    # previous generation, and sees the *same* object.
    assert cm.current() is published
    assert cm.get_events() is published.events
    assert cm.get_first_acquisition_date("AAPL") == date(2024, 1, 15)
    assert cm.load_accounts() is published.accounts


def test_nothing_is_published_when_the_first_build_fails(tmp_path):
    """A candidate that raises leaves ``_config`` untouched — here, at ``None``."""
    cm = ConfigurationManager(config_dir=str(tmp_path))

    def _refuse(opened_store):
        raise EventValidationError("row 2: unknown event_type")

    cm._load_from_store = _refuse

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


# --------------------------------------------------------------------------- #
# The v4 settings.yaml: named, never read (issue #698)
# --------------------------------------------------------------------------- #
def test_a_settings_yaml_is_named_at_startup(tmp_path, mocker):
    """The same gesture ``config.yaml`` gets: name it, do not read it, keep it.

    A v4 owner opening v5 has to be told which file stopped being read, or the
    accounts they declared in it look like accounts the update lost.
    """
    settings = tmp_path / "settings.yaml"
    settings.write_text("accounts:\n- id: PEA\n  type: PEA\n  currency: EUR\n",
                        encoding="utf-8")
    warn = mocker.patch.object(main.app_logger, "warning")

    cm = ConfigurationManager(config_dir=str(tmp_path))
    assert cm.report_unread_files() == [str(settings)]

    message = warn.call_args.args[0]
    assert "settings.yaml" in message
    assert "id, type, label" in message   # says how to declare them instead
    assert settings.exists()              # and touches nothing


def test_a_v4_accounts_block_declares_nothing(tmp_path, events_dir):
    """Never read means never obeyed, and the observable proof is the ledger.

    The fixture's events carry no ``account`` column. If the block were read,
    declaring ``PEA`` would make every one of those rows invalid; instead they
    import exactly as before and fall into ``default``.
    """
    _write_settings(
        tmp_path,
        "accounts:\n  - id: PEA\n    type: PEA\n    currency: EUR\n")
    cm = seeded(tmp_path, events_dir)

    snapshot = cm.reload()
    assert snapshot.accounts is None
    assert {s["account"] for s in snapshot.shares} == {"default"}


def test_touching_settings_yaml_does_not_invalidate_the_cache(tmp_path, events_dir):
    """It used to join the key, because the accounts block was read from it.

    Now that nothing reads it, a key that still watched it would rebuild the
    whole configuration every time a v4 file was touched by anything at all.
    """
    _write_settings(tmp_path, "mode: events\n")
    cm = ConfigurationManager(config_dir=str(tmp_path))

    key_before = cm.current().cache_key
    settings = tmp_path / "settings.yaml"
    st = settings.stat()
    os.utime(settings, (st.st_atime, st.st_mtime + 100))

    assert cm._compute_cache_key() == key_before
