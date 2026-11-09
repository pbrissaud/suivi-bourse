"""Pure view logic for the web UI (issue #659, rewritten to v5's shape by #700)."""
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime
from typing import (
    Any, Callable, Collection, Dict, Iterable, List, Mapping, Optional, Sequence,
)

from application import instants
from application.carrying import carrying_price, is_quoted, was_quoted
from application.events.schemas import unit_cost as _unit_cost

_ADDITIVE = ('quantity', 'cost_basis', 'realized_gain', 'received_dividend')


def unit_cost(quantity: Optional[float],
              cost_basis: Optional[float]) -> Optional[float]:
    """The weighted-average unit price — the one division, called not re-spelled."""
    return _unit_cost(quantity or 0.0, cost_basis or 0.0)


@dataclass(frozen=True)
class AccountPosition:
    """One share as held in one account — the detail sheet's breakdown row."""

    account: str
    quantity: Optional[float]
    cost_basis: Optional[float]
    unit_cost: Optional[float]
    realized_gain: Optional[float]
    received_dividend: Optional[float]
    market_value: Optional[float]
    plus_value_latente: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'account': self.account,
            'quantity': self.quantity,
            'cost_basis': self.cost_basis,
            'unit_cost': self.unit_cost,
            'realized_gain': self.realized_gain,
            'received_dividend': self.received_dividend,
            'market_value': self.market_value,
            'plus_value_latente': self.plus_value_latente,
        }


@dataclass(frozen=True)
class SharePosition:
    """One row of the shares table: a share aggregated across its accounts."""

    symbol: str
    name: Optional[str]
    currency: Optional[str]
    exchange: Optional[str]
    quote_type: Optional[str]
    price: Optional[float]
    price_native: Optional[float]
    fx_rate: Optional[float]
    price_time: Optional[datetime]
    quantity: Optional[float]
    cost_basis: Optional[float]
    unit_cost: Optional[float]
    realized_gain: Optional[float]
    received_dividend: Optional[float]
    market_value: Optional[float]
    plus_value_latente: Optional[float]
    plus_value_pct: Optional[float]
    unit_gain: Optional[float]
    dividend_yield: Optional[float]
    pe_ratio: Optional[float]
    market_cap: Optional[float]
    accounts: Sequence[AccountPosition]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'currency': self.currency,
            'exchange': self.exchange,
            'quote_type': self.quote_type,
            'price': self.price,
            'price_native': self.price_native,
            'fx_rate': self.fx_rate,
            'price_time': instants.iso(self.price_time),
            'quantity': self.quantity,
            'cost_basis': self.cost_basis,
            'unit_cost': self.unit_cost,
            'realized_gain': self.realized_gain,
            'received_dividend': self.received_dividend,
            'market_value': self.market_value,
            'plus_value_latente': self.plus_value_latente,
            'plus_value_pct': self.plus_value_pct,
            'unit_gain': self.unit_gain,
            'dividend_yield': self.dividend_yield,
            'pe_ratio': self.pe_ratio,
            'market_cap': self.market_cap,
            'accounts': [a.to_dict() for a in self.accounts],
        }


def build_shares(rows: Sequence[Dict[str, Any]],
                 carried: Collection[str] = ()) -> List[SharePosition]:
    """Fold P1's per-``(account, symbol)`` rows into one entry per share."""
    by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        symbol = row.get('symbol')
        if not symbol:
            continue
        by_symbol.setdefault(symbol, []).append(row)

    return [_build_share(symbol, group, symbol in carried)
            for symbol, group in sorted(by_symbol.items())]


def latent_gains_by_account(
        shares: Sequence[SharePosition],
        accounts: Collection[str] = ()) -> Dict[str, Optional[float]]:
    """``Σ market_value − Σ cost_basis`` per account — the projection's assiette
    for the two kinds that read one (#919).

    Folded off :func:`build_shares` rather than off P1's rows, so the figure is
    the one the shares table already renders, carried prices and all.

    **Strict**: one unvalued line makes the whole account's assiette unknown, and
    the account answers ``None`` rather than a sum of the lines that happened to
    have a price. :func:`_sum` is the ``?? 0`` this refuses — a gain nobody knows
    is not a gain of zero, and a tax projected off a partial valuation would
    understate itself in silence.

    ``accounts`` seeds the declared ones at zero, and that is the *other* half of
    the same distinction: an account holding nothing — deposits and no purchase,
    which is what a freshly declared wrapper looks like — has an assiette of
    exactly nothing, and it is **known**. Left out of the fold it would publish
    no figure and the panel would say *I cannot tell* about a sum the app can do
    in its head.
    """
    gains: Dict[str, Optional[float]] = {account: 0.0 for account in accounts}
    for share in shares:
        for holding in share.accounts:
            known = gains.get(holding.account, 0.0)
            if known is None:
                continue
            # **A closed line is worth exactly nothing, and that is known.**
            # `positions()` keeps the row after a full exit, and the aggregator
            # zeroes its basis with it; a delisted symbol then has no price, so
            # the strict rule below would read *unknown* off a holding whose
            # answer is not in doubt and erase the whole account's assiette with
            # it — for ever, and with no hint why.
            if not holding.quantity:
                continue
            latent = holding.plus_value_latente
            gains[holding.account] = None if latent is None else known + latent
    return gains


def _build_share(symbol: str, group: List[Dict[str, Any]],
                 carry: bool = False) -> SharePosition:
    """Aggregate one symbol's per-account rows into a table row + breakdown."""
    accounts = [_build_account(row, carry) for row in sorted(
        group, key=lambda row: str(row.get('account') or ''))]

    totals = {field: _sum(group, field) for field in _ADDITIVE}
    quantity = totals['quantity']
    cost_basis = totals['cost_basis']

    quote = group[0]
    price = quote.get('price')
    carried_at = (
        carrying_price(price,
                       is_quoted(quote.get('price_native'),
                                 quote.get('currency')),
                       quantity, cost_basis)
        if carry else price)
    market_value = _product(quantity, carried_at)

    plus_value = _latent(market_value, cost_basis)
    return SharePosition(
        symbol=symbol,
        name=_first_value(group, 'name'),
        currency=quote.get('currency'),
        exchange=quote.get('exchange'),
        quote_type=quote.get('quote_type'),
        price=price,
        price_native=quote.get('price_native'),
        fx_rate=quote.get('fx_rate'),
        price_time=quote.get('price_time'),
        quantity=quantity,
        cost_basis=cost_basis,
        unit_cost=unit_cost(quantity, cost_basis),
        realized_gain=totals['realized_gain'],
        received_dividend=totals['received_dividend'],
        market_value=market_value,
        plus_value_latente=plus_value,
        plus_value_pct=_ratio(plus_value, cost_basis),
        unit_gain=_difference(carried_at, unit_cost(quantity, cost_basis)),
        dividend_yield=quote.get('dividend_yield'),
        pe_ratio=quote.get('pe_ratio'),
        market_cap=quote.get('market_cap'),
        accounts=accounts,
    )


def build_positions(rows: Sequence[Dict[str, Any]],
                    base_currency: Optional[str],
                    terminal: Collection[str]) -> List[Dict[str, Any]]:
    """P1's rows as ``GET /api/positions`` publishes them (#745)."""
    return [_build_position(row, base_currency, terminal) for row in rows]


def _build_position(row: Dict[str, Any],
                    base_currency: Optional[str],
                    terminal: Collection[str]) -> Dict[str, Any]:
    """One P1 row on the wire."""
    price_native = row.get('price_native')
    converted = row.get('price')
    at = instants.iso(row.get('price_time'))
    held = _build_account(row, row.get('symbol') in terminal)
    # A closed line is worth exactly nothing, and that is known (see
    # :func:`latent_gains_by_account`): its latent gain is zero, not unknown.
    latent_gain = held.plus_value_latente if held.quantity else 0.0
    return {
        'account': row.get('account'),
        'symbol': row.get('symbol'),
        'name': row.get('name'),
        'quantity': row.get('quantity'),
        'cost_basis': row.get('cost_basis'),
        'realised': row.get('realized_gain'),
        'dividends': row.get('received_dividend'),
        'price': None if price_native is None else {
            'value': price_native,
            'currency': row.get('currency'),
            'at': at,
        },
        'converted': None if converted is None else {
            'value': converted,
            'currency': base_currency,
            'rate': row.get('fx_rate'),
            'rate_at': at,
        },
        # **On the securities' cost only**, never on what was paid in: the
        # same arithmetic as the shares table's row, so the Titres summary is
        # the sum of its rows.
        'latent_gain': latent_gain,
        'latent_gain_pct': _ratio(latent_gain, held.cost_basis),
        'closed_at': instants.iso(row.get('closed_at')),
        'terminal': row.get('symbol') in terminal,
        'fundamentals': _build_fundamentals(row),
    }


def _build_fundamentals(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the instrument is, beside what the holding is worth (issue #720)."""
    values = {
        'currency': row.get('currency'),
        'exchange': row.get('exchange'),
        'quote_type': row.get('quote_type'),
        'dividend_yield': row.get('dividend_yield'),
        'pe_ratio': row.get('pe_ratio'),
        'market_cap': row.get('market_cap'),
        'sector': row.get('sector'),
        'industry': row.get('industry'),
        'country': row.get('country'),
    }
    if all(value is None for key, value in values.items() if key != 'currency'):
        return None
    return values


def build_price_series(symbol: str, rows: Sequence[Dict[str, Any]],
                       resolution: str,
                       base_currency: Optional[str]) -> Dict[str, Any]:
    """One symbol's series as ``GET /api/prices/<symbol>`` publishes it (#719)."""
    return {
        'symbol': symbol,
        'base_currency': base_currency,
        'resolution': resolution,
        'points': [{'t': instants.iso(row.get('ts')), 'price': row.get('price')}
                   for row in rows],
    }


def ytd_base_day(day: date) -> date:
    """The day the year-to-date counts from: 31 December of the previous year."""
    return date(day.year - 1, 12, 31)


def build_portfolio_totals(
    latest: Optional[Dict[str, Any]],
    base: Optional[Dict[str, Any]],
    twr_since: Optional[date],
    transfer_fees: Optional[float],
) -> Optional[Dict[str, Any]]:
    """One ``portfolio_totals`` row plus its three derived members (#745)."""
    if latest is None:
        return None

    payload = {name: latest.get(name) for name in _TOTALS_MEMBERS}
    payload['day'] = instants.iso(latest.get('day'))
    payload['twr_since'] = instants.iso(twr_since)
    payload['transfer_fees'] = transfer_fees
    payload['ytd'] = _ytd(latest, base)
    return payload


#: The ranges the hero reads its change over (``MAX`` is the whole series).
VARIATION_RANGES = ('1M', 'YTD', '1Y', 'MAX')


def _back(day: date, months: int) -> date:
    """``day`` less whole months, clamped to the shorter month's last day."""
    index = day.year * 12 + day.month - 1 - months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(day.day, monthrange(year, month)[1]))


def variation_base_day(name: str, day: date) -> Optional[date]:
    """The day a range counts from; ``None`` for ``MAX``, whose start is the series'."""
    if name == 'MAX':
        return None
    if name == 'YTD':
        return ytd_base_day(day)
    return _back(day, 1 if name == '1M' else 12)


def build_variation(
    latest: Dict[str, Any],
    bases: Mapping[str, Optional[Dict[str, Any]]],
    first: Optional[Dict[str, Any]],
) -> Dict[str, Optional[Dict[str, Any]]]:
    """``{amount, pct, start_date}`` per range, or ``None`` where the series is too short.

    **The amount is the change in gain** (``gain_absolu``), so a deposit inside
    the range is not a performance. The percentage is over the value at the
    start of the range. ``MAX`` is the exception, and a stated one: the
    series starts at its first deposit, a base too small to mean anything, so
    its amount is the whole gain and its base the net contribution.
    """
    out: Dict[str, Optional[Dict[str, Any]]] = {}
    for name in VARIATION_RANGES:
        if name == 'MAX':
            if first is None:
                out[name] = None
                continue
            amount, base, start = (latest.get('gain_absolu'),
                                   latest.get('net_contributed'), first)
        else:
            start = bases.get(name)
            if start is None:
                out[name] = None
                continue
            amount = _difference(latest.get('gain_absolu'),
                                 start.get('gain_absolu'))
            base = start.get('total_value')
        out[name] = {'amount': amount, 'pct': _ratio(amount, base),
                     'start_date': instants.iso(start.get('day'))}
    return out


def build_gain_total(shares: Sequence[SharePosition],
                     transfer_fees: Optional[float],
                     net_contributed: Optional[float]) -> Dict[str, Optional[float]]:
    """The official gain: latent + realised + dividends − fees, over the net contribution.

    Unknown (``None``) when a held line has no value, as the front's four-term
    sum is: a partial latent gain is not a gain.
    """
    latent: Optional[float] = 0.0
    for share in shares:
        if not share.quantity:
            continue
        if share.plus_value_latente is None:
            latent = None
            break
        latent += share.plus_value_latente
    if latent is None or transfer_fees is None:
        amount = None
    else:
        realised = sum(share.realized_gain or 0.0 for share in shares)
        dividends = sum(share.received_dividend or 0.0 for share in shares)
        amount = latent + realised + dividends + transfer_fees
    return {'amount': amount, 'pct': _ratio(amount, net_contributed)}


_TOTALS_MEMBERS = (
    'total_value', 'holdings_value', 'cash_balance', 'net_contributed',
    'xirr', 'twr_index', 'gain_absolu',
)


def _ytd(latest: Dict[str, Any],
         base: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The year-to-date pair, or ``None`` when the series does not reach the base."""
    if base is None:
        return None
    return {
        'gain': _difference(latest.get('gain_absolu'),
                            base.get('gain_absolu')),
        'twr': _relative(latest.get('twr_index'), base.get('twr_index')),
    }


def _relative(index: Optional[float],
              base: Optional[float]) -> Optional[float]:
    """``index / base − 1``, and ``None`` rather than a division by zero."""
    if index is None or not base:
        return None
    return index / base - 1.0


@dataclass(frozen=True)
class AccountSummary:
    """One row of the accounts comparison table."""

    id: str
    label: Optional[str]
    as_of: Optional[date]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    gain_absolu: Optional[float]
    xirr: Optional[float]
    twr_index: Optional[float]
    transfer_fees: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'label': self.label,
            'as_of': instants.iso(self.as_of),
            'cash_balance': self.cash_balance,
            'holdings_value': self.holdings_value,
            'total_value': self.total_value,
            'net_contributed': self.net_contributed,
            'gain_absolu': self.gain_absolu,
            'xirr': self.xirr,
            'twr_index': self.twr_index,
            'transfer_fees': self.transfer_fees,
        }


def build_accounts(
    declared: Sequence[Any],
    rows: Sequence[Dict[str, Any]],
    transfer_fees: Optional[Mapping[str, float]] = None,
) -> List[AccountSummary]:
    """Join the declared accounts to their newest ``account_metrics`` row."""
    by_id = {
        row.get('account'): row for row in rows
        if row.get('account') is not None
    }

    summaries = []
    for account in declared:
        row = by_id.get(account.id) or {}
        summaries.append(AccountSummary(
            id=account.id,
            label=getattr(account, 'label', None),
            as_of=row.get('day'),
            cash_balance=row.get('cash_balance'),
            holdings_value=row.get('holdings_value'),
            total_value=row.get('total_value'),
            net_contributed=row.get('net_contributed'),
            gain_absolu=row.get('gain_absolu'),
            xirr=row.get('xirr'),
            twr_index=row.get('twr_index'),
            transfer_fees=(transfer_fees or {}).get(account.id),
        ))
    return summaries


def valuation_series(
    closes: Sequence[Dict[str, Any]],
    positions_at: Callable[[date], Sequence[Dict[str, Any]]],
    carried_in: Optional[Dict[str, float]] = None,
    carried: Collection[str] = (),
    first_quoted: Optional[Mapping[str, date]] = None,
    symbols: Optional[Collection[str]] = None,
) -> List[Dict[str, Any]]:
    """The daily valuation curve, from the day's closes and the day's holdings.

    ``symbols`` is the perimeter to value, and the caller owns it. Without it
    the day axis is read off every close in the store, so a merely **tracked**
    symbol (#982) puts days on the curve that the portfolio never lived
    through — the shape wrong and not one value, which is the worst kind of
    wrong. The scope is the ledger's, not what is held today: a line sold last
    year was still worth something on the days it was held.
    """
    if symbols is not None:
        closes = [row for row in closes if row.get('symbol') in symbols]
    days = sorted({row['day'] for row in closes if row.get('day') is not None})
    by_day: Dict[Any, Dict[str, float]] = {}
    for row in closes:
        day, symbol = row.get('day'), row.get('symbol')
        if day is None or not symbol or row.get('price') is None:
            continue
        by_day.setdefault(day, {})[symbol] = row['price']

    price: Dict[str, float] = dict(carried_in or {})
    quoted_from = first_quoted or {}
    series: List[Dict[str, Any]] = []
    for day in days:
        price.update(by_day.get(day, {}))
        held = positions_at(day)
        series.append({
            't': instants.iso(day),
            'value': _sum_values(
                _product(position.get('quantity'),
                         _valued_at(position, price.get(position['symbol']),
                                    carried, day, quoted_from))
                for position in held),
            'invested': _sum_values(
                position.get('cost_basis') for position in held),
        })
    return series


def _valued_at(position: Dict[str, Any], observed: Optional[float],
               carried: Collection[str], day: date,
               first_quoted: Mapping[str, date]) -> Optional[float]:
    symbol = position.get('symbol')
    if symbol not in carried:
        return observed
    return carrying_price(observed,
                          was_quoted(first_quoted.get(symbol), day),
                          position.get('quantity'),
                          position.get('cost_basis'))


def _build_account(row: Dict[str, Any], carry: bool = False) -> AccountPosition:
    """One breakdown row, with the same arithmetic scoped to a single account."""
    quantity = row.get('quantity')
    cost_basis = row.get('cost_basis')
    price = row.get('price')
    market_value = _product(
        quantity,
        carrying_price(price,
                       is_quoted(row.get('price_native'), row.get('currency')),
                       quantity, cost_basis) if carry else price)
    return AccountPosition(
        account=str(row.get('account') or 'default'),
        quantity=quantity,
        cost_basis=cost_basis,
        unit_cost=unit_cost(quantity, cost_basis),
        realized_gain=row.get('realized_gain'),
        received_dividend=row.get('received_dividend'),
        market_value=market_value,
        plus_value_latente=_latent(market_value, cost_basis),
    )


def _latent(market_value: Optional[float],
            cost_basis: Optional[float]) -> Optional[float]:
    """``market_value − cost_basis``, or ``None`` without an observed price."""
    if market_value is None:
        return None
    return market_value - (cost_basis or 0.0)


def _sum(rows: Iterable[Dict[str, Any]], field: str) -> Optional[float]:
    values = [row[field] for row in rows if row.get(field) is not None]
    return sum(values) if values else None


def _sum_values(values: Iterable[Optional[float]]) -> Optional[float]:
    """:func:`_sum` over an iterable of values rather than a field of rows."""
    present = [value for value in values if value is not None]
    return sum(present) if present else None


def _product(left: Optional[float], right: Optional[float]) -> Optional[float]:
    return None if left is None or right is None else left * right


def _difference(left: Optional[float], right: Optional[float]) -> Optional[float]:
    return None if left is None or right is None else left - right


def _ratio(numerator: Optional[float],
           denominator: Optional[float]) -> Optional[float]:
    """``numerator / denominator``, or ``None`` when there is nothing to divide by."""
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def _first_value(rows: Sequence[Dict[str, Any]], field: str) -> Any:
    """First non-``None`` value of ``field`` across a symbol's rows."""
    for row in rows:
        value = row.get(field)
        if value is not None:
            return value
    return None


__all__ = [
    'AccountPosition', 'AccountSummary', 'SharePosition',
    'build_shares', 'build_accounts', 'latent_gains_by_account', 'unit_cost',
    'build_positions', 'build_portfolio_totals', 'ytd_base_day',
    'build_price_series', 'valuation_series', 'build_variation',
    'build_gain_total', 'variation_base_day',
]
