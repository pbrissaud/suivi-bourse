"""What a Yahoo payload *says* — the one place its keys are named (issue #846).

Pure, and listed as such in the suite's ``_PURE``: no store, no yfinance, no
pandas, no clock. It handles one thing, a mapping, and it is the half of the
market edge that can be read without knowing anything about the network —
:mod:`market` is the other half, and it is the one that fetches.

**Two shapes pass through here, and the difference is worth stating.** The
*raw* one is Yahoo's own — ``ticker.info`` and the ``history_metadata`` that
rides beside it — and its keys are Yahoo's spelling (``quoteType``,
``trailingPE``, ``exchangeTimezoneName``, ``currentTradingPeriod``). The
*translated* one is the app's, and it is what every other module receives: the
cache the backfill reads, the mapping the scrape hands to
:mod:`scheduling`, the columns :mod:`quotes` writes. Both are read here, and
nowhere else in the tree — which is what the accessors at the bottom are for.
A caller that wants the currency asks for the currency; it never spells a key.

**And there is no sentinel any more** (issue #845). The string the tree used to
put on ``currency``, ``exchange`` and ``quoteType`` when Yahoo held no value for
them was **the app's own**, not yfinance's — the library does not contain it —
and it was set in one place, removed in two that did not agree, and not removed
by the translation towards the quotation columns, which is how it reached the
currency column: read back out of it, it was named as one half of a pair
(``UNDEFINEDEUR=X``), resolved to nothing, and armed ``unconvertible`` — the
terminal that asks the owner to act, on a symbol they can do nothing about.
``None`` says everything the word was trying to say and every reader downstream
already knows how to read it, so the three defaults are simply gone and the two
removals with them.
"""

from typing import Mapping, Optional


# --------------------------------------------------------------------------- #
# The raw payload -> the app's vocabulary
# --------------------------------------------------------------------------- #

def quote_attributes(raw: Mapping) -> dict:
    """The quotation attributes of a fetch, from Yahoo's own mapping.

    The three text fields are read **with no default** (#845): a key the payload
    does not carry lands as ``None``, which is what the store writes as ``NULL``
    and what every reader here already answers for a failed fetch. There was a
    default, it was a word, and a word stored in the currency column is a
    currency as far as the rest of the app is concerned.

    It is the one translation of the attributes, for the live fetch and for the
    single ``.info`` the lateral pass asks (:func:`market.symbol_attributes`).
    Those were two functions until #845, and the difference between them was
    exactly the sentinel — one removed it from the currency and one set it — so
    with the sentinel gone there is one reading left and this is it.

    ``peRatio`` is the app's own word and has no Yahoo key: the trailing ratio
    when there is one, the forward ratio otherwise. The dividend yield is
    passed on as the **percentage** yfinance hands over — ``dividendYield`` is
    already 5.32 for a 5,32 % yield, the ratio being spelled
    ``trailingAnnualDividendYield``. Scaling it here stored 532.
    """
    return {
        'currency': raw.get('currency'),
        'exchange': raw.get('exchange'),
        'quoteType': raw.get('quoteType'),
        'dividendYield': raw.get('dividendYield'),
        'peRatio': raw.get('trailingPE') or raw.get('forwardPE'),
        'marketCap': raw.get('marketCap'),
    }


def market_context(raw: Mapping, history_meta: Optional[Mapping]) -> dict:
    """The cadence fields, which ride on the same mapping as the attributes.

    :mod:`scheduling` consumes them and does not translate them: the market
    state and the venue's timezone come off ``info``, the current trading
    period off the metadata ``history()`` carries, and the three travel
    together so the fetch keeps its ``(last_quote, info)`` shape. The extra
    keys are ignored by the write path.
    """
    return {
        'marketState': raw.get('marketState'),
        'exchangeTimezoneName': raw.get('exchangeTimezoneName'),
        '_history_meta': history_meta,
    }


def live_attributes(raw: Mapping, history_meta: Optional[Mapping]) -> dict:
    """Everything a live fetch learns: the attributes plus the cadence fields."""
    return {**quote_attributes(raw), **market_context(raw, history_meta)}


# --------------------------------------------------------------------------- #
# The app's vocabulary -> its readers
# --------------------------------------------------------------------------- #

def quote_columns(info: Mapping) -> dict:
    """The ``symbol_quote`` columns one translated mapping supplies.

    The fundamentals are stored in **current value only** (spec #695 § 3):
    yfinance gives them on the live quote alone, so v4's attempt at a history
    of them was a comb of ``NULL`` down the price series that nothing ever read
    as one.
    """
    return {
        'currency': info.get('currency'),
        'exchange': info.get('exchange'),
        'quote_type': info.get('quoteType'),
        'dividend_yield': info.get('dividendYield'),
        'pe_ratio': info.get('peRatio'),
        'market_cap': info.get('marketCap'),
    }


def currency_of(info: Optional[Mapping]) -> Optional[str]:
    """The unit a translated mapping says the symbol is quoted in, or ``None``.

    Read as it is stored, and since #845 what is stored is what Yahoo said: a
    payload naming no currency lands ``None`` here, so the conversion path, the
    write path and the backfill's prefetch all see the absence rather than a
    word that looks like a code.
    """
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
    """``currentTradingPeriod.regular.start`` — a Unix timestamp, or ``None``.

    Read defensively, layer by layer: any missing or garbage level answers
    ``None`` so the caller falls back. It is handed back as Yahoo states it, a
    number, because what a scheduler makes of it — the instant, and whether a
    past one is read for its hour or for its date — is :mod:`scheduling`'s
    subject and not this module's.
    """
    if not isinstance(history_meta, dict):
        return None
    period = history_meta.get('currentTradingPeriod')
    if not isinstance(period, dict):
        return None
    regular = period.get('regular')
    if not isinstance(regular, dict):
        return None
    return regular.get('start')
