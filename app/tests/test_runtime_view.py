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
from datetime import date, datetime, timedelta, timezone

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


def test_a_line_nobody_holds_says_so_rather_than_unknown():
    """``unknown`` is a statement about *this process*, and it would never clear.

    A sold line keeps no scrape job and no record, so the ranking would call it
    "the scheduler has never reached this symbol" for the life of the container,
    with no future event able to erase it — and it is on the page precisely
    because its history is still being rebuilt (#703). ``held`` therefore
    outranks everything, exactly as it does for ``next_run_state``.
    """
    assert runtime_view.symbol_pill(None, held=False) == \
        runtime_view.PILL_NOT_HELD
    # And it stays the headline even while a record from before the sale
    # survives: what the pill answers is a property of the symbol, not of the
    # last pass over it.
    assert runtime_view.symbol_pill(_scrape(), held=False) == \
        runtime_view.PILL_NOT_HELD
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


def test_the_bar_follows_the_anchor_and_not_what_is_stored():
    """#703 parted the two, and only one of them moves.

    A symbol Yahoo answers nothing about for its early windows — a partial
    delisting, a history that simply starts later — stores no new point while
    its anchor descends a chunk a cycle. A bar drawn from the stored point
    freezes for the whole of the work and then jumps to 1,0 at the terminal:
    it reports a stall through exactly the period it exists to describe.
    """
    now = datetime(2026, 8, 10, tzinfo=UTC)
    target = datetime(2020, 1, 1, tzinfo=UTC)
    ceiling = datetime(2024, 1, 1, tzinfo=UTC)
    stored = datetime(2023, 12, 1, tzinfo=UTC)   # never moves: nothing to fetch
    anchor = datetime(2022, 1, 1, tzinfo=UTC)    # two chunks down

    progress = runtime_view.backfill_progress(
        _backfill(target=target, ceiling=ceiling, anchor=anchor, oldest=stored),
        runtime_state.BACKWARD, now)

    # Half the window walked, not the one month the series happens to hold.
    assert progress.ratio == pytest.approx(0.5, abs=0.001)
    assert progress.to_dict()['anchor'] == anchor.isoformat()
    assert progress.to_dict()['oldest'] == stored.isoformat()


def test_a_record_without_an_anchor_falls_back_to_what_is_stored():
    """A record published before the field existed still draws its bar."""
    progress = runtime_view.backfill_progress(
        _backfill(target=NOW - timedelta(days=400), ceiling=NOW,
                  oldest=NOW - timedelta(days=200)),
        runtime_state.BACKWARD, NOW)

    assert progress.ratio == 0.5


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
# The lateral pass, the third direction (issue #704)
# ===================================================================== #

def _lateral(**overrides):
    base = dict(direction=runtime_state.LATERAL)
    base.update(overrides)
    return _backfill(**base)


def test_the_lateral_pass_is_a_member_of_its_own_beside_the_other_two():
    """What it reports is orthogonal to both, so it cannot be folded into either.

    A series can be complete backwards, up to date forwards, and entirely
    unconverted — three independent facts, three members.
    """
    rows = runtime_view.build_symbols(
        [_share()], {},
        {
            ('AAPL', runtime_state.BACKWARD): _backfill(
                terminal=runtime_state.TERMINAL_COMPLETE),
            ('AAPL', runtime_state.FORWARD): _backfill(
                direction=runtime_state.FORWARD,
                skipped=runtime_state.SKIP_TOO_RECENT),
            ('AAPL', runtime_state.LATERAL): _lateral(written=42),
        },
        {}, NOW)

    payload = rows[0].to_dict()
    assert payload['backward']['state'] == runtime_state.TERMINAL_COMPLETE
    assert payload['forward']['state'] == runtime_state.SKIP_TOO_RECENT
    assert payload['lateral']['state'] == runtime_view.BACKFILL_RUNNING
    assert payload['lateral']['written'] == 42


def test_an_unconvertible_series_carries_the_reason_and_not_an_error():
    """The one terminal that asks the reader to act, so it has to name itself.

    *"Waiting for a conversion"* and *"will never convert"* are two different
    sentences; a state word with no subject leaves the second one in front of an
    empty column with no explanation. It is a **reply** and not a failure, so it
    stays out of the errors list, where a retry would be expected to clear it.
    """
    progress = runtime_view.backfill_progress(
        _lateral(terminal=runtime_state.TERMINAL_UNCONVERTIBLE,
                 reason='no exchange rate exists between XYZ and EUR'),
        runtime_state.LATERAL, NOW)

    assert progress.state == runtime_state.TERMINAL_UNCONVERTIBLE
    assert progress.to_dict()['reason'] == \
        'no exchange rate exists between XYZ and EUR'
    assert progress.error is None
    # No bar: what it walks is a set of rows missing a column, which is not an
    # interval of time and grows again every time the other two passes write.
    assert progress.ratio is None


def test_an_unconvertible_series_is_not_a_reconstruction_that_finished():
    """The banner counts the **backward** pass, and this is why it stays that way.

    The lateral pass's terminal is not an achievement but a fault to act on, so
    counting it as *done* beside a reconstructed series would have the banner
    announce as finished the very thing it should be naming. Its healthy steady
    state (``nothing_to_repair``) is out for the reason the forward pass's is.
    """
    symbols = runtime_view.build_symbols(
        [_share()], {},
        {
            ('AAPL', runtime_state.BACKWARD): _backfill(),
            ('AAPL', runtime_state.LATERAL): _lateral(
                terminal=runtime_state.TERMINAL_UNCONVERTIBLE,
                reason='no exchange rate exists between XYZ and EUR'),
        },
        {}, NOW)

    summary = runtime_view.build_backfill_summary(symbols)

    assert summary['complete'] == 0
    assert summary['running'] == 1
    assert summary['ratio'] == 0.0


def test_an_unanswered_reporting_currency_is_a_skip_and_never_a_terminal():
    """The trap the ticket writes down, seen from the payload.

    That absence is transitory and lifted by a write of the owner's, so it is a
    no-op the reader can wait out — never the sentence that says a currency will
    never resolve.
    """
    progress = runtime_view.backfill_progress(
        _lateral(skipped=runtime_state.SKIP_NO_BASE_CURRENCY),
        runtime_state.LATERAL, NOW)

    assert progress.state == runtime_state.SKIP_NO_BASE_CURRENCY
    assert progress.reason is None


def test_a_symbol_never_quoted_can_say_so_durably():
    """A quote currency is only ever learnt at a first successful fetch, so a
    symbol may sit with no converted point for as long as Yahoo says nothing —
    and the runtime state has to be able to say which of the two absences it
    is."""
    progress = runtime_view.backfill_progress(
        _lateral(skipped=runtime_state.SKIP_NO_QUOTE_CURRENCY),
        runtime_state.LATERAL, NOW)

    assert progress.state == runtime_state.SKIP_NO_QUOTE_CURRENCY


def test_a_lateral_fetch_that_failed_is_an_error_like_any_other():
    """The other half of the split: a fetch that did not complete *is* a failure,
    and it belongs where the other two passes publish theirs."""
    symbols = runtime_view.build_symbols(
        [_share()], {},
        {('AAPL', runtime_state.LATERAL): _lateral(
            failed=True, failures=2,
            error='the USD→EUR rates could not be fetched')},
        {}, NOW)

    errors = runtime_view.build_errors(symbols, None, None)

    assert [error['source'] for error in errors] == ['backfill:lateral']
    assert errors[0]['key'] == 'AAPL'


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


def test_the_accounts_are_the_ones_that_hold_it_not_the_ones_that_did():
    """The field says *holding*, and #703 must not change that in silence.

    Widening the row set to every symbol the ledger names (a sold line has a
    reconstruction of its own) also widened this list, which was already
    published: a share held in a PEA and sold out of a CTO listed both, so a
    reader summing per account counted a holding nobody has.
    """
    rows = runtime_view.build_symbols(
        [_share(account='pea', quantity=10), _share(account='cto', quantity=0)],
        {'AAPL': _scrape()}, {}, {}, NOW)

    assert rows[0].accounts == ['pea']
    assert rows[0].held is True


def test_a_symbol_nobody_holds_lists_no_account_and_says_why():
    """Empty, and ``held`` is the field that carries the meaning. *Which
    accounts once held it* is a different question, and the ledger answers it —
    inventing an answer here would be the same silent widening."""
    rows = runtime_view.build_symbols(
        [_share(account='pea', quantity=0), _share(account='cto', quantity=0)],
        {}, {}, {}, NOW)

    assert rows[0].accounts == []
    assert rows[0].held is False
    assert rows[0].pill == runtime_view.PILL_NOT_HELD


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


def test_the_perf_verdict_publishes_no_reasons():
    """``reasons`` went with the gate that produced them (issue #707).

    The three booleans were #618's inputs and existed because a skip *was* the
    three of them being quiet. A recompute that runs every cycle, in full, has
    no decision to publish — and three booleans nothing reads would be a page
    explaining a choice nobody makes.
    """
    ran = runtime_view.build_perf(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_RAN))
    failed = runtime_view.build_perf(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_FAILED, error='the store is unwritable'))

    assert set(ran) == {'at', 'verdict', 'error'}
    assert ran['verdict'] == 'ran' and ran['error'] is None
    assert failed['error'] == 'the store is unwritable'
    assert not hasattr(runtime_state, 'PERF_SKIPPED')


def test_the_perf_record_publishes_the_horizon_of_each_account():
    """``/api/runtime`` carries the horizon per account, from process memory.

    A **calendar day**, rendered as one: every other member of this payload is an
    instant, and stamping a day at midnight is how a browser reads the day
    before. ``null`` says nothing constrains the account — it holds nothing whose
    price is still on its way — which is a different statement from the account
    being absent from the list, i.e. not computed by this pass at all.
    """
    rows = runtime_view.build_accounts(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_RAN,
        horizons={'PEA': date(2021, 6, 3), 'CTO': None}))

    assert rows == [{'account': 'CTO', 'horizon': None},
                    {'account': 'PEA', 'horizon': '2021-06-03'}]


def test_no_perf_pass_publishes_no_account_row_at_all():
    """Absence rather than a list of nulls: this pass established nothing, and a
    ``horizon: null`` would be a claim that nothing constrains the account."""
    assert runtime_view.build_accounts(None) == []
    assert runtime_view.build_accounts(runtime_state.PerfRecord(
        at=NOW, verdict=runtime_state.PERF_FAILED, error='boom')) == []


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


def test_the_payload_says_whether_the_reconstruction_still_has_windows():
    """``rebuilding`` (contract #745, issue #763) — the pure half of it.

    ``total > 0 and complete < total``, and the two degenerate readings are the
    point: an install with nothing to reconstruct is ``(0, 0)`` and is **not**
    rebuilding, while a process that cannot see the scheduler passes ``None`` and
    asserts nothing. A boolean has no room for #709's third answer, and what this
    one enables is the *claim* that the TWR's base date is still moving — which
    an observer who cannot see the reconstruction has no ground to make.
    """
    assert runtime_view.is_rebuilding((0, 2)) is True
    assert runtime_view.is_rebuilding((1, 2)) is True
    assert runtime_view.is_rebuilding((2, 2)) is False
    assert runtime_view.is_rebuilding((0, 0)) is False
    assert runtime_view.is_rebuilding(None) is False

    payload = runtime_view.build_runtime(
        shares=[_share()], scrape={}, backfill={}, next_runs={},
        ingest=None, perf=None, now=NOW, reconstruction=(1, 3))

    assert payload['rebuilding'] is True


def test_the_payload_carries_the_mount_observation_verbatim():
    """``store.persistence`` (issue #741, ADR-0015), published by the **same
    path as the rest of the runtime state** and for the same reason
    ``rebuilding`` is here: it is a fact about *this process* — its mount
    namespace — answered from memory with no query, so it survives the one
    failure that empties every other page (a store nobody can open), which is
    exactly when *"where did my data go"* gets asked.

    All three answers reach the front, ``unknown`` included: a payload that only
    carried two would force #724's *store* block to invent the third.

    The **path travels in the same object** since #724, because the block reads
    the two as one line — *the path, and whether it survives* — and both are boot
    knowledge answered with no query."""
    import mounts

    for state in (mounts.EPHEMERAL, mounts.PERSISTENT, mounts.UNKNOWN):
        payload = runtime_view.build_runtime(
            shares=[_share()], scrape={}, backfill={}, next_runs={},
            ingest=None, perf=None, now=NOW, persistence=state,
            store_path='/data/suivi-bourse.duckdb')

        assert payload['store'] == {
            'persistence': state, 'path': '/data/suivi-bourse.duckdb'}


def test_a_runtime_that_named_no_store_publishes_no_path():
    """``path: null`` and never an empty string (issue #724). A runtime built
    with no store — a test harness, a process that failed before it opened one —
    has no path to state, and the block renders the absence rather than a
    plausible-looking ``''`` a reader would take for a root directory."""
    payload = runtime_view.build_runtime(
        shares=[_share()], scrape={}, backfill={}, next_runs={},
        ingest=None, perf=None, now=NOW)

    assert payload['store']['path'] is None


def test_an_unobserved_runtime_defaults_to_unknown_rather_than_kept():
    """The default is not ``persistent``. A test runtime, or the one a
    Docker-less checkout builds, has observed nothing — and a payload saying
    *kept* would be a claim nobody made."""
    import mounts

    payload = runtime_view.build_runtime(
        shares=[_share()], scrape={}, backfill={}, next_runs={},
        ingest=None, perf=None, now=NOW)

    assert payload['store']['persistence'] == mounts.UNKNOWN


# ===================================================================== #
# Health — the fold from N symbols to one word (issue #818, ADR-0036)
# ===================================================================== #

def _health(shares=None, scrape=None, backfill=None, perf=None,
            scheduler_running=True):
    """The body, composed the way :mod:`web.health` composes it."""
    symbols = runtime_view.build_symbols(
        shares=shares if shares is not None else [_share()],
        scrape=scrape or {}, backfill=backfill or {}, next_runs={}, now=NOW,
        scheduler_running=scheduler_running)
    return runtime_view.build_health(
        symbols=symbols, perf=perf, now=NOW,
        scheduler_running=scheduler_running)


def test_the_scrape_verdict_is_the_worst_symbol_and_not_the_commonest():
    """One word for N symbols, and the ranking is :func:`symbol_pill`'s.

    *Broken beats asleep* all the way down, one storey up: a portfolio where
    nine symbols wrote and the tenth persists nothing says ``write_failed``,
    because the reader came to find out whether anything is wrong and a majority
    verdict would answer a question nobody asked.
    """
    body = _health(
        shares=[_share(symbol='AAPL'), _share(symbol='ASML.AS')],
        scrape={'AAPL': _scrape(),
                'ASML.AS': _scrape(symbol='ASML.AS',
                                   verdict=runtime_state.SCRAPE_WRITE_FAILED)})

    assert body['jobs']['scrape']['verdict'] == 'write_failed'
    assert body['jobs']['scrape']['status'] == runtime_view.HEALTH_ATTENTION
    assert body['jobs']['scrape']['attention'] == ['ASML.AS']
    assert body['status'] == runtime_view.HEALTH_ATTENTION


def test_the_scrape_last_pass_is_the_newest_of_them():
    """*Is it still scraping* is the question, so the newest pass answers it.

    A symbol a back-off has parked for four hours would otherwise drag the whole
    job's date back with it and read as a scheduler that stopped — while the
    pill beside it already says what is true of that one symbol.
    """
    body = _health(
        shares=[_share(symbol='AAPL'), _share(symbol='ASML.AS')],
        scrape={'AAPL': _scrape(at=NOW - timedelta(hours=4)),
                'ASML.AS': _scrape(symbol='ASML.AS', at=NOW)})

    assert body['jobs']['scrape']['at'] == NOW.isoformat()


def test_a_sold_line_is_out_of_the_scrape_fold_entirely():
    """It is not polled **by design**, so it is neither well nor unwell.

    Folding it in would answer *"the scheduler has never reached this symbol"*
    about a symbol nothing polls — for the life of the process, and with no
    future event able to clear it. The backfill is where a sold line is still
    read, because that pass is still running on it (#703).
    """
    body = _health(shares=[_share(quantity=0)],
                   scrape={'AAPL': _scrape(stale=True)})

    assert body['jobs']['scrape']['held'] == 0
    assert body['jobs']['scrape']['verdict'] == runtime_view.HEALTH_UNKNOWN
    assert body['jobs']['scrape']['attention'] == []


def test_an_unconvertible_series_is_a_reason_to_look_although_it_is_terminal():
    """The one backfill terminal that asks the owner to do something (#704).

    ``complete`` is a conclusion and this is a fault, which is why
    :func:`build_backfill_summary` refuses to count it as an achievement — and
    why it is a reason to look here rather than a job well done.
    """
    body = _health(backfill={
        ('AAPL', runtime_state.LATERAL): _backfill(
            direction=runtime_state.LATERAL,
            terminal=runtime_state.TERMINAL_UNCONVERTIBLE,
            reason='no exchange rate exists between XYZ and EUR')})

    assert body['jobs']['backfill']['verdict'] == 'unconvertible'
    assert body['jobs']['backfill']['attention'] == ['AAPL']


def test_a_reconstruction_that_reached_its_target_reads_complete():
    """And it carries its two numbers, because *advancing* is not a word."""
    body = _health(backfill={
        ('AAPL', runtime_state.BACKWARD): _backfill(
            target=NOW - timedelta(days=400),
            terminal=runtime_state.TERMINAL_COMPLETE)})

    assert body['jobs']['backfill']['verdict'] == 'complete'
    assert body['jobs']['backfill']['complete'] == 1
    assert body['jobs']['backfill']['in_scope'] == 1
    assert body['jobs']['backfill']['status'] == runtime_view.HEALTH_OK


def test_nothing_observed_is_unknown_the_whole_included():
    """The boot window: nothing is wrong, and nothing is known either.

    Two different sentences, and answering ``ok`` to the second is how a page
    announces a reconstruction that has not started as one that finished. The
    *whole* says it too: ``ok`` claims that everything ran and nothing asks to be
    looked at, and a container a minute old can support neither half of it.
    """
    body = _health()

    assert body['jobs']['scrape']['verdict'] == runtime_view.HEALTH_UNKNOWN
    assert body['jobs']['backfill']['verdict'] == runtime_view.HEALTH_UNKNOWN
    assert body['jobs']['performance'] == {
        'status': runtime_view.HEALTH_UNKNOWN, 'at': None,
        'verdict': runtime_view.HEALTH_UNKNOWN, 'error': None}
    assert body['status'] == runtime_view.HEALTH_UNKNOWN


def test_one_pass_is_enough_for_the_whole_to_leave_unknown():
    """``unknown`` is *nothing has run*, and not *something has not run yet*.

    A scrape that wrote is an observation, so the whole is ``ok`` although the
    backfill and the perf cycle are still ahead of their first pass. The
    stricter reading — the worst of the three — would park a portfolio whose
    lines are all sold on ``unknown`` for the life of the process, since neither
    of those two jobs has anything left to observe there.
    """
    body = _health(scrape={'AAPL': _scrape()})

    assert body['jobs']['scrape']['at'] is not None
    assert body['jobs']['backfill']['status'] == runtime_view.HEALTH_UNKNOWN
    assert body['jobs']['performance']['status'] == runtime_view.HEALTH_UNKNOWN
    assert body['status'] == runtime_view.HEALTH_OK


def test_a_boot_window_with_a_stopped_scheduler_asks_to_be_looked_at():
    """Attention keeps its precedence over the honest silence.

    A worker whose scheduler has stopped will run none of the three jobs ever
    again, so *nothing has been observed* is exactly the wrong word for it: what
    is true is that nothing ever will be.
    """
    body = _health(scheduler_running=False)

    assert [job['at'] for job in body['jobs'].values()] == [None, None, None]
    assert body['status'] == runtime_view.HEALTH_ATTENTION


def test_a_stopped_scheduler_is_a_reason_to_look_however_well_the_jobs_went():
    """It is not merely a fact reported: none of the three will run again.

    The one problem the sidebar's dot could already detect before this body
    existed, and it survives it — here, and never in the status code.
    """
    body = _health(scrape={'AAPL': _scrape()},
                   perf=runtime_state.PerfRecord(
                       at=NOW, verdict=runtime_state.PERF_RAN),
                   scheduler_running=False)

    assert body['jobs']['scrape']['status'] == runtime_view.HEALTH_OK
    assert body['scheduler_running'] is False
    assert body['status'] == runtime_view.HEALTH_ATTENTION
