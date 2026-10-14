"""The positions and totals envelopes, assembled **once** for the two surfaces
that serve them — ``/api/positions`` and ``list_positions``,
``/api/portfolio-totals`` and ``get_portfolio_totals`` (#1042).

Each was built by hand twice, identical and held together by nothing: the drift
:mod:`application.account_facts` ended for the accounts (#920). A member is
added here or it exists nowhere.

**The store and the snapshot arrive resolved**, as they do for
:func:`account_facts.accounts_payload`: the route raises, and the tool raises
*in words*, and neither sentence belongs here.
"""
from datetime import datetime
from typing import Any, Dict

from application import portfolio_view
from application import quotes
from application.store_reads import PortfolioReader


def positions_payload(store, snapshot, now: datetime) -> Dict[str, Any]:
    """Every (account, symbol) row, in the base currency."""
    currency = store.setting('base_currency')
    carried = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    return {
        'base_currency': currency,
        'positions': portfolio_view.build_positions(
            PortfolioReader(store).positions(), currency, carried),
    }


def totals_payload(store) -> Dict[str, Any]:
    """The newest day of the global perf series, plus three derived members."""
    reader = PortfolioReader(store)
    latest = reader.latest_totals()

    totals = None
    if latest is not None:
        day = latest['day']
        totals = portfolio_view.build_portfolio_totals(
            latest,
            reader.totals_on_or_before(portfolio_view.ytd_base_day(day)),
            reader.twr_origin(),
            reader.transfer_fees(day))

    return {'base_currency': store.setting('base_currency'), 'totals': totals}
