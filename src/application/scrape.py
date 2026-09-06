"""The scrape workload: one self-rescheduling job per held symbol (issue #847)."""
import logging
import random
import threading
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional, Tuple

from application import market
from application import market_info
from application import quotes
from application import runtime_state
from application import scheduling

app_logger = logging.getLogger("suivi_bourse")


SCRAPE_JOB_PREFIX = 'scrape:'


def _scrape_job_id(symbol: str) -> str:
    return f'{SCRAPE_JOB_PREFIX}{symbol}'


def scrape_next_runs(scheduler) -> Dict[str, Optional[datetime]]:
    """``symbol -> next_run_time`` for the live per-symbol scrape jobs."""
    if scheduler is None:
        return {}
    runs = {}
    for job in (scheduler.get_jobs() or []):
        job_id = getattr(job, 'id', '') or ''
        if job_id.startswith(SCRAPE_JOB_PREFIX):
            runs[job_id[len(SCRAPE_JOB_PREFIX):]] = getattr(
                job, 'next_run_time', None)
    return runs


def scrape_verdict(should_write: bool, state, wrote: bool,
                   has_holdings: bool) -> str:
    """Name what one scrape pass did, at the instant it did it (issue #668)."""
    if scheduling.is_closed(state):
        return runtime_state.SCRAPE_CLOSED
    if not should_write:
        return runtime_state.SCRAPE_NO_PRICE
    if wrote or not has_holdings:
        return runtime_state.SCRAPE_WROTE
    return runtime_state.SCRAPE_WRITE_FAILED


class ScrapeWorkload:
    """The scrape, whole: its state, its jobs, and the pass they run."""

    def __init__(self, facade, info_cache):
        self.facade = facade
        self.info_cache = info_cache

        self.failure_counts: Dict[str, int] = {}
        self.failure_counts_lock = threading.Lock()

        self.sonde_lock = threading.Lock()
        self.sonde_state: Dict[str, scheduling.SondeState] = {}

    def fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        """One symbol's newest close and its attributes, and the cache's fill."""
        last_quote, info = market.latest_quote(symbol, max_retries)
        if info is not None:
            self.info_cache[symbol] = info
        return last_quote, info

    def write_quote(self, symbol: str, last_quote, info, now: datetime,
                    converted=None, fx_rate=None) -> bool:
        """Persist one live observation: ``symbol_quote`` + one ``price_point``."""
        try:
            with self.facade.config_manager.writing() as opened:
                quotes.record_quote(opened, symbol, now, last_quote,
                                    market_info.quote_columns(info),
                                    converted, fx_rate)
            return True
        except Exception as e:
            app_logger.error(f"Failed to write the quote for {symbol}: {e}")
            return False

    def scrape_held(self):
        """Fetch and store every held symbol's quote, once."""
        shares = self.facade.shares
        held = sorted({share['symbol'] for share in shares
                       if share.get('symbol') and share.get('quantity')})
        for symbol in held:
            last_quote, info = self.facade._fetch_ticker_data(symbol)
            converted, rate = self.facade._convert(
                last_quote, market_info.currency_of(info))

            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {symbol}, skipping the quote write")
            else:
                self.facade._write_quote(symbol, last_quote, info,
                                         datetime.now(timezone.utc),
                                         converted, rate)

    def scrape(self):
        """Scrape stock prices from Yahoo Finance, refusing an empty portfolio."""
        if not self.facade.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.facade.scrape_held()

    def held_symbols(self) -> set:
        """The set of symbols currently held across all accounts."""
        return {s['symbol'] for s in self.facade.shares
                if s.get('symbol') and s.get('quantity')}

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its venue for auto pool sizing (#851, #619)."""
        held = self.facade._held_symbols()
        if not held:
            return {}
        return quotes.quote_exchanges(self.facade.config_manager.store, held)

    def scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job."""
        out = set()
        for job in (self.facade.scheduler.get_jobs() or []):
            jid = getattr(job, 'id', '') or ''
            if jid.startswith(SCRAPE_JOB_PREFIX):
                out.add(jid[len(SCRAPE_JOB_PREFIX):])
        return out

    def arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        """(Re)schedule a symbol's scrape job to fire ``delay`` seconds from now."""
        jitter = random.uniform(0, scheduling.JITTER_SECONDS)
        run_date = now + timedelta(seconds=delay + jitter)
        self.facade.scheduler.add_job(
            self.facade._scrape_symbol, 'date', run_date=run_date,
            args=[symbol], id=_scrape_job_id(symbol),
            name=f'Scrape {symbol}', replace_existing=True,
            misfire_grace_time=None, max_instances=1)

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """Re-arm the symbols a new ``regular_interval`` reaches (issue #701)."""
        if self.facade.scheduler is None:
            return 0, 0
        try:
            now = datetime.now(timezone.utc)
            held = self.facade._held_symbols()
            armed = set(scrape_next_runs(self.facade.scheduler))
            closed = {symbol: self.facade._last_pass_closed(symbol)
                      for symbol in held}
            split = scheduling.rearm_split(held, closed, armed)
        except Exception as e:
            app_logger.error(f"Failed to read the scrape jobs to re-arm: {e}")
            return 0, 0

        reached = len(split.self_arming)
        for symbol in split.rearm:
            try:
                with self.failure_counts_lock:
                    failures = self.failure_counts.get(symbol, 0)
                self.facade._arm_symbol(
                    symbol,
                    scheduling.backoff_delay(
                        self.facade.regular_interval, failures),
                    now)
                reached += 1
            except Exception as e:
                app_logger.error(f"Failed to re-arm scrape job for {symbol}: {e}")

        app_logger.info(
            f"Poll cadence is now {self.facade.regular_interval}s: {reached} "
            f"symbol(s) reached, {len(split.asleep)} waiting for their market "
            f"to open")
        return reached, len(split.asleep)

    def last_pass_closed(self, symbol: str) -> Optional[bool]:
        """Was this symbol's market shut on its last pass? ``None`` if it has none."""
        record = self.facade.recorder.scrape_of(symbol)
        return None if record is None else record.closed

    def reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604)."""
        if self.facade.scheduler is None:
            return
        try:
            now = datetime.now(timezone.utc)
            held = self.facade._held_symbols()
            scheduled = self.facade._scheduled_symbols()
        except Exception as e:
            app_logger.error(f"Failed to reconcile per-symbol jobs: {e}")
            return
        for symbol in held - scheduled:
            try:
                self.facade._arm_symbol(symbol, 0, now)
            except Exception as e:
                app_logger.error(f"Failed to arm scrape job for {symbol}: {e}")
        for symbol in scheduled - held:
            try:
                self.facade.scheduler.remove_job(_scrape_job_id(symbol))
            except Exception as e:
                app_logger.debug(f"Job for {symbol} already gone, skipping: {e}")
            finally:
                with self.failure_counts_lock:
                    self.failure_counts.pop(symbol, None)
                self.facade.recorder.forget_scrape(symbol)

    def check_price_freshness(self, symbol: str,
                              live_price, now: datetime) -> bool:
        """Price-freshness liveness sonde (issue #628, design #626)."""
        if self.facade.staleness_horizon <= 0:
            return False
        stale = False
        try:
            stored_price = quotes.last_price(
                self.facade.config_manager.store, symbol)
            with self.sonde_lock:
                new_state, stale = scheduling.price_freshness_step(
                    self.sonde_state.get(symbol), live_price, stored_price,
                    now, self.facade.staleness_horizon)
                if new_state is None:
                    self.sonde_state.pop(symbol, None)
                else:
                    self.sonde_state[symbol] = new_state

            if stale:
                app_logger.warning(
                    f"Price-freshness sonde: the stored price for {symbol} is "
                    f"frozen at {stored_price} across REGULAR polling while the "
                    f"live quote is {live_price} — the writer may be silently "
                    f"stale")
        except Exception as e:
            app_logger.debug(f"Price-freshness sonde failed for {symbol}: {e}")
        return stale

    def scrape_symbol(self, symbol: str, now: Optional[datetime] = None) -> None:
        """Scrape one symbol, gate the write, and re-arm the job (design #602)."""
        injected_now = now is not None
        now = now or datetime.now(timezone.utc)
        next_delay = self.facade.regular_interval
        try:
            last_quote, info = self.facade._fetch_ticker_data(symbol)
            price_present = last_quote is not None and info is not None

            converted, rate = self.facade._convert(
                last_quote, market_info.currency_of(info))

            holdings = [s for s in self.facade.shares
                        if s.get('symbol') == symbol and s.get('quantity')]

            if info is not None:
                state, next_open = scheduling.extract_market_context(
                    info, market_info.history_metadata_of(info), now)
            else:
                state, next_open = None, None

            with self.failure_counts_lock:
                should_write, next_delay, new_failure_count = scheduling.decide(
                    state, price_present, next_open, now,
                    self.failure_counts.get(symbol, 0),
                    self.facade.regular_interval)
                if symbol in self.facade._held_symbols():
                    self.failure_counts[symbol] = new_failure_count
                else:
                    self.failure_counts.pop(symbol, None)

            stale = False
            if should_write:
                stale = self.facade._check_price_freshness(
                    symbol, last_quote, now)

                wrote_live_data = bool(holdings) and self.facade._write_quote(
                    symbol, last_quote, info, now, converted, rate)
            else:
                wrote_live_data = False
                app_logger.debug(
                    f"Skipping write for {symbol} (state={state}, "
                    f"price_present={price_present})")

            self.facade.recorder.record_scrape(runtime_state.ScrapeRecord(
                symbol=symbol,
                at=now,
                market_state=state,
                closed=scheduling.is_closed(state),
                price_present=price_present,
                verdict=scrape_verdict(
                    should_write, state, wrote_live_data, bool(holdings)),
                failure_count=new_failure_count,
                next_delay=next_delay,
                wrote=wrote_live_data,
                stale=stale,
                error=(
                    f"No point persisted for {symbol}: the store refused the write"
                    if should_write and not wrote_live_data and holdings else None),
            ))
        except Exception as exc:
            app_logger.error(
                f"Scrape pass for {symbol} failed", exc_info=True)
            self.facade.recorder.record_scrape(runtime_state.ScrapeRecord(
                symbol=symbol,
                at=now,
                market_state=None,
                closed=False,
                price_present=False,
                verdict=runtime_state.SCRAPE_NO_PRICE,
                failure_count=self.failure_counts.get(symbol, 0),
                next_delay=next_delay,
                wrote=False,
                stale=False,
                error=f"{type(exc).__name__}: {exc}",
            ))
        finally:
            if self.facade.scheduler is not None and \
                    symbol in self.facade._held_symbols():
                arm_now = now if injected_now else datetime.now(timezone.utc)
                self.facade._arm_symbol(symbol, next_delay, arm_now)
