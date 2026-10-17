"""The currency of a file's amounts, asked about before the write (#1261).

No write path converts an amount: ``entries.create_many`` stores what the file
carries, and the schema reads it as the reporting currency. A line quoted in USD
in a EUR install is therefore read as EUR unless somebody says otherwise, and the
import preview is where somebody can. This module answers the three things that
question needs: which lines are foreign (:func:`survey`), what a pair sent back
by the front means (:func:`pairs`), and the conversion itself (:func:`convert`).
"""
import math
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from logfmt_logger import getLogger

from application import entries
from application import fx
from application import market
from application import market_info
from application import quotes
from application.events.schemas import Event, canonical_symbol

logger = getLogger("import_currency")

#: What one security's lookup may take. A symbol not answered in time is
#: *unverified*: the preview goes on without it.
LOOKUP_TIMEOUT_S = 4

_WORKERS = 4

#: How far before a day its rate may come from (``fx._DAILY_LOOKBACK_DAYS``): a
#: file starting on a weekend still finds Friday's close.
_LOOKBACK = timedelta(days=10)

#: Shared by every request, so a slow Yahoo costs the process four threads and
#: not four per upload.
_POOL = ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix='currency')

#: ``{symbol: currency}``, for the life of the process. Only a success is kept:
#: a failure is not an answer, and a lookup that lands after its request gave up
#: fills this, so the next forecast lists the symbol.
_LOOKED_UP: Dict[str, str] = {}


class Unconvertible(Exception):
    """No rate is known for a row, so its amounts cannot be converted."""

    def __init__(self, symbol: str, currency: str, base: str, day: date):
        super().__init__(
            f"no {currency}/{base} rate is known around {day.isoformat()} "
            f"({symbol})")
        self.symbol = symbol
        self.currency = currency
        self.base = base
        self.day = day


class BadPair(ValueError):
    """A ``foreign`` pair the file does not support."""


@dataclass(frozen=True)
class ForeignLine:
    """One security quoted outside the base, and how many events carry money."""

    symbol: str
    currency: str
    rows: int


@dataclass(frozen=True)
class Survey:
    """What a file's lines say about their currency, once looked up."""

    lines: Tuple[ForeignLine, ...]
    unverified: Tuple[str, ...]

    @property
    def pairs(self) -> Dict[str, str]:
        return {line.symbol: line.currency for line in self.lines}


def _carries_money(event: Event) -> bool:
    return (event.unit_price is not None or event.fee is not None
            or event.amount is not None)


def _money_rows(rows: Sequence[Event]) -> Dict[str, int]:
    """``{symbol: events carrying money}``. A cash movement has no symbol."""
    counts: Dict[str, int] = {}
    for event in rows:
        symbol = canonical_symbol(event.symbol)
        if symbol and _carries_money(event):
            counts[symbol] = counts.get(symbol, 0) + 1
    return counts


def survey(store, rows: Sequence[Event], base: str) -> Survey:
    """The foreign lines of a file, learning unknown currencies from Yahoo.

    Reads ``symbol_quote`` first, then the process cache, then asks Yahoo for
    what is left, in parallel and within :data:`LOOKUP_TIMEOUT_S` per batch of
    four. Writes nothing to the store (#967).
    """
    target, _ = fx.normalise(base)
    counts = _money_rows(rows)

    found: Dict[str, str] = {}
    to_ask: List[str] = []
    for symbol in sorted(counts):
        currency = quotes.quote_currency(store, symbol) or _LOOKED_UP.get(symbol)
        if currency:
            found[symbol] = currency
        else:
            to_ask.append(symbol)

    unverified = _ask(to_ask, found)

    lines = []
    for symbol in sorted(found):
        main, _ = fx.normalise(found[symbol])
        if main is not None and main != target:
            lines.append(ForeignLine(symbol, main, counts[symbol]))
    return Survey(tuple(lines), tuple(sorted(unverified)))


def _ask(symbols: Sequence[str], found: Dict[str, str]) -> List[str]:
    """Look ``symbols`` up into ``found``; name the ones that did not answer."""
    if not symbols:
        return []
    started = time.monotonic()
    futures = {_POOL.submit(_look_up, symbol): symbol for symbol in symbols}
    deadline = LOOKUP_TIMEOUT_S * math.ceil(len(symbols) / _WORKERS)
    done, _ = wait(futures, timeout=max(0.0, started + deadline - time.monotonic()))

    unverified = []
    for future, symbol in futures.items():
        currency = future.result() if future in done else None
        if currency:
            found[symbol] = currency
        else:
            unverified.append(symbol)
    return unverified


def _look_up(symbol: str) -> Optional[str]:
    """One symbol's currency from Yahoo, cached on success. Never raises."""
    try:
        currency = market_info.currency_of(market.symbol_attributes(symbol))
    except Exception as exc:
        logger.warning(f"Could not look up the currency of {symbol}: {exc}")
        return None
    if fx.normalise(currency)[0] is None:
        return None
    _LOOKED_UP[symbol] = currency
    return currency


def pairs(rows: Sequence[Event], sent: Sequence[str], base: str) -> Dict[str, str]:
    """The ``SYMBOL:CCY`` pairs of a write, checked against the file.

    Raises :class:`BadPair` for a symbol the file does not name, a code that is
    not a currency, or a currency that is the base.
    """
    target, _ = fx.normalise(base)
    named = {canonical_symbol(event.symbol) for event in rows}
    chosen: Dict[str, str] = {}
    for pair in sent:
        symbol, _, code = pair.rpartition(':')
        symbol = canonical_symbol(symbol)
        main, _ = fx.normalise(code)
        if not symbol or symbol not in named:
            raise BadPair(f"foreign {pair!r}: the file does not name that symbol")
        if main is None:
            raise BadPair(f"foreign {pair!r}: {code!r} is not a currency code")
        if main == target:
            raise BadPair(f"foreign {pair!r}: {main} is the base currency")
        chosen[symbol] = main
    return chosen


def lines(rows: Sequence[Event], chosen: Mapping[str, str]) -> Tuple[ForeignLine, ...]:
    """``chosen`` as lines, counted on the file."""
    counts = _money_rows(rows)
    return tuple(ForeignLine(symbol, chosen[symbol], counts.get(symbol, 0))
                 for symbol in sorted(chosen))


def convert(rows: Sequence[Event], chosen: Mapping[str, str],
            rates: Optional[fx.Rates], base: str) -> List[Event]:
    """``rows`` with the amounts of the ``chosen`` securities in ``base``.

    Each row is converted at the daily rate of its own day. One series is
    fetched per currency, then every row reads it. A row with no rate refuses
    the whole file, naming the earliest such day.
    """
    days: Dict[str, List[date]] = {}
    for event in rows:
        symbol = canonical_symbol(event.symbol)
        if symbol in chosen and _carries_money(event):
            days.setdefault(chosen[symbol], []).append(event.date)
    if rates is not None:
        for currency, held in days.items():
            # Padded like ``Rates._daily_rate`` pads its own fetch: Yahoo's ``end``
            # is exclusive, and the first day may not be a trading one.
            rates.series(currency, base, min(held) - _LOOKBACK,
                         max(held) + timedelta(days=1))

    converted: List[Event] = []
    missing: List[Tuple[date, str, str]] = []
    for event in rows:
        symbol = canonical_symbol(event.symbol)
        if symbol not in chosen or not _carries_money(event):
            converted.append(event)
            continue
        currency = chosen[symbol]
        rate = None if rates is None else rates.rate(currency, base, at=event.date)
        if rate is None:
            missing.append((event.date, symbol, currency))
            converted.append(event)
            continue
        converted.append(replace(
            event,
            unit_price=_scaled(event.unit_price, rate),
            fee=_scaled(event.fee, rate),
            amount=_scaled(event.amount, rate)))

    if missing:
        day, symbol, currency = min(missing)
        raise Unconvertible(symbol, currency, base, day)
    return converted


def _scaled(value: Optional[float], rate: float) -> Optional[float]:
    if value is None:
        return None
    return float(entries.AMOUNT_PRECISION % (value * rate))


__all__ = [
    'LOOKUP_TIMEOUT_S', 'Unconvertible', 'BadPair', 'ForeignLine', 'Survey',
    'survey', 'pairs', 'lines', 'convert',
]
