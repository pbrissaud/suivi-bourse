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

**The sentinel is named once**, and this module is the once. Yahoo answers
:data:`UNDEFINED` for a field it holds no value for, and the tree used to *set*
it as a default in one place and *remove* it in two others that did not agree —
one of them removing it and one of them not, which is issue #845. This ticket
moves the three readings without changing any of them: the sentinel still
reaches exactly the columns it reaches today, it is simply said in one file.
"""

from typing import Mapping, Optional

#: yfinance's own answer for a field it has no value for. It is a **string**
#: that names an absence, so it must never be stored as if it were the value:
#: read back out of the currency column it would be named as one half of a pair
#: (``UNDEFINEDEUR=X``), resolve to nothing, and arm ``unconvertible`` — the
#: terminal that asks the owner to act, on a symbol they can do nothing about.
UNDEFINED = 'undefined'


def real_value(value: Optional[str]) -> Optional[str]:
    """``None`` for an absent value **or** for the sentinel, else the value.

    The normalization the tree spelled by hand in two places and forgot in a
    third. Empty counts as absent for the same reason blank counts as unset
    everywhere else in the app: a field that says nothing is a field that has
    nothing to say.
    """
    return value if value and value != UNDEFINED else None


# --------------------------------------------------------------------------- #
# The raw payload -> the app's vocabulary
# --------------------------------------------------------------------------- #

def quote_attributes(raw: Mapping) -> dict:
    """The quotation attributes of a **live** fetch, from Yahoo's own mapping.

    The sentinel is *set* here, on the three text fields, exactly as the fetch
    path has always set it — it is what a reader downstream then has to remove,
    and the two that do it (:func:`exchange_of` and the currency the lateral
    pass learns) now do it through :func:`real_value`. Preserving the defaults
    rather than dropping them is deliberate: dropping them is #845, which is a
    one-line change *in this file* once this ticket has landed, and doing it
    here would make a move into a fix.

    ``peRatio`` is the app's own word and has no Yahoo key: the trailing ratio
    when there is one, the forward ratio otherwise. The dividend yield is
    passed on as the **percentage** yfinance hands over — ``dividendYield`` is
    already 5.32 for a 5,32 % yield, the ratio being spelled
    ``trailingAnnualDividendYield``. Scaling it here stored 532.
    """
    return {
        'currency': raw.get('currency', UNDEFINED),
        'exchange': raw.get('exchange', UNDEFINED),
        'quoteType': raw.get('quoteType', UNDEFINED),
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


def learned_attributes(raw: Mapping) -> dict:
    """The attributes of a symbol the lateral pass asked about, once (#773).

    **Not** :func:`live_attributes`, and the two differences are the ones that
    were there before this module existed. The sentinel is removed from the
    currency, because this mapping's whole purpose is to answer *what unit is
    this quoted in* and a sentinel stored there is the defect described on
    :data:`UNDEFINED`. And no field is sentinel-defaulted, because this reading
    writes ``symbol_quote`` for a symbol the scrape may never meet: a text
    field Yahoo is silent about lands as ``NULL`` rather than as the word.
    """
    return {
        'currency': real_value(raw.get('currency')),
        'exchange': raw.get('exchange'),
        'quoteType': raw.get('quoteType'),
        'dividendYield': raw.get('dividendYield'),
        'peRatio': raw.get('trailingPE') or raw.get('forwardPE'),
        'marketCap': raw.get('marketCap'),
    }


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

    Read as it is stored, sentinel included: the conversion path has always
    seen whatever the fetch put there, and a mapping learnt by the lateral pass
    carries a currency :func:`real_value` has already been through.
    """
    return (info or {}).get('currency')


def exchange_of(info: Optional[Mapping]) -> Optional[str]:
    """The venue, or ``None`` for a failed fetch or the sentinel.

    ``None`` so ``compute_pool_size`` treats the symbol as a solo market rather
    than grouping every unknown venue into one giant cohort.
    """
    return real_value((info or {}).get('exchange'))


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
