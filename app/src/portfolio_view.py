"""Pure view logic for the web UI (issue #659, rewritten to v5's shape by #700).

Rows in, page objects out — in the exact taste of :mod:`scheduling` and
:mod:`performance`: no store import, no Flask import, no clock. That is what
lets the arithmetic below be tested with literal lists, which matters because
the arithmetic is where the money is.

The module exists because :meth:`store_reads.PortfolioReader.positions`
deliberately returns the per-account rows instead of ``SUM``-ing them away in
SQL. Grafana aggregates inside the query, which is precisely why no panel of the
baseline can show the breakdown (#652 déc. 6); aggregating here means the table
row *and* the sheet's breakdown come from one read.

**A position is a quantity and a cost basis** (ADR-0003), and three things fall
out of that here rather than being defended by branches:

* the unit cost is **derived**, by :func:`events.schemas.unit_cost` and by
  nothing else, so a sold position's is honestly undefined instead of zero;
* what was invested **is** ``cost_basis``, so a fully sold line reports zero
  invested by construction — the phantom −932 € of #672 has no expression left;
* the latent gain is ``market_value − cost_basis`` and **carries neither
  dividends nor fees**. It is one of three named figures, not a composite: the
  realized gain and the dividends received are the other two, and each has its
  own domain (spec #695 § 8).

**A position with no price is carried at its cost** (issue #706, ADR-0004), and
the builders below take the set of symbols that qualifies — the ones whose
backfill is terminal. What they do with it is the ticket's fifth criterion: the
**price** column stays the em dash, because the app does not invent a quote,
while **value** and **latent gain** are computed from the carrying price. That
asymmetry is what makes the sum of the rows equal the total on the dashboard,
which reads the same :func:`carrying.carrying_price` through
:mod:`performance`. What qualifies is a position **no cours was observed for** —
``price_native``, not the converted column: a quote whose rate has not landed is
*waiting*, and the two absences are never rendered alike.

The trap a contributor will break is stated once, here and in the docs: **the
realized gain is a decomposition of the absolute gain, never a term added to
it.** The proceeds of a sale are already in the cash balance.
"""
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import (
    Any, Callable, Collection, Dict, Iterable, List, Mapping, Optional, Sequence,
)

from carrying import carrying_price, was_quoted

#: Fields summed straight across a share's accounts. All three are *amounts* or
#: quantities of the same instrument, so adding them is meaningful — unlike the
#: instrument's own attributes (``dividend_yield``, ``pe_ratio``,
#: ``market_cap``), which describe the security and not the holding: owning the
#: same ETF in a PEA and a CTO does not double its market capitalisation. Those
#: are read off the row that carries them, never summed.
_ADDITIVE = ('quantity', 'cost_basis', 'realized_gain', 'received_dividend')


def unit_cost(quantity: Optional[float],
              cost_basis: Optional[float]) -> Optional[float]:
    """The weighted-average unit price — the one division, re-exported.

    A thin alias of :func:`events.schemas.unit_cost` so this module stays free
    of the events package (importing it pulls pandas and openpyxl into a pure
    view module). The rule it carries is the French tax one (CGI art. 150-0 D)
    and it has no dial: ``cost_basis / quantity``, and ``None`` when nobody holds
    any — a position with no quantity has no unit cost, it has a realized gain.

    Summed across accounts this *is* the weighted mean: ``Σ cost_basis /
    Σ quantity``. A share bought 1 × 100 € and 9 × 200 € cost 190 € a share, not
    300 € and not 150 € — the two answers a plain sum and a plain mean give, both
    of which look like prices.
    """
    if not quantity:
        return None
    return (cost_basis or 0.0) / quantity


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
    """One row of the shares table: a share aggregated across its accounts.

    ``symbol`` is the identity and ``name`` is display only (#652 déc. 3). The
    Grafana baseline keys every per-share panel on the name, so a rename splits
    a continuous series in two; here the name lives on the **position**, written
    by the replay from the owner's own file, and renaming a share cannot touch
    its price history at all — the two no longer share a row (#700).
    """

    symbol: str
    name: Optional[str]
    currency: Optional[str]
    exchange: Optional[str]
    quote_type: Optional[str]
    #: The **converted** price — every money figure below is in the reporting
    #: currency (issue #702), and ``None`` while that currency is unanswered.
    price: Optional[float]
    #: The quote as the exchange gives it, and the rate that turned it into the
    #: figure above. They ride here so a reader can recognise what their broker
    #: shows them, and so the conversion can be read back rather than believed
    #: (*"2 345 € — 10 × 234,50 $ at 1,0844"*). Neither is ever summed.
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
    # #659 reserved a `status` slot here for #656's live scheduler state. #656
    # decision 6 **retired it rather than filling it**, and the reason is this
    # module's own error contract read one storey up: `/api/shares` is a query,
    # so the blueprint answers 503 when it fails — and a pill riding on this
    # payload would vanish exactly when it is the only thing able to explain the
    # empty table. The pills live on `GET /api/runtime`, which reads no store.

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
            'price_time': _iso(self.price_time),
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
    """Fold P1's per-``(account, symbol)`` rows into one entry per share.

    ``carried`` is the set of symbols whose backfill is terminal (issue #706).
    It defaults to empty, which is the honest default: carrying a position at its
    cost while its history is still being fetched is the one thing ADR-0004
    forbids, so a caller that has not established the second term gets none of it.
    """
    by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        symbol = row.get('symbol')
        if not symbol:
            continue
        by_symbol.setdefault(symbol, []).append(row)

    return [_build_share(symbol, group, symbol in carried)
            for symbol, group in sorted(by_symbol.items())]


def build_share(rows: Sequence[Dict[str, Any]], symbol: str,
                carried: Collection[str] = ()) -> Optional[SharePosition]:
    """The single-share form, for the detail sheet. ``None`` when unknown."""
    group = [row for row in rows if row.get('symbol') == symbol]
    return _build_share(symbol, group, symbol in carried) if group else None


def _build_share(symbol: str, group: List[Dict[str, Any]],
                 carry: bool = False) -> SharePosition:
    """Aggregate one symbol's per-account rows into a table row + breakdown.

    Every market column comes from the same source for every row of the group —
    the join is on the symbol, and a price belongs to no account — so "the
    price of this share" is simply read off the first row rather than combined.
    That is the account dimension leaving the series, seen from the reader's
    side: there is nothing left to reconcile between two accounts' observations.

    ``carry`` says this symbol's backfill is terminal, which is the second term
    of ADR-0004's predicate; :func:`carrying.carrying_price` supplies the first,
    and it is handed **``price_native``** for it rather than being left to read
    the converted price alone (issue #706). A row that carries a native quote and
    no converted one is *waiting for a rate*, which is a different absence from
    *carried at cost* and must not be rendered as one — and it is a durable state,
    not a blink, for as long as a pair fails to resolve.

    Note what is **not** done with the answer: ``price`` keeps the observed
    value, ``None`` and all, so the column stays an em dash — the app states a
    convention, it does not invent a quote. The valuation figures below take the
    carrying price instead, ``unit_gain`` included, since that is the per-share
    form of ``plus_value_latente`` and the two cannot honestly disagree.
    """
    accounts = [_build_account(row, carry) for row in sorted(
        group, key=lambda row: str(row.get('account') or ''))]

    totals = {field: _sum(group, field) for field in _ADDITIVE}
    quantity = totals['quantity']
    cost_basis = totals['cost_basis']

    quote = group[0]
    price = quote.get('price')
    carried_at = (
        carrying_price(price, quote.get('price_native') is not None,
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

#: Declared accounts: the global perf series exists and the head is **Gain** —
#: total value − net contributed.
MODE_ACCOUNTS = 'accounts'

#: No declared accounts: the head falls back to **plus-value latente**,
#: computable from the positions and their quotes alone. This is what a default
#: install runs, so it is a designed mode, not a failure.
MODE_TITRES = 'titres'

# ``MODE_MULTI_CURRENCY`` and ``build_multi_currency_head`` are **gone** (issue
# #702, ADR-0002), and deleted rather than left unreachable. There are two levels
# of currency and not three — the reporting currency and the security's quote
# currency — so "declared accounts that do not share a currency" is a sentence
# with no referent: an account has no currency to disagree about. The third mode
# was a whole branch of the API, of the page and of the tests defending a state
# the model can no longer be in, and a mode that is published but cannot occur is
# something a front will eventually handle for nothing.


def portfolio_mode(declared: bool) -> str:
    """Which head this portfolio gets. Pure — the page's first decision.

    Decided from the **configuration**, never from whether the series happens to
    have rows: that is what keeps "no declared accounts" and "the perf job has
    not run yet" from rendering the same screen.

    One question since #702, where it used to be two. It took a list of account
    currencies because a third mode turned on their disagreeing; with the
    per-account currency deleted, what is left is the only thing the decision
    ever really rested on — is there a declaration.
    """
    return MODE_ACCOUNTS if declared else MODE_TITRES


def build_totals_head(
    row: Optional[Dict[str, Any]],
    currency: Optional[str],
    baseline_since: Optional[datetime] = None,
    baseline_value: Optional[float] = None,
) -> Dict[str, Any]:
    """The ``accounts`` head: one ``portfolio_totals`` row, made into a page.

    ``gain_absolu`` in euros is the headline (#652 déc. 5 — the eye looks for
    euros, not a rate), with net contributed under it and ``xirr`` /
    ``twr_index`` as two rates answering two different questions.

    ``row`` is ``None`` when the series has no point yet — declared accounts
    whose first perf cycle has not run. Every figure is then ``null`` and
    ``as_of`` says so; the mode still says ``accounts``, because the mode is a
    property of the configuration and emptiness a property of the data.
    """
    row = row or {}
    total = row.get('total_value')
    return {
        'mode': MODE_ACCOUNTS,
        'currency': currency,
        'as_of': _iso(row.get('day')),
        'total_value': total,
        'cash_balance': row.get('cash_balance'),
        'holdings_value': row.get('holdings_value'),
        'net_contributed': row.get('net_contributed'),
        'gain_absolu': row.get('gain_absolu'),
        'xirr': row.get('xirr'),
        'twr_index': row.get('twr_index'),
        'baseline': _baseline(total, baseline_value, baseline_since),
    }


def build_titres_head(shares: Sequence[SharePosition],
                      currency: Optional[str] = None) -> Dict[str, Any]:
    """The degraded head: the three named figures, from the positions alone.

    Not an error state — it is what every install without a declared account
    shows, which is the default one. And ``plus_value_latente`` is deliberately
    *not* called Gain: Gain is total value − net contributed and needs declared
    accounts and events. #652 déc. 6 exists to keep the two apart, so they never
    share a field name here either.

    The realized gain and the dividends ride beside it rather than inside it,
    which is the whole of #672's correction: one composite figure became three
    named ones, each with its own domain, and adding them here would rebuild the
    composite under a new name.

    ``baseline`` is ``null`` and stays so. A relative delta would need each
    position's *quantity* at the baseline instant as well as its price, and
    valuing today's holdings at an old price would announce a move that is
    partly a purchase.

    ``currency`` is the **reporting** currency and arrives as an argument (issue
    #702). It used to be derived from the shares' own quote currencies, which was
    the three-level model showing through: two accounts in EUR holding only
    USD-quoted securities produced a head labelled ``USD`` over figures whose
    cost basis was in euros. It is ``None`` while the question is unanswered, and
    that ``None`` is what the page says the condition with.
    """
    holdings = _sum_values(share.market_value for share in shares)
    cost_basis = _sum_values(share.cost_basis for share in shares)
    dividends = _sum_values(share.received_dividend for share in shares)
    realized = _sum_values(share.realized_gain for share in shares)
    plus_value = _latent(holdings, cost_basis)

    times = [share.price_time for share in shares
             if isinstance(share.price_time, datetime)]
    return {
        'mode': MODE_TITRES,
        'currency': currency,
        'as_of': _iso(max(times)) if times else None,
        'holdings_value': holdings,
        'cost_basis': cost_basis,
        'received_dividend': dividends,
        'realized_gain': realized,
        'plus_value_latente': plus_value,
        'plus_value_pct': _ratio(plus_value, cost_basis),
        'baseline': None,
    }


# --------------------------------------------------------------------- #
# The v5 contract: the hot read, and the global perf cache (#745, issue #763)
#
# Two builders, and neither aggregates anything. That is the difference with
# everything above: the v4 pages asked the server for a *page* — a head, a
# folded shares table, a movers block — while the v5 front asks for the
# **store's own nouns** and does the folding itself (`lib/gain.ts` computes the
# four terms, `lib/absence.ts` classifies the three absences). So what is left
# for a pure module here is naming and shape, plus the one arithmetic no client
# can do without a second request: the year-to-date, which needs a row of the
# series the payload does not otherwise carry.
# --------------------------------------------------------------------- #

def build_positions(rows: Sequence[Dict[str, Any]],
                    base_currency: Optional[str]) -> List[Dict[str, Any]]:
    """P1's rows as ``GET /api/positions`` publishes them (#745).

    **One row per ``(account, symbol)``, folded nowhere.** ``/api/shares``
    aggregates because a *table of shares* is what it serves; this resource is
    named after the ``position`` table and hands back what that table holds, the
    per-account detail included — the head sums it, the shares page will fold it,
    and both read one query and one client cache.

    A **sold** position (``quantity`` 0) travels like any other: it stays in the
    table (ADR-0017) and its realized gain is the figure it has left to say. So
    does a position whose symbol has never been fetched — P1's join is a LEFT
    one, so every market column is ``NULL`` and the row is *a line with no
    price*, never a line that is missing.

    The **price and its conversion are two objects**, and that is the shape
    carrying the distinction (#712 §11): ``price`` non-null with ``converted``
    null is *quoted, and the rate has not landed*, while ``price`` null is *never
    observed* — a position carried at its cost (ADR-0004). A single nullable
    number cannot tell the two apart, and they are not rendered alike.
    """
    return [_build_position(row, base_currency) for row in rows]


def _build_position(row: Dict[str, Any],
                    base_currency: Optional[str]) -> Dict[str, Any]:
    """One P1 row on the wire.

    ``realised`` / ``dividends`` are the client's names for the store's
    ``realized_gain`` / ``received_dividend``: the translation is here, once,
    rather than in a component.

    ``at`` is the same instant on both objects, and deliberately: the rate stored
    beside a price is the rate that price was multiplied by (#702), observed in
    the same pass, so there is no second timestamp to report and inventing one
    would suggest a conversion done later than the quote it converts.

    ``price.currency`` is the instrument's own, as ``symbol_quote`` observed it,
    and it can be absent on a symbol only the **backfill** has ever written — the
    range writer moves the ``last_*`` columns and refreshes no attribute, and
    since #699 a sold line is reconstructed and never polled. Suppressing the
    whole price for want of its label would be the worse answer: it turns
    *quoted* into *never quoted*, which is the one distinction the pair of
    objects exists to carry.

    ``closed_at`` is the day the position reached zero and ``null`` while it is
    held — the shares page's folded section **sorts on it** (#719), and it is the
    only column that discriminates those rows, market value being zero across the
    whole section and a column of zeros ordering nothing. No derivation is
    available on the client either: a position carries a quantity, never the
    event that emptied it. The predicate lives in the SQL beside the sale it
    reads (:meth:`store_reads.PortfolioReader.positions`).
    """
    price_native = row.get('price_native')
    converted = row.get('price')
    at = _iso(row.get('price_time'))
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
        # The **reporting** currency, read once for the payload rather than per
        # row: there is one, and a row claiming another would be the third
        # currency level #702 deleted.
        'converted': None if converted is None else {
            'value': converted,
            'currency': base_currency,
            'rate': row.get('fx_rate'),
            'rate_at': at,
        },
        'closed_at': _iso(row.get('closed_at')),
    }


def build_price_series(symbol: str, rows: Sequence[Dict[str, Any]],
                       resolution: str,
                       base_currency: Optional[str]) -> Dict[str, Any]:
    """One symbol's series as ``GET /api/prices/<symbol>`` publishes it (#719).

    ``resolution`` is **announced and never guessed**, and it is passed in rather
    than worked out here: what was served is a fact about the query that ran, so
    the one place that can state it is the one that chose it
    (:func:`store_reads.chart_window`). A reader deducing it from the spacing of
    the points would be reading an outage into an archive whose fineness is a
    function of age (ADR-0010) — and it is announced **once**, the chart's
    *aggregated by X* caption reading this field instead of stating a second
    bucketing of its own.

    ``price`` is in the **reporting currency** and ``null`` means *quoted, and
    the rate never resolved* — never a missing point. That is the difference
    between this resource and ``/api/shares/<symbol>/prices``, which drops the
    point: here the gap of a weekend (no row at all) and the gap of a conversion
    (a row with no price) are two different pieces of news, and only the second
    one repairs itself.
    """
    return {
        'symbol': symbol,
        'base_currency': base_currency,
        'resolution': resolution,
        'points': [{'ts': _iso(row.get('ts')), 'price': row.get('price')}
                   for row in rows],
    }


def ytd_base_day(day: date) -> date:
    """The day the year-to-date counts from: 31 December of the previous year.

    Pure and named, because it *is* the decision (issue #763) rather than an
    index into a list: the base has to be a state the measured year has not
    touched, and the argument against the other bound is written on
    :meth:`store_reads.PortfolioReader.totals_on_or_before`, which consumes it.

    The year is the one of the row the payload describes, never the wall clock's:
    the resource is a statement about that day, and a clock read here would let a
    series that stops in December be compared against a base *after* its own
    latest row.
    """
    return date(day.year - 1, 12, 31)


def build_portfolio_totals(
    latest: Optional[Dict[str, Any]],
    base: Optional[Dict[str, Any]],
    twr_since: Optional[date],
    transfer_fees: Optional[float],
) -> Optional[Dict[str, Any]]:
    """One ``portfolio_totals`` row plus its three derived members (#745).

    ``None`` — the payload's ``totals: null`` — when the series has no point at
    all, which has **two** causes and one shape: no ledger, or no reporting
    currency answered (the perf job writes nothing at all until it is, every
    figure it computes being money). Not ``[]`` and not a ``404``: the resource
    exists and has nothing to report.

    ``gain_absolu`` rides along and **is not read by the head**, which computes
    the total from ADR-0018's four terms; it is here so a report can quote both
    numbers, and a divergent value proves the page ignores it.

    ``ytd`` is ``null`` **if and only if** the series does not reach the base —
    the one state the reconstruction degrades, and everything above it is exact
    from the first cycle. That is why an unwritable *member* of the pair stays a
    ``null`` member inside a present object: a failed division is not the same
    news as a history that has not been rebuilt that far back.
    """
    if latest is None:
        return None

    payload = {name: latest.get(name) for name in _TOTALS_MEMBERS}
    payload['day'] = _iso(latest.get('day'))
    payload['twr_since'] = _iso(twr_since)
    payload['transfer_fees'] = transfer_fees
    payload['ytd'] = _ytd(latest, base)
    return payload


#: The members ``portfolio_totals`` carries as columns, in the order #745 writes
#: them. ``day`` is handled apart, being a date rather than a figure.
_TOTALS_MEMBERS = (
    'total_value', 'holdings_value', 'cash_balance', 'net_contributed',
    'xirr', 'twr_index', 'gain_absolu',
)


def _ytd(latest: Dict[str, Any],
         base: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The year-to-date pair, or ``None`` when the series does not reach the base.

    ``gain`` is the movement of ``gain_absolu``, which **is** the movement of
    value minus the movement of contributions — ``gain_absolu = total_value −
    net_contributed``, so the difference of the differences and the difference
    of the gains are one quantity, not two readings of it. Subtracting the
    contributions is the whole figure: without that term a deposit made in
    January reads as performance, and the measured case would print
    ``+6 713,69 €`` instead of ``+40,69 €``. It is pinned to the cent in
    ``test_web_api.py``, against ``−1,25 %`` of time-weighted return over the
    same period — opposite signs, both correct, because the portfolio grew by
    6 673 € of deposits while its holdings lost 1,25 %.

    Spelling it on ``gain_absolu`` rather than on the pair is what makes it
    **defined more often**, and that is the reason for the spelling rather than
    a side effect of it: since #708 the two terms it would otherwise subtract
    are ``NULL`` on an install carrying no cash event, while ``gain_absolu`` is
    written **always** (ADR-0018). Written the other way round, an ordinary v4
    arrival — no ``DEPOSIT`` anywhere, v4 having no cash events at all — got a
    present ``ytd`` object whose members were both ``null``, and the head read
    that as *the history is not rebuilt that far back* under a portfolio whose
    history is complete.

    ``twr`` stays a ratio of two base-100 indices, which is what makes it
    period-relative without any rebasing: ``index / index_base − 1``. It has no
    such repair and needs none: ``twr_index`` follows ``total_value``, so on
    that same install the time-weighted return is genuinely not computable —
    an em dash there says *there is nothing to compute* (ADR-0016) and is the
    truth, which is why the pair keeps two members that can fail apart.
    """
    if base is None:
        return None
    return {
        'gain': _difference(latest.get('gain_absolu'),
                            base.get('gain_absolu')),
        'twr': _relative(latest.get('twr_index'), base.get('twr_index')),
    }


def _relative(index: Optional[float],
              base: Optional[float]) -> Optional[float]:
    """``index / base − 1``, and ``None`` rather than a division by zero.

    A base-100 index cannot legitimately be zero — it is a chained product of
    ``1 + r`` — so a zero here is a series that has not been computed, and the
    honest answer is that there is no figure.
    """
    if index is None or not base:
        return None
    return index / base - 1.0


# --------------------------------------------------------------------- #
# The accounts page (issue #661, content #652 déc. 13)
# --------------------------------------------------------------------- #

@dataclass(frozen=True)
class AccountSummary:
    """One row of the accounts comparison table.

    A **declaration joined to an observation**, and the join direction is the
    decision: the declaration drives. It settles two cases at once — a declared
    account whose perf cycle has not run yet is a row of em dashes rather than a
    missing line, and a series left behind by an account since removed from the
    declaration is not a row at all.

    ``label`` and ``type`` come from the declaration, never from the series: the
    series records what the account *was* when the point was written, the
    declaration is what it is. Since #700 the series does not even carry them —
    ``account_type`` and ``account_currency`` were InfluxDB tags, and the store
    has no column for either.

    There is no ``currency`` on the row at all since #702. An account has none:
    there is one reporting currency for the whole install, and it is the
    collection's business rather than each row's — a per-row currency here is
    precisely the third level ADR-0002 deletes, and it would let a comparison
    table put two units in one column.
    """

    id: str
    label: Optional[str]
    type: Optional[str]
    #: The day the figures below describe — ``None`` when nothing was written
    #: yet. A **day**, not an instant: today's point is rewritten in place
    #: through the day as prices move.
    as_of: Optional[date]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    gain_absolu: Optional[float]
    xirr: Optional[float]
    twr_index: Optional[float]
    #: Where the declaration came from: the import that carried it, or ``None``
    #: for one created in the app (issue #698). It rides on the row because the
    #: page has to render the difference — what came from a file is read-only.
    source_id: Optional[int] = None

    @property
    def editable(self) -> bool:
        return self.source_id is None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'label': self.label,
            'type': self.type,
            'source_id': self.source_id,
            'editable': self.editable,
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

    Nothing is summed across accounts here, deliberately. The consolidated
    figures have exactly one source — ``portfolio_totals`` — and a second
    arithmetic path to the same number is how the two would eventually disagree.
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
            as_of=row.get('day'),
            cash_balance=row.get('cash_balance'),
            holdings_value=row.get('holdings_value'),
            total_value=row.get('total_value'),
            net_contributed=row.get('net_contributed'),
            gain_absolu=row.get('gain_absolu'),
            xirr=row.get('xirr'),
            twr_index=row.get('twr_index'),
            source_id=getattr(account, 'source_id', None),
        ))
    return summaries


# --------------------------------------------------------------------- #
# The main chart: value vs invested (#652 déc. 7)
# --------------------------------------------------------------------- #

def valuation_series(
    closes: Sequence[Dict[str, Any]],
    positions_at: Callable[[date], Sequence[Dict[str, Any]]],
    carried_in: Optional[Dict[str, float]] = None,
    carried: Collection[str] = (),
    first_quoted: Optional[Mapping[str, date]] = None,
) -> List[Dict[str, Any]]:
    """The daily valuation curve, from the day's closes and the day's holdings.

    The shape this function has is #700's, and it is the ticket in one place:
    the price and the position stopped sharing a row, so a valuation is a
    **join** of two things that are true of the same day rather than a read of
    one. ``closes`` is one row per ``(day, symbol)`` out of the price series;
    ``positions_at`` is the replay, which answers *what was held on that day*
    and has no gaps by construction.

    The **forward-fill on the price** is what makes the curve a valuation rather
    than a map of exchange calendars: a symbol whose market was shut on a day
    the others traded has no row for it, and dropping it from that day's total
    would show the portfolio losing the value of its French shares on a French
    holiday and getting it back the next morning. Carrying each symbol's last
    known close forward is the fix, and it is pure logic, so it is tested with
    literal lists.

``carried_in`` is each symbol's last close **before** the window, and it is
    not an optimisation. The holdings come from the replay, which knows nothing
    of the window, while the prices come from a bounded read — so without it a
    symbol whose last close predates ``from`` counts its whole cost in
    ``invested`` and nothing at all in ``value``, and the curve reports a loss
    of that position's entire worth for as long as the window's left edge sits
    after its last quote. The two terms have to be bounded the same way, and the
    price is the one that can be carried.

    A symbol held on a day for which **no close has ever been seen** — carried in
    or not — used to contribute nothing to ``value`` while contributing its cost
    to ``invested``, and that was the crater: the curve fell by the whole
    purchase on the day of the purchase and climbed back the next morning. #706
    fills it, and ``carried`` is the second term of the rule that does — the set
    of symbols whose backfill is terminal. A symbol still being reconstructed is
    not in it, so its priceless days stay hollow rather than flat-at-cost, which
    is the misreading ADR-0004 exists to prevent.

    ``first_quoted`` is the **first** term, and it is a separate argument because
    ``closes`` cannot answer it: those rows are the *converted* series, so a day
    absent from them is either a day nobody quoted or a day whose rate never
    landed. The second is *waiting*, not carried — so the day each symbol was
    first quoted at all arrives beside the closes
    (:func:`quotes.first_quoted_days`), and everything from that day on is treated
    as observed whether or not its conversion did.
    """
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
            't': _iso(day),
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
    """The price one day of one position is valued at — ADR-0004's two terms.

    Membership of ``carried`` is the term the caller owns (*no price is coming*);
    :func:`carrying.carrying_price` is the term the helper owns (*no price is
    here*), and :func:`carrying.was_quoted` is what tells it apart from *no rate
    is here* — a day past the symbol's first quote is observed even when its
    conversion is missing, and it is then worth nothing computable rather than
    its cost. Written as one function because the same pair is asked once per
    position per day, and inlining it three lines up would put the predicate in
    the middle of a generator expression.
    """
    symbol = position.get('symbol')
    if symbol not in carried:
        return observed
    return carrying_price(observed,
                          was_quoted(first_quoted.get(symbol), day),
                          position.get('quantity'),
                          position.get('cost_basis'))


# --------------------------------------------------------------------- #
# Movers (#652 déc. 8)
# --------------------------------------------------------------------- #

@dataclass(frozen=True)
class Mover:
    """One share's move since the previous session close.

    No ``currency`` on the row since #702. Every amount here — the price, the
    change, the contribution — is in the **reporting** currency, so it is one
    fact about the whole block rather than a column repeated identically down it.
    The share's own quote currency is on ``/api/shares``, beside the native price
    it labels.
    """

    symbol: str
    name: Optional[str]
    price: Optional[float]
    previous_price: Optional[float]
    change: Optional[float]
    change_pct: Optional[float]
    market_value: Optional[float]
    #: What the move did to the portfolio in money: ``change × quantity``. A
    #: 12 % jump on a token holding and a 0.4 % drift on the biggest line are not
    #: the same news, and a percentage column alone cannot say which.
    contribution: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'symbol': self.symbol,
            'name': self.name,
            'price': self.price,
            'previous_price': self.previous_price,
            'change': self.change,
            'change_pct': self.change_pct,
            'market_value': self.market_value,
            'contribution': self.contribution,
        }


def session_baseline_instant(newest: datetime) -> datetime:
    """Midnight UTC of the day the newest observation falls in.

    #652 déc. 8's trap, and it is worth spelling out why this simple rule
    answers it. *"Today" is meaningless on a weekend*: on a Sunday, midnight
    today is after every price the portfolio holds, so a delta measured from it
    is uniformly zero and the block goes blank on the two days a week someone
    actually sits down to look at it. Anchoring on the newest **observation**
    makes a Sunday read Friday's session, which is what "since the last close"
    means.

    One instant for the whole portfolio, and that stays correct across
    exchanges: a share whose market has not opened today has its last point on
    an earlier day, so the last point ≤ this instant *is* that same point and it
    reports a change of zero — which is the truth, it has not traded.
    """
    utc = newest.astimezone(timezone.utc) if newest.tzinfo else newest
    return datetime(utc.year, utc.month, utc.day, tzinfo=timezone.utc)


def baseline_reference(
    baseline_rows: Sequence[Dict[str, Any]],
) -> Optional[datetime]:
    """The newest observation the baseline is actually built from.

    Found by looking at the page. :func:`session_baseline_instant` returns a
    *cut* — midnight of the newest day — and labelling the block with it read
    « depuis la clôture du 5 août » on the afternoon of 5 August, announcing a
    close that had not happened. The cut is the rule; it is not a session.

    The rows carry the answer already, since the baseline read selects the
    instant alongside the price: the newest of those *is* an observed price, and
    it lies at or before the cut by construction.
    """
    times = [row.get('t') for row in baseline_rows
             if isinstance(row.get('t'), datetime)]
    return max(times) if times else None


def build_movers(
    shares: Sequence[SharePosition],
    baseline_rows: Sequence[Dict[str, Any]],
) -> List[Mover]:
    """Rank the portfolio by its move since :func:`session_baseline_instant`.

    ``baseline_rows`` is the baseline read's output — one row per symbol
    carrying its last price at or before that instant, and the instant it was
    observed at.

    A share with no baseline (its first day) or no current price is **left out**
    rather than shown at zero: it has not failed to move, it has nothing to
    compare against, and a zero in a movers list is a claim. It still appears in
    the allocation block, which needs no history.
    """
    baseline = {
        row.get('symbol'): row.get('price') for row in baseline_rows
        if row.get('symbol') and row.get('price') is not None
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
            price=share.price,
            previous_price=previous,
            change=change,
            change_pct=_ratio(change, previous),
            market_value=share.market_value,
            contribution=_product(change, share.quantity),
        ))

    # Biggest riser first, biggest faller last — the front takes both ends.
    movers.sort(key=lambda mover: (mover.change_pct is None,
                                   -(mover.change_pct or 0.0)))
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
    is the shape of mistake this whole ticket removes.
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


def _build_account(row: Dict[str, Any], carry: bool = False) -> AccountPosition:
    """One breakdown row, with the same arithmetic scoped to a single account.

    The carrying price is recomputed **per account** rather than taken from the
    aggregate, and it has to be: the PMP is a weighted mean, so two accounts
    holding the same share at different costs carry it at different prices, and a
    single figure applied to both would make the breakdown stop adding up to the
    row above it (issue #706). ``price_native`` rides along for the same reason it
    does one level up: a known quote with no rate is *waiting*, never carried.
    """
    quantity = row.get('quantity')
    cost_basis = row.get('cost_basis')
    price = row.get('price')
    market_value = _product(
        quantity,
        carrying_price(price, row.get('price_native') is not None,
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


# --------------------------------------------------------------------- #
# Arithmetic that treats absence as absence
#
# Every helper below returns None when it has nothing to work with, rather
# than 0. #655's three-state table calls this "absent by design", and it is
# the difference between "this position has no cost price" and "this position
# cost nothing" — which render identically the moment one of them becomes a
# zero.
# --------------------------------------------------------------------- #

def _latent(market_value: Optional[float],
            cost_basis: Optional[float]) -> Optional[float]:
    """``market_value − cost_basis``, or ``None`` without an observed price.

    The holdings term is **required** and the basis defaults to zero, and that
    asymmetry earned itself with a test: composing this out of null-tolerant
    helpers made a share whose price had never been observed report a latent
    gain of *minus everything invested* — the app announcing a total loss
    because it had never seen a quote. Without a price there is no valuation, so
    there is no latent gain either, and the honest answer is the em dash.

    Note what is **not** in it: dividends and fees. A dividend received is its
    own named figure, and an acquisition fee is inside the cost basis since
    #699 — adding either here would count it twice and rebuild the composite
    #672 replaced.
    """
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
    """First non-``None`` value of ``field`` across a symbol's rows.

    Used for the name, which lives on the position and may therefore differ
    between two accounts that legitimately call the same line differently. The
    table shows one of them; the sheet shows the breakdown, where each account
    keeps its own. Deliberately *first* and not *newest*: the rows are ordered
    by account and carry no instant of their own — a position is a current
    state, not an observation — so there is no "newest" among them to pick.
    """
    for row in rows:
        value = row.get(field)
        if value is not None:
            return value
    return None


def _iso(value) -> Optional[str]:
    """ISO-8601 UTC, the wire format #655 fixed for every date and instant."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return None


__all__ = [
    'AccountPosition', 'AccountSummary', 'SharePosition', 'Mover',
    'build_shares', 'build_share', 'build_accounts', 'unit_cost',
    'MODE_ACCOUNTS', 'MODE_TITRES', 'portfolio_mode',
    'build_totals_head', 'build_titres_head',
    'build_positions', 'build_portfolio_totals', 'ytd_base_day',
    'build_price_series',
    'valuation_series', 'session_baseline_instant', 'baseline_reference',
    'build_movers',
]
