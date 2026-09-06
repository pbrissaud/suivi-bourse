"""The market edge: the one module that talks to yfinance (issue #846)."""

import time
from datetime import date, datetime, timezone
from typing import Dict, List, Optional, Tuple

import pandas as pd
import yfinance as yf
from logfmt_logger import getLogger
from urllib3 import exceptions as u_exceptions
from yfinance.exceptions import YFRateLimitError

from application import market_info
from application import scheduling

logger = getLogger("market")


def latest_quote(symbol: str,
                 max_retries: int = 3) -> Tuple[Optional[float], Optional[dict]]:
    """The newest close of one symbol and its attributes, or ``(None, None)``."""
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            ticker_history = ticker.history()
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


def price_history(symbol: str, start: datetime, end: datetime,
                  delay: float,
                  max_retries: int = 3) -> Optional[List[Dict]]:
    """One symbol's closes over ``[start, end]``, or ``None`` on failure."""
    for attempt in range(max_retries):
        try:
            ticker = yf.Ticker(symbol)
            interval = scheduling.history_interval(
                start, datetime.now(timezone.utc))
            history = ticker.history(start=start, end=end, interval=interval)

            if history.empty:
                logger.debug(f"No historical data for {symbol} from {start} to {end}")
                return []

            prices = []
            for idx, row in history.iterrows():
                close = row['Close']
                if pd.isna(close):
                    continue
                ts = idx.to_pydatetime()
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
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
        moment = index.to_pydatetime()
        day = moment.date() if moment.tzinfo is None else moment.astimezone(
            timezone.utc).date()
        series[day] = float(close)
    return series


def symbol_attributes(symbol: str) -> Optional[dict]:
    """One symbol's attributes, asked for on their own, or ``None``."""
    try:
        raw = yf.Ticker(symbol).info or {}
    except Exception as e:
        logger.warning(f"Could not fetch the attributes of {symbol}: {e}")
        return None
    return market_info.quote_attributes(raw)
