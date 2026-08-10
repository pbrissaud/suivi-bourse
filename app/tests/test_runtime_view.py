"""Tests for the app's own runtime state — the pure half (issue #668, #656).

#668's testing criterion is explicit about what this file has to earn: the
composition is pure, so **the ambiguous ``next_run_time``, the backfill's
terminal state and the boot window are all testable without a scheduler**.
Those three are the cases most likely to be rendered wrong, and each of them
would be rendered wrong in the *reassuring* direction — a stall that reads as
progress, a nominal absence that reads as a stall — which is the kind of defect
a screen does not reveal by being looked at.

The recorder is here too, because its one piece of logic is the consecutive
failure fold, and that fold is the answer to #656's driving question.
"""
from datetime import datetime, timedelta, timezone

import pytest

import runtime_state
import runtime_view
import scheduling


UTC = timezone.utc
NOW = datetime(2026, 8, 5, 15, 0, tzinfo=UTC)


def _share(symbol='AAPL', name='Apple Inc', account='pea', quantity=10):
    """One position. ``quantity=0`` is a sold one — no scrape job, but a row all
    the same since #703: its history is still being reconstructed."""
    return {'name': name, 'symbol': symbol, 'account': account,
            'quantity': quantity}


def _scrape(**overrides):
    base = dict(
        symbol='AAPL', at=NOW, market_state='REGULAR', closed=False,
        price_present=True, verdict=runtime_state.SCRAPE_WROTE,
        failure_count=0, next_delay=120.0, wrote=True, stale=False,
    )
    base.update(overrides)
    return runtime_state.ScrapeRecord(**base)


def _backfill(**overrides):
    base = dict(
        symbol='AAPL', direction=runtime_state.BACKWARD, at=NOW)
    base.update(overrides)
    return runtime_state.BackfillRecord(**base)


# ===================================================================== #
# The pills (#652 déc. 15)
# ===================================================================== #

def test_no_record_is_unknown_not_a_fault():
    """A freshly booted container has scraped nothing yet. That is a state."""
    assert runtime_view.symbol_pill(None) == runtime_view.PILL_UNKNOWN


def test_a_written_pass_is_open_and_a_closed_one_is_closed():
    assert runtime_view.symbol_pill(_scrape()) == runtime_view.PILL_OPEN
    assert runtime_view.symbol_pill(_scrape(
        market_state='CLOSED', closed=True,
        verdict=runtime_state.SCRAPE_CLOSED)) == runtime_view.PILL_CLOSED


def test_a_refused_write_outranks_everything_because_the_backoff_cannot_see_it():
    """The pill #617's counter is structurally blind to.

    ``scheduling.decide`` resets the failure counter whenever a price was
    present, so an InfluxDB outage leaves a symbol polling at ``base_interval``
    with a counter of zero — healthy by every measure the scheduler keeps, and
    persisting nothing at all. Without this value the row would read ``open``.
    """
    record = _scrape(verdict=runtime_state.SCRAPE_WRITE_FAILED,
                     wrote=False, failure_count=0)

    assert runtime_view.symbol_pill(record) == runtime_view.PILL_WRITE_FAILED


def test_backoff_only_once_the_delay_has_actually_grown():
    """``failing`` and ``backoff`` are different news, and the boundary is #617's.

    Inside the grace window the job still re-arms at ``base_interval``; past it
    the delay grows geometrically and the symbol will not be retried for a long
    time. Collapsing the two would make a single transient failure look like a
    symbol the app has given up on.
    """
    assert runtime_view.symbol_pill(_scrape(
        failure_count=1, verdict=runtime_state.SCRAPE_NO_PRICE,
    )) == runtime_view.PILL_FAILING
    assert runtime_view.symbol_pill(_scrape(
        failure_count=scheduling.FAILURE_GRACE,
        verdict=runtime_state.SCRAPE_NO_PRICE,
    )) == runtime_view.PILL_FAILING
    assert runtime_view.symbol_pill(_scrape(
        failure_count=scheduling.FAILURE_GRACE + 1,
        verdict=runtime_state.SCRAPE_NO_PRICE,
    )) == runtime_view.PILL_BACKOFF


def test_a_frozen_price_outranks_a_failing_fetch():
    """#628's sonde beats #617's counter, because it is the quieter failure.

    A failing fetch shows up eventually in the price simply stopping; a writer
    that fetches fine and persists a frozen value looks healthy from every other
    angle, which is why the sonde exists at all.
    """
    record = _scrape(failure_count=1, stale=True)

    assert runtime_view.symbol_pill(record) == runtime_view.PILL_FROZEN


def test_the_pill_never_reads_the_cached_market_state():
    """#656 traps 2 and 3, made structural by carrying two fields.

    ``decide`` fail-opens an unrecognised state to REGULAR while
    ``_share_info_cache`` keeps yfinance's raw string, and the cache is written
    only on a *successful* fetch. So the record carries what this cycle read
    (``market_state``, ``None`` when the fetch failed) beside what the scheduler
    acted on (``closed``), and the pill is decided by the second.
    """
    garbage = _scrape(market_state='PREPRE-nonsense', closed=False)
    assert runtime_view.symbol_pill(garbage) == runtime_view.PILL_OPEN

    failed = _scrape(market_state=None, closed=False, price_present=False,
                     verdict=runtime_state.SCRAPE_NO_PRICE, failure_count=1)
    row = runtime_view.build_symbols(
        [_share()], {'AAPL': failed}, {}, {'AAPL': NOW}, NOW)[0]
    assert row.market_state is None


# ===================================================================== #
# Trap 1: an absent next_run_time is ambiguous
# ===================================================================== #

def test_a_missing_job_is_ambiguous_never_departed_and_never_running():
    """The trap, and the only thing a correct renderer can do about it.

    A ``date`` job is removed from the jobstore *while it runs* and re-added at
    the end of ``_scrape_symbol``, so absence means "being scraped right now"
    **or** "symbol departed" — and a cycle can be seconds long. The value carries
    both readings; picking one would be wrong roughly half the time, silently.
    """
    rows = runtime_view.build_symbols(
        [_share()], {'AAPL': _scrape()}, {}, {}, NOW)

    assert rows[0].next_run_state == runtime_view.NEXT_RUN_AMBIGUOUS
    assert rows[0].next_run is None


def test_a_job_with_no_next_run_time_is_ambiguous_too():
    rows = runtime_view.build_symbols(
        [_share()], {'AAPL': _scrape()}, {}, {'AAPL': None}, NOW)

    assert rows[0].next_run_state == runtime_view.NEXT_RUN_AMBIGUOUS


def test_no_scheduler_at_all_is_its_own_state():
    """Distinct from absence *from* a running jobstore, and it has to be.

    ``GET /api/runtime`` answers in the master and in a test, where there is no
    scheduler — folding that onto trap 1's ambiguity would have every symbol
    claim it might be mid-scrape in a process that is scraping nothing.
    """
    rows = runtime_view.build_symbols(
        [_share()], {'AAPL': _scrape()}, {}, {}, NOW, scheduler_running=False)

    assert rows[0].next_run_state == runtime_view.NEXT_RUN_UNAVAILABLE


def test_a_scheduled_job_carries_its_instant():
    later = NOW + timedelta(seconds=120)
    rows = runtime_view.build_symbols(
        [_share()], {'AAPL': _scrape()}, {}, {'AAPL': later}, NOW)

    assert rows[0].next_run_state == runtime_view.NEXT_RUN_SCHEDULED
    assert rows[0].next_run == later


# ===================================================================== #
# The backfill's terminal state, never collapsed with a stall (#656 trap 6)
# ===================================================================== #

def test_complete_is_carried_through_verbatim():
    """``complete`` — everything back to the first acquisition is stored.

    It had two siblings and both lost their subject: ``manual_mode`` with the
    mode it named (#711), and ``no_buy`` at #703, where the target became the
    first *acquisition* — ``GRANT`` included — so a symbol that would have
    carried it has no holding window and never reaches the backfill at all.

    Rendering the survivor as a stall accuses the app of a fault it does not
    have.
    """
    progress = runtime_view.backfill_progress(
        _backfill(terminal=runtime_state.TERMINAL_COMPLETE),
        runtime_state.BACKWARD, NOW)

    assert progress.state == runtime_state.TERMINAL_COMPLETE


def test_the_boot_window_announces_no_backfill_at_all():
    """Found by looking, on a manual install, in the first minute after a restart.

    The backfill job runs every 60 s, so until its first cycle **no** series has
    a record — and counting those as pending drew « 0 séries sur 2 » across the
    banner for a reprise d'historique that was never going to happen (manual mode
    has no backward pass at all). An unobserved series is not known to be
    pending; it is not known to be anything.
    """
    symbols = runtime_view.build_symbols(
        [_share('AAPL'), _share('MSFT')], {}, {}, {}, NOW)

    summary = runtime_view.build_backfill_summary(symbols)

    assert summary['unknown'] == 2
    assert summary['in_scope'] == 0
    assert summary['ratio'] is None


def test_a_sold_position_is_inside_the_bar_because_it_is_what_is_rebuilt():
    """The denominator counts sold lines too (issue #703).

    The backfill is driven by the replay now, so a position closed in 2022 has a
    backward pass of its own — and it is precisely the history nothing else can
    supply. Leaving it out of the bar would announce « 1 série sur 1 » while a
    second one is still walking back through five years.
    """
    symbols = runtime_view.build_symbols(
        [_share('AAPL'), _share('ALO', quantity=0)],
        {},
        {
            ('AAPL', runtime_state.BACKWARD): _backfill(
                terminal=runtime_state.TERMINAL_COMPLETE),
            ('ALO', runtime_state.BACKWARD): _backfill(
                symbol='ALO', oldest=NOW - timedelta(days=200),
                target=NOW - timedelta(days=1200)),
        },
        {}, NOW)

    summary = runtime_view.build_backfill_summary(symbols)

    assert summary['total'] == 2
    assert summary['in_scope'] == 2
    assert summary['running'] == 1
    assert summary['ratio'] == 0.5


def test_a_sold_position_says_it_is_not_polled_rather_than_nothing():
    """Its row is not a stuck scheduler, and has to say so (issue #703).

    The scrape's set and the backfill's stopped being the same one: a sold line
    keeps no job and no scrape record, so the row would otherwise read as a
    symbol the scheduler has never reached — permanently, with no future event
    able to clear it.
    """
    rows = runtime_view.build_symbols(
        [_share('AAPL'), _share('ALO', quantity=0)],
        {'AAPL': _scrape()}, {}, {'AAPL': NOW}, NOW)

    held, sold = rows[0], rows[1]
    assert (held.symbol, held.held) == ('AAPL', True)
    assert held.next_run_state == runtime_view.NEXT_RUN_SCHEDULED
    assert (sold.symbol, sold.held) == ('ALO', False)
    assert sold.next_run_state == runtime_view.NEXT_RUN_NOT_HELD


def test_a_symbol_held_in_one_account_and_sold_in_another_is_still_held():
    """One symbol, one job, one series: the holding is asked of the portfolio."""
    rows = runtime_view.build_symbols(
        [_share('AAPL', account='pea', quantity=0),
         _share('AAPL', account='cto', quantity=4)],
        {}, {}, {}, NOW)

    assert [(row.symbol, row.held) for row in rows] == [('AAPL', True)]


def test_a_terminal_outranks_a_stale_failure_count():
    """A series marked complete is not failing at anything.

    The terminal is a *conclusion* the pass reached; the counter describes
    attempts. Reading the counter first would leave a finished series flagged
    forever by the failures it survived on the way.
    """
    record = _backfill(terminal=runtime_state.TERMINAL_COMPLETE, failures=4)
    progress = runtime_view.backfill_progress(
        record, runtime_state.BACKWARD, NOW)

    assert progress.state == runtime_state.TERMINAL_COMPLETE
    assert progress.failures == 4


def test_a_failing_pass_is_told_apart_from_an_empty_window():
    """The distinction #656 says nothing in the app can make today.

    ``_backfill_backward`` logs a warning and returns ``0`` on a failed fetch —
    the same ``0`` a healthy weekend returns. Here the two are different states,
    and the difference is exactly "pacing normally" versus "wedged on yfinance".
    """
    wedged = runtime_view.backfill_progress(
        _backfill(failures=5, failed=True, error='rate limited'),
        runtime_state.BACKWARD, NOW)
    weekend = runtime_view.backfill_progress(
        _backfill(window=(NOW - timedelta(days=2), NOW), written=0),
        runtime_state.BACKWARD, NOW)

    assert wedged.state == runtime_view.BACKFILL_FAILING
    assert weekend.state == runtime_view.BACKFILL_RUNNING


# ===================================================================== #
# The progress bar
# ===================================================================== #

def test_the_bar_is_two_dates_from_one_record():
    """Half the history stored reads as half a bar."""
    target = NOW - timedelta(days=400)
    oldest = NOW - timedelta(days=200)
    progress = runtime_view.backfill_progress(
        _backfill(target=target, oldest=oldest),
        runtime_state.BACKWARD, NOW)

    assert progress.ratio == 0.5


def test_a_sold_line_is_measured_against_its_holding_window_not_against_now():
    """The denominator is ``[target, ceiling]``, and #703 is what parted them.

    A line bought 2020-03-02 and sold 2022-05-04 has 794 days of history to
    rebuild, not the 2 352 that separate its purchase from today. After the
    first of its three chunks the pass has covered 364 of those 794 — **0,458**.
    Dividing by *now* answers **0,817**, and the older the sale the wider the
    lie: a line held 2014-2015 reads over 0,9 on its very first cycle, i.e. the
    bar is inflated for exactly the class of row this ticket adds to the payload
    and at exactly the moment it has a use.

    The ceiling is asserted on the payload too: without it no consumer could
    tell the two readings apart, let alone repair the number.
    """
    now = datetime(2026, 8, 10, tzinfo=UTC)
    acquired = datetime(2020, 3, 2, tzinfo=UTC)
    ceiling = datetime(2022, 5, 5, tzinfo=UTC)   # the day after the last exit
    oldest = datetime(2021, 5, 6, tzinfo=UTC)    # one chunk down from the ceiling

    progress = runtime_view.backfill_progress(
        _backfill(target=acquired, ceiling=ceiling, oldest=oldest),
        runtime_state.BACKWARD, now)

    assert progress.ratio == pytest.approx(0.458, abs=0.001)
    assert progress.to_dict()['ceiling'] == ceiling.isoformat()


def test_a_still_held_line_keeps_reading_against_today():
    """The ceiling of a position still held **is** now, so nothing moves for it.

    Worth pinning: the fix above changes the denominator of every backward bar,
    and a live line reading differently afterwards would be a regression dressed
    up as a fix.
    """
    held = runtime_view.backfill_progress(
        _backfill(target=NOW - timedelta(days=400), ceiling=NOW,
                  oldest=NOW - timedelta(days=200)),
        runtime_state.BACKWARD, NOW)

    assert held.ratio == 0.5


def test_a_point_stored_after_the_last_exit_floors_the_bar_at_zero():
    """A pre-#703 install can hold points a scrape wrote after the sale.

    The subtraction then goes the wrong way. Clamping is the honest answer —
    nothing of the holding window has been rebuilt — where a negative ratio
    would render as a bar drawn backwards.
    """
    progress = runtime_view.backfill_progress(
        _backfill(target=datetime(2020, 3, 2, tzinfo=UTC),
                  ceiling=datetime(2022, 5, 5, tzinfo=UTC),
                  oldest=datetime(2025, 1, 6, tzinfo=UTC)),
        runtime_state.BACKWARD, datetime(2026, 8, 10, tzinfo=UTC))

    assert progress.ratio == 0.0


def test_a_naive_influxdb_timestamp_neither_crashes_nor_shifts_the_page():
    """Found by looking at a real stack, and hidden by the terminal states.

    ``get_oldest_timestamp`` returns whatever pandas hands back from the Arrow
    ``time`` column — **tz-naive** — while ``target`` is built from an event date
    and is aware. Subtracting one from the other raises ``TypeError``, which the
    API blueprint renders as *503 Portfolio storage unavailable* from the one
    route that reads no storage, and only while a backward pass is **in
    progress**: a completed one short-circuits to ``1.0`` before the arithmetic
    ever runs, so a stack whose history is already filled never shows it.

    The second half is quieter: a naive ISO string is read by ``new Date()`` as
    *local* time, shifting every instant on the page by the browser's offset.
    """
    # Half the span stored, with the oldest point arriving naive — exactly the
    # shape ``get_oldest_timestamp`` produces.
    naive_oldest = (NOW - timedelta(days=200)).replace(tzinfo=None)
    progress = runtime_view.backfill_progress(
        _backfill(target=NOW - timedelta(days=400), oldest=naive_oldest),
        runtime_state.BACKWARD, NOW)

    assert progress.ratio == 0.5
    assert progress.to_dict()['oldest'] == (NOW - timedelta(days=200)).isoformat()


def test_complete_is_one_by_definition_not_by_arithmetic():
    """A first BUY on a day the market never traded stops just short, forever.

    The watermark is set when the oldest point *reaches* the target — and also
    when the fetch comes back empty at the target, which is what a Saturday
    purchase produces. Letting the arithmetic answer would leave that portfolio
    reading 99 % for the life of the container, which is indistinguishable from
    a stall.
    """
    progress = runtime_view.backfill_progress(
        _backfill(terminal=runtime_state.TERMINAL_COMPLETE,
                  target=NOW - timedelta(days=400),
                  oldest=NOW - timedelta(days=398)),
        runtime_state.BACKWARD, NOW)

    assert progress.ratio == 1.0


def test_no_target_means_no_bar_rather_than_an_invented_denominator():
    progress = runtime_view.backfill_progress(
        _backfill(direction=runtime_state.FORWARD,
                  skipped=runtime_state.SKIP_TOO_RECENT),
        runtime_state.FORWARD, NOW)

    assert progress.ratio is None
    assert progress.state == runtime_state.SKIP_TOO_RECENT


def test_the_forward_pass_healthy_no_op_is_not_folded_into_the_bar():
    """``too_recent`` is what a live-trading portfolio looks like all day.

    The forward pass stands aside while ``newest ≈ now`` so the REGULAR writer
    stays the sole writer of the present. Counting that as unfinished work would
    make a perfectly well portfolio look permanently half-done.
    """
    symbols = runtime_view.build_symbols(
        [_share()], {},
        {
            ('AAPL', runtime_state.BACKWARD): _backfill(
                terminal=runtime_state.TERMINAL_COMPLETE),
            ('AAPL', runtime_state.FORWARD): _backfill(
                direction=runtime_state.FORWARD,
                skipped=runtime_state.SKIP_TOO_RECENT),
        },
        {}, NOW)

    summary = runtime_view.build_backfill_summary(symbols)

    assert summary['total'] == 1
    assert summary['ratio'] == 1.0


# ===================================================================== #
# The row set comes from the snapshot, never from the recorder
# ===================================================================== #

def test_a_symbol_the_scheduler_has_not_reached_is_a_row_with_an_unknown_pill():
    """#656 déc. 3, and it is what keeps the reader out of the scrape threads.

    Iterating the recorder would both race the writers and drop this row
    entirely. Driving the fold from the configuration snapshot gives the honest
    answer for free: the position exists, nothing has been observed about it yet.
    """
    rows = runtime_view.build_symbols(
        [_share('AAPL'), _share('MSFT')], {'AAPL': _scrape()}, {}, {}, NOW)

    assert [row.symbol for row in rows] == ['AAPL', 'MSFT']
    assert rows[1].pill == runtime_view.PILL_UNKNOWN
    assert rows[1].last_pass is None


def test_a_symbol_held_in_two_accounts_is_one_row_naming_both():
    """One row, and no per-account measurement under it (issue #700).

    The sub-rows left with the dimension they described: the scrape writes one
    point per symbol and the backfill fetches one window per symbol, so a
    payload that kept them would have shown two identical bars for one piece of
    work. What the page still needs is *who holds it*, which is a list of names.
    """
    rows = runtime_view.build_symbols(
        [_share(account='pea'), _share(account='cto')],
        {'AAPL': _scrape(wrote=True, stale=True)},
        {}, {}, NOW)

    assert len(rows) == 1
    assert rows[0].accounts == ['cto', 'pea']
    assert rows[0].frozen is True
    assert rows[0].written is True


# ===================================================================== #
# The banner
# ===================================================================== #

def test_a_failed_ingestion_says_it_kept_the_previous_configuration():
    """The silent failure this record exists for.

    Since #658 a rejected configuration is never published, so the app goes on
    running — correctly — on its last valid snapshot, and the only trace anywhere
    is a line in the log. ``kept_previous`` is what turns that into a sentence on
    screen.
    """
    payload = runtime_view.build_ingestion(runtime_state.IngestRecord(
        at=NOW, outcome=runtime_state.INGEST_FAILED,
        error='Invalid event at 2024.csv:4'))

    assert payload['kept_previous'] is True
    assert payload['error'] == 'Invalid event at 2024.csv:4'


def test_a_successful_ingestion_does_not_claim_to_have_kept_anything():
    payload = runtime_view.build_ingestion(runtime_state.IngestRecord(
        at=NOW, outcome=runtime_state.INGEST_UNCHANGED, shares=3, events=12))

    assert payload['kept_previous'] is False
    assert payload['shares'] == 3


def test_the_perf_verdict_carries_all_three_of_618s_reasons():
    """A skip *is* the three of them being quiet, so all three are shown.

    Reducing them to one "reason" string would be the view inventing a verdict —
    and it could not even be done honestly, since on a skip there is no single
    condition to name.
    """
    skipped = runtime_view.build_perf(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_SKIPPED))
    ran = runtime_view.build_perf(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_RAN, live_write=True))

    assert skipped['reasons'] == {
        'events_changed': False, 'backfill_pending': False, 'live_write': False}
    assert ran['reasons']['live_write'] is True


def test_errors_are_folded_newest_first_across_every_job():
    older = NOW - timedelta(minutes=30)
    symbols = runtime_view.build_symbols(
        [_share()],
        {'AAPL': _scrape(at=older, verdict=runtime_state.SCRAPE_WRITE_FAILED,
                         wrote=False, error='the store refused the write')},
        {('AAPL', runtime_state.BACKWARD): _backfill(
            failed=True, failures=2, error='rate limited')},
        {}, NOW)

    errors = runtime_view.build_errors(
        symbols,
        runtime_state.IngestRecord(
            at=NOW - timedelta(hours=2),
            outcome=runtime_state.INGEST_FAILED, error='bad row'),
        None)

    assert [e['source'] for e in errors] == [
        'backfill:backward', 'scrape', 'ingest']
    assert errors[0]['key'] == 'AAPL'


def test_a_healthy_process_reports_no_errors():
    symbols = runtime_view.build_symbols(
        [_share()], {'AAPL': _scrape()}, {}, {}, NOW)

    assert runtime_view.build_errors(symbols, None, None) == []


# ===================================================================== #
# The recorder
# ===================================================================== #

def test_the_backfill_failure_counter_accumulates_and_resets():
    """The counter that has no equivalent anywhere in the app today.

    #656's driving question — "is the backfill advancing, or is it stuck?" — is
    unanswerable without it, because a single failed cycle and a wedged series
    both return ``0`` points written. It is *consecutive*: one success is enough
    to say the series recovered.
    """
    recorder = runtime_state.RuntimeRecorder()

    for expected in (1, 2, 3):
        record = recorder.record_backfill(_backfill(failed=True))
        assert record.failures == expected

    recovered = recorder.record_backfill(_backfill(written=42))

    assert recovered.failures == 0
    assert recorder.backfill_of(
        'AAPL', runtime_state.BACKWARD).failures == 0


def test_an_empty_window_never_counts_as_a_failure():
    """A weekend classifies itself by coming back empty (#606).

    Counting that would have every Monday morning read as wedged — the exact
    misreading the counter exists to prevent.
    """
    recorder = runtime_state.RuntimeRecorder()
    recorder.record_backfill(_backfill(failed=True))
    record = recorder.record_backfill(
        _backfill(window=(NOW - timedelta(days=2), NOW), written=0))

    assert record.failures == 0


def test_the_two_backfill_directions_keep_separate_counters():
    """They are independent passes (#626); a wedged forward pass must not make
    the backward one look wedged, and vice versa."""
    recorder = runtime_state.RuntimeRecorder()
    recorder.record_backfill(_backfill(failed=True))
    recorder.record_backfill(_backfill(failed=True))

    forward = recorder.record_backfill(
        _backfill(direction=runtime_state.FORWARD, failed=True))

    assert forward.failures == 1
    assert recorder.backfill_of(
        'AAPL', runtime_state.BACKWARD).failures == 2


def test_a_departed_scrape_job_leaves_the_backfill_records_standing():
    """The two sets parted company at #703, and so did the two cleanups.

    A sold position loses its scrape job and goes on being *reconstructed*.
    Dropping its backfill records with the job would blank the progress of a
    pass still running, permanently — no future event brings it back.
    """
    recorder = runtime_state.RuntimeRecorder()
    recorder.record_scrape(_scrape())
    recorder.record_backfill(_backfill())

    recorder.forget_scrape('AAPL')

    assert recorder.scrape_of('AAPL') is None
    assert recorder.backfill_of('AAPL', runtime_state.BACKWARD) is not None


def test_leaving_the_ledger_drops_both_maps():
    """What takes a backfill record away is a forgotten import, and only that."""
    recorder = runtime_state.RuntimeRecorder()
    recorder.record_scrape(_scrape())
    recorder.record_backfill(_backfill())
    recorder.record_backfill(_backfill(symbol='MSFT'))

    recorder.retain({'MSFT'})

    assert recorder.scrape_of('AAPL') is None
    assert recorder.backfill_of('AAPL', runtime_state.BACKWARD) is None
    assert recorder.backfill_of('MSFT', runtime_state.BACKWARD) is not None


def test_records_are_frozen_so_a_published_one_cannot_be_edited_in_place():
    """#658's rule, carried up one level: never mutate published state.

    A reader holding a record is holding a coherent dated observation for as
    long as it needs it, which is only true if nobody can change it underneath.
    """
    import dataclasses
    import pytest

    record = runtime_state.RuntimeRecorder().record_scrape(_scrape())

    with pytest.raises(dataclasses.FrozenInstanceError):
        record.failure_count = 9


# ===================================================================== #
# The whole payload
# ===================================================================== #

def test_the_payload_no_longer_states_a_mode_there_being_only_one():
    payload = runtime_view.build_runtime(
        shares=[_share()], scrape={}, backfill={}, next_runs={},
        ingest=None, perf=None, now=NOW, scheduler_running=False)

    assert 'mode' not in payload
    assert payload['scheduler_running'] is False
    assert payload['now'] == NOW.isoformat()
    assert payload['symbols'][0]['pill'] == runtime_view.PILL_UNKNOWN
    assert payload['ingestion'] is None
    assert payload['perf'] is None
