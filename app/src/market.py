"""The market edge: the one module that talks to yfinance (issue #846).

``import yfinance`` appears here and nowhere else in the tree, and a test on the
source holds that (``test_suite_conventions.py``). Everything the app asks of
Yahoo is one of the five gestures below; what comes back is already in the
app's vocabulary, :mod:`market_info` having translated it — so no caller of
this module ever sees a Yahoo key.

**Three error policies, and they are three decisions rather than an
inconsistency.** They were made where the calls were, and moving the calls does
not merge them:

* :func:`latest_quote` and :func:`price_history` **retry** with an exponential
  back-off on ``YFRateLimitError`` and answer *nothing* when they run out —
  the scrape and the backfill both have a cadence that will come back;
* :func:`pair_rate` **swallows** whatever goes wrong into ``None``, because an
  unresolvable pair is an ordinary state (spec #695 § 7): it writes a ``NULL``
  converted price and never loses a quote;
* :func:`pair_series` **raises**, and that is the whole of how the backfill's
  lateral pass tells its two stopping conditions apart (issue #704) — a raise
  is a fetch that did not complete, an empty answer is yfinance saying the pair
  is not a ticker.

``max_retries`` stays a parameter with a default rather than becoming a
constant in here: it is the caller's politeness, not the market's.

This module knows nothing of the store. The ``info`` cache the scrape keeps per
symbol stays with the scrape — whose it is, is issue #847's subject.
"""

import time
from datetime import date, datetime, timezone
from typing import Dict, List, Optional, Tuple

import pandas as pd
import yfinance as yf
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

import market_info
import scheduling

logger = getLogger("market")


def latest_quote(symbol: str,
                 max_retries: int = 3) -> Tuple[Optional[float], Optional[dict]]:
    """The newest close of one symbol and its attributes, or ``(None, None)``.

    Retries on a rate limit with an exponential back-off, and answers
    ``(None, None)`` on anything it cannot get past — a transient failure is
    the scrape's ordinary weather, and the caller reads the absence as one.
    """
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            ticker_history = ticker.history()
            if ticker_history.empty:
                logger.warning(f"No price history returned for {symbol}")
                return None, None
            # Use the last row that actually has a close. Yahoo returns the
            # most recent daily bar with a NaN close for a while after a
            # session ends (the daily aggregate lags the intraday data), so a
            # blind tail(1) would reject a perfectly good series outside
            # market hours, defeating the missed-session gap-fill (#627).
            # Mirror the per-row NaN skip price_history does.
            valid_close = ticker_history['Close'].dropna()
            if valid_close.empty:
                logger.warning(f"No non-NaN close price for {symbol}, skipping")
                return None, None
            last_quote = valid_close.iloc[-1]
            # The cadence fields ride on the same mapping as the attributes, so
            # this call keeps its (last_quote, info) shape; the metadata that
            # carries the current trading period is read off the ticker rather
            # than off ``info``, which is why it is passed separately.
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


def price_history(symbol: str, start: datetime, end: datetime,
                  delay: float,
                  max_retries: int = 3) -> Optional[List[Dict]]:
    """One symbol's closes over ``[start, end]``, or ``None`` on failure.

    ``[]`` is an answer — Yahoo has nothing for that window — and ``None`` is
    the absence of one, which is what the backfill's back-off reads. ``delay``
    is the caller's politeness delay, the unit its retry back-off doubles.
    """
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            # **An API ceiling, not an arbitration** (issue #705, ADR-0010).
            # Yahoo sells nothing below the hour past
            # ``scheduling.HOURLY_CEILING_DAYS``, so the rebuild asks for the
            # finest bars that still exist rather than for the finest the
            # ladder would allow — which is why that number is not a dial and
            # not derived from :mod:`retention`'s walls either. The two sit a
            # day apart (the hourly rung runs to 730) and that is the whole
            # point: the ladder was drawn *from* this ceiling, so a
            # reconstructed past and an ageing present implement one function
            # of age instead of two policies meeting at the present. It is
            # also the sentence behind *fine resolution is only ever obtained
            # by having been there*: past this line there is nowhere to buy
            # it back.
            #
            # The choice is made **once for the whole window**, off its
            # oldest day, because that is what Yahoo refuses a request on —
            # which is why the backward pass cuts a chunk that straddles the
            # ceiling rather than letting one interval answer for both sides
            # of it (issue #783). It is read here, at the edge, because it is
            # a property of what the API sells and not of the ladder.
            interval = scheduling.history_interval(
                start, datetime.now(timezone.utc))
            history = ticker.history(start=start, end=end, interval=interval)

            if history.empty:
                logger.debug(f"No historical data for {symbol} from {start} to {end}")
                return []

            prices = []
            for idx, row in history.iterrows():
                # Skip rows without a valid close price (holidays / partial
                # bars come back as NaN) so no NaN price reaches the store.
                close = row['Close']
                if pd.isna(close):
                    continue
                # idx is a pandas Timestamp
                ts = idx.to_pydatetime()
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                # The close, and only the close (issue #700). OHLC and
                # volume are not dropped for economy: the *live* writer set
                # open = high = low = close on every point it ever wrote, so
                # the four columns disagreed about what they meant depending
                # on which pass had filled them, and a candlestick drawn from
                # them showed a flat doji through every session the app was
                # up for. A column that lies is worse than one that is
                # missing.
                prices.append({'timestamp': ts, 'price': float(close)})

            return prices

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
                return None
        except Exception as e:
            logger.error(f"Error fetching history for {symbol}: {e}")
            return None

    return None


def pair_rate(pair: str) -> Optional[float]:
    """The newest close of one currency pair, or ``None``.

    Deliberately **not** :func:`latest_quote`: that one hands back the
    attributes the scrape caches per symbol, and a currency pair landing in
    that cache would put an instrument that is not a holding into the
    portfolio's own memory. What is wanted here is one number.

    Errors are swallowed into ``None`` on purpose — an unresolvable pair is an
    ordinary state (spec #695 § 7), it writes a ``NULL`` converted price and
    never a lost quote.
    """
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
    """The pair's **daily** closes over ``[start, end]``.

    Daily whatever the window's age, unlike :func:`price_history`: an hourly
    rate would be a hundredfold more rows for a series whose consumer is a
    calendar day, and Yahoo caps hourly at 730 days anyway.

    **It raises rather than swallowing** (issue #704), and that is the whole of
    how the lateral pass tells its two stopping conditions apart: a raise is a
    fetch that did not complete, an empty answer is yfinance saying the pair is
    not a ticker. :meth:`fx.Rates._ensure_window` catches it and logs where the
    swallow used to be, so the *rebuild's* behaviour is unchanged — what
    changed with #704 is that the difference survives as far as the caller that
    needs it.
    """
    history = yf.Ticker(pair).history(start=start, end=end, interval='1d')
    if history is None or history.empty:
        return {}

    series: Dict[date, float] = {}
    for index, row in history.iterrows():
        close = row['Close']
        if pd.isna(close):
            continue
        moment = index.to_pydatetime()
        day = moment.date() if moment.tzinfo is None else moment.astimezone(
            timezone.utc).date()
        # The **last** close of a day wins, the survivor rule the rest of
        # the store follows.
        series[day] = float(close)
    return series


def symbol_attributes(symbol: str) -> Optional[dict]:
    """One symbol's attributes, asked for on their own, or ``None``.

    The unit-learning request (#773): no price, no history, one ``.info``. The
    ``None`` is *the request did not complete* and never *Yahoo named nothing*
    — the caller has to keep those two apart, since only the second is a reply
    it may remember. A completed request that names nothing answers a mapping
    whose currency is ``None``.
    """
    try:
        raw = yf.Ticker(symbol).info or {}
    except Exception as e:
        logger.warning(f"Could not fetch the attributes of {symbol}: {e}")
        return None
    return market_info.learned_attributes(raw)
