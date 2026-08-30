"""The backfill workload: the past, rebuilt in three directions (issue #848).

The scrape writes the present, and this file writes everything else. It is the
largest of the five extractions #842 breaks the runtime class into — a third of
that class stood here — and it is one file rather than three because the three
passes share what they remember: the windows already attempted, the units
already learnt, the symbols Yahoo has already been asked about.

*What* each pass may ask for is decided elsewhere and by pure code — the
forward window's sizing and the hourly ceiling are :mod:`scheduling`'s, the
holding bounds and the terminal predicate are :mod:`carrying`'s, the retention
ladder's rungs are :mod:`retention`'s. *What it asks the market* is
:mod:`market`'s, the app's one door to yfinance since #846. *What it writes* is
:mod:`quotes`', the single writer of the market tables (ADR-0006). What is left
— the impure orchestration that calls those in order, one symbol per cycle with
a politeness delay between them — is this file.

Three named entry points, one per direction, and they are independent of one
another by design:

* :meth:`BackfillWorkload.backward` extends a symbol's series toward its first
  acquisition, one chunk per cycle, from the oldest window it has **tried**
  (issue #703) until :func:`carrying.is_terminal` says the window is finished.
  That predicate is where a backfill's terminality is said, and it is said
  there only: the watermark this pass sets and the store-derived answer
  :func:`quotes.terminal_symbols` gives the whole portfolio read one anchor and
  one comparison (issue #706).
* :meth:`BackfillWorkload.forward` recovers a session missed while the app was
  down (issue #627), and no-ops during live trading so the scrape stays the
  sole writer of the present.
* :meth:`BackfillWorkload.lateral` repairs the points that landed with no
  conversion (issue #704) and learns, once per symbol, the unit the live scrape
  never wrote (issue #773, #825). **Its two stopping conditions are told apart
  by the fact that a rate series raises rather than answering empty**: a raise
  is a fetch that did not complete and is retried for ever, an empty answer is
  yfinance saying the pair is not a ticker and is terminal. That distinction is
  structural: :meth:`fx.Rates.observe` hands it to the pass as ``FAILED``
  versus ``UNRESOLVED``, and only because the series fetch under it raises.

:meth:`BackfillWorkload.run` is the cycle the interval job is armed on: the
retention ladder first — a statement over the whole table, so it belongs to the
job that already owns ``price_point`` rather than to a fifth one — then the
three passes over each symbol of the replay's window map.

**The workload calls its collaborators through the façade that carries it**,
for the reason :mod:`scrape` gives at length: several tests replace a method
*on the instance* — the history fetch above all — and a pass holding references
captured at construction would step over the replacement.

What it owns is the memory the three passes share, and what it is **handed** is
the per-symbol ``info`` cache (:mod:`share_info`) the scrape observes into: one
object for the two workloads, so the unit this file learns is the unit that one
reads.
"""
import logging
import time
from datetime import date, datetime, timezone, timedelta, time as time_of_day
from typing import Dict, List, Optional, Set, Tuple

import carrying
import fx
import market
import market_info
import quotes
import runtime_state
import scheduling

#: The application's own logger, by name rather than by import: :mod:`main`
#: builds it (level, handler, formatter) and this module writes to the same
#: object, so a line a backfill cycle emits is the line it always was.
app_logger = logging.getLogger("suivi_bourse")

#: How far **before** the oldest day it has to repair the lateral pass asks the
#: currency pair for (issue #704). The mirror of ``fx``'s own daily lookback, and
#: it earns its place twice: a rate is a market series, so the first day of a
#: chunk may be a Sunday whose rate is Friday's; and an answer that came back
#: empty must mean *this pair is not a ticker* rather than *this window held no
#: trading day*, which is the difference between a terminal and a no-op.
LATERAL_LOOKBACK_DAYS = 10


def span_instants(first: date, last: date) -> Tuple[datetime, datetime]:
    """Two calendar days as the two UTC instants a last-pass record carries.

    ``BackfillRecord.window`` is a pair of *instants* — every other member of
    ``/api/runtime`` is one, and the payload renders them as such. The lateral
    pass walks calendar days, so the conversion happens here, once, rather than
    letting a ``date`` travel into a field whose reader would render it ``null``.
    """
    return (datetime.combine(first, time_of_day.min, tzinfo=timezone.utc),
            datetime.combine(last, time_of_day.min, tzinfo=timezone.utc))


class BackfillWorkload:
    """The backfill, whole: its memory, its ladder, and its three passes.

    ``facade`` is the object that carries the workloads — the store manager, the
    dials, the recorder, the exchange rates — and every collaborator is reached
    through it (see this module's docstring). It is
    :class:`main.SuiviBourseMetrics` today, and #850 owns what it is called.
    ``info_cache`` is handed in and never built here: the scrape observes into
    the same one.
    """

    def __init__(self, facade, info_cache):
        self.facade = facade
        self.info_cache = info_cache

        # Symbols whose backward pass has reached their first acquisition, mapped
        # to that date so an earlier newly-added event re-opens the pass. A
        # process-lifetime shortcut, not the watermark: what survives a restart is
        # ``symbol_quote.oldest_window_tried`` (issue #703).
        self.complete: Dict[str, datetime] = {}

        # The lateral pass's back-off (issue #704): when a symbol whose rate
        # fetch **failed** may be tried again. #617's guard transposed onto a
        # job that is an interval trigger rather than a self-rescheduling one —
        # there is no ``run_date`` to push out, so what is remembered is the
        # instant, and the pass steps over the symbol until it. The counter
        # itself is not copied here (decision 2 of ``runtime_state``): it lives
        # on the last-pass record, folded by the recorder, and one ``get``
        # retrieves it.
        self.lateral_retry_at: Dict[str, datetime] = {}

        # The symbols the lateral pass has asked Yahoo about and got **no
        # currency** for (issue #773). It is what keeps the cost of #773's
        # repair *bounded and per symbol*: a currency that is learnt is written
        # to ``symbol_quote`` and never asked for again — the store answers —
        # while a symbol Yahoo names no currency for has nothing to write, so
        # without this set the pass would re-ask on every cycle, for ever.
        # Process memory rather than a column, and deliberately: the answer is
        # *"Yahoo said nothing this time"*, which a restart is entitled to put
        # again, one request per symbol per process. A `NULL` column already
        # means something else — nobody has asked yet — and a second meaning on
        # it would make the two indistinguishable at the exact moment
        # ``SKIP_NO_QUOTE_CURRENCY`` has to tell them apart.
        self.quote_currency_unknown: Set[str] = set()

    # ------------------------------------------------------------------ #
    # The market edge (issue #846)
    # ------------------------------------------------------------------ #

    def fetch_historical_data(self, symbol: str, start: datetime,
                              end: datetime,
                              max_retries: int = 3) -> Optional[List[Dict]]:
        """One symbol's closes over ``[start, end]``, or ``None`` on failure.

        :func:`market.price_history` with this job's politeness delay, which is
        the unit its rate-limit back-off doubles. ``[]`` is an answer and
        ``None`` is the absence of one — the distinction the backfill's
        back-off reads.
        """
        return market.price_history(symbol, start, end, self.facade.backfill_delay,
                                    max_retries)

    # ------------------------------------------------------------------ #
    # The cycle, and the three passes over one symbol (issue #705)
    # ------------------------------------------------------------------ #

    def run(self, now: Optional[datetime] = None):
        """
        Backfill historical price data, one series per **symbol**, in both
        directions. This runs as its own scheduled job, progressively filling
        gaps.

        **One clock for the whole cycle**, injected the way :mod:`scheduling`
        and :mod:`carrying` take theirs (issue #705). It is #658's rule about
        the snapshot applied to the other input every pass reads: the ladder's
        two walls and each symbol's holding ceiling are answers to *when is it*,
        and read one at a time they can straddle midnight — a symbol banded
        against one day and the next symbol against the following one, on a job
        whose cycle is minutes long at thirty symbols. APScheduler calls it with
        no argument, so the default is the read it replaces; a test passes the
        instant it seeded against.

        The cycle opens with the **retention ladder** — one statement over the
        whole table, ageing every point onto its rung (issue #705, ADR-0010) —
        and it is a step of this job rather than a fifth one because it writes
        ``price_point``, which is the past this job already owns.

        Then, for each symbol, delegates to :meth:`backfill_symbol` which runs
        three independent passes (issues #626, #704):
          * Backward: extend the series toward the first **acquisition**, one
            ``backfill_chunk_days`` chunk per cycle, until ``complete`` is set.
          * Forward: recover a session missed while the app was down by fetching
            ``[newest, now]`` (issue #627) — independent of the backward
            watermark.
          * Lateral: repair the points that landed with no ``price_converted``
            (issue #704) — an ``UPDATE`` on rows that exist, never an
            ``INSERT``, and independent of both the others.
        Fetches one chunk (default: 1 year) of history per direction and rate
        limits between requests.

        **Per symbol and no longer per position** (issue #700). The unit was the
        ``(account, symbol)`` pair because the *series* was, and a price series
        with no account dimension left would have made a share held in three
        accounts fetch the same window from Yahoo three times a cycle — three
        times the rate-limit exposure, on the job that already emits more
        requests than anything else in the app.

        **Driven by the replay and not by current holdings** (issue #703,
        ADR-0009). The symbol set is the union over the whole timeline and each
        symbol carries its own holding window — see
        :meth:`ConfigSnapshot.backfill_windows`. This is where the backfill and
        the scrape stop having the same symbols: the scrape keeps its own set,
        filtered on ``quantity``.

        **The rhythm does not change and there is no accelerated mode.**
        ``backfill_delay`` is a courtesy to Yahoo at the exact moment the app
        emits more requests than at any other time of its life, and a code path
        that runs once per installation is a code path nobody ever tests. One
        chunk per symbol per cycle: ~25 minutes for 30 symbols over 5 years.
        """
        # One snapshot for the whole cycle (issue #658). Shares, events and
        # accounts have to come from the same generation: reading them one call
        # at a time let a mid-cycle reload pair this cycle's shares with the
        # next cycle's events, and — through the old invalidate-then-load pair —
        # with no events at all, which quietly neutralised the backward pass.
        now = now or datetime.now(timezone.utc)
        snapshot = self.facade.config_manager.current()
        windows = snapshot.backfill_windows()

        # The retention ladder, and it runs **before** the window check rather
        # than inside the loop below (issue #705, ADR-0010). Two reasons, and
        # neither is tidiness. Its subject is the *table* and not this cycle's
        # holdings: the rows spec #695 § 10 most insists on keeping — those of a
        # symbol no event names any more — are exactly the ones the loop never
        # visits, and a ladder that skipped them would leave the finest series
        # in the store the one nobody can see. And ``price_point`` carries no
        # index (ADR-0007), so ``WHERE symbol = ?`` is a full scan: one
        # statement partitioned by symbol pays for one scan where N calls pay
        # for N. It belongs to the backfill and never to a fifth job because it
        # **writes ``price_point``**, which is the past this job already owns.
        self.facade._collapse_to_ladder(now)

        if not windows:
            app_logger.debug("Nothing was ever held, skipping backfill")
            return

        app_logger.info("Starting backfill cycle")
        backfilled_count = 0

        # Held **off this cycle's snapshot** and not through the scrape's
        # ``held_symbols``, which would take a second one: shares, events and
        # accounts have to come from the same generation (issue #658), and a
        # reload landing between the two reads would pair one cycle's symbol
        # set with another cycle's holdings. It is the forward pass's gate
        # alone — the backward one runs on a closed position too, because the
        # chart wants the history of a line the owner held.
        held = {share['symbol'] for share in snapshot.shares
                if share.get('symbol') and share.get('quantity')}

        # The two figures are counted apart, and never summed (issue #704): a
        # lateral repair is an ``UPDATE`` of a column on a row that already
        # exists, so counting it as a *data point written* both overstates what
        # was fetched and makes "no new data to write" unreachable for as long
        # as a repair runs — on a cycle that recovered no point at all.
        repaired_count = 0

        for symbol in sorted(windows):
            written, repaired = self.facade._backfill_symbol(
                symbol, windows[symbol], symbol in held, now)
            backfilled_count += written
            repaired_count += repaired

        if backfilled_count > 0 or repaired_count > 0:
            said = []
            if backfilled_count > 0:
                said.append(f"{backfilled_count} data points written")
            if repaired_count > 0:
                said.append(f"{repaired_count} conversions repaired")
            app_logger.info(f"Backfill cycle complete: {', '.join(said)}")
        else:
            app_logger.debug("Backfill cycle complete: no new data to write")

        # The cycle that just moved the reconstruction is the one that
        # re-observes it (issue #709), and it is also where the *event*
        # installation fact is born: the last backward pass reaching its first
        # acquisition is the earliest instant at which every symbol's quote
        # currency has been observed, and therefore the earliest at which the
        # app can say what it assumed of the amounts it imported. The condition
        # is re-tested every cycle rather than latched — the currency may be
        # answered long after the reconstruction ended — and the write is
        # idempotent, so it is produced exactly once.
        self.facade.review_installation_facts()

    def backfill_symbol(self, symbol: str,
                        window: Tuple[date, Optional[date]],
                        held: bool, now: datetime) -> Tuple[int, int]:
        """Backfill one symbol over its own holding window (issue #626, #703, #704).

        The **backward** pass extends the series toward the first acquisition
        and stops once ``complete`` is set; the **forward** pass recovers a
        recent session missed while the app was down; the **lateral** pass gives
        the points already stored the conversion they were written without. The
        three directions are **independent** — a completed backward watermark
        never suppresses the forward pass (issue #627), and neither of them says
        anything about a conversion still missing (issue #704). Returns
        ``(points written, conversions repaired)`` — two figures and not their
        sum, a repaired point being one the store already held.

        ``window`` is ``(first acquisition, last exit or None)``. A ``None`` end
        means *still held*, so the ceiling is **now**; a closed position's
        ceiling is the day after its last sale, since yfinance reads the end of a
        range as exclusive and the price of the day one sells is part of the
        history one held.

        **The two directions part company on a sold position** (issue #699,
        #672 D5). The backward pass keeps running: the chart wants the history
        of a line the user held, and the watermark bounds it, so it finishes and
        stops. The forward pass stops at the same predicate as the scrape — it
        exists to catch a writer up, and that writer has just been removed.
        Left running it would be *worse than useless*: its own no-op guard is
        "the newest point is under a day old", which only the live writer keeps
        true, so the moment the job departs the anchor ages past the guard and
        the pass fetches ``[newest → now]`` from Yahoo **every day, forever**,
        for every symbol the user has ever sold out of.
        """
        acquired, exited = window
        # One definition of the window's two instants, shared with the
        # terminality read (issue #706): the pass that fills the history and the
        # question "is this history finished" must not measure two windows. And
        # ``now`` is the **cycle's**, not a second read of the clock (#705): two
        # symbols banded either side of midnight is one ledger described at two
        # dates.
        target, ceiling = carrying.holding_bounds(acquired, exited, now)

        written = 0
        # Backward pass — skip once complete to avoid refetching the same window
        # every cycle (e.g. a first acquisition on a non-trading day never lets
        # the anchor reach it exactly). This skip must NOT gate the forward pass.
        if self.complete.get(symbol) == target:
            app_logger.debug(f"Backfill already complete for {symbol}")
        else:
            written += self.facade._backfill_backward(symbol, target, ceiling, now)

        # Forward pass — independent of the backward-completion watermark, but
        # not of the holding: there is no live writer to catch up with once the
        # position is sold out.
        if held:
            written += self.facade._backfill_forward(symbol, now)

        # Lateral pass — independent of both, and of the holding too (issue
        # #704). It repairs the conversion of points that already exist, so it
        # is gated by nothing the other two decide: a series can be complete
        # backwards, up to date forwards and entirely unconverted. A sold line
        # is squarely in its subject — its reconstructed history is what the
        # account's returns are computed from, and an unconverted point is a day
        # missing from that computation.
        repaired = self.facade._backfill_lateral(symbol)
        return written, repaired

    # ------------------------------------------------------------------ #
    # What both filling passes share: one chunk, fetched and written
    # ------------------------------------------------------------------ #

    def fetch_and_store(self, symbol, start_date, end_date):
        """Fetch one ``[start, end]`` chunk and, if non-empty, write it.

        The shared tail of both backfill passes (they differ only in window
        sizing and how they treat an empty window). Returns ``(prices, written)``:

          * ``prices is None`` — the fetch failed; the caller logs and retries.
          * ``prices == []`` — an empty window (yfinance returned no rows); the
            caller decides what an empty window means for its direction.
          * otherwise ``prices`` is the fetched rows and ``written`` the count
            persisted.

        The **enrichment is gone with the shape it fed** (issue #700). Every
        chunk used to be walked date by date so each point could be stamped with
        the position held that day, because a price point carried position
        fields; a market observation says nothing about who held what, so the
        write is now the prices and only the prices.

        The **conversion rides along** (issue #702): the pair's daily history is
        fetched beside the price history — one request for the whole chunk,
        because the rates are cached — so every point is converted at the rate of
        its own day. Converting a five-year-old close at today's rate would put a
        currency move into a chart of a share price.

        Rate-limits (``backfill_delay``) after any completed fetch — empty or
        written — but not after a fetch failure.
        """
        prices = self.facade._fetch_historical_data(symbol, start_date, end_date)
        if prices is None:
            return None, 0
        if not prices:
            time.sleep(self.facade.backfill_delay)
            return prices, 0

        self.facade._convert_history(symbol, prices)

        written = 0
        try:
            with self.facade.config_manager.writing() as opened:
                written = quotes.record_history(opened, symbol, prices)
        except Exception as e:
            app_logger.error(
                f"Failed to write historical prices for {symbol}: {e}")
        # Newly filled prices change ``holdings_value`` over that window, and
        # this is where the backfill used to lower a perf watermark so the next
        # recompute would rewrite the tail. It tells the perf job nothing now
        # (issue #707): the next cycle recomputes the whole series from the
        # prices the store holds, this chunk included.
        # Rate limit between symbols
        time.sleep(self.facade.backfill_delay)
        return prices, written

    def backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        """Where the backward pass resumes from — **the oldest window tried**.

        The anchor used to be the oldest *stored* point, and that is a silent
        infinite loop (issue #703, ADR-0009): a delisted symbol stores nothing,
        so the anchor never moves, the stop condition is never reached, and the
        same window is asked of Yahoo every 60 seconds for the life of the
        process. Neither guard that could have caught it does: an empty return is
        classified as a **gap** and not a failure (#606), deliberately, so the
        consecutive-failure counter stays at zero too.

        So the anchor is the oldest window this pass has **attempted**, persisted
        on ``symbol_quote`` (spec #695 § 4's one named exception to *watermarks
        stay derived* — the argument for deriving is "it recomputes itself from
        the rows", which is exactly what a symbol with no rows cannot do).

        The **minimum** of three, so it can only ever move backwards:

        * the holding window's ``ceiling`` — where a symbol with nothing stored
          and nothing tried starts, which for a closed position is its last exit
          and not today;
        * the oldest stored point, which keeps the pass working **strictly
          before** the series it already has. That is half of the geometry
          ``price_point`` has instead of a uniqueness constraint (ADR-0007), and
          it is also what makes an install that predates this anchor resume
          where its data ends rather than re-fetching from the ceiling;
        * the oldest window tried, which is the only one that moves on a symbol
          Yahoo answers nothing about.

        The minimum itself is :func:`carrying.backward_anchor` since #706, so
        this pass and the terminality question :func:`quotes.terminal_symbols`
        puts to the whole portfolio compute one anchor and not two. What stays
        here is the *reading* of the three inputs, one symbol at a time — which
        is affordable on a job that visits one symbol per cycle with a rate-limit
        sleep between them, and is exactly what that batched read exists to avoid
        doing per request.
        """
        return carrying.backward_anchor(
            ceiling,
            quotes.oldest_ts(self.facade.config_manager.store, symbol),
            quotes.oldest_window_tried(self.facade.config_manager.store, symbol))

    def convert_history(self, symbol: str, prices: List[Dict]) -> None:
        """Stamp a fetched chunk with its converted price and rate, in place.

        One prefetch of the pair over the chunk's own span — :meth:`fx.Rates.series`
        caches it, so the per-point :meth:`fx.Rates.rate` calls that follow are
        dictionary lookups — then one conversion per point at the rate of **its**
        day.

        The symbol's currency is read from ``info_cache`` rather than
        fetched **here**, and the argument is per chunk: a second ``.info`` call
        on this path would double the rate-limit exposure of the job that already
        emits the most requests in the app, for a fact that changes once in a
        symbol's life. The sentence that used to justify it — *the backfill runs
        on symbols the scrape has already met* — was true before #703 and false
        after it (ADR-0009), and a symbol absent from the cache therefore leaves
        its conversion ``NULL``. What repairs that is #704's lateral pass, which
        since #773 **learns the currency itself**, once per symbol, and fills
        this cache on its way — so the chunks fetched after it are converted at
        write time and the pass has less to repair on every following cycle.

        Nothing is raised: a chunk that cannot be converted is still a chunk of
        prices, and losing it over a currency is the one outcome ADR-0002 rules
        out.
        """
        if not prices or not self.facade.base_currency:
            return
        currency = market_info.currency_of(self.info_cache.get(symbol))
        if not currency:
            return

        days = [point['timestamp'].date() for point in prices]
        try:
            self.facade.rates.series(currency, self.facade.base_currency,
                                     min(days), max(days))
        except Exception as e:
            app_logger.warning(
                f"Could not prefetch the rates for {symbol}: {e}")

        for point, day in zip(prices, days):
            converted, rate = self.facade._convert(point.get('price'), currency, day)
            point['converted'] = converted
            point['rate'] = rate

    # ------------------------------------------------------------------ #
    # The backward pass — entry point (issue #626, #703, #706)
    # ------------------------------------------------------------------ #

    def backward(self, symbol: str, target: datetime, ceiling: datetime,
                 now: Optional[datetime] = None) -> int:
        """Backward pass: extend the series toward the first acquisition, one chunk
        (``backfill_chunk_days``) per cycle. Returns points written this cycle.

        ``target`` is the first acquisition — ``BUY`` **or ``GRANT``**, since a
        granted share is held from the day it lands — and ``ceiling`` the top of
        the holding window. Between them the pass walks backwards one chunk at a
        time from :meth:`backward_anchor`.

        ``now`` is the **cycle's**, and it is not the ceiling: a sold position's
        ceiling is the day after its last sale, while Yahoo's hourly ceiling is
        measured from today whatever the position did (issue #783). Defaulted to
        a read of the product's clock so a caller that has none — a test, never
        the job — still gets the read it replaces.

        Every exit publishes a last-pass record (issue #668). That is the whole
        answer to #656's driving question: this method used to log a warning and
        return ``0`` on failure, which is indistinguishable from the ``0`` a
        healthy weekend returns — so nothing anywhere told "pacing normally"
        apart from "wedged on yfinance". The record carries the window it
        attempted, the **three** dates the progress bar is drawn from — target,
        ceiling and oldest — and, through the recorder's fold, how many
        consecutive cycles have now failed. The ceiling is on the record for the
        same reason the target is: the bar measures ``[target, ceiling]``, and a
        reader given only two of the three would divide by the wrong span on
        every sold line.
        """
        def publish(**fields) -> None:
            self.facade.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol,
                direction=runtime_state.BACKWARD,
                at=datetime.now(timezone.utc),
                target=target, ceiling=ceiling, **fields))

        now = now or datetime.now(timezone.utc)

        # The oldest stored point — reported, not decided upon: it is what the
        # progress bar is drawn from, while the resume point is the anchor below.
        oldest_timestamp = quotes.oldest_ts(self.facade.config_manager.store, symbol)
        end_date = self.facade._backward_anchor(symbol, ceiling)

        # Compare at day granularity to avoid chasing tiny windows — and through
        # :func:`carrying.is_terminal`, which is the same predicate the carrying
        # convention's second term reads (issue #706). The watermark this branch
        # sets and the store-derived answer that convention takes must not be two
        # different notions of "finished".
        if carrying.is_terminal(end_date, target):
            app_logger.debug(
                f"Backfill complete for {symbol}: "
                f"anchor={end_date.date()}, target={target.date()}")
            self.complete[symbol] = target
            publish(anchor=end_date, oldest=oldest_timestamp,
                    terminal=runtime_state.TERMINAL_COMPLETE)
            return 0

        # Calculate the chunk to fetch (going backwards in time)
        start_date = end_date - timedelta(days=self.facade.backfill_chunk_days)

        # Don't go before the first acquisition
        if start_date < target:
            start_date = target

        # **Cut the chunk on Yahoo's hourly ceiling** (issue #783). The interval
        # is chosen from the window's oldest day, so a chunk with one foot either
        # side of the ceiling is bought entirely in daily bars — and the default
        # chunk on an anchor that starts at today straddles it by a single day,
        # which is how ADR-0010's whole hourly band came back daily. Cutting here
        # costs no request (one chunk per cycle either way) and one more cycle
        # for the symbol; the remainder is what the next cycle asks for, from the
        # ceiling, in daily bars.
        #
        # It only ever raises ``start_date``, which is what keeps the anchor
        # persisted below moving backwards only (issue #703) and keeps this
        # branch out of the terminal's way: a cut window **starts** strictly after
        # the target, so it can neither reach it nor conclude the pass early.
        #
        # **And it repairs nothing already stored.** The ladder is a ceiling and
        # never a floor (ADR-0010): a day that landed daily stays daily, and past
        # the ceiling the hour is not sold any more — so this is worth exactly
        # the reconstructions still to come.
        start_date = scheduling.clip_to_hourly_ceiling(
            start_date, end_date, now)

        # Skip if window is less than 1 day (avoids useless requests outside market hours)
        if (end_date - start_date).days < 1:
            app_logger.debug(
                f"Backfill window too small for {symbol}, skipping until next cycle")
            publish(anchor=end_date, oldest=oldest_timestamp,
                    skipped=runtime_state.SKIP_WINDOW_TOO_SMALL)
            return 0

        app_logger.info(
            f"Backfilling {symbol}: {start_date.date()} to {end_date.date()}")

        prices, written = self.facade._fetch_and_store(symbol, start_date, end_date)

        if prices is None:
            app_logger.warning(f"Failed to fetch history for {symbol}, will retry next cycle")
            publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                    failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        # The fetch completed — empty or not — so this window has been tried and
        # the anchor moves. Only here: a *failed* fetch has attempted nothing the
        # app is entitled to skip, and persisting it would let one Yahoo hiccup
        # erase a year of history the pass will never come back to.
        self.facade._record_window_tried(symbol, start_date.date())

        if not prices:
            # Empty window: the fetch succeeded but returned no rows. If we
            # have already reached the first acquisition there is no earlier
            # trading data (e.g. it fell on a weekend/holiday), so mark the
            # symbol complete to avoid refetching this window forever.
            if start_date <= target:
                app_logger.debug(
                    f"Backfill complete for {symbol}: reached the first "
                    f"acquisition with no earlier trading data")
                self.complete[symbol] = target
                publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                        terminal=runtime_state.TERMINAL_COMPLETE)
                return written
            # An empty window that has *not* reached the target is a gap
            # classifying itself (#606) — a weekend, a holiday. Emphatically not
            # a failure: counting it would make every Monday morning read as
            # wedged, which is the exact misreading the counter exists to prevent.
            # A mute symbol lands here every cycle, and what stops it is the
            # anchor just persisted, never the counter.
            publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date))
            return written

        publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                written=written)
        return written

    # ------------------------------------------------------------------ #
    # The retention ladder's application (issue #705, ADR-0010)
    # ------------------------------------------------------------------ #

    def collapse_to_ladder(self, now: datetime) -> int:
        """Age the stored series onto the ladder, guarded like every other write.

        The impure half of ADR-0010: the rungs and the walls are
        :mod:`retention`'s, the statement is :func:`quotes.collapse_to_ladder`'s,
        and what is decided here is only *when* and *how loudly*.

        **A store that refuses this must not abort the cycle.** Nothing depends
        on it: the ladder removes points and never writes one, so a failed pass
        costs a series that stays finer than it should until the next cycle —
        which is sixty seconds away and will designate exactly the same rows,
        the operation carrying no watermark.

        **And it is logged at DEBUG, not INFO.** In steady state a cycle ages
        the handful of points that crossed a wall in the last sixty seconds —
        during the session hours of the day a year ago, that is one or two
        points, every cycle, all day. Said at INFO it would be the loudest line
        in the log and would say nothing: the wall produces no wrong figure and
        no news, only fewer points, which is the same reason it is not marked on
        screen either.
        """
        try:
            with self.facade.config_manager.writing() as opened:
                return quotes.collapse_to_ladder(opened, now)
        except Exception as e:
            app_logger.error(f"Failed to age the stored series: {e}")
            return 0

    def record_window_tried(self, symbol: str, oldest: date) -> None:
        """Persist the backward pass's anchor, guarded like every other write.

        A store that refuses this must not abort the cycle: the points of the
        chunk are already in, and the only cost of losing the anchor is one
        re-fetched window next cycle.
        """
        try:
            with self.facade.config_manager.writing() as opened:
                quotes.record_window_tried(opened, symbol, oldest)
        except Exception as e:
            app_logger.error(
                f"Failed to persist the backfill anchor for {symbol}: {e}")

    # ------------------------------------------------------------------ #
    # The forward pass — entry point (issue #627)
    # ------------------------------------------------------------------ #

    def forward(self, symbol: str, now: Optional[datetime] = None) -> int:
        """Forward pass: recover a session missed while the app was down by
        fetching ``[newest, now]`` (issue #627).

        Window sizing is delegated to the pure
        ``scheduling.forward_backfill_window`` and gap classification to yfinance
        — an empty window (weekend/holiday, or already covered) writes nothing.
        The pure ``< 1 day`` guard makes this **no-op during live trading**
        (newest ≈ now → sub-day window → skip), so the live ``REGULAR`` writer
        stays the sole writer of the present with no duplicate at the seam.
        Returns points written this cycle.

        ``now`` is the **cycle's**, like the backward pass's (issue #783). It
        used to be a second read of the clock taken here, which was harmless
        while the window only ever ended at the present and stopped being so the
        moment that window is cut on an age: two symbols of one cycle would then
        be cut against two ceilings, and neither against the one the cycle says
        it is running at.
        """
        now = now or datetime.now(timezone.utc)
        newest = quotes.newest_ts(self.facade.config_manager.store, symbol)

        def publish(**fields) -> None:
            self.facade.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol,
                direction=runtime_state.FORWARD,
                at=datetime.now(timezone.utc),
                newest=newest, **fields))

        window = scheduling.forward_backfill_window(
            newest, now, self.facade.backfill_chunk_days)
        if window is None:
            # The two no-ops the pure window sizing returns, told apart because
            # they mean opposite things: an empty series is waiting on the
            # *backward* pass to seed it, while `too_recent` is the healthy
            # steady state during live trading — `newest ≈ now`, so this pass
            # stands aside and the REGULAR writer stays the sole writer of the
            # present. Collapsing them would make a perfectly well portfolio and
            # an unseeded one read the same.
            publish(skipped=(runtime_state.SKIP_NO_SERIES if newest is None
                             else runtime_state.SKIP_TOO_RECENT))
            return 0
        start_date, end_date = window

        app_logger.info(
            f"Forward-filling {symbol}: {start_date.date()} to {end_date.date()}")

        # Same granularity/chunking as the backward pass: 1h within 730d, 1d beyond.
        prices, written = self.facade._fetch_and_store(symbol, start_date, end_date)

        if prices is None:
            app_logger.warning(
                f"Failed to fetch forward history for {symbol}, will retry next cycle")
            publish(window=(start_date, end_date), failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        if not prices:
            # Empty window: yfinance returned no rows — a weekend/holiday gap or
            # an already-covered range. Self-classifying no-op, nothing written.
            app_logger.debug(
                f"Forward-fill window for {symbol} returned no rows, skipping")

        publish(window=(start_date, end_date), written=written)
        return written

    # ------------------------------------------------------------------ #
    # The lateral pass — entry point below, its unit lookup first (#704)
    # ------------------------------------------------------------------ #

    def learn_quote_currency(self, symbol: str) -> Tuple[Optional[str], bool]:
        """Ask Yahoo what unit a symbol is quoted in. ``(currency, failed)``.

        **The exit #773 chose, and the argument is one of place**: the lateral
        pass is what *knows* the currency is missing, it already owns a back-off
        (#617), the backfill's politeness delay and a last-pass record, and the
        cost lands on the one job whose rhythm is designed for it. The other two
        exits were refused where they stood. Asking from the **backfill's
        conversion** step contradicts ``convert_history``'s own argument head on
        — a second ``.info`` per *chunk* doubles the rate-limit exposure of the
        job that already emits the most requests in the app — and the need is per
        **symbol**, once. The third exit was worse still and has since ceased to
        exist: widening the pool sizing's *pre-scheduler capture* to the replay's
        symbol set would have put the fetch in :func:`start_runtime`, where the
        whole boot blocked on it before the socket was bound — and #851 removed
        that fetch altogether rather than hang anything else off it
        (:meth:`scrape.ScrapeWorkload.read_exchange_of`).

        The defect it repairs is dated. ``convert_history`` deferred to the
        lateral pass *naming exactly this case*, and the lateral pass named it and
        stood down — because :func:`quotes.quote_currency`'s ``None`` was written
        for a symbol Yahoo says nothing about. ADR-0009 made the backfill's set
        the union over the **whole** timeline while the paths that can learn a
        currency (:meth:`scrape.ScrapeWorkload.scrape_symbol`, and the
        ``info_cache`` its fetch fills — the pre-scheduler capture was a third
        until #851 removed it) stayed bounded by the held lines, so a position
        sold before the install existed got years of reconstructed prices and
        no unit for any of them: `no_quote_currency` was the one lateral
        condition with **no exit**.

        Three answers, and the middle one is why this is not a bare
        ``Optional[str]``:

        * ``(currency, False)`` — learnt, and written to ``symbol_quote`` before
          it is returned. The store is what the next cycle reads, so the request
          is emitted **once for the life of the install** and not once a cycle.
        * ``(None, False)`` — the request completed and named no currency. That
          is a *reply*, it is remembered in ``quote_currency_unknown`` so it is
          not put again, and it is what ``SKIP_NO_QUOTE_CURRENCY`` keeps as its
          subject: nothing is concluded about a pair, because there is still no
          pair.
        * ``(None, True)`` — the request did not complete, or the write did not.
          Nothing was learnt, so nothing may be concluded: the caller backs off
          exactly as it does for a rate fetch that failed, and retries for ever.

        The politeness delay is paid after a fetch that **completed**, which is
        ``fetch_and_store``'s rule rather than a second one — and never after one
        that failed.
        """
        if symbol in self.quote_currency_unknown:
            return None, False

        # ``None`` is the request that did not complete, and it is the one
        # answer this method may not confuse with a reply — :mod:`market` keeps
        # the two apart for exactly this call site. What a payload naming no
        # currency answers is ``None`` too, and it always did: the translation
        # used to remove a sentinel here, and since #845 there is none to
        # remove — the fetch does not make one.
        info = market.symbol_attributes(symbol)
        if info is None:
            return None, True

        currency = market_info.currency_of(info)
        time.sleep(self.facade.backfill_delay)

        if not currency:
            self.quote_currency_unknown.add(symbol)
            app_logger.info(
                f"Yahoo names no quote currency for {symbol}; its stored prices "
                f"stay unconverted")
            return None, False

        try:
            with self.facade.config_manager.writing() as opened:
                quotes.record_attributes(
                    opened, symbol, datetime.now(timezone.utc),
                    market_info.quote_columns(info))
        except Exception as e:
            app_logger.error(
                f"Failed to record the attributes of {symbol}: {e}")
            return None, True

        # And into the cache the *rebuild* reads, which is the second half of the
        # repair rather than a convenience: the backward pass goes on fetching
        # chunks of this symbol, and ``convert_history`` converting them at write
        # time leaves the lateral pass with less to repair on every cycle that
        # follows. *Learnt* and not *observed* (issue #847): the gesture is a
        # ``setdefault``, so a live fetch's fuller entry — market state, trading
        # period — is never overwritten by this poorer one.
        self.info_cache.learned(symbol, info)
        app_logger.info(f"{symbol} is quoted in {currency}")
        return currency, False

    def lateral(self, symbol: str) -> int:
        """Lateral pass: give the stored points the conversion they lack (#704).

        It works on **the same rows as the other two, short of a column** — an
        ``UPDATE``, never an ``INSERT`` — and that is what makes #702's decision
        viable at all: a rate that could not be had writes the point with
        ``price_converted NULL`` instead of losing the quote, and Yahoo gives
        nothing back under the hour past sixty days, so a lost quote is lost for
        good while a missing conversion is repairable for ever. Without this pass
        the ``NULL`` would be a permanent absence every reader had to work
        around, and ``latest`` would have to become *the most recent **complete**
        point* — the per-field last-non-null row the store exists to avoid.

        It rides on the backfill rather than owning a job: the rhythm, the
        politeness delay and the chunk are the backfill's, and its last-pass
        record is one more **direction** on the same recorder.

        **Two stopping conditions, and they never collapse into each other.**
        That is the ticket:

        * a **fetch that did not complete** is a failure. It follows #617's
          back-off — the first :data:`scheduling.FAILURE_GRACE` at the base
          interval, then ``base × 2^(n − 3)`` capped at 24 h, reset to zero by
          the first conversion that lands — and it retries **indefinitely**.
          Nothing was learnt about the pair, so nothing may be concluded about
          it.
        * a **pair that does not resolve** is a *reply*: yfinance completed the
          request and ``XYZEUR=X`` is not a ticker. It arms the
          :data:`runtime_state.TERMINAL_UNCONVERTIBLE` terminal and names the
          pair, because *"waiting for a conversion"* and *"will never convert"*
          are two different sentences and only the second asks the owner to act.

        **And an unanswered reporting currency arms neither.** It is the trap
        the ticket writes in black and white: that absence is transitory and
        lifted by a write of the owner's, so reading it as an unresolvable pair
        would make answering the dial change nothing for the entire stock already
        scraped — the one gesture the whole feature exists to honour. The pass
        stands down on :data:`runtime_state.SKIP_NO_BASE_CURRENCY` before it
        looks at anything else.

        The **security's** own currency is the second thing that can be missing,
        and since #773 the pass **asks for it** instead of only naming its
        absence. Standing down there was right about a symbol Yahoo says nothing
        about and wrong about the one it was actually meeting: a line sold before
        this install existed is never polled by the live scrape (#699) and is
        fully in the backfill's set (ADR-0009), so it collected years of
        reconstructed prices in a unit nothing could learn — the one lateral
        condition with no exit, and a whole account reading −99,98 % underneath
        it. :meth:`learn_quote_currency` is that exit, one request per symbol
        and once. :data:`runtime_state.SKIP_NO_QUOTE_CURRENCY` keeps the case the
        sentence was aimed at: the request came back naming no currency.

        **And the gate that lets it be reached is the pass's own subject** (issue
        #825). *A point with no conversion* was the one trigger, which made a
        symptom the condition of a repair: a symbol quoted in the **reporting**
        currency has nothing to convert — its points land at 1,0 off the memory
        cache — so the pass declared ``nothing_to_repair`` and left the unit
        unlearnt for as long as its market stayed shut. The trigger is now *a
        point with no conversion **or** a symbol with no unit*, and the three
        guards that bound the cost — the back-off above, the memory of the
        symbols Yahoo named nothing for, and the fact that a learnt unit is
        written to the store — are what keep the widening one request per symbol
        for the life of the install rather than one per cycle.

        Returns the number of points repaired this cycle.
        """
        now = datetime.now(timezone.utc)

        def publish(**fields) -> None:
            self.facade.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol, direction=runtime_state.LATERAL, at=now,
                **fields))

        def back_off() -> None:
            """#617's own formula, and its own base: the wait is a multiple of
            ``regular_interval``, which is what makes the number in the settings
            form the number in the formula here too. Read **before** the record
            of this cycle is published, so the fold counts this failure once."""
            record = self.facade.recorder.backfill_of(symbol, runtime_state.LATERAL)
            failures = (record.failures if record is not None else 0) + 1
            self.lateral_retry_at[symbol] = now + timedelta(
                seconds=scheduling.backoff_delay(
                    self.facade.regular_interval, failures))

        if not self.facade.base_currency:
            publish(skipped=runtime_state.SKIP_NO_BASE_CURRENCY)
            return 0

        # The back-off, and the one place it is honoured. Publishing nothing
        # while it holds is deliberate: a record with ``failed=False`` would
        # reset the recorder's fold and flatten the delay back to the base
        # interval on the very next cycle, while one with ``failed=True`` would
        # count a cycle nobody attempted. The previous record stands, which is
        # the honest reading — the last pass *is* still the last pass.
        retry_at = self.lateral_retry_at.get(symbol)
        if retry_at is not None and now < retry_at:
            return 0

        store_open = self.facade.config_manager.store
        span = quotes.unconverted_span(store_open, symbol)
        currency = quotes.quote_currency(store_open, symbol)

        # **A unit that cannot name a pair is not a unit** (issue #845). The
        # column is text and a store written before that ticket can hold the
        # word the fetch used to fabricate — a *truthy* string, so
        # every gate below read it as a currency and the line stayed *waiting
        # for a rate* for the life of the install, with nothing left to ask.
        # Widening the predicate rather than migrating the column is the repair
        # (ADR-0007's rule met from the other side: the DDL carries no migration
        # machinery): the pass goes and **learns the real unit**, writes it, and
        # the condition empties itself as the rows go through it.
        if fx.normalise(currency)[0] is None:
            currency = None

        # **The gate is double, and issue #825 is the second half of it.** It
        # read *"are there points without a conversion"* alone, which was a
        # symptom standing in for the subject: the pass repairs what is
        # *missing*, and a missing unit is one of the two things it can repair.
        # The two came apart on the case nobody had met — a symbol quoted in the
        # **reporting** currency, first seen with its market shut. The fetch
        # succeeds market shut and leaves the unit in ``info_cache``, so
        # ``convert_history`` converts the rebuilt points at 1,0 and every one
        # of them carries its conversion; the live scrape's gate (*not closed and
        # a price*) writes nothing, so nothing records the attributes; and this
        # pass stood down on ``nothing_to_repair`` **before** the branch below,
        # which is the only other writer of the unit. The cache dies with the
        # process, ``symbol_quote`` stays bare, and *a quote is a number and a
        # unit* (#774) renders the whole line carried at its cost until the
        # market reopens — a whole weekend, with ``/health`` saying ``ok``.
        # In a foreign currency the points stay unconverted, so the old gate saw
        # them and the repair happened: it is exactly the pair *quote currency =
        # reporting currency* that fell between the two.
        if span is None and currency:
            # The steady state, and the one that clears the back-off: every
            # point carries its conversion, and the unit they are in is known.
            self.lateral_retry_at.pop(symbol, None)
            publish(skipped=runtime_state.SKIP_NOTHING_TO_REPAIR)
            return 0

        # ``None`` when the unit alone is what is missing: there is no span to
        # report, and a window invented for the record would date a repair
        # nobody made.
        span_window = span_instants(span[0], span[1]) if span else None

        if not currency:
            # Nobody has asked yet — the live scrape never met this symbol
            # (issue #773), or met it with the market shut (issue #825). The
            # pass that knows the unit is missing is the one that asks for it,
            # once, and writes the answer where the store can give it back.
            currency, failed = self.facade._learn_quote_currency(symbol)
            if failed:
                back_off()
                app_logger.warning(
                    f"Could not establish the currency {symbol} is quoted in, "
                    f"will retry")
                # The consequence is named only when there is one: with no span
                # to repair, promising a number of points that cannot be
                # converted would count rows this pass never had.
                consequence = (
                    f", so its {span[2]} stored price(s) cannot be converted "
                    f"yet" if span else "")
                publish(window=span_window, failed=True,
                        error=f"the currency {symbol} is quoted in could not "
                              f"be established{consequence}")
                return 0
            if not currency:
                publish(window=span_window,
                        skipped=runtime_state.SKIP_NO_QUOTE_CURRENCY)
                return 0
            if span is None:
                # The unit was the whole of the work, and it landed: the symbol
                # is **quoted** from here on rather than carried at its cost, and
                # the pass says so in its own word rather than borrowing the
                # steady state's (issue #825). A success, so the back-off clears
                # exactly as it does for a conversion that lands.
                self.lateral_retry_at.pop(symbol, None)
                app_logger.info(
                    f"Learnt the unit of {symbol}; it had no point left to "
                    f"convert")
                publish(skipped=runtime_state.SKIP_UNIT_LEARNT)
                return 0

        oldest, newest, pending = span

        # One chunk per cycle, from the **oldest** unconverted day, exactly as
        # the backward pass walks one chunk per cycle from its anchor.
        end = min(newest, oldest + timedelta(days=self.facade.backfill_chunk_days))
        window = span_instants(oldest, end)

        fetch_start = oldest - timedelta(days=LATERAL_LOOKBACK_DAYS)
        fetch_end = end + timedelta(days=1)
        # Asked **before** the fetch, because afterwards the window is cached
        # either way and the question can no longer be put.
        cached = self.facade.rates.answers_from_cache(
            currency, self.facade.base_currency, fetch_start, fetch_end)
        outcome, _ = self.facade.rates.observe(
            currency, self.facade.base_currency, fetch_start, fetch_end)
        # The backfill's politeness, and it is ``fetch_and_store``'s rule
        # rather than a second one: rate-limit after a fetch that **completed**,
        # never after one that failed — and never at all when nothing was asked.
        # That last clause is the one that matters here, because it is
        # permanent: a symbol whose pair does not resolve, or whose oldest
        # unconverted day the pair has no rate for, answers off the cache every
        # cycle for the life of the process. Slept through unconditionally,
        # three such symbols spend half of every default cycle waiting for a
        # request nobody emitted.
        if not cached and outcome != fx.FAILED:
            time.sleep(self.facade.backfill_delay)

        if outcome == fx.FAILED:
            back_off()
            app_logger.warning(
                f"Could not fetch the rates to convert {symbol}, will retry")
            publish(window=window, failed=True,
                    error=f"the {currency}→{self.facade.base_currency} rates for "
                          f"{oldest} → {end} could not be fetched")
            return 0

        if outcome == fx.UNRESOLVED:
            # A reply, not a failure: the counter is reset rather than raised,
            # and no retry is scheduled because there is nothing to retry.
            self.lateral_retry_at.pop(symbol, None)
            # Normalised, and with no fallback to the raw column: ``observe``
            # answers ``UNRESOLVED`` only once both codes are ones, so there is
            # a code here by construction (#845).
            pair = fx.pair_symbol(
                fx.normalise(currency)[0], self.facade.base_currency)
            app_logger.warning(
                f"{symbol} cannot be converted: no {pair} rate exists "
                f"({pending} price(s) will stay unconverted)")
            publish(window=window,
                    terminal=runtime_state.TERMINAL_UNCONVERTIBLE,
                    reason=f"no exchange rate exists between {currency} and "
                           f"{self.facade.base_currency} ({pair}), so {pending} stored "
                           f"price(s) of {symbol} cannot be converted")
            return 0

        # Resolved: one factor per day that actually carries a point to repair —
        # the rate of **its own day**, forward-filled inside the window that was
        # just fetched, exactly as a rebuilt chunk is converted. A day the pair
        # has no rate for at all keeps its ``NULL`` and comes back next cycle;
        # the window is cached by then, so no request is emitted for it.
        days = quotes.unconverted_days(store_open, symbol, oldest, end)
        factors = {}
        for day in days:
            factor = self.facade.rates.rate(currency, self.facade.base_currency, day)
            if factor is not None:
                factors[day] = factor

        self.lateral_retry_at.pop(symbol, None)
        repaired = 0
        try:
            with self.facade.config_manager.writing() as opened:
                repaired = quotes.repair_conversions(opened, symbol, factors)
        except Exception as e:
            app_logger.error(
                f"Failed to repair the conversions of {symbol}: {e}")
        if repaired:
            app_logger.info(
                f"Converted {repaired} stored price(s) of {symbol} "
                f"({oldest} → {end})")
        publish(window=window, written=repaired)
        return repaired
