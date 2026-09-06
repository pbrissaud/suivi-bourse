"""The backfill workload: the past, rebuilt in three directions (issue #848)."""
import logging
import time
from datetime import date, datetime, timezone, timedelta, time as time_of_day
from typing import Dict, List, Optional, Set, Tuple

from application import carrying
from application import fx
from application import market
from application import market_info
from application import quotes
from application import runtime_state
from application import scheduling

app_logger = logging.getLogger("suivi_bourse")

LATERAL_LOOKBACK_DAYS = 10


def span_instants(first: date, last: date) -> Tuple[datetime, datetime]:
    """Two calendar days as the two UTC instants a last-pass record carries."""
    return (datetime.combine(first, time_of_day.min, tzinfo=timezone.utc),
            datetime.combine(last, time_of_day.min, tzinfo=timezone.utc))


class BackfillWorkload:
    """The backfill, whole: its memory, its ladder, and its three passes."""

    def __init__(self, facade, info_cache):
        self.facade = facade
        self.info_cache = info_cache

        self.complete: Dict[str, datetime] = {}

        self.lateral_retry_at: Dict[str, datetime] = {}

        self.quote_currency_unknown: Set[str] = set()

    def fetch_historical_data(self, symbol: str, start: datetime,
                              end: datetime,
                              max_retries: int = 3) -> Optional[List[Dict]]:
        """One symbol's closes over ``[start, end]``, or ``None`` on failure."""
        return market.price_history(symbol, start, end, self.facade.backfill_delay,
                                    max_retries)

    def run(self, now: Optional[datetime] = None):
        """Backfill historical price data, one series per **symbol**, in both directions. This runs as its own scheduled job, progressively filling gaps."""
        now = now or datetime.now(timezone.utc)
        snapshot = self.facade.config_manager.current()
        windows = snapshot.backfill_windows()

        self.facade._collapse_to_ladder(now)

        if not windows:
            app_logger.debug("Nothing was ever held, skipping backfill")
            return

        app_logger.info("Starting backfill cycle")
        backfilled_count = 0

        held = {share['symbol'] for share in snapshot.shares
                if share.get('symbol') and share.get('quantity')}

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

        self.facade.review_installation_facts()

    def backfill_symbol(self, symbol: str,
                        window: Tuple[date, Optional[date]],
                        held: bool, now: datetime) -> Tuple[int, int]:
        """Backfill one symbol over its own holding window (issue #626, #703, #704)."""
        acquired, exited = window
        target, ceiling = carrying.holding_bounds(acquired, exited, now)

        written = 0
        if self.complete.get(symbol) == target:
            app_logger.debug(f"Backfill already complete for {symbol}")
        else:
            written += self.facade._backfill_backward(symbol, target, ceiling, now)

        if held:
            written += self.facade._backfill_forward(symbol, now)

        repaired = self.facade._backfill_lateral(symbol)
        return written, repaired

    def fetch_and_store(self, symbol, start_date, end_date):
        """Fetch one ``[start, end]`` chunk and, if non-empty, write it.

        Four outcomes, and the caller can tell them apart (issue #853):
        ``(None, 0)`` the fetch failed; ``([], 0)`` the window is empty;
        ``(prices, n)`` fetched and ``n`` points written; ``(prices, None)``
        fetched, but the **write failed** — nothing of the window reached the
        store, so the window has not been tried and its anchor must not move.
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
            written = None
            app_logger.error(
                f"Failed to write historical prices for {symbol}: {e}")
        time.sleep(self.facade.backfill_delay)
        return prices, written

    def backward_anchor(self, symbol: str, ceiling: datetime) -> datetime:
        """Where the backward pass resumes from — **the oldest window tried**."""
        return carrying.backward_anchor(
            ceiling,
            quotes.oldest_ts(self.facade.config_manager.store, symbol),
            quotes.oldest_window_tried(self.facade.config_manager.store, symbol))

    def convert_history(self, symbol: str, prices: List[Dict]) -> None:
        """Stamp a fetched chunk with its converted price and rate, in place."""
        if not prices or not self.facade.base_currency:
            return
        currency = market_info.currency_of(self.info_cache.get(symbol))
        if not currency:
            return

        days = [quotes.truncate(point['timestamp']).date() for point in prices]
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

    def backward(self, symbol: str, target: datetime, ceiling: datetime,
                 now: Optional[datetime] = None) -> int:
        """Backward pass: extend the series toward the first acquisition, one chunk (``backfill_chunk_days``) per cycle. Returns points written this cycle."""
        def publish(**fields) -> None:
            self.facade.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol,
                direction=runtime_state.BACKWARD,
                at=datetime.now(timezone.utc),
                target=target, ceiling=ceiling, **fields))

        now = now or datetime.now(timezone.utc)

        oldest_timestamp = quotes.oldest_ts(self.facade.config_manager.store, symbol)
        end_date = self.facade._backward_anchor(symbol, ceiling)

        if carrying.is_terminal(end_date, target):
            app_logger.debug(
                f"Backfill complete for {symbol}: "
                f"anchor={end_date.date()}, target={target.date()}")
            self.complete[symbol] = target
            publish(anchor=end_date, oldest=oldest_timestamp,
                    terminal=runtime_state.TERMINAL_COMPLETE)
            return 0

        start_date = end_date - timedelta(days=self.facade.backfill_chunk_days)

        if start_date < target:
            start_date = target

        start_date = scheduling.clip_to_hourly_ceiling(
            start_date, end_date, now)

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

        if written is None:
            publish(anchor=end_date, oldest=oldest_timestamp,
                    window=(start_date, end_date), failed=True,
                    error=f"the history of {symbol} over "
                          f"{start_date.date()} → {end_date.date()} was fetched "
                          f"but could not be written to the store")
            return 0

        self.facade._record_window_tried(symbol, start_date.date())

        if not prices:
            if start_date <= target:
                app_logger.debug(
                    f"Backfill complete for {symbol}: reached the first "
                    f"acquisition with no earlier trading data")
                self.complete[symbol] = target
                publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                        terminal=runtime_state.TERMINAL_COMPLETE)
                return written
            publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date))
            return written

        publish(anchor=end_date, oldest=oldest_timestamp, window=(start_date, end_date),
                written=written)
        return written

    def collapse_to_ladder(self, now: datetime) -> int:
        """Age the stored series onto the ladder, guarded like every other write."""
        try:
            with self.facade.config_manager.writing() as opened:
                return quotes.collapse_to_ladder(opened, now)
        except Exception as e:
            app_logger.error(f"Failed to age the stored series: {e}")
            return 0

    def record_window_tried(self, symbol: str, oldest: date) -> None:
        """Persist the backward pass's anchor, guarded like every other write."""
        try:
            with self.facade.config_manager.writing() as opened:
                quotes.record_window_tried(opened, symbol, oldest)
        except Exception as e:
            app_logger.error(
                f"Failed to persist the backfill anchor for {symbol}: {e}")

    def forward(self, symbol: str, now: Optional[datetime] = None) -> int:
        """Forward pass: recover a session missed while the app was down by fetching ``[newest, now]`` (issue #627)."""
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
            publish(skipped=(runtime_state.SKIP_NO_SERIES if newest is None
                             else runtime_state.SKIP_TOO_RECENT))
            return 0
        start_date, end_date = window

        app_logger.info(
            f"Forward-filling {symbol}: {start_date.date()} to {end_date.date()}")

        prices, written = self.facade._fetch_and_store(symbol, start_date, end_date)

        if prices is None:
            app_logger.warning(
                f"Failed to fetch forward history for {symbol}, will retry next cycle")
            publish(window=(start_date, end_date), failed=True,
                    error=f"yfinance returned no history for {symbol} over "
                          f"{start_date.date()} → {end_date.date()}")
            return 0

        if written is None:
            publish(window=(start_date, end_date), failed=True,
                    error=f"the history of {symbol} over "
                          f"{start_date.date()} → {end_date.date()} was fetched "
                          f"but could not be written to the store")
            return 0

        if not prices:
            app_logger.debug(
                f"Forward-fill window for {symbol} returned no rows, skipping")

        publish(window=(start_date, end_date), written=written)
        return written

    def learn_quote_currency(self, symbol: str) -> Tuple[Optional[str], bool]:
        """Ask Yahoo what unit a symbol is quoted in. ``(currency, failed)``."""
        if symbol in self.quote_currency_unknown:
            return None, False

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

        self.info_cache.setdefault(symbol, info)
        app_logger.info(f"{symbol} is quoted in {currency}")
        return currency, False

    def lateral(self, symbol: str) -> int:
        """Lateral pass: give the stored points the conversion they lack (#704)."""
        now = datetime.now(timezone.utc)

        def publish(**fields) -> None:
            self.facade.recorder.record_backfill(runtime_state.BackfillRecord(
                symbol=symbol, direction=runtime_state.LATERAL, at=now,
                **fields))

        def back_off() -> None:
            """#617's own formula, and its own base: the wait is a multiple of ``regular_interval``, which is what makes the number in the settings form the number in the formula here too."""
            record = self.facade.recorder.backfill_of(symbol, runtime_state.LATERAL)
            failures = (record.failures if record is not None else 0) + 1
            self.lateral_retry_at[symbol] = now + timedelta(
                seconds=scheduling.backoff_delay(
                    self.facade.regular_interval, failures))

        if not self.facade.base_currency:
            publish(skipped=runtime_state.SKIP_NO_BASE_CURRENCY)
            return 0

        retry_at = self.lateral_retry_at.get(symbol)
        if retry_at is not None and now < retry_at:
            return 0

        store_open = self.facade.config_manager.store
        span = quotes.unconverted_span(store_open, symbol)
        currency = quotes.quote_currency(store_open, symbol)

        if fx.normalise(currency)[0] is None:
            currency = None

        if span is None and currency:
            self.lateral_retry_at.pop(symbol, None)
            publish(skipped=runtime_state.SKIP_NOTHING_TO_REPAIR)
            return 0

        span_window = span_instants(span[0], span[1]) if span else None

        if not currency:
            currency, failed = self.facade._learn_quote_currency(symbol)
            if failed:
                back_off()
                app_logger.warning(
                    f"Could not establish the currency {symbol} is quoted in, "
                    f"will retry")
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
                self.lateral_retry_at.pop(symbol, None)
                app_logger.info(
                    f"Learnt the unit of {symbol}; it had no point left to "
                    f"convert")
                publish(skipped=runtime_state.SKIP_UNIT_LEARNT)
                return 0

        oldest, newest, pending = span

        end = min(newest, oldest + timedelta(days=self.facade.backfill_chunk_days))
        window = span_instants(oldest, end)

        fetch_start = oldest - timedelta(days=LATERAL_LOOKBACK_DAYS)
        fetch_end = end + timedelta(days=1)
        cached = self.facade.rates.answers_from_cache(
            currency, self.facade.base_currency, fetch_start, fetch_end)
        outcome, _ = self.facade.rates.observe(
            currency, self.facade.base_currency, fetch_start, fetch_end)
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
            self.lateral_retry_at.pop(symbol, None)
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
