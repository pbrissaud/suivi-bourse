"""The scrape: one self-rescheduling entry per held symbol (issues #847, #1253)."""
import logging
import random
import threading
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional, Tuple

from application import carrying
from application import job_history
from application import market_info
from application import quotes
from application import runtime_state
from application import runtime_view
from application import scheduling
from application.jobs import base

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
    if not should_write:
        return (runtime_state.SCRAPE_CLOSED if scheduling.is_closed(state)
                else runtime_state.SCRAPE_NO_PRICE)
    if not has_holdings:
        return runtime_state.SCRAPE_NOTHING_TO_WRITE
    if wrote:
        return runtime_state.SCRAPE_WROTE
    return runtime_state.SCRAPE_WRITE_FAILED


class ScrapeJob(base.JobFamily):
    """The scrape, whole: its state, its entries, and the pass they run."""

    id = job_history.SCRAPE
    label_key = 'settings.jobs.scrape'
    triggers = (base.SelfArmed(dial='regular_interval'),)
    in_health = True

    def __init__(self, ctx, jobs):
        super().__init__(ctx, jobs)

        self.failure_counts: Dict[str, int] = {}
        self.failure_counts_lock = threading.Lock()

        self.sonde_lock = threading.Lock()
        self.sonde_state: Dict[str, scheduling.SondeState] = {}

    @property
    def info_cache(self) -> Dict[str, Dict]:
        """The attributes the last quote of each symbol came with — shared."""
        return self.ctx.info_cache

    def members(self) -> set:
        return self.held_symbols()

    def run(self, member: str, now: Optional[datetime] = None) -> None:
        self.scrape_symbol(member, now)

    def outcome(self, member: str) -> base.Outcome:
        return runtime_view.scrape_outcome(self.ctx.recorder.scrape_of(member))

    @classmethod
    def health(cls, view):
        return runtime_view.health_scrape(view.symbols)

    def rearm(self, dial: str, value) -> base.Rearmed:
        reached, sleeping = self.rearm_regular_scrapes()
        return base.Rearmed(symbols=reached, at_market_open=sleeping)

    def fetch_ticker_data(self, symbol: str, max_retries: int = 3):
        """One symbol's newest close and its attributes, and the cache's fill."""
        last_quote, info = self.ctx.market.latest_quote(symbol, max_retries)
        if info is not None:
            self.info_cache[symbol] = info
        return last_quote, info

    def write_quote(self, symbol: str, last_quote, info, now: datetime,
                    converted=None, fx_rate=None) -> bool:
        """Persist one live observation: ``symbol_quote`` + one ``price_point``."""
        try:
            with self.ctx.config_manager.writing() as opened:
                quotes.record_quote(opened, symbol, now, last_quote,
                                    market_info.quote_columns(info),
                                    converted, fx_rate)
            return True
        except Exception as e:
            app_logger.error(f"Failed to write the quote for {symbol}: {e}")
            return False

    def scrape_held(self):
        """Fetch and store every held symbol's quote, once."""
        shares = self.ctx.shares
        held = sorted(carrying.held_symbols(shares))
        for symbol in held:
            last_quote, info = self.fetch_ticker_data(symbol)
            converted, rate = self.ctx.convert(
                last_quote, market_info.currency_of(info))

            if last_quote is None or info is None:
                app_logger.warning(
                    f"No data fetched for {symbol}, skipping the quote write")
            else:
                self.write_quote(symbol, last_quote, info,
                                 datetime.now(timezone.utc),
                                 converted, rate)

    def scrape(self):
        """Scrape stock prices from Yahoo Finance, refusing an empty portfolio."""
        if not self.ctx.shares:
            app_logger.warning("No shares configured, skipping scrape")
            return

        self.scrape_held()

    def held_symbols(self) -> set:
        """The set of symbols currently held across all accounts."""
        return carrying.held_symbols(self.ctx.shares)

    def read_exchange_of(self) -> Dict[str, Optional[str]]:
        """Map each held symbol to its venue for auto pool sizing (#851, #619)."""
        held = self.held_symbols()
        if not held:
            return {}
        return quotes.quote_exchanges(self.ctx.config_manager.store, held)

    def scheduled_symbols(self) -> set:
        """Symbols that currently have a live per-symbol scrape job."""
        out = set()
        for job in (self.ctx.scheduler.get_jobs() or []):
            jid = getattr(job, 'id', '') or ''
            if jid.startswith(SCRAPE_JOB_PREFIX):
                out.add(jid[len(SCRAPE_JOB_PREFIX):])
        return out

    def arm_symbol(self, symbol: str, delay: float, now: datetime) -> None:
        """(Re)schedule a symbol's scrape job to fire ``delay`` seconds from now."""
        jitter = random.uniform(0, scheduling.JITTER_SECONDS)
        run_date = now + timedelta(seconds=delay + jitter)
        self.ctx.scheduler.add_job(
            self, 'date', run_date=run_date,
            args=[symbol], id=_scrape_job_id(symbol),
            name=f'Scrape {symbol}', replace_existing=True,
            misfire_grace_time=None, max_instances=1)

    def rearm_regular_scrapes(self) -> Tuple[int, int]:
        """Re-arm the symbols a new ``regular_interval`` reaches (issue #701)."""
        if self.ctx.scheduler is None:
            return 0, 0
        try:
            now = datetime.now(timezone.utc)
            held = self.held_symbols()
            armed = set(scrape_next_runs(self.ctx.scheduler))
            closed = {symbol: self.last_pass_closed(symbol)
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
                self.arm_symbol(
                    symbol,
                    scheduling.backoff_delay(
                        self.ctx.regular_interval, failures),
                    now)
                reached += 1
            except Exception as e:
                app_logger.error(f"Failed to re-arm scrape job for {symbol}: {e}")

        app_logger.info(
            f"Poll cadence is now {self.ctx.regular_interval}s: {reached} "
            f"symbol(s) reached, {len(split.asleep)} waiting for their market "
            f"to open")
        return reached, len(split.asleep)

    def last_pass_closed(self, symbol: str) -> Optional[bool]:
        """Was this symbol's market shut on its last pass? ``None`` if it has none."""
        record = self.ctx.recorder.scrape_of(symbol)
        return None if record is None else record.closed

    def reconcile_jobs(self) -> None:
        """Diff the held-symbol set against the scheduled jobs (design #604)."""
        if self.ctx.scheduler is None:
            return
        try:
            now = datetime.now(timezone.utc)
            held = self.held_symbols()
            scheduled = self.scheduled_symbols()
        except Exception as e:
            app_logger.error(f"Failed to reconcile per-symbol jobs: {e}")
            return
        for symbol in held - scheduled:
            try:
                self.arm_symbol(symbol, 0, now)
            except Exception as e:
                app_logger.error(f"Failed to arm scrape job for {symbol}: {e}")
        for symbol in scheduled - held:
            try:
                self.ctx.scheduler.remove_job(_scrape_job_id(symbol))
            except Exception as e:
                app_logger.debug(f"Job for {symbol} already gone, skipping: {e}")
            finally:
                with self.failure_counts_lock:
                    self.failure_counts.pop(symbol, None)
                self.ctx.recorder.forget_scrape(symbol)

    def check_price_freshness(self, symbol: str,
                              live_price, now: datetime) -> bool:
        """Price-freshness liveness sonde (issue #628, design #626)."""
        if self.ctx.staleness_horizon <= 0:
            return False
        stale = False
        try:
            stored_price = quotes.last_price(
                self.ctx.config_manager.store, symbol)
            with self.sonde_lock:
                new_state, stale = scheduling.price_freshness_step(
                    self.sonde_state.get(symbol), live_price, stored_price,
                    now, self.ctx.staleness_horizon)
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
        next_delay = self.ctx.regular_interval
        try:
            last_quote, info = self.fetch_ticker_data(symbol)
            price_present = last_quote is not None and info is not None

            converted, rate = self.ctx.convert(
                last_quote, market_info.currency_of(info))

            holdings = [s for s in self.ctx.shares
                        if s.get('symbol') == symbol and s.get('quantity')]

            if info is not None:
                state, next_open = scheduling.extract_market_context(
                    info, market_info.history_metadata_of(info), now)
            else:
                state, next_open = None, None

            closed = scheduling.is_closed(state)
            print_at = session_end = stored_at = None
            if closed:
                print_at, session_end = scheduling.session_print(
                    market_info.history_metadata_of(info))
                stored = quotes.read_quote(
                    self.ctx.config_manager.store, symbol)
                stored_at = stored and stored['last_price_ts']

            with self.failure_counts_lock:
                should_write, next_delay, new_failure_count = scheduling.decide(
                    state, price_present, next_open, now,
                    self.failure_counts.get(symbol, 0),
                    self.ctx.regular_interval, print_at=print_at,
                    session_end=session_end, stored_at=stored_at)
                if symbol in self.held_symbols():
                    self.failure_counts[symbol] = new_failure_count
                else:
                    self.failure_counts.pop(symbol, None)

            stale = False
            if should_write:
                # A closed pass stamps the point at the print's own instant
                # (#1352), and the REGULAR-only sonde has nothing to say of it.
                if not closed:
                    stale = self.check_price_freshness(
                        symbol, last_quote, now)

                wrote_live_data = bool(holdings) and self.write_quote(
                    symbol, last_quote, info, print_at if closed else now,
                    converted, rate)
            else:
                wrote_live_data = False
                app_logger.debug(
                    f"Skipping write for {symbol} (state={state}, "
                    f"price_present={price_present})")

            self.ctx.recorder.record_scrape(runtime_state.ScrapeRecord(
                symbol=symbol,
                at=now,
                market_state=state,
                closed=closed,
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
            self.ctx.recorder.record_scrape(runtime_state.ScrapeRecord(
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
            # The only thing that puts the symbol back, so neither the read nor
            # the arming may escape into APScheduler (issue #855). A read that
            # fails re-arms all the same: an arming too many writes nothing, a
            # missing arming costs the symbol.
            if self.ctx.scheduler is not None:
                try:
                    still_held = symbol in self.held_symbols()
                except Exception as e:
                    app_logger.error(
                        f"Failed to read the held symbols after the pass for "
                        f"{symbol}: {e} — re-arming anyway")
                    still_held = True
                if still_held:
                    try:
                        self.arm_symbol(
                            symbol, next_delay,
                            now if injected_now else datetime.now(timezone.utc))
                    except Exception as e:
                        app_logger.error(
                            f"Failed to re-arm the scrape job for {symbol}: {e} "
                            f"— it leaves the rotation until the next reconcile")
