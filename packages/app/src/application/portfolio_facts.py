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
from typing import Any, Dict, Optional

from application import account_facts
from application import instants
from application.events.schemas import EventType, declared_value
from application import portfolio_view
from application import quotes
from application.store_reads import PortfolioReader


def positions_payload(store, snapshot, now: datetime) -> Dict[str, Any]:
    """Every (account, symbol) row, in the base currency."""
    currency = store.setting('base_currency')
    carried = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    reader = PortfolioReader(store)
    previous = {row['symbol']: row['price']
                for row in reader.previous_closes()}
    return {
        'base_currency': currency,
        'positions': portfolio_view.with_day_change(
            portfolio_view.build_positions(reader.positions(), currency,
                                           carried), previous),
    }


def totals_payload(store, snapshot, now: datetime) -> Dict[str, Any]:
    """The newest day of the global perf series, plus what the hero reads off it.

    Besides the three derived members of #745: ``variation`` per range,
    ``cash``, ``gain_total`` (the four terms, over the net contribution) and
    ``net_if_sold_today`` with the accounts whose tax was estimated.
    """
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
        bases = {
            name: reader.totals_on_or_before(
                portfolio_view.variation_base_day(name, day))
            for name in ('1M', 'YTD', '1Y')}
        terminal = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
        totals['variation'] = portfolio_view.build_variation(
            latest, bases, reader.first_totals())
        totals['cash'] = latest.get('cash_balance')
        totals.update(_ledger_facts(snapshot.events or [], day))
        totals['gain_total'] = portfolio_view.build_gain_total(
            portfolio_view.build_shares(reader.positions(), terminal),
            totals['transfer_fees'], latest.get('net_contributed'))
        totals.update(_net_if_sold_today(
            latest.get('total_value'), account_facts.accounts_payload(
                store, snapshot, now)['accounts']))

    return {'base_currency': store.setting('base_currency'), 'totals': totals}


def _ledger_facts(events, day) -> Dict[str, Any]:
    """What the head says about the ledger itself, read off it and never off the
    series: the first deposit (the series may still be rebuilding, and then
    starts later than the money did) and what grants add to the net contribution.

    A grant **is** counted as contributed, at its declared value -- the gain and
    the IRR are taken against it, so a free share is not profit (#1012). The
    head says so beside « Versé net » rather than let it pass for a deposit.
    """
    cutoff = str(day)[:10]
    deposits = [e.date for e in events
                if e.event_type == EventType.DEPOSIT and str(e.date) <= cutoff]
    granted = sum(declared_value(e.quantity, e.unit_price) for e in events
                  if e.event_type == EventType.GRANT and str(e.date) <= cutoff)
    return {
        'first_deposit': instants.iso(min(deposits)) if deposits else None,
        'granted': round(granted, 2),
    }


def _net_if_sold_today(total_value: Optional[float],
                       accounts) -> Dict[str, Any]:
    """The value less the projected tax -- the one place that reads it.

    An account with no projection counts gross, and the ones that did carry
    one are named so the tooltip can say *tax estimated on the PEA only*.
    """
    taxed = [account for account in accounts
             if account.get('projected_tax') is not None]
    tax = sum(account['projected_tax'] for account in taxed)
    net = None if total_value is None else total_value - tax
    # **Rounded once per account, then added**: an account's page prints its own
    # `value - tax` to the cent, so the portfolio's figure is the sum of those
    # and never a second rounding of the whole (a cent apart on real data).
    valued = [account for account in accounts
              if account.get('total_value') is not None]
    summed = sum(account['total_value'] for account in valued)
    if net is not None and valued and abs(summed - total_value) < 0.5:
        net = sum(round(account['total_value'] - (account.get('projected_tax') or 0.0), 2)
                  for account in valued)
    return {
        'net_if_sold_today': net,
        'estimated_accounts': [account['id'] for account in taxed],
    }
