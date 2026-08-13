"""
Tests for the pure ``scheduling`` module (issue #616 / testing plan #614).

Everything here is network-free and clock-free: ``decide`` and
``extract_market_context`` take an injected ``now`` and plain dicts, so no mock
clock or real market is required. ``zoneinfo`` is exercised for real (no new
dependency) to prove DST handling.
"""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

import scheduling
from scheduling import (
    decide, extract_market_context, compute_pool_size,
    forward_backfill_window, price_freshness_step, SondeState,
    SHORT_RETRY, MAX_SLEEP, FAILURE_GRACE, POOL_CAP, STALENESS_HORIZON)


UTC = timezone.utc
NOW = datetime(2024, 1, 15, 12, 0, tzinfo=UTC)
BASE = 120

_CAPTURES = Path(__file__).parent / "fixtures" / "trading_period"


def _capture(name):
    """A real reading, split as ``extract_market_context`` takes its arguments.

    Read from a file rather than written inline (issue #769): the defect is a
    field that means something other than what its name suggests, and a
    hand-written dict says whatever its author already believed. The README
    beside it holds the reading and the fields it deliberately does not carry.
    """
    data = json.loads((_CAPTURES / f"{name}.json").read_text(encoding="utf-8"))
    return data["info"], data["history_meta"]


# ``BNP.PA`` on 2026-08-12, Euronext Paris (CEST). The reading was taken at
# 20:47 UTC, over five hours after the 15:30 UTC close, and its
# ``regular.start`` is that same morning's 07:00 — the whole subject of #769.
BNP = "bnp-pa-2026-08-12"
BNP_REGULAR_START = datetime(2026, 8, 12, 7, 0, tzinfo=UTC)
BNP_BEFORE_OPEN = datetime(2026, 8, 12, 5, 30, tzinfo=UTC)    # 07:30 local
BNP_AFTER_CLOSE = datetime(2026, 8, 12, 20, 47, tzinfo=UTC)   # the reading itself
# ~08:00 local the next day, which is what ``_approx_next_open`` answers and the
# only producer that guarantees a strictly future date.
BNP_APPROX_NEXT_OPEN = datetime(2026, 8, 13, 6, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# decide — write gate (two-gate split #608) + coercion
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("state", ["REGULAR", None, "", "GARBAGE", "regular", 42])
def test_decide_non_closed_states_write_when_price_present(state):
    """Anything outside the closed-family is coerced to REGULAR (fail-open)."""
    should_write, next_delay, _fc = decide(
        state, True, None, NOW, 0, BASE)
    assert should_write is True
    assert next_delay == BASE  # REGULAR-tier cadence


@pytest.mark.parametrize("state", ["CLOSED", "POST", "POSTPOST", "PRE", "PREPRE"])
def test_decide_closed_states_never_write(state):
    """Only the five closed-family states quiet a job."""
    next_open = NOW + timedelta(hours=2)
    should_write, next_delay, _fc = decide(
        state, True, next_open, NOW, 0, BASE)
    assert should_write is False
    assert next_delay == pytest.approx(2 * 3600)  # sleep to next open


def test_decide_non_closed_without_price_does_not_write_but_keeps_polling():
    """A transient price failure keeps polling at base_interval (write gate off,
    reschedule gate still REGULAR)."""
    should_write, next_delay, _fc = decide(
        "REGULAR", False, None, NOW, 0, BASE)
    assert should_write is False
    assert next_delay == BASE


# ---------------------------------------------------------------------------
# decide — cadence tiers (#607)
# ---------------------------------------------------------------------------

def test_decide_closed_sleeps_to_exact_next_open_no_margin():
    next_open = NOW + timedelta(seconds=3600)
    _, next_delay, _ = decide("CLOSED", False, next_open, NOW, 0, BASE)
    assert next_delay == 3600


def test_decide_closed_caps_deep_sleep_at_max_sleep():
    next_open = NOW + timedelta(hours=48)
    _, next_delay, _ = decide("POST", False, next_open, NOW, 0, BASE)
    assert next_delay == MAX_SLEEP


def test_decide_closed_with_unknown_next_open_short_retries():
    _, next_delay, _ = decide("CLOSED", False, None, NOW, 0, BASE)
    assert next_delay == SHORT_RETRY


def test_decide_closed_with_past_next_open_short_retries():
    """A non-future open is read as *unknown*, which is the only thing
    ``SHORT_RETRY`` is for (issue #769).

    This is the **guard** and no longer a case: ``extract_market_context`` holds
    the invariant that a date it hands over is strictly future, so the only way
    into this branch is a caller that does not. It used to be reached every
    single evening, and was described here as a holiday or a half-day.
    """
    next_open = NOW - timedelta(seconds=10)
    _, next_delay, _ = decide("PRE", False, next_open, NOW, 0, BASE)
    assert next_delay == SHORT_RETRY


# ---------------------------------------------------------------------------
# decide — dead-ticker guard: consecutive-failure backoff (#617, design #608)
# ---------------------------------------------------------------------------

def test_decide_write_resets_failure_count():
    """A successful write clears the counter regardless of its prior value."""
    _, next_delay, new_fc = decide("REGULAR", True, None, NOW, 7, BASE)
    assert new_fc == 0
    assert next_delay == BASE            # reset -> back to base cadence


def test_decide_non_closed_no_price_increments_failure_count():
    """A non-closed cycle with no writable price is a failure."""
    _, _, new_fc = decide("REGULAR", False, None, NOW, 0, BASE)
    assert new_fc == 1


@pytest.mark.parametrize("state", ["CLOSED", "POST", "POSTPOST", "PRE", "PREPRE"])
def test_decide_closed_cycle_never_counts_as_failure(state):
    """A closed -> sleep-to-open cycle leaves the counter untouched (passthrough),
    neither incrementing (market shut is not a ticker fault) nor resetting."""
    _, _, new_fc = decide(state, False, None, NOW, 5, BASE)
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
        _, next_delay, fc = decide("REGULAR", False, None, NOW, fc, BASE)
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
        _, delay, fc = decide("REGULAR", False, None, NOW, fc, BASE)
    assert delay > BASE and fc == 6

    # The market prints a price -> write, reset.
    should_write, delay, fc = decide("REGULAR", True, None, NOW, fc, BASE)
    assert (should_write, delay, fc) == (True, BASE, 0)


def test_decide_closed_cycles_interleaved_do_not_advance_backoff():
    """closed cycles between failures must not increment the counter, so the
    backoff resumes exactly where the failures left it."""
    fc = 0
    # Two failures.
    _, _, fc = decide("REGULAR", False, None, NOW, fc, BASE)
    _, _, fc = decide("REGULAR", False, None, NOW, fc, BASE)
    assert fc == 2

    # A closed stretch: counter frozen, sleeps to next open (not backoff).
    next_open = NOW + timedelta(hours=1)
    _, closed_delay, fc = decide("CLOSED", False, next_open, NOW, fc, BASE)
    assert (fc, closed_delay) == (2, 3600)

    # Failures resume: n=3 still grace, n=4 first backoff step.
    _, delay3, fc = decide("REGULAR", False, None, NOW, fc, BASE)
    assert (fc, delay3) == (3, BASE)
    _, delay4, fc = decide("REGULAR", False, None, NOW, fc, BASE)
    assert (fc, delay4) == (4, BASE * 2)


def test_decide_backoff_never_overflows_for_a_long_dead_ticker():
    """A ticker dead for a very long run stays pinned at MAX_SLEEP without
    building an astronomical delay from 2^n."""
    _, next_delay, new_fc = decide("REGULAR", False, None, NOW, 100_000, BASE)
    assert next_delay == MAX_SLEEP
    assert new_fc == 100_001


# ---------------------------------------------------------------------------
# decide — looped sequences (re-inject the returned clock/counter)
# ---------------------------------------------------------------------------

def test_decide_sequence_pre_regular_post():
    """PRE (sleep to open) -> REGULAR (poll+write) -> POST (sleep to next open)."""
    open1 = NOW + timedelta(hours=1)
    w, d, _ = decide("PRE", True, open1, NOW, 0, BASE)
    assert (w, d) == (False, 3600)

    # Woken at the open, now REGULAR.
    at_open = open1
    w, d, _ = decide("REGULAR", True, None, at_open, 0, BASE)
    assert (w, d) == (True, BASE)

    # Market closes for the day.
    next_open = at_open + timedelta(hours=20)
    w, d, _ = decide("POST", True, next_open, at_open, 0, BASE)
    assert (w, d) == (False, 20 * 3600)


def test_decide_sequence_closed_then_short_retry_resolves_forward():
    """A closed wake with a stale (past) next-open short-retries until REGULAR."""
    stale_open = NOW - timedelta(minutes=5)
    w, d, _ = decide("CLOSED", False, stale_open, NOW, 0, BASE)
    assert (w, d) == (False, SHORT_RETRY)

    # 60s later it flips to REGULAR.
    later = NOW + timedelta(seconds=SHORT_RETRY)
    w, d, _ = decide("REGULAR", True, None, later, 0, BASE)
    assert (w, d) == (True, BASE)


# ---------------------------------------------------------------------------
# The perf gate is gone (issue #707, ADR-0011)
# ---------------------------------------------------------------------------

def test_scheduling_exposes_no_perf_gate():
    """``perf_should_run`` is deleted **without a replacement**.

    Asserted on the module rather than left to the absence of a test, because
    the failure mode the ticket names is a *successor*: the same predicate
    re-expressed as a query, or reduced to a single signal. The recompute is
    unconditional, so nothing here has an opinion on whether it should run.
    """
    assert not [name for name in dir(scheduling) if 'should_run' in name]


def test_decide_returns_three_values_and_no_perf_signal():
    """``decide``'s fourth element said "this write makes the perf series stale".

    It was ``should_write`` spelt twice and it left with the flag it fed: a
    scrape has nothing to tell a recompute that reads the store every cycle.
    """
    assert len(decide("REGULAR", True, None, NOW, 0, BASE)) == 3


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

@pytest.mark.parametrize("now, expected", [
    pytest.param(BNP_BEFORE_OPEN, BNP_REGULAR_START, id="morning"),
    pytest.param(BNP_AFTER_CLOSE, BNP_APPROX_NEXT_OPEN, id="evening"),
])
def test_extract_sweeps_both_sides_of_the_captured_open(now, expected):
    """One **real** reading, read at two instants — the sweep that was missing.

    ``currentTradingPeriod`` describes the current period and never the next
    one, so the same ``regular.start`` is the next open in the morning and this
    morning's open in the evening. Before it, the exact value wins over the
    ~08:00 guess (which would answer the *next* day here, so the two are
    distinguishable); after it, the exact value is discarded and the guess —
    the one producer that guarantees a future date — takes over.

    The predecessor of this test pinned ``ts = 1_700_000_000``, i.e.
    2023-11-14, *before* its own ``NOW`` of 2024-01-15, and asserted the
    function returned it: the evening case was **inside** the sweep with the
    defect written down as the expected answer. That is one turn worse than
    #765's *a test attesting a property it never exercised*, and it is why the
    successor reads one capture at two instants rather than adding a case
    beside the old one.
    """
    info, meta = _capture(BNP)
    _, next_open = extract_market_context(info, meta, now)
    assert next_open == expected


@pytest.mark.parametrize("hour", range(0, 24))
def test_extract_never_answers_a_next_open_that_has_already_happened(hour):
    """The invariant, swept across the captured day: strictly future, or None.

    Stated on the whole day rather than on the two interesting instants, because
    what makes it an invariant is that no caller has to know which side of the
    open it is on — ``decide``'s non-positive-delta branch stops being reachable
    from here at any hour.
    """
    info, meta = _capture(BNP)
    now = datetime(2026, 8, 12, hour, 13, tzinfo=UTC)
    _, next_open = extract_market_context(info, meta, now)
    assert next_open is not None          # the reading names a timezone
    assert next_open > now


def test_a_closed_evening_sleeps_to_the_next_open():
    """End to end on the reading: the evening sleeps, it does not re-probe.

    The measured symptom was ~70 to 90 seconds per symbol all evening —
    ``SHORT_RETRY`` plus #619's jitter — of the order of 4 000 Yahoo requests a
    night on eleven European lines, not one of which may write: ``decide``'s
    write gate is shut on a closed market by construction, which the assertion
    on ``should_write`` re-states here.
    """
    info, meta = _capture(BNP)
    state, next_open = extract_market_context(info, meta, BNP_AFTER_CLOSE)

    assert scheduling.is_closed(state)    # POSTPOST, as read
    should_write, next_delay, _ = decide(
        state, False, next_open, BNP_AFTER_CLOSE, 0, BASE)

    assert should_write is False
    assert next_delay != SHORT_RETRY
    assert next_delay == pytest.approx(
        (BNP_APPROX_NEXT_OPEN - BNP_AFTER_CLOSE).total_seconds())
    assert next_delay > 9 * 3600          # the closure, not a minute


def test_no_helper_claims_to_read_the_next_open():
    """The name says what the field holds, not what a scheduler would like.

    Asserted on the module rather than left to the reading of a docstring: the
    old ``_exact_next_open`` announced *"the exact next regular open"* and the
    statement was simply false half of every day, which is the divergence #769
    is about. Its successor is named after the period the field describes.
    """
    assert not hasattr(scheduling, '_exact_next_open')
    assert hasattr(scheduling, '_current_regular_open')


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


# ---------------------------------------------------------------------------
# rearm_split — which symbols a new regular_interval reaches (#701)
# ---------------------------------------------------------------------------

def test_rearm_split_reaches_only_the_symbols_whose_market_is_open():
    """The acceptance criterion: a sleeping symbol is off-topic, not mis-set."""
    held = {"AAPL", "MSFT", "MC.PA"}
    closed = {"AAPL": False, "MSFT": False, "MC.PA": True}

    split = scheduling.rearm_split(held, closed, armed=held)

    assert split.rearm == ("AAPL", "MSFT")
    assert split.asleep == ("MC.PA",)


def test_rearm_split_asks_the_last_pass_and_not_the_clock():
    """The armed time cannot tell a #617 back-off from a market close.

    A symbol failing six cycles is armed at ``120 × 2³`` — sixteen minutes out,
    further than some market opens — and it is *not* asleep: its market is open
    and its wait is a multiple of the very dial being changed. Reporting it as
    "waiting for its market to open" would collapse the two states #668 keeps
    apart, on the one screen an operator would consult to tell them apart.
    """
    split = scheduling.rearm_split(
        {"DEAD"}, {"DEAD": False}, armed={"DEAD"})

    assert split.rearm == ("DEAD",)
    assert split.asleep == ()


def test_rearm_split_leaves_a_symbol_mid_pass_to_arm_itself():
    """Trap 1: a ``date`` job leaves the jobstore *while it runs*.

    APScheduler removes it rather than nulling its run time, so the symbol is
    simply absent from ``armed``. It re-arms itself from the new value at the
    end of its own pass — reached, and not to be raced.
    """
    split = scheduling.rearm_split(
        {"AAPL"}, {"AAPL": False}, armed=set())

    assert split.rearm == ()
    assert split.self_arming == ("AAPL",)
    assert split.asleep == ()


def test_rearm_split_leaves_a_symbol_that_has_never_run_alone():
    """At boot every held symbol is armed to fire *immediately*.

    Re-arming one there would push the bootstrap a whole cadence into the
    future — a dial saved in the first seconds of a boot would delay the first
    scrape it was meant to hasten.
    """
    split = scheduling.rearm_split(
        {"AAPL"}, {"AAPL": None}, armed={"AAPL"})

    assert split.rearm == ()
    assert split.self_arming == ("AAPL",)


def test_rearm_split_covers_the_whole_portfolio():
    """The two published figures must add up, or the reader draws the wrong one.

    The row set is the held positions, never the jobstore: reading it off the
    jobstore drops whichever symbol is mid-scrape, and a portfolio of four
    answering "3 reached, 0 asleep" reads as one symbol quietly broken.
    """
    held = {"A", "B", "C", "D"}
    closed = {"A": False, "B": True, "C": False, "D": None}

    split = scheduling.rearm_split(held, closed, armed={"A", "B", "D"})

    assert len(split.rearm) + len(split.self_arming) + len(split.asleep) == 4
    assert split.self_arming == ("C", "D")


def test_rearm_split_of_an_empty_portfolio_is_three_empties():
    assert scheduling.rearm_split(set(), {}, armed=set()) == ((), (), ())


# ---------------------------------------------------------------------------
# compute_pool_size — auto executor-pool sizing (#619, design #611)
# ---------------------------------------------------------------------------

def _shares(*symbols):
    """Minimal share dicts — compute_pool_size only reads ``symbol``."""
    return [{"symbol": s} for s in symbols]


def _same_exchange(symbols, exchange="NMS"):
    return {s: exchange for s in symbols}


@pytest.mark.parametrize("count,expected", [
    # Design #611 worked examples: RESERVED + ceil(cohort*5/30), RESERVED = 3.
    (30, 8),    # 3 + ceil(150/30)=5
    (100, 20),  # 3 + ceil(500/30)=17
    (5, 4),     # 3 + ceil(25/30)=1
    (1, 4),     # 3 + ceil(5/30)=1
])
def test_compute_pool_size_same_exchange_cohort(count, expected):
    symbols = [f"SYM{i}" for i in range(count)]
    assert compute_pool_size(
        _shares(*symbols), _same_exchange(symbols)) == expected


def test_compute_pool_size_clamps_to_cap():
    # A cohort large enough to blow past POOL_CAP is clamped to it.
    symbols = [f"SYM{i}" for i in range(1000)]
    size = compute_pool_size(_shares(*symbols), _same_exchange(symbols))
    assert size == POOL_CAP


def test_compute_pool_size_empty_portfolio_is_reserved_and_at_least_one():
    """One reserved figure since #711: one loading path means one job set."""
    assert compute_pool_size([], {}) == scheduling.RESERVED


def test_compute_pool_size_sizes_on_largest_cohort_only():
    # Two exchanges: NMS holds 30, PAR holds 3 -> the 30-cohort drives the size.
    nms = [f"N{i}" for i in range(30)]
    par = [f"P{i}" for i in range(3)]
    exchange_of = {**_same_exchange(nms, "NMS"), **_same_exchange(par, "PAR")}
    assert compute_pool_size(_shares(*(nms + par)), exchange_of) == 8  # 3 + 5


def test_compute_pool_size_unknown_exchange_is_a_solo_market():
    # No exchange known for any symbol -> each is a solo cohort of 1, not grouped.
    symbols = [f"SYM{i}" for i in range(30)]
    exchange_of = {s: None for s in symbols}
    # largest cohort = 1 -> ceil(5/30)=1 -> 3+1=4 (not 8).
    assert compute_pool_size(_shares(*symbols), exchange_of) == 4


def test_compute_pool_size_missing_exchange_entry_is_solo():
    # A symbol absent from exchange_of behaves like an unknown exchange (solo).
    assert compute_pool_size(_shares("AAA", "BBB"), {}) == 4  # 3 + 1


def test_compute_pool_size_ignores_shares_without_symbol():
    shares = [{"symbol": "AAA"}, {"name": "no symbol"}, {"symbol": None}]
    assert compute_pool_size(shares, {"AAA": "NMS"}) == 4  # 3 + 1


# ---------------------------------------------------------------------------
# forward_backfill_window — forward gap-fill window sizing (#627/#626)
# ---------------------------------------------------------------------------

def test_forward_window_fresh_gap_fills_to_now():
    # A missed session: newest is 2 days back, a large chunk covers it in one
    # window, so end lands exactly on now.
    newest = NOW - timedelta(days=2)
    assert forward_backfill_window(newest, NOW, chunk_days=365) == (newest, NOW)


def test_forward_window_no_gap_returns_none():
    # newest == now (freshly written): nothing to recover.
    assert forward_backfill_window(NOW, NOW, chunk_days=365) is None


def test_forward_window_sub_day_gap_is_noop_during_live_trading():
    # The live REGULAR writer keeps newest ≈ now; a sub-day window (e.g. a
    # weekend that has only just begun) is skipped by the < 1 day guard so the
    # forward pass never races the seam.
    newest = NOW - timedelta(hours=6)
    assert forward_backfill_window(newest, NOW, chunk_days=365) is None


def test_forward_window_multi_chunk_long_gap_advances_one_chunk():
    # An 800-day gap with a 365-day chunk: only the first chunk this cycle, end
    # capped at newest + chunk_days (< now), advancing forward next cycles.
    newest = NOW - timedelta(days=800)
    start, end = forward_backfill_window(newest, NOW, chunk_days=365)
    assert start == newest
    assert end == newest + timedelta(days=365)
    assert end < NOW


def test_forward_window_none_newest_returns_none():
    # Empty series: the backward pass owns seeding it, the forward pass has no
    # anchor.
    assert forward_backfill_window(None, NOW, chunk_days=365) is None


def test_forward_window_naive_newest_is_coerced_utc():
    # A naive newest (defensive) must not raise on the now - newest subtraction.
    newest_naive = (NOW - timedelta(days=3)).replace(tzinfo=None)
    start, end = forward_backfill_window(newest_naive, NOW, chunk_days=365)
    assert start == NOW - timedelta(days=3)
    assert end == NOW


def test_forward_window_clock_skew_returns_none():
    # now before newest (clock skew) yields a negative delta → skipped, not a
    # backwards window.
    newest = NOW + timedelta(days=1)
    assert forward_backfill_window(newest, NOW, chunk_days=365) is None


# ---------------------------------------------------------------------------
# price_freshness_step — price-freshness liveness sonde (#628/#626)
# ---------------------------------------------------------------------------

HORIZON = 900


def _step(prev, live, stored, now):
    return price_freshness_step(prev, live, stored, now, HORIZON)


def test_first_observation_baselines_and_never_flags():
    # No prior state: baseline the frozen anchor, never flag on the first look.
    state, stale = _step(None, live=191.0, stored=185.0, now=NOW)
    assert stale is False
    assert state == SondeState(185.0, NOW, NOW)


def test_frozen_value_moved_quote_past_horizon_is_stale():
    # Stored value unchanged across consecutive polling for >= horizon while the
    # live quote has moved away from it: the writer is silently stale.
    prev = SondeState(stored_price=185.0, frozen_since=NOW,
                      last_seen=NOW + timedelta(seconds=450))
    now = NOW + timedelta(seconds=HORIZON)
    state, stale = _step(prev, live=191.0, stored=185.0, now=now)
    assert stale is True
    assert state == SondeState(185.0, NOW, now)  # anchor carried forward


def test_frozen_but_within_horizon_is_not_stale():
    # Unchanged and moved, but not frozen long enough yet: no false positive on
    # an ordinary tick.
    prev = SondeState(185.0, NOW, NOW)
    now = NOW + timedelta(seconds=HORIZON - 1)
    _state, stale = _step(prev, live=191.0, stored=185.0, now=now)
    assert stale is False


def test_value_advanced_rebaselines_and_is_not_stale():
    # A healthy writer advances the stored value each cycle → re-baseline, never
    # flag, however old the previous anchor.
    prev = SondeState(185.0, NOW, NOW)
    now = NOW + timedelta(seconds=HORIZON + 5000)
    state, stale = _step(prev, live=191.0, stored=190.0, now=now)
    assert stale is False
    assert state == SondeState(190.0, now, now)


def test_polling_gap_wider_than_horizon_rebaselines():
    # The market-open-after-close fix: a break in consecutive polling wider than
    # the horizon (overnight/weekend) re-baselines even with the value unchanged,
    # so the first morning tick never fires a false positive (#628 acceptance).
    prev = SondeState(185.0, NOW, NOW)
    now = NOW + timedelta(hours=16)  # overnight gap, value still 185
    state, stale = _step(prev, live=191.0, stored=185.0, now=now)
    assert stale is False
    assert state == SondeState(185.0, now, now)


def test_flat_market_past_horizon_is_not_stale():
    # Stored value frozen and old, but the live quote still matches it: a
    # genuinely flat market, not a stuck writer (accepted #626 false-negative).
    prev = SondeState(185.0, NOW, NOW + timedelta(seconds=450))
    now = NOW + timedelta(seconds=HORIZON)
    _state, stale = _step(prev, live=185.0, stored=185.0, now=now)
    assert stale is False


def test_flat_quote_within_tolerance_is_not_stale():
    # A sub-epsilon float wobble on an otherwise flat price is "unchanged".
    prev = SondeState(185.0, NOW, NOW + timedelta(seconds=450))
    now = NOW + timedelta(seconds=HORIZON)
    _state, stale = _step(prev, live=185.0 + 1e-9, stored=185.0, now=now)
    assert stale is False


def test_missing_live_quote_never_flags():
    # No live quote to compare against → no signal (state still advances).
    prev = SondeState(185.0, NOW, NOW + timedelta(seconds=450))
    now = NOW + timedelta(seconds=HORIZON)
    _state, stale = _step(prev, live=None, stored=185.0, now=now)
    assert stale is False


def test_empty_series_forgets_state_and_never_flags():
    # No stored price yet (empty series): nothing to anchor on.
    state, stale = _step(SondeState(185.0, NOW, NOW), live=191.0,
                         stored=None, now=NOW + timedelta(seconds=HORIZON))
    assert (state, stale) == (None, False)


@pytest.mark.parametrize("horizon", [0, -1, -900])
def test_non_positive_horizon_disables_sonde(horizon):
    # A non-positive horizon turns the sonde off, even with a clearly stuck writer.
    prev = SondeState(185.0, NOW, NOW)
    state, stale = price_freshness_step(
        prev, 191.0, 185.0, NOW + timedelta(seconds=10_000), horizon)
    assert (state, stale) == (None, False)


def test_at_exactly_horizon_counts_as_stale():
    # frozen elapsed == horizon meets the ">= horizon" gate (inclusive boundary),
    # with the polling gap itself not exceeding the horizon (so no re-baseline).
    prev = SondeState(185.0, NOW, NOW)
    now = NOW + timedelta(seconds=HORIZON)
    _state, stale = _step(prev, live=191.0, stored=185.0, now=now)
    assert stale is True


def test_default_horizon_is_several_cycles_wide():
    # The shipped default is comfortably wider than a REGULAR poll interval so an
    # ordinary tick can't trip the sonde.
    assert STALENESS_HORIZON >= 5 * BASE
