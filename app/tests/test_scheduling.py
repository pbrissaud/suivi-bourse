"""
Tests for the pure ``scheduling`` module (issue #616 / testing plan #614).

Everything here is network-free and clock-free: ``decide`` and
``extract_market_context`` take an injected ``now`` and plain dicts, so no mock
clock or real market is required. ``zoneinfo`` is exercised for real (no new
dependency) to prove DST handling.
"""

from datetime import datetime, timezone, timedelta

import pytest

import scheduling
from scheduling import (
    decide, extract_market_context, perf_should_run,
    SHORT_RETRY, MAX_SLEEP, FAILURE_GRACE)


UTC = timezone.utc
NOW = datetime(2024, 1, 15, 12, 0, tzinfo=UTC)
BASE = 120


# ---------------------------------------------------------------------------
# decide — write gate (two-gate split #608) + coercion
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("state", ["REGULAR", None, "", "GARBAGE", "regular", 42])
def test_decide_non_closed_states_write_when_price_present(state):
    """Anything outside the closed-family is coerced to REGULAR (fail-open)."""
    should_write, next_delay, _fc, mark_dirty = decide(
        state, True, None, NOW, 0, BASE)
    assert should_write is True
    assert mark_dirty is True
    assert next_delay == BASE  # REGULAR-tier cadence


@pytest.mark.parametrize("state", ["CLOSED", "POST", "POSTPOST", "PRE", "PREPRE"])
def test_decide_closed_states_never_write(state):
    """Only the five closed-family states quiet a job."""
    next_open = NOW + timedelta(hours=2)
    should_write, next_delay, _fc, mark_dirty = decide(
        state, True, next_open, NOW, 0, BASE)
    assert should_write is False
    assert mark_dirty is False
    assert next_delay == pytest.approx(2 * 3600)  # sleep to next open


def test_decide_non_closed_without_price_does_not_write_but_keeps_polling():
    """A transient price failure keeps polling at base_interval (write gate off,
    reschedule gate still REGULAR)."""
    should_write, next_delay, _fc, mark_dirty = decide(
        "REGULAR", False, None, NOW, 0, BASE)
    assert should_write is False
    assert mark_dirty is False
    assert next_delay == BASE


# ---------------------------------------------------------------------------
# decide — cadence tiers (#607)
# ---------------------------------------------------------------------------

def test_decide_closed_sleeps_to_exact_next_open_no_margin():
    next_open = NOW + timedelta(seconds=3600)
    _, next_delay, _, _ = decide("CLOSED", False, next_open, NOW, 0, BASE)
    assert next_delay == 3600


def test_decide_closed_caps_deep_sleep_at_max_sleep():
    next_open = NOW + timedelta(hours=48)
    _, next_delay, _, _ = decide("POST", False, next_open, NOW, 0, BASE)
    assert next_delay == MAX_SLEEP


def test_decide_closed_with_unknown_next_open_short_retries():
    _, next_delay, _, _ = decide("CLOSED", False, None, NOW, 0, BASE)
    assert next_delay == SHORT_RETRY


def test_decide_closed_with_past_next_open_short_retries():
    """Woken on/after the expected open but still closed (holiday/half-day)."""
    next_open = NOW - timedelta(seconds=10)
    _, next_delay, _, _ = decide("PRE", False, next_open, NOW, 0, BASE)
    assert next_delay == SHORT_RETRY


# ---------------------------------------------------------------------------
# decide — dead-ticker guard: consecutive-failure backoff (#617, design #608)
# ---------------------------------------------------------------------------

def test_decide_write_resets_failure_count():
    """A successful write clears the counter regardless of its prior value."""
    _, next_delay, new_fc, _ = decide("REGULAR", True, None, NOW, 7, BASE)
    assert new_fc == 0
    assert next_delay == BASE            # reset -> back to base cadence


def test_decide_non_closed_no_price_increments_failure_count():
    """A non-closed cycle with no writable price is a failure."""
    _, _, new_fc, _ = decide("REGULAR", False, None, NOW, 0, BASE)
    assert new_fc == 1


@pytest.mark.parametrize("state", ["CLOSED", "POST", "POSTPOST", "PRE", "PREPRE"])
def test_decide_closed_cycle_never_counts_as_failure(state):
    """A closed -> sleep-to-open cycle leaves the counter untouched (passthrough),
    neither incrementing (market shut is not a ticker fault) nor resetting."""
    _, _, new_fc, _ = decide(state, False, None, NOW, 5, BASE)
    assert new_fc == 5


def test_decide_grace_then_backoff_progression():
    """K=3 failures at base_interval, then base×2^(n-K) capped at MAX_SLEEP.

    Loops the non-closed no-price failure branch, re-injecting the returned
    counter each cycle with a simple injected clock, and records the delay.
    """
    K = FAILURE_GRACE
    assert K == 3
    fc = 0
    delays = []
    for _ in range(15):
        _, next_delay, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
        delays.append(next_delay)

    # Failures 1..K all re-arm at base_interval (grace window).
    assert delays[:K] == [BASE, BASE, BASE]
    # From the K-th failure onward, geometric ×2 growth: base×2^(n-K).
    assert delays[3] == BASE * 2       # n=4
    assert delays[4] == BASE * 4       # n=5
    assert delays[5] == BASE * 8       # n=6
    # Every delay is capped at MAX_SLEEP and the tail is pinned there.
    assert all(d <= MAX_SLEEP for d in delays)
    assert delays[-1] == MAX_SLEEP


def test_decide_success_mid_backoff_resets_to_base():
    """A successful write in the middle of a backoff drops cadence back to base."""
    fc = 0
    for _ in range(6):                                  # build up a deep backoff
        _, delay, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
    assert delay > BASE and fc == 6

    # The market prints a price -> write, reset.
    should_write, delay, fc, dirty = decide("REGULAR", True, None, NOW, fc, BASE)
    assert (should_write, delay, fc, dirty) == (True, BASE, 0, True)


def test_decide_closed_cycles_interleaved_do_not_advance_backoff():
    """closed cycles between failures must not increment the counter, so the
    backoff resumes exactly where the failures left it."""
    fc = 0
    # Two failures.
    _, _, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
    _, _, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
    assert fc == 2

    # A closed stretch: counter frozen, sleeps to next open (not backoff).
    next_open = NOW + timedelta(hours=1)
    _, closed_delay, fc, _ = decide("CLOSED", False, next_open, NOW, fc, BASE)
    assert (fc, closed_delay) == (2, 3600)

    # Failures resume: n=3 still grace, n=4 first backoff step.
    _, delay3, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
    assert (fc, delay3) == (3, BASE)
    _, delay4, fc, _ = decide("REGULAR", False, None, NOW, fc, BASE)
    assert (fc, delay4) == (4, BASE * 2)


def test_decide_backoff_never_overflows_for_a_long_dead_ticker():
    """A ticker dead for a very long run stays pinned at MAX_SLEEP without
    building an astronomical delay from 2^n."""
    _, next_delay, new_fc, _ = decide("REGULAR", False, None, NOW, 100_000, BASE)
    assert next_delay == MAX_SLEEP
    assert new_fc == 100_001


# ---------------------------------------------------------------------------
# decide — looped sequences (re-inject the returned clock/counter)
# ---------------------------------------------------------------------------

def test_decide_sequence_pre_regular_post():
    """PRE (sleep to open) -> REGULAR (poll+write) -> POST (sleep to next open)."""
    open1 = NOW + timedelta(hours=1)
    w, d, _, _ = decide("PRE", True, open1, NOW, 0, BASE)
    assert (w, d) == (False, 3600)

    # Woken at the open, now REGULAR.
    at_open = open1
    w, d, _, dirty = decide("REGULAR", True, None, at_open, 0, BASE)
    assert (w, d, dirty) == (True, BASE, True)

    # Market closes for the day.
    next_open = at_open + timedelta(hours=20)
    w, d, _, _ = decide("POST", True, next_open, at_open, 0, BASE)
    assert (w, d) == (False, 20 * 3600)


def test_decide_sequence_closed_then_short_retry_resolves_forward():
    """A closed wake with a stale (past) next-open short-retries until REGULAR."""
    stale_open = NOW - timedelta(minutes=5)
    w, d, _, _ = decide("CLOSED", False, stale_open, NOW, 0, BASE)
    assert (w, d) == (False, SHORT_RETRY)

    # 60s later it flips to REGULAR.
    later = NOW + timedelta(seconds=SHORT_RETRY)
    w, d, _, _ = decide("REGULAR", True, None, later, 0, BASE)
    assert (w, d) == (True, BASE)


# ---------------------------------------------------------------------------
# perf_should_run — gate the perf-recompute interval job (#618, design #605)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("events_changed,backfill_pending,live_write,expected", [
    # All quiet -> skip (a fully-closed market wave, no closed-day Parquet drip).
    (False, False, False, False),
    # Any single dirty signal -> run.
    (True, False, False, True),     # events cache reloaded (full rewrite)
    (False, True, False, True),     # backfill watermark pending
    (False, False, True, True),     # live REGULAR write since last run (boot seed)
    # Combinations still run.
    (True, True, False, True),
    (True, False, True, True),
    (False, True, True, True),
    (True, True, True, True),
])
def test_perf_should_run_truth_table(events_changed, backfill_pending, live_write, expected):
    assert perf_should_run(events_changed, backfill_pending, live_write) is expected


# ---------------------------------------------------------------------------
# extract_market_context — state passthrough
# ---------------------------------------------------------------------------

def test_extract_returns_raw_market_state():
    state, _ = extract_market_context({"marketState": "POST"}, None, NOW)
    assert state == "POST"


def test_extract_missing_state_is_none():
    state, _ = extract_market_context({}, None, NOW)
    assert state is None


# ---------------------------------------------------------------------------
# extract_market_context — exact next-open from history metadata (#603)
# ---------------------------------------------------------------------------

def test_extract_prefers_exact_next_open_from_history_meta():
    ts = 1_700_000_000
    meta = {"currentTradingPeriod": {"regular": {"start": ts, "end": ts + 23400}}}
    # exchangeTimezoneName present too — exact must win over the ~08:00 guess.
    info = {"marketState": "CLOSED", "exchangeTimezoneName": "America/New_York"}
    _, next_open = extract_market_context(info, meta, NOW)
    assert next_open == datetime.fromtimestamp(ts, tz=UTC)


@pytest.mark.parametrize("meta", [
    None,
    {},
    {"currentTradingPeriod": None},
    {"currentTradingPeriod": {}},
    {"currentTradingPeriod": {"regular": {}}},
    {"currentTradingPeriod": {"regular": {"start": None}}},
    {"currentTradingPeriod": "garbage"},
])
def test_extract_falls_back_when_history_meta_incomplete(meta):
    info = {"exchangeTimezoneName": "America/New_York"}
    _, next_open = extract_market_context(info, meta, NOW)
    # Falls back to the ~08:00 local guess -> a real datetime, not the exact one.
    assert next_open is not None
    assert next_open.tzinfo is not None


# ---------------------------------------------------------------------------
# extract_market_context — zoneinfo ~08:00 fallback + DST (#603)
# ---------------------------------------------------------------------------

def test_extract_fallback_same_day_open():
    # 06:00 UTC = 01:00 EST -> next open 08:00 EST today = 13:00 UTC.
    now = datetime(2024, 1, 15, 6, 0, tzinfo=UTC)
    _, next_open = extract_market_context(
        {"exchangeTimezoneName": "America/New_York"}, None, now)
    assert next_open == datetime(2024, 1, 15, 13, 0, tzinfo=UTC)


def test_extract_fallback_rolls_to_next_day_when_past_open():
    # 20:00 UTC = 15:00 EST, already past 08:00 -> next day 08:00 EST = 13:00 UTC.
    now = datetime(2024, 1, 15, 20, 0, tzinfo=UTC)
    _, next_open = extract_market_context(
        {"exchangeTimezoneName": "America/New_York"}, None, now)
    assert next_open == datetime(2024, 1, 16, 13, 0, tzinfo=UTC)


def test_extract_fallback_handles_dst_offset_shift():
    """Same 08:00 local wall-clock maps to a different UTC across DST."""
    winter = datetime(2024, 1, 15, 6, 0, tzinfo=UTC)      # EST, UTC-5
    summer = datetime(2024, 7, 15, 6, 0, tzinfo=UTC)      # EDT, UTC-4
    tz = {"exchangeTimezoneName": "America/New_York"}
    _, w_open = extract_market_context(tz, None, winter)
    _, s_open = extract_market_context(tz, None, summer)
    assert w_open == datetime(2024, 1, 15, 13, 0, tzinfo=UTC)  # 08:00-05:00
    assert s_open == datetime(2024, 7, 15, 12, 0, tzinfo=UTC)  # 08:00-04:00


def test_extract_no_next_open_without_meta_or_timezone():
    _, next_open = extract_market_context({"marketState": "CLOSED"}, None, NOW)
    assert next_open is None


def test_extract_unknown_timezone_yields_no_next_open():
    _, next_open = extract_market_context(
        {"exchangeTimezoneName": "Mars/Olympus_Mons"}, None, NOW)
    assert next_open is None


def test_extract_none_info_is_safe():
    state, next_open = extract_market_context(None, None, NOW)
    assert state is None and next_open is None


def test_is_closed_whitelist():
    for s in ("CLOSED", "POST", "POSTPOST", "PRE", "PREPRE"):
        assert scheduling.is_closed(s) is True
    for s in ("REGULAR", None, "", "unknown"):
        assert scheduling.is_closed(s) is False
