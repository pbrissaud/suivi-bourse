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
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

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


# --------------------------------------------------------------------- #
# The consolidated dashboard (issue #660, content #652 déc. 5–8)
#
# Everything below answers one page, and the shape of the answer is a
# **discriminated union** rather than one object with every field optional
# (#655 déc. 8). The three builders return plain dicts on purpose: a single
# dataclass carrying `gain_absolu` *and* `plus_value_latente`, each null in the
# other's mode, is precisely the "infer the mode from which fields are null"
# the discriminator exists to forbid — and it would put #652 déc. 6's two terms,
# which must never be conflated, in one namespace.
# --------------------------------------------------------------------- #

#: Declared accounts, one currency: the global perf series exists and the head
#: is **Gain** — total value − net contributed.
MODE_ACCOUNTS = 'accounts'

#: No declared accounts (or manual mode): the head falls back to **plus-value
#: latente**, computable from ``portfolio_metrics`` alone. This is what a default
#: install runs, so it is a designed mode, not a failure.
MODE_TITRES = 'titres'

#: Declared accounts in more than one currency. ``portfolio_totals`` is not
#: written at all in that case (``performance.compute_portfolio_total`` returns
#: ``None`` — pooling currencies needs FX, which is out of scope), so there is no
#: global head to render. The slot #655 déc. 8 reserved: the API **states** the
#: condition instead of answering with an empty head, and *what a consolidated
#: view of a mixed portfolio should show* stays the open product question it was.
MODE_MULTI_CURRENCY = 'multi_currency'


def portfolio_mode(
    account_currencies: Optional[Sequence[str]],
    events_mode: bool,
) -> str:
    """Which head this portfolio gets. Pure — the page's first decision.

    ``account_currencies`` is ``None`` when no ``accounts:`` block is declared,
    and the currencies of the declared accounts otherwise.

    The two conditions are #652 déc. 6's, read off their source: ``account_metrics``
    and ``portfolio_totals`` are written by ``update_account_metrics``, which
    returns early both when no ``Portfolio`` is declared *and* when the snapshot
    carries no events — so a declared ``accounts:`` block in manual mode produces
    no series either, and answering ``accounts`` there would leave the dashboard
    waiting forever on a computation that is never going to run.

    Deliberately decided from the **configuration**, never from whether the
    series happens to have rows. That is what keeps "no declared accounts" and
    "the perf job has not run yet" from rendering the same screen: the first is a
    mode, the second is a mode whose figures are still absent.
    """
    if not account_currencies or not events_mode:
        return MODE_TITRES
    return MODE_ACCOUNTS if len(set(account_currencies)) == 1 else MODE_MULTI_CURRENCY


def build_totals_head(
    row: Optional[Dict[str, Any]],
    currency: Optional[str],
    baseline_since: Optional[datetime] = None,
    baseline_value: Optional[float] = None,
) -> Dict[str, Any]:
    """The ``accounts`` head: one ``portfolio_totals`` row, made into a page.

    ``gain_absolu`` in euros is the headline (#652 déc. 5 — the eye looks for
    euros, not a rate), with net contributed under it and ``xirr`` / ``twr_index``
    as two rates answering two different questions. Grafana's
    ``Total Performance %`` is **deleted, not ported**: ``(val + div − inv) / inv``
    ignores cash and external flows, and a fourth calculation standing next to
    three correct ones is worse than a missing one.

    ``row`` is ``None`` when the series has no point yet — declared accounts
    whose first perf cycle has not run. Every figure is then ``null`` and
    ``as_of`` says so; the mode still says ``accounts``, because the mode is a
    property of the configuration and emptiness is a property of the data.
    """
    row = row or {}
    total = row.get('total_value')
    return {
        'mode': MODE_ACCOUNTS,
        'currency': currency,
        'as_of': _iso(row.get('time')),
        'total_value': total,
        'cash_balance': row.get('cash_balance'),
        'holdings_value': row.get('holdings_value'),
        'net_contributed': row.get('net_contributed'),
        'gain_absolu': row.get('gain_absolu'),
        'xirr': row.get('xirr'),
        'twr_index': row.get('twr_index'),
        'baseline': _baseline(total, baseline_value, baseline_since),
    }


def build_titres_head(shares: Sequence[SharePosition]) -> Dict[str, Any]:
    """The degraded head: **plus-value latente**, from ``portfolio_metrics``.

    Not an error state — it is what every install without a declared
    ``accounts:`` block shows, which is the default one. And the figure is
    deliberately *not* called Gain: Gain is total value − net contributed and
    needs declared accounts and events, while this is holdings + dividends −
    invested − fees. #652 déc. 6 exists to keep the two apart, so they never
    share a field name here either.

    ``baseline`` is ``null`` and stays so. A relative delta would need each
    position's *quantity* at the baseline instant as well as its price, and
    valuing today's holdings at an old price would announce a move that is
    partly a purchase. The honest answer is no delta rather than a wrong one.
    """
    holdings = _sum_values(s.market_value for s in shares)
    invested = _sum_values(s.invested for s in shares)
    dividends = _sum_values(s.received_dividend for s in shares)
    fees = _sum_values(s.purchased_fee for s in shares)
    plus_value = _plus_value(holdings, dividends, invested, fees)

    times = [s.price_time for s in shares if isinstance(s.price_time, datetime)]
    return {
        'mode': MODE_TITRES,
        'currency': _single_currency(s.currency for s in shares),
        'as_of': _iso(max(times)) if times else None,
        'holdings_value': holdings,
        'invested': invested,
        'received_dividend': dividends,
        'purchased_fee': fees,
        'plus_value_latente': plus_value,
        'plus_value_pct': _ratio(plus_value, invested),
        'baseline': None,
    }


def build_multi_currency_head(accounts: Sequence[Any]) -> Dict[str, Any]:
    """The third case: declared accounts that do not share a currency.

    States the condition and names the accounts, and stops there. There is no
    global series to read — and inventing one by summing the per-account figures
    would be adding euros to dollars, which is exactly what
    ``compute_portfolio_total`` refuses to do.
    """
    return {
        'mode': MODE_MULTI_CURRENCY,
        'currencies': sorted({a.currency for a in accounts if a.currency}),
        'accounts': [
            {'id': a.id, 'label': a.label, 'currency': a.currency}
            for a in accounts
        ],
    }


# --------------------------------------------------------------------- #
# The accounts page (issue #661, content #652 déc. 13)
# --------------------------------------------------------------------- #

@dataclass(frozen=True)
class AccountSummary:
    """One row of the accounts comparison table.

    A **declaration joined to an observation**, and the join direction is the
    decision: the declaration drives. #652 déc. 4 settled where the account list
    comes from (``settings.yaml``, not ``DISTINCT account``), and it decides two
    cases at once here — a declared account whose perf cycle has not run yet is a
    row with an em dash in every figure rather than a missing line, and a series
    left behind by an account since removed from the declaration is not a row at
    all.

    ``label``, ``type`` and ``currency`` come from the declaration too, never
    from the ``account_type`` / ``account_currency`` tags that ride the series.
    The tags record what the account *was* when the point was written; the
    declaration is what it is. Trap 14 is the same rule seen from the other end —
    the baseline reads neither and hardcodes ``currencyEUR``.
    """

    id: str
    label: Optional[str]
    type: Optional[str]
    currency: Optional[str]
    #: The day the figures below describe — ``None`` when nothing was written
    #: yet. Trap 2: the newest point is *today's*, and it is rewritten in place
    #: through the day, so this is a day rather than an instant.
    as_of: Optional[datetime]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    gain_absolu: Optional[float]
    xirr: Optional[float]
    twr_index: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'label': self.label,
            'type': self.type,
            'currency': self.currency,
            'as_of': _iso(self.as_of),
            'cash_balance': self.cash_balance,
            'holdings_value': self.holdings_value,
            'total_value': self.total_value,
            'net_contributed': self.net_contributed,
            'gain_absolu': self.gain_absolu,
            'xirr': self.xirr,
            'twr_index': self.twr_index,
        }


def build_accounts(
    declared: Sequence[Any],
    rows: Sequence[Dict[str, Any]],
) -> List[AccountSummary]:
    """Join the declared accounts to their newest ``account_metrics`` row.

    ``declared`` is ``Portfolio.accounts`` — the ``Account`` objects of the
    published snapshot (#658) — and ``rows`` is
    :meth:`influx_reads.PortfolioReader.latest_account_metrics`'s output.

    Declaration order is kept: it is the order the human wrote in
    ``settings.yaml``, which is a better default than any sort this module could
    invent, and the table sorts on demand anyway.

    Nothing is summed across accounts here, deliberately. The consolidated
    figures have exactly one source — ``portfolio_totals``, read by
    :func:`build_totals_head` — and a second arithmetic path to the same number
    is how the two would eventually disagree. It would also be *wrong* the
    moment the currencies differ, which is the very condition that makes
    ``portfolio_totals`` absent.
    """
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
            type=getattr(account, 'type', None),
            currency=getattr(account, 'currency', None),
            as_of=row.get('time'),
            cash_balance=row.get('cash_balance'),
            holdings_value=row.get('holdings_value'),
            total_value=row.get('total_value'),
            net_contributed=row.get('net_contributed'),
            gain_absolu=row.get('gain_absolu'),
            xirr=row.get('xirr'),
            twr_index=row.get('twr_index'),
        ))
    return summaries


# --------------------------------------------------------------------- #
# The main chart: total value vs net contributed (#652 déc. 7)
# --------------------------------------------------------------------- #

def valuation_series(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fold per-``(day, symbol, account)`` closing rows into a daily portfolio.

    The degraded main chart's arithmetic, and the forward-fill is the reason it
    is here rather than in the SQL. A symbol whose exchange was shut on a day the
    others traded has **no row** for that day, and a `GROUP BY day` would then
    quietly drop it from that day's total — so a French holiday would show up as
    the whole portfolio losing the value of its French shares and getting it back
    the next morning. Carrying each series' last known state forward is what
    makes the curve a valuation rather than a map of exchange calendars.

    Rows arrive already reduced to one per ``(day, symbol, account)`` by
    :meth:`influx_reads.PortfolioReader.daily_position_series` — that reduction
    *is* SQL's job, since summing raw 120-second points would multiply the
    portfolio by its polling rate.
    """
    by_day: Dict[Any, List[Dict[str, Any]]] = {}
    for row in rows:
        day = row.get('day')
        if day is None:
            continue
        by_day.setdefault(day, []).append(row)

    state: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    series: List[Dict[str, Any]] = []
    for day in sorted(by_day):
        for row in by_day[day]:
            state[(row.get('share_symbol'), str(row.get('account') or 'default'))] = row
        held = list(state.values())
        series.append({
            't': _iso(day),
            'value': _sum_products(held, 'owned_quantity', 'share_price'),
            'invested': _sum_products(held, 'purchased_quantity', 'purchased_price'),
        })
    return series


# --------------------------------------------------------------------- #
# Movers (#652 déc. 8)
# --------------------------------------------------------------------- #

@dataclass(frozen=True)
class Mover:
    """One share's move since the previous session close."""

    symbol: str
    name: Optional[str]
    currency: Optional[str]
    price: Optional[float]
    previous_price: Optional[float]
    change: Optional[float]
    change_pct: Optional[float]
    market_value: Optional[float]
    #: What the move did to the portfolio in money: ``change × owned_quantity``.
    #: A 12 % jump on a token holding and a 0.4 % drift on the biggest line are
    #: not the same news, and a percentage column alone cannot say which.
    contribution: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'currency': self.currency,
            'price': self.price,
            'previous_price': self.previous_price,
            'change': self.change,
            'change_pct': self.change_pct,
            'market_value': self.market_value,
            'contribution': self.contribution,
        }


def session_baseline_instant(newest: datetime) -> datetime:
    """The instant "since the last session close" resolves to: midnight UTC of
    the day the newest observation falls in.

    #652 déc. 8's trap, and it is worth spelling out why this simple rule answers
    it. *"Today" is meaningless on a weekend*: on a Sunday, midnight-today is
    after every price the portfolio holds, so a delta measured from it is
    uniformly zero and the block goes blank on the two days a week someone
    actually sits down to look at it. Anchoring on the newest **observation**
    instead of on the clock makes a Sunday read Friday's session, which is what
    "since the last close" means.

    One instant for the whole portfolio, not one per symbol, and that stays
    correct across exchanges: a share whose market has not opened today has its
    last point on an earlier day, so the last point ≤ this instant *is* that same
    point and it reports a change of zero — which is the truth, it has not traded.

    Known limitation: a session that straddles UTC midnight (Sydney) would have
    its baseline fall inside itself. No such exchange is in reach of this
    portfolio today, and the fix would be a market calendar — the thing #616
    already declined to carry.
    """
    utc = newest.astimezone(timezone.utc) if newest.tzinfo else newest
    return datetime(utc.year, utc.month, utc.day, tzinfo=timezone.utc)


def baseline_reference(baseline_rows: Sequence[Dict[str, Any]]) -> Optional[datetime]:
    """The newest observation the baseline is actually built from.

    Found by looking at the page. :func:`session_baseline_instant` returns a
    *cut* — midnight of the newest day — and labelling the block with it read
    « depuis la clôture du 5 août » on the afternoon of 5 August, announcing a
    close that had not happened. The cut is the rule; it is not a session.

    The rows carry the answer already, since ``values_at`` selects ``time``
    alongside the value: the newest of those timestamps *is* an observed price,
    and it lies at or before the cut by construction — so it is the last close
    the comparison rests on, and naming it is a statement about data rather than
    about the calendar.
    """
    times = [
        row.get('time') for row in baseline_rows
        if isinstance(row.get('time'), datetime)
    ]
    return max(times) if times else None


def build_movers(
    shares: Sequence[SharePosition],
    baseline_rows: Sequence[Dict[str, Any]],
) -> List[Mover]:
    """Rank the portfolio by its move since ``session_baseline_instant``.

    ``baseline_rows`` is ``values_at``'s output — one row per symbol carrying its
    last price at or before that instant.

    A share with no baseline (its first day) or no current price is **left out**
    rather than shown at zero: it has not failed to move, it has nothing to
    compare against, and a zero in a movers list is a claim. It still appears in
    the allocation block, which needs no history.
    """
    baseline = {
        row.get('share_symbol'): row.get('share_price')
        for row in baseline_rows
        if row.get('share_symbol') and row.get('share_price') is not None
    }

    movers = []
    for share in shares:
        previous = baseline.get(share.symbol)
        change = _difference(share.price, previous)
        if change is None:
            continue
        movers.append(Mover(
            symbol=share.symbol,
            name=share.name,
            currency=share.currency,
            price=share.price,
            previous_price=previous,
            change=change,
            change_pct=_ratio(change, previous),
            market_value=share.market_value,
            contribution=_product(change, share.owned_quantity),
        ))

    # Biggest riser first, biggest faller last — the front takes both ends.
    movers.sort(key=lambda m: (m.change_pct is None, -(m.change_pct or 0.0)))
    return movers


def _baseline(
    current: Optional[float],
    previous: Optional[float],
    since: Optional[datetime],
) -> Optional[Dict[str, Any]]:
    """The head's relative delta — #652 déc. 2's UI preference, made a payload.

    ``None`` when the caller asked for no baseline. When it asked and there is
    nothing stored that early, ``previous`` is ``null`` and so are the deltas:
    the portfolio did not exist yet, and calling that a gain of its entire value
    is the exact shape of mistake trap 3 is about.
    """
    if since is None:
        return None
    change = _difference(current, previous)
    return {
        'since': _iso(since),
        'total_value': previous,
        'change': change,
        'change_pct': _ratio(change, previous),
    }


def _single_currency(values: Iterable[Optional[str]]) -> Optional[str]:
    """The one currency in play, or ``None`` when they disagree.

    ``None`` makes the front render a bare number instead of guessing EUR —
    which is trap 14, and precisely what the Grafana baseline does by hardcoding
    ``currencyEUR`` in every panel unit.
    """
    found = {value for value in values if value}
    return found.pop() if len(found) == 1 else None


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


def _sum_values(values: Iterable[Optional[float]]) -> Optional[float]:
    """:func:`_sum` over an iterable of values rather than a field of rows."""
    present = [value for value in values if value is not None]
    return sum(present) if present else None


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
    'AccountPosition', 'AccountSummary', 'SharePosition', 'Mover',
    'build_shares', 'build_share', 'build_accounts', 'weighted_cost_price',
    'MODE_ACCOUNTS', 'MODE_TITRES', 'MODE_MULTI_CURRENCY', 'portfolio_mode',
    'build_totals_head', 'build_titres_head', 'build_multi_currency_head',
    'valuation_series', 'session_baseline_instant', 'baseline_reference',
    'build_movers',
]
