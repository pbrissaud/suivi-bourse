"""The comparison of #760, assembled: per account, then aggregated.

**Per account is the unit, from the first version.** The replay is per account
because the seed is (each wrapper has its own first written day), because the
flows are (a deposit lands in one account), and above all because the tax is:
``taxation_projection`` takes the floor at zero *per account* — a loss owes
nothing and does not owe a negative for another account to absorb — so the net
is ``Σ (1 − rᵢ)·max(gᵢ, 0)`` and never ``(1 − r̄)·g``. Computed on an aggregate
it is wrong the moment one account loses while another gains, which is the
nominal case for anyone holding a PEA beside a CTO.

**The figure and the right to display it travel together.** ``terminal`` rides
on this payload beside the numbers it governs, so the two cannot disagree
between two reads. A gap computed over a half-built series is a *wrong* number
and not a short one — −38 % that quietly repairs itself an hour later, seen by
the owner and by nobody else — and it is the likeliest shipping bug of the
whole ticket. Terminality is read **from the store** and never from
``runtime_state.Recorder``, which is a per-process dict wiped on every restart:
a figure that appears after a deploy and vanishes on the next one is worse than
no figure.

The period is announced, never chosen: the latest of the accounts' starts and
the earliest of their ends. A counterfactual replays the flows from the
beginning, so narrowing it to a year does not shorten the answer, it asks a
different question.
"""
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import benchmarks
from application import counterfactual
from application import instants
from application import performance
from application import ledger
from application import portfolio_view
from application import quotes
from application import taxation
from application import taxation_projection
from application.events.aggregator import EventAggregator
from application.store_reads import PortfolioReader

logger = getLogger(__name__)

#: No reference named. Not a failure: the untouched state of the dial.
NO_REFERENCE = 'no_reference'

#: A reference is named but its history is still being fetched. **No figure.**
REBUILDING = 'rebuilding'

#: Named, terminal, and still nothing to compare — no events, no account with a
#: written day inside the fund's own history.
NOTHING_TO_COMPARE = 'nothing_to_compare'

#: Named and quoted, but this install has never established the reference's
#: split history — a store written before #760 that had already fetched it.
#: **No figure**, for the same reason a half-built series carries none.
SPLITS_UNKNOWN = 'splits_unknown'

#: Everything answered.
READY = 'ready'


def comparison(store, snapshot, now: datetime) -> Dict[str, Any]:
    """The whole screen's payload: the reference, the verdict, and the period."""
    symbol = store.setting('benchmark_symbol')
    if not symbol:
        return {'state': NO_REFERENCE, 'reference': None,
                'offered': _offered(),
                'consulted': ledger.consulted_benchmarks(store)}

    offered = benchmarks.offered(symbol)
    head: Dict[str, Any] = {
        'reference': symbol,
        # An off-list value is rendered, never dropped: `PUT /api/settings`
        # stays open, and a reference that disappears from its own selector is
        # one the owner cannot switch away from.
        'index': offered.index if offered else None,
        'inception': instants.iso(offered.inception) if offered else None,
        'offered': _offered(),
        # **Which of the seven this install already holds a series for.** The
        # consulted list and not a scan of `price_point`, because that list is
        # exactly what #760 keeps alive so switching back is instant — and the
        # selector's *déjà téléchargé* column is the only thing that makes the
        # promise visible. Without it every switch is a coin flip between
        # instant and a two-hour rebuild.
        'consulted': ledger.consulted_benchmarks(store),
    }

    # No tracked window means an empty ledger: `tracked_windows` anchors the
    # reference on the ledger's own first day, so with no events there is no
    # window — and nothing will ever be fetched for it either. That is *nothing
    # to compare*, not a rebuild in progress; a bar that never fills is worse
    # than an empty state that names what is missing.
    window = snapshot.tracked_windows(symbol).get(symbol)
    if not window:
        return {**head, 'state': NOTHING_TO_COMPARE, 'excluded_accounts': []}

    if symbol not in quotes.terminal_symbols(store, {symbol: window}, now):
        return {**head, 'state': REBUILDING,
                'rebuild': _rebuild(store, symbol, offered, now)}

    prices = quotes.price_series(store, symbol)
    if not prices:
        return {**head, 'state': REBUILDING,
                'rebuild': _rebuild(store, symbol, offered, now)}

    # **An empty split history is not the same as none, and the difference is
    # invisible in the figure.** A store that fetched this symbol before #760
    # persisted the ratios carries zero rows exactly like a symbol that has
    # never split, and a replay taking the first for the second walks through a
    # four-for-one and divides the holding by four — silently, permanently,
    # beside a portfolio figure that is right. This is the same class of defect
    # as a gap over a half-built series, so it gets the same answer: no figure
    # at all until the next fetch establishes the history.
    if not quotes.splits_were_read(store, symbol):
        return {**head, 'state': SPLITS_UNKNOWN,
                'rebuild': _rebuild(store, symbol, offered, now)}

    replayed, excluded = _by_account(store, snapshot, prices, symbol)
    if not replayed:
        return {**head, 'state': NOTHING_TO_COMPARE,
                'excluded_accounts': excluded}

    return {**head, 'state': READY, 'excluded_accounts': excluded,
            **_aggregate(store, snapshot, replayed, now)}


def _offered() -> List[Dict[str, Any]]:
    """The closed list, as the selector renders it."""
    return [{'symbol': entry.symbol, 'index': entry.index,
             'currency': entry.currency, 'pea': entry.pea,
             'inception': instants.iso(entry.inception)}
            for entry in benchmarks.BENCHMARKS]


def _rebuild(store, symbol: str, offered, now: datetime) -> Dict[str, Any]:
    """The rebuild bar, **fed from the store** and not from the recorder.

    `runtime_view.backfill_progress` reads `runtime_state.Recorder`, a dict this
    process holds and loses on restart — so a bar built from it is empty on
    every boot, on a job that runs for hours. The three facts here are all
    persisted: where the backward pass has reached (`price_point`), where it is
    heading (the fund's inception, or the oldest day the pass has tried), and
    today.

    No promised duration. `RebuildBlock` already refuses to name an hour, and a
    mute symbol backing off to twenty-four hours is the reason.
    """
    reached = quotes.oldest_ts(store, symbol)
    reached_day = reached.date() if reached is not None else None
    target = offered.inception if offered else quotes.oldest_window_tried(
        store, symbol)
    today = now.date()

    ratio = None
    if reached_day is not None and target is not None and target < today:
        covered = (today - reached_day).days
        total = (today - target).days
        ratio = max(0.0, min(1.0, covered / total)) if total else None

    return {'symbol': symbol, 'reached': instants.iso(reached_day),
            'target': instants.iso(target), 'ratio': ratio}


def _by_account(store, snapshot, prices: Dict[date, float],
                symbol: str) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """One replay per account, and the accounts that could not have one."""
    written = _written_days(store)
    quoted_from = min(prices)
    splits = quotes.read_splits(store, symbol)
    unconverted = _unconverted_days(store, symbol)
    timeline = EventAggregator().replay(snapshot.events or [])

    replayed: Dict[str, Any] = {}
    excluded: List[Dict[str, str]] = []
    for account in _perimeter(store, snapshot):
        days = written.get(account)
        if not days:
            continue

        # **A grant nobody priced takes its account out** (`declared_value`
        # answers `0.0` on purpose). The portfolio gained shares on a day the
        # reference would be handed nothing, so the comparison would trail by
        # the whole undeclared amount for ever, and silently.
        granted = performance.undeclared_grants(timeline, account)
        if granted:
            excluded.append({'account': account, 'reason': 'undeclared_grant',
                             'symbols': ','.join(granted)})
            continue

        seed_day = max(days[0][0], quoted_from)
        seeded = [row for row in days if row[0] <= seed_day]
        if not seeded or seeded[-1][1] is None:
            continue

        result = counterfactual.replay(
            (seed_day, days[-1][0]), prices, splits,
            performance.external_flows(timeline, account),
            seeded[-1][1], unconverted)
        if result.first_day is None:
            continue
        replayed[account] = (result, dict(days))

    return replayed, excluded


def _perimeter(store, snapshot) -> List[str]:
    """The declared accounts, in id order."""
    declared = snapshot.accounts
    rows = (declared.accounts if declared is not None
            else accounts_module.seeded_only(store))
    return sorted(account.id for account in rows)


def _written_days(store) -> Dict[str, List[Tuple[date, Optional[float]]]]:
    """``{account: [(day, total_value), …]}`` — every account, in one query.

    One read and not one per account: `perf_job` writes a row a day per account
    over the whole ledger, and this is the real curve of the comparison, its
    seed and its day axis all at once.
    """
    days: Dict[str, List[Tuple[date, Optional[float]]]] = {}
    for account, day, value in store.query(
            'SELECT account, day, total_value FROM account_metrics '
            'ORDER BY account, day'):
        days.setdefault(account, []).append((day, value))
    return days


def _unconverted_days(store, symbol: str) -> List[date]:
    """The days whose close is stored but has no rate to convert it at."""
    span = quotes.unconverted_span(store, symbol)
    if span is None:
        return []
    return quotes.unconverted_days(store, symbol, span[0], span[1])


def _aggregate(store, snapshot, replayed: Dict[str, Any],
               now: datetime) -> Dict[str, Any]:
    """Sum the accounts over the period they share, gross and net."""
    # **The period is the intersection**: the latest of the starts, because an
    # account opened later has nothing to say about the years before it, and
    # the earliest of the ends, because a reference exhausted in one account
    # stops the comparison there rather than carrying a frozen figure forward.
    covered_from = max(result.first_day for result, _ in replayed.values())
    covered_to = min(result.last_day for result, _ in replayed.values())
    ended = next((result.ended for result, _ in replayed.values()
                  if result.ended), None)

    portfolio = _portfolio_at(replayed, covered_to)
    reference = sum(_reference_at(result, covered_to)
                    for result, _ in replayed.values())
    contributed = sum(result.contributed for result, _ in replayed.values())

    taxes = _net(store, snapshot, replayed, covered_to, now)
    return {
        'covered_from': instants.iso(covered_from),
        'covered_to': instants.iso(covered_to),
        'ended': ended,
        'accounts': sorted(replayed),
        'portfolio_value': portfolio,
        'reference_value': reference,
        'gap_gross': None if portfolio is None else portfolio - reference,
        'portfolio_return': _return(portfolio, contributed),
        'reference_return': _return(reference, contributed),
        'idle_cash': _idle_cash(store, replayed, covered_to),
        'series': _series(replayed, covered_from, covered_to),
        'gap_net': _gap_net(portfolio, reference, taxes),
        **taxes,
    }


def _gap_net(portfolio: Optional[float], reference: float,
             taxes: Dict[str, Any]) -> Optional[float]:
    """What is left on each side once the wrappers have taken their cut.

    Absent whenever one account of the perimeter could not project: a net short
    by a wrapper is a figure the owner reads as their own, and nothing on the
    screen would say which one is missing.
    """
    if portfolio is None or taxes['portfolio_tax'] is None:
        return None
    left = portfolio - taxes['portfolio_tax']
    theirs = reference - taxes['reference_tax']
    return left - theirs


def _portfolio_at(replayed: Dict[str, Any],
                  day: date) -> Optional[float]:
    """The real portfolio's value on ``day``, summed over the perimeter.

    ``None`` when one account has no value that day: a total missing a term is
    not a smaller total, and the screen says *I cannot tell* rather than
    handing the reference a walkover.
    """
    total = 0.0
    for _, days in replayed.values():
        value = days.get(day)
        if value is None:
            return None
        total += value
    return total


def _reference_at(result, day: date) -> float:
    """The replay's value on ``day``, or on the last day it covered."""
    for covered, value in reversed(result.series):
        if covered <= day:
            return value
    return 0.0


def _return(value: Optional[float],
            contributed: float) -> Optional[float]:
    """The money-weighted return, on the denominator both sides share.

    ``None`` on a perimeter that has taken more out than it put in: the ratio
    still divides, and it answers with the sign flipped.
    """
    if value is None or contributed <= 0:
        return None
    return (value - contributed) / contributed


def _idle_cash(store, replayed: Dict[str, Any],
               day: date) -> Optional[float]:
    """Cash sitting in the perimeter on the last covered day.

    The replay puts every euro to work on the day it arrives, so a portfolio
    holding cash is compared against a reference that never did. The figure is
    published rather than adjusted for: correcting it would answer a question
    nobody asked, and hiding it would let the comparison look unfair without
    saying why.
    """
    rows = store.query(
        'SELECT account, cash_balance FROM account_metrics WHERE day = ?',
        [day])
    balances = [balance for account, balance in rows
                if account in replayed and balance is not None]
    return sum(balances) if balances else None


def _series(replayed: Dict[str, Any], first: date,
            last: date) -> List[Dict[str, Any]]:
    """The two curves on one day axis, over the shared period only."""
    reference: Dict[date, float] = {}
    for result, _ in replayed.values():
        for day, value in result.series:
            if first <= day <= last:
                reference[day] = reference.get(day, 0.0) + value

    points = []
    for day in sorted(reference):
        points.append({
            't': instants.iso(day),
            'portfolio': _portfolio_at(replayed, day),
            'reference': reference[day],
        })
    return points


def _net(store, snapshot, replayed: Dict[str, Any], day: date,
         now: datetime) -> Dict[str, Any]:
    """The after-tax side, or the reason there is none — **all or nothing**.

    One account whose model this version refuses makes the *whole* net absent,
    and the screen names that account. A net summed over the accounts that
    happened to project would be a figure the owner reads as their own and that
    is short by a wrapper, which is exactly the shape of error nobody catches.
    ``none`` and ``withholding_income`` are not refusals: they are a known zero
    and they count.

    ``projected_tax`` is called **once per account per side**, on that side's
    own latent gain, and never through an effective rate:
    ``taxation_projection`` refuses to name one rate for a ladder because
    ``_bracketed`` is not linear, and a rate averaged here would be the same
    mistake made one module further out.
    """
    carried = accounts_module.taxation_models_by_account(store)
    models = {model.id: model for model in accounts_module.read_models(store)}
    opened_on = accounts_module.opening_dates_by_account(store)
    payments = ledger.first_payments(store)
    latent = _real_latent_gains(store, snapshot, replayed, now)

    unavailable: List[Dict[str, str]] = []
    portfolio_tax = 0.0
    reference_tax = 0.0
    for account, (result, _) in sorted(replayed.items()):
        model = models.get(carried.get(account))
        if model is None:
            unavailable.append({'account': account, 'reason': 'no_model'})
            continue
        try:
            taxation.validate(model.kind, model.parameters)
        except taxation.ModelRejected as exc:
            logger.warning(
                f"account {account} carries taxation model {model.id} "
                f"({model.kind}), which this version refuses: {exc}. No net "
                f"comparison is published.")
            unavailable.append({'account': account, 'reason': 'unreadable_model'})
            continue

        facts = dict(kind=model.kind, parameters=model.parameters,
                     opened_on=opened_on.get(account),
                     first_payment=payments.get(account), now=day)
        real = taxation_projection.projected_tax(
            latent_gain=latent.get(account), **facts)
        theirs = taxation_projection.projected_tax(
            latent_gain=result.latent_gain, **facts)
        if real is None and model.kind in taxation_projection.PROJECTED_KINDS:
            unavailable.append({'account': account, 'reason': 'no_assiette'})
            continue
        portfolio_tax += real or 0.0
        reference_tax += theirs or 0.0

    if unavailable:
        return {'net_unavailable': unavailable,
                'portfolio_tax': None, 'reference_tax': None}
    return {'net_unavailable': [],
            'portfolio_tax': portfolio_tax, 'reference_tax': reference_tax}


def _real_latent_gains(store, snapshot, replayed: Dict[str, Any],
                       now: datetime) -> Dict[str, Optional[float]]:
    """The portfolio's own assiette, per account — one bulk read, like #919's."""
    reader = PortfolioReader(store)
    terminal = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    return portfolio_view.latent_gains_by_account(
        portfolio_view.build_shares(reader.positions(), terminal),
        list(replayed))


__all__ = ['comparison', 'NO_REFERENCE', 'REBUILDING', 'NOTHING_TO_COMPARE',
           'SPLITS_UNKNOWN', 'READY']
