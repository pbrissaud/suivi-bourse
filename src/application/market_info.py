"""What a Yahoo payload *says* — the one place its keys are named (issue #846)."""

from typing import Mapping, Optional


def quote_attributes(raw: Mapping) -> dict:
    """The quotation attributes of a fetch, from Yahoo's own mapping."""
    return {
        'currency': raw.get('currency'),
        'exchange': raw.get('exchange'),
        'quoteType': raw.get('quoteType'),
        'dividendYield': raw.get('dividendYield'),
        'peRatio': raw.get('trailingPE') or raw.get('forwardPE'),
        'marketCap': raw.get('marketCap'),
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
