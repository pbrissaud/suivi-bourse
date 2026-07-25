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
from scheduling import decide, extract_market_context, SHORT_RETRY, MAX_SLEEP


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
# decide — failure_count passthrough (backoff deferred to a later slice)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("state,price", [
    ("REGULAR", True), ("REGULAR", False), ("CLOSED", False), (None, True)])
def test_decide_threads_failure_count_unchanged(state, price):
    _, _, new_fc, _ = decide(state, price, None, NOW, 7, BASE)
    assert new_fc == 7


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
