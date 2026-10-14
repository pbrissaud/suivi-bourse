"""What a Yahoo payload *says* — the one place its keys are named (issue #846)."""

import math
from datetime import date
from typing import Mapping, MutableMapping, Optional, Sequence


def quote_attributes(raw: Mapping) -> dict:
    """The quotation attributes of a fetch, from Yahoo's own mapping."""
    return {
        'currency': raw.get('currency'),
        'exchange': raw.get('exchange'),
        'quoteType': raw.get('quoteType'),
        'dividendYield': raw.get('dividendYield'),
        'peRatio': raw.get('trailingPE') or raw.get('forwardPE'),
        'marketCap': raw.get('marketCap'),
        #: What the instrument *does* and *where* — the three keys #964 adds.
        #: **Never** ``raw['region']``: it answers ``'US'`` on ``AI.PA`` as on
        #: any other symbol, because it is yfinance's own locale echoed back
        #: and not a fact about the instrument. ``country`` is the fact.
        'sector': raw.get('sector'),
        'industry': raw.get('industry'),
        'country': raw.get('country'),
    }


def market_context(raw: Mapping, history_meta: Optional[Mapping]) -> dict:
    """The cadence fields, which ride on the same mapping as the attributes."""
    return {
        'marketState': raw.get('marketState'),
        'exchangeTimezoneName': raw.get('exchangeTimezoneName'),
        '_history_meta': history_meta,
    }


def live_attributes(raw: Mapping, history_meta: Optional[Mapping]) -> dict:
    """Everything a live fetch learns: the attributes plus the cadence fields."""
    return {**quote_attributes(raw), **market_context(raw, history_meta)}


def quote_columns(info: Mapping) -> dict:
    """The ``symbol_quote`` columns one translated mapping supplies."""
    return {
        'currency': info.get('currency'),
        'exchange': info.get('exchange'),
        'quote_type': info.get('quoteType'),
        'dividend_yield': info.get('dividendYield'),
        'pe_ratio': info.get('peRatio'),
        'market_cap': info.get('marketCap'),
        'sector': info.get('sector'),
        'industry': info.get('industry'),
        'country': info.get('country'),
    }


def currency_of(info: Optional[Mapping]) -> Optional[str]:
    """The unit a translated mapping says the symbol is quoted in, or ``None``."""
    return (info or {}).get('currency')


def market_state_of(info: Optional[Mapping]) -> Optional[str]:
    """Yahoo's ``marketState``, untouched — ``decide`` fail-opens the unknown."""
    return (info or {}).get('marketState')


def exchange_timezone_name_of(info: Optional[Mapping]) -> Optional[str]:
    """The IANA name of the venue's timezone, or ``None``."""
    return (info or {}).get('exchangeTimezoneName')


def history_metadata_of(info: Optional[Mapping]) -> Optional[Mapping]:
    """The ``history()`` metadata the live fetch carried along, or ``None``."""
    return (info or {}).get('_history_meta')


def regular_period_start(history_meta: Optional[Mapping]):
    """``currentTradingPeriod.regular.start`` — a Unix timestamp, or ``None``."""
    if not isinstance(history_meta, dict):
        return None
    period = history_meta.get('currentTradingPeriod')
    if not isinstance(period, dict):
        return None
    regular = period.get('regular')
    if not isinstance(regular, dict):
        return None
    return regular.get('start')


def as_printed(prices: Sequence[MutableMapping],
               splits: Mapping[date, float]) -> Sequence[MutableMapping]:
    """Yahoo's closes, put back in the share the market printed them in (#987).

    Yahoo serves every close **split-adjusted to today's share**; the ledger
    holds the quantity **as traded on the day**. A line bought before a split is
    therefore valued in two units at once — three shares of a symbol that
    reverse-split 1-for-1000 are carried at a thousand times what they were
    worth, for the whole of their pre-split history. ``auto_adjust=False`` does
    not reach this: it only turns off the adjustment yfinance makes locally, the
    dividend one (#1008). The chart endpoint applies the split upstream, so the
    caller cannot turn it off and the correction has to be made here.

    The printed close is the served one multiplied back by **every split that
    came after it**; the close of the split day itself already stands in the new
    unit, which is why the comparison is strict.

    Corrected in place, and returned for the caller to read as one expression.

    What this does *not* undo is an adjustment Yahoo made for anything but a
    split — a rights issue leaves no row in ``ticker.splits`` and no factor to
    read, so a symbol that went through one keeps a residue this cannot see.
    """
    ratios = [(day, ratio) for day, ratio in splits.items() if ratio > 0]
    if not ratios:
        return prices

    for point in prices:
        price = point.get('price')
        if price is None:
            continue
        day = point['timestamp'].date()
        point['price'] = price * math.prod(
            ratio for split_day, ratio in ratios if split_day > day)
    return prices
