"""The market edge: the one module that talks to yfinance (issue #846)."""

import math
import time
from datetime import date, datetime, timezone, time as time_of_day
from typing import Dict, List, Optional, Tuple

import pandas as pd
import yfinance as yf
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

from application import instants
from application import market_info
from application import scheduling

logger = getLogger("market")


def latest_quote(symbol: str,
                 max_retries: int = 3) -> Tuple[Optional[float], Optional[dict]]:
    """The newest close of one symbol and its attributes, or ``(None, None)``."""
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            # `auto_adjust=False` for the same reason as the history fetch
            # (#1008), though **not** for the same stake: the factor is anchored
            # on the newest bar, so the one this function reads comes back the
            # same either way and the stored live price was never wrong.
            # Passed anyway so the two call sites read the same column rather
            # than the same column under one invariant -- a dividend cannot go
            # ex after the last bar in the window, but that is a fact about
            # Yahoo, not about this code, and it is the kind that stops being
            # true quietly.
            ticker_history = ticker.history(auto_adjust=False)
            if ticker_history.empty:
                logger.warning(f"No price history returned for {symbol}")
                return None, None
            valid_close = ticker_history['Close'].dropna()
            if valid_close.empty:
                logger.warning(f"No non-NaN close price for {symbol}, skipping")
                return None, None
            last_quote = valid_close.iloc[-1]
            info = market_info.live_attributes(
                ticker.info, getattr(ticker, 'history_metadata', None))
            return last_quote, info
        except YFRateLimitError:
            if attempt < max_retries - 1:
                wait_time = 2 ** (attempt + 1)
                logger.warning(
                    f"Rate limited for {symbol}, retrying in {wait_time}s "
                    f"(attempt {attempt + 1}/{max_retries})")
                time.sleep(wait_time)
            else:
                logger.error(
                    f"Rate limited for {symbol}, max retries exceeded")
                return None, None
        except (u_exceptions.NewConnectionError, RuntimeError):
            logger.error(
                "Error while retrieving data from Yfinance API",
                exc_info=True)
            return None, None
    return None, None


def _splits(ticker, symbol: str) -> Optional[Dict[date, float]]:
    """When this symbol split and by how much, or ``None`` when Yahoo would not say.

    The absence is **not** an empty answer (#987). A window written without the
    splits is written in the wrong share, and nothing ever comes back for it: the
    backward pass does not ask twice for a window it has filled. So a symbol
    whose splits could not be read fails its fetch instead, and the chunk is
    retried on the next cycle like any other failure.

    A ticker that has no ``splits`` at all is a different thing from one that
    could not be asked, and it says so: the fakes the suite hands the market
    have no corporate actions, and neither do most symbols.
    """
    try:
        series = getattr(ticker, 'splits', None)
        if series is None or len(series) == 0:
            return {}
        # **A ratio is a positive, finite number or it is not a ratio.** Yahoo
        # serves these out of a pandas frame, where an empty cell is `NaN` --
        # and `NaN` is truthy, so a replay multiplying units by it turns the
        # whole holding into `NaN` and every figure downstream with it. A zero
        # would be silently skipped and a negative would flip the position.
        # Rejected here, at the edge, so nothing further down has to ask.
        kept = {index.date(): float(ratio) for index, ratio in series.items()}
        return {day: ratio for day, ratio in kept.items()
                if math.isfinite(ratio) and ratio > 0}
    except Exception as e:
        logger.error(f"Could not read the splits of {symbol}: {e}")
        return None


def bar_instant(moment: datetime, interval: str) -> datetime:
    """Where on the clock one fetched bar is stored (issue #1013).

    **A daily bar is a date, not an instant.** yfinance stamps it at midnight
    in the *exchange's own* timezone, and Paris midnight is 22:00Z the day
    before — while everything downstream reads the UTC day: ``time_bucket`` in
    :meth:`store_reads.PortfolioReader.chart_series`, ``CAST(ts AS DATE)`` in
    the retention ladder and the conversion repair, and the day the rate is
    looked up under. So every close of every exchange east of UTC was filed one
    trading day early, and the store came out *mixed by exchange*, because a US
    bar's local midnight is 04:00–05:00Z and still lands on the right day.

    Anchored at **UTC noon on the exchange's date** instead. Noon is what makes
    both halves agree without ``time_bucket`` having a say: it is twelve hours
    from either edge, so UTC−11 through UTC+12 all land on the day the market
    actually traded.

    An intraday bar *is* an instant and is kept as one, normalized to UTC the
    way every other instant in the tree is.
    """
    if interval == scheduling.DAILY:
        return datetime.combine(moment.date(), time_of_day(12),
                                tzinfo=timezone.utc)
    return instants.utc(moment)


def price_history(symbol: str, start: datetime, end: datetime,
                  delay: float,
                  max_retries: int = 3
                  ) -> Tuple[Optional[List[Dict]], Optional[Dict[date, float]]]:
    """One symbol's closes over ``[start, end]`` and its splits, or ``(None, None)``.

    Two adjustments stand between Yahoo and the close the market printed, and
    they are undone in two different places because Yahoo applies them in two
    different places. ``auto_adjust=False`` turns off the one yfinance makes
    locally — it swaps ``Close`` for ``Adj Close``, which is **net of every
    dividend paid since** (#1008), and a dividend is already in the ledger as an
    event crediting cash, so leaving it in the price counts it twice and values
    the whole past short. The split half is applied by the chart endpoint
    upstream and no flag reaches it, which is what
    :func:`market_info.as_printed` is for.

    The splits ride along because they are read here and nowhere else, and
    because :func:`market_info.as_printed` **consumes** them: it puts the closes
    back in the share the market printed them in and the ratios are gone by the
    time the chunk reaches its caller. Anything counting units across a split
    needs them (#760), so they are handed over rather than dropped.

    The second half is ``None`` whenever no split history was established --
    the fetch failed, or the window came back empty and the question was never
    asked. It is ``{}`` for a symbol that has simply never split, which is a
    different answer and the caller may store it as one.
    """
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            interval = scheduling.history_interval(
                start, datetime.now(timezone.utc))
            history = ticker.history(start=start, end=end, interval=interval,
                                     auto_adjust=False)

            if history.empty:
                logger.debug(f"No historical data for {symbol} from {start} to {end}")
                return [], None

            prices = []
            for idx, row in history.iterrows():
                close = row['Close']
                if pd.isna(close):
                    continue
                ts = bar_instant(idx.to_pydatetime(), interval)
                prices.append({'timestamp': ts, 'price': float(close)})

            if not prices:
                return prices, None

            splits = _splits(ticker, symbol)
            if splits is None:
                return None, None
            return market_info.as_printed(prices, splits), splits

        except YFRateLimitError:
            if attempt < max_retries - 1:
                wait_time = delay * (2 ** attempt)
                logger.warning(
                    f"Rate limited fetching history for {symbol}, "
                    f"retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait_time)
            else:
                logger.error(
                    f"Rate limited fetching history for {symbol}, max retries exceeded")
                return None, None
        except Exception as e:
            logger.error(f"Error fetching history for {symbol}: {e}")
            return None, None

    return None, None


def pair_rate(pair: str) -> Optional[float]:
    """The newest close of one currency pair, or ``None``."""
    try:
        history = yf.Ticker(pair).history()
    except Exception as e:
        logger.warning(f"Could not fetch the {pair} rate: {e}")
        return None
    if history is None or history.empty or 'Close' not in history.columns:
        return None
    closes = history['Close'].dropna()
    return float(closes.iloc[-1]) if not closes.empty else None


def pair_series(pair: str, start: date, end: date) -> Dict[date, float]:
    """The pair's **daily** closes over ``[start, end]``."""
    history = yf.Ticker(pair).history(start=start, end=end, interval='1d')
    if history is None or history.empty:
        return {}

    series: Dict[date, float] = {}
    for index, row in history.iterrows():
        close = row['Close']
        if pd.isna(close):
            continue
        # The date the bar carries, **as the venue stamped it** — not the date
        # its midnight falls on once moved to UTC (#1013). London midnight in
        # summer is 23:00Z the day before, so converting first filed a whole
        # pair's series one day early, and every price converted at that rate
        # with it.
        series[index.to_pydatetime().date()] = float(close)
    return series


def symbol_attributes(symbol: str) -> Optional[dict]:
    """One symbol's attributes, asked for on their own, or ``None``."""
    try:
        raw = yf.Ticker(symbol).info or {}
    except Exception as e:
        logger.warning(f"Could not fetch the attributes of {symbol}: {e}")
        return None
    return market_info.quote_attributes(raw)
