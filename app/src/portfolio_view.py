"""Pure view logic for the web UI (issue #659, design #655).

Rows in, page objects out — in the exact taste of :mod:`scheduling` and
:mod:`performance`: no InfluxDB import, no Flask import, no clock. That is what
lets the arithmetic below be tested with literal lists, which matters because
the arithmetic is where the money is: a **plain sum of cost prices is wrong**,
and it is wrong in a way that looks plausible on screen.

The whole module exists because :func:`influx_reads.PortfolioReader.latest_per_account`
deliberately returns the per-account rows instead of ``SUM``-ing them away in
SQL. Grafana aggregates inside the query, which is precisely why no panel of the
baseline can show the breakdown (#652 déc. 6, item 6). Aggregating here means
both views come from one read: the table row *and* the sheet's breakdown.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence

#: Fields summed straight across a share's accounts.
_ADDITIVE = (
    'purchased_quantity',
    'purchased_fee',
    'owned_quantity',
    'received_dividend',
)

#: Fields that describe the *instrument*, not the holding, and must therefore
#: never be summed across accounts: ``dividend_yield``, ``pe_ratio``,
#: ``market_cap``. Holding the same ETF in a PEA and a CTO does not double its
#: market capitalisation. Each is read off the newest row that carries it — see
#: ``_newest_value`` at the bottom of the module.


@dataclass(frozen=True)
class AccountPosition:
    """One share as held in one account — the detail sheet's breakdown row."""

    account: str
    owned_quantity: Optional[float]
    purchased_quantity: Optional[float]
    cost_price: Optional[float]
    purchased_fee: Optional[float]
    received_dividend: Optional[float]
    market_value: Optional[float]
    invested: Optional[float]
    plus_value_latente: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'account': self.account,
            'owned_quantity': self.owned_quantity,
            'purchased_quantity': self.purchased_quantity,
            'cost_price': self.cost_price,
            'purchased_fee': self.purchased_fee,
            'received_dividend': self.received_dividend,
            'market_value': self.market_value,
            'invested': self.invested,
            'plus_value_latente': self.plus_value_latente,
        }


@dataclass(frozen=True)
class SharePosition:
    """One row of the shares table: a share aggregated across its accounts.

    ``symbol`` is the identity and ``name`` is display only — trap 9, and #652
    déc. 3. The baseline keys every per-share panel on ``share_name``, so a
    rename splits a continuous series in two; here the name is simply whatever
    the newest point called it.
    """

    symbol: str
    name: Optional[str]
    currency: Optional[str]
    exchange: Optional[str]
    quote_type: Optional[str]
    price: Optional[float]
    price_time: Optional[datetime]
    owned_quantity: Optional[float]
    purchased_quantity: Optional[float]
    cost_price: Optional[float]
    purchased_fee: Optional[float]
    received_dividend: Optional[float]
    market_value: Optional[float]
    invested: Optional[float]
    plus_value_latente: Optional[float]
    plus_value_pct: Optional[float]
    unit_gain: Optional[float]
    dividend_yield: Optional[float]
    pe_ratio: Optional[float]
    market_cap: Optional[float]
    accounts: Sequence[AccountPosition]
    #: Reserved for #656's live scheduler state (market open/closed, price
    #: frozen per #628, dead ticker backing off per #617). #652 déc. 15 wants a
    #: pill per row; which state is readable, and how it is read without racing
    #: the scheduler's threads, is that ticket's question. The slot is here so
    #: the payload shape does not change when it lands.
    status: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'currency': self.currency,
            'exchange': self.exchange,
            'quote_type': self.quote_type,
            'price': self.price,
            'price_time': _iso(self.price_time),
            'owned_quantity': self.owned_quantity,
            'purchased_quantity': self.purchased_quantity,
            'cost_price': self.cost_price,
            'purchased_fee': self.purchased_fee,
            'received_dividend': self.received_dividend,
            'market_value': self.market_value,
            'invested': self.invested,
            'plus_value_latente': self.plus_value_latente,
            'plus_value_pct': self.plus_value_pct,
            'unit_gain': self.unit_gain,
            'dividend_yield': self.dividend_yield,
            'pe_ratio': self.pe_ratio,
            'market_cap': self.market_cap,
            'accounts': [a.to_dict() for a in self.accounts],
            'status': self.status,
        }


def weighted_cost_price(rows: Iterable[Dict[str, Any]]) -> Optional[float]:
    """Quantity-weighted mean cost price, ``Σ(pp × pq) / Σpq``.

    Panel 9's rule, and the single most load-bearing line of the module. A share
    bought 1 × 100 € and 9 × 200 € cost 190 € a share, not 300 € and not 150 €;
    both wrong answers are what a plain sum and a plain mean produce, and both
    look like prices.

    Returns ``None`` when the denominator is zero — trap 13. A fully-sold or
    never-bought position has no cost price, and rendering it as ``0`` would put
    a 100 % gain on screen.
    """
    numerator = 0.0
    denominator = 0.0
    for row in rows:
        price = row.get('purchased_price')
        quantity = row.get('purchased_quantity')
        if price is None or quantity is None:
            continue
        numerator += price * quantity
        denominator += quantity
    if denominator == 0:
        return None
    return numerator / denominator


def build_shares(rows: Sequence[Dict[str, Any]]) -> List[SharePosition]:
    """Fold P1's per-``(symbol, account)`` rows into one entry per share.

    The rows are :meth:`influx_reads.PortfolioReader.latest_per_account`'s
    output — already the *newest* observation of each pair, so there is no time
    reasoning left to do here, only arithmetic.
    """
    by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        symbol = row.get('share_symbol')
        if not symbol:
            continue
        by_symbol.setdefault(symbol, []).append(row)

    return [_build_share(symbol, group) for symbol, group in sorted(by_symbol.items())]


def build_share(rows: Sequence[Dict[str, Any]], symbol: str) -> Optional[SharePosition]:
    """The single-share form, for the detail sheet. ``None`` when unknown."""
    group = [r for r in rows if r.get('share_symbol') == symbol]
    return _build_share(symbol, group) if group else None


def _build_share(symbol: str, group: List[Dict[str, Any]]) -> SharePosition:
    """Aggregate one symbol's per-account rows into a table row + breakdown."""
    # Newest first: the instrument-level attributes (name, currency, exchange,
    # quote type, price, fundamentals) are read off the freshest observation
    # rather than combined. A price belongs to no account — the same rule
    # ``get_price_series`` carries — so "the price of this share" is simply the
    # most recently observed one, whichever account's write produced it.
    ordered = sorted(group, key=_time_key, reverse=True)
    newest = ordered[0]

    accounts = [_build_account(row) for row in sorted(
        group, key=lambda r: str(r.get('account') or ''))]

    totals = {field: _sum(group, field) for field in _ADDITIVE}
    cost_price = weighted_cost_price(group)

    market_value = _sum_products(group, 'owned_quantity', 'share_price')
    invested = _sum_products(group, 'purchased_quantity', 'purchased_price')

    # Plus-value latente — #652 déc. 6's second term: holdings + dividends −
    # invested − fees, straight out of portfolio_metrics. It is deliberately
    # **not** called Gain. Gain is total value − net contributed, needs declared
    # accounts and events, and conflating the two is the mistake déc. 6 exists
    # to prevent.
    plus_value = _plus_value(
        market_value, totals['received_dividend'], invested,
        totals['purchased_fee'])

    price = newest.get('share_price')
    return SharePosition(
        symbol=symbol,
        name=newest.get('share_name'),
        currency=newest.get('share_currency'),
        exchange=newest.get('share_exchange'),
        quote_type=newest.get('quote_type'),
        price=price,
        price_time=newest.get('time'),
        owned_quantity=totals['owned_quantity'],
        purchased_quantity=totals['purchased_quantity'],
        cost_price=cost_price,
        purchased_fee=totals['purchased_fee'],
        received_dividend=totals['received_dividend'],
        market_value=market_value,
        invested=invested,
        plus_value_latente=plus_value,
        plus_value_pct=_ratio(plus_value, invested),
        unit_gain=_difference(price, cost_price),
        dividend_yield=_newest_value(ordered, 'dividend_yield'),
        pe_ratio=_newest_value(ordered, 'pe_ratio'),
        market_cap=_newest_value(ordered, 'market_cap'),
        accounts=accounts,
    )


def _build_account(row: Dict[str, Any]) -> AccountPosition:
    """One breakdown row, with the same arithmetic scoped to a single account."""
    market_value = _product(row.get('owned_quantity'), row.get('share_price'))
    invested = _product(row.get('purchased_quantity'), row.get('purchased_price'))
    plus_value = _plus_value(
        market_value, row.get('received_dividend'), invested,
        row.get('purchased_fee'))
    return AccountPosition(
        account=str(row.get('account') or 'default'),
        owned_quantity=row.get('owned_quantity'),
        purchased_quantity=row.get('purchased_quantity'),
        cost_price=row.get('purchased_price'),
        purchased_fee=row.get('purchased_fee'),
        received_dividend=row.get('received_dividend'),
        market_value=market_value,
        invested=invested,
        plus_value_latente=plus_value,
    )


# --------------------------------------------------------------------- #
# Arithmetic that treats absence as absence
#
# Every helper below returns None when it has nothing to work with, rather
# than 0. #655's three-state table calls this "absent by design", and it is
# the difference between "this position has no cost price" and "this position
# cost nothing" — which render identically the moment one of them becomes a
# zero.
# --------------------------------------------------------------------- #

def _plus_value(
    market_value: Optional[float],
    dividends: Optional[float],
    invested: Optional[float],
    fees: Optional[float],
) -> Optional[float]:
    """``holdings + dividends − invested − fees``, or ``None``.

    The holdings term is **required**; the other three default to zero when
    absent. That asymmetry is the whole point, and a test earned it: composing
    this out of null-tolerant helpers made a share whose price had never been
    observed report a plus-value of *minus everything invested* — the app
    announcing a total loss because it had never seen a quote. Without a price
    there is no valuation, so there is no plus-value either, and the honest
    answer is the em dash.

    The other three genuinely may be absent and genuinely mean zero: a position
    that has paid no dividend, a GRANT that cost nothing, a broker that charged
    no fee.
    """
    if market_value is None:
        return None
    return market_value + (dividends or 0.0) - (invested or 0.0) - (fees or 0.0)


def _sum(rows: Iterable[Dict[str, Any]], field: str) -> Optional[float]:
    values = [r[field] for r in rows if r.get(field) is not None]
    return sum(values) if values else None


def _sum_products(rows: Iterable[Dict[str, Any]], left: str, right: str) -> Optional[float]:
    products = [
        r[left] * r[right] for r in rows
        if r.get(left) is not None and r.get(right) is not None
    ]
    return sum(products) if products else None


def _product(left: Optional[float], right: Optional[float]) -> Optional[float]:
    return None if left is None or right is None else left * right


def _add(left: Optional[float], right: Optional[float]) -> Optional[float]:
    if left is None:
        return right
    if right is None:
        return left
    return left + right


def _difference(left: Optional[float], right: Optional[float]) -> Optional[float]:
    return None if left is None or right is None else left - right


def _ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    """``numerator / denominator``, or ``None`` — trap 13's ``NULLIF`` guard."""
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def _newest_value(ordered: Sequence[Dict[str, Any]], field: str) -> Optional[float]:
    """First non-``None`` value of ``field``, scanning newest row first.

    The fundamentals ride the same point as the price, so the newest row
    normally has them. Scanning on is for the case where one account's newest
    write predates yfinance supplying the field; it costs nothing and removes a
    blank cell that has no meaning.
    """
    for row in ordered:
        value = row.get(field)
        if value is not None:
            return value
    return None


def _time_key(row: Dict[str, Any]) -> float:
    """Sortable stamp for a row, tolerating a missing or naive ``time``."""
    value = row.get('time')
    if isinstance(value, datetime):
        return value.timestamp()
    return float('-inf')


def _iso(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601 UTC, the wire format #655 fixed for every timestamp."""
    return value.isoformat() if isinstance(value, datetime) else None


__all__ = [
    'AccountPosition', 'SharePosition',
    'build_shares', 'build_share', 'weighted_cost_price',
]
