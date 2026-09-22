"""The comparison of #760, assembled: per account, then aggregated.

**One question, and #1018 is what narrowed it to one.** What became of the
money actually put into securities, dividends included, against the same money
in the index. Cash never enters — the reference receives purchases and gives
back sales and dividends, so it is invested exactly when the owner was — and
tax never enters either: both sides sit in the *same* wrapper under the *same*
declared model, so the tax says something about the choice of wrapper and this
module is not about that. *Impôt projeté* on the account page is where that
question is answered.

The dividends need no machinery on the reference side: all seven offered
references are accumulating ETFs, so their distributions are already inside the
close. Only the owner's side has dividends to count, and they are counted by
**leaving** the pot — a negative flow the reference matches, which is the
existing withdrawal handling of ``counterfactual.replay`` and no new arithmetic.

**Per account is still the unit.** The seed is per account (each wrapper puts
its first money into securities on its own day) and so are the flows (a
purchase lands in one account), so the replay is too.

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

**And both ends of it bind** (#1028). The end always did — every term is read
back on the shared last day. The start did not: each account was replayed from
its *own* first day and summed as it stood, so the oldest wrapper walked into
the stated period with whatever its reference had already drifted by, and that
drift was inside the headline. The aggregate re-seeds every account on the
shared first day, at the pot it really held that evening, so the two curves
open on the same euro — which is what makes the figure and the dates printed
under it the same period.

**And it is announced twice** (#1014). The aggregate keeps the intersection —
one headline figure names one period — but the intersection is the youngest
account's start, so opening a second account shortens the comparison of the
first by years it has every right to be judged on. ``per_account`` publishes
each account's own window beside it, off the replays ``_by_account`` was
already computing and ``_aggregate`` was discarding.

**#983 splits the gap in two, and only one of the halves is new.** `gap_gross`
already answers *what did my securities do* — the reference ran the owner's own
flows on the owner's own days, so the dates are common to both sides and cancel
out of the difference. What it cannot answer is what those days were themselves
worth, and that needs a third replay: the same index, the same total, the same
window, paid in equal monthly instalments (`counterfactual.smooth`). The
distance between the second and the third is `date_effect`, and the sum of the
two halves is the gap against an index investor who never chose a day.

All-or-nothing: the smoothed replay can exhaust the reference on a different
day than the real one, and a decomposition summed over the accounts whose third
replay happened to reach the covered day is short by a wrapper without saying
so. Since #1018 ``counterfactual.smooth`` smooths the *purchases*, so the date
effect measures when the owner bought rather than when they funded the account
— the first is a decision an investor makes and the second is not.
"""
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from application import accounts as accounts_module
from application import benchmarks
from application import counterfactual
from application import instants
from application import performance
from application import ledger
from application import quotes
from application.events.aggregator import EventAggregator

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
        # **Which of the five this install already holds a series for.** The
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

    replayed, excluded, opened, reseed = _by_account(
        store, snapshot, prices, symbol)
    if not replayed:
        return {**head, 'state': NOTHING_TO_COMPARE,
                'excluded_accounts': excluded}

    rows = _rows(replayed)
    aggregate = _aggregate(replayed, reseed, opened, min(prices))
    if aggregate is None:
        # The accounts replayed, and their periods do not overlap. Nothing to
        # compare is the honest answer *for the aggregate*, not a comparison
        # over no days at all — but the rows are exactly what #1014 is about,
        # and this is the case where an empty intersection hides not four
        # years of one account but the whole of every one of them. The state
        # stays, because no headline figure can be stated; the rows travel with
        # it, because each of them can.
        return {**head, 'state': NOTHING_TO_COMPARE,
                'excluded_accounts': excluded, 'per_account': rows}

    return {**head, 'state': READY, 'excluded_accounts': excluded,
            'per_account': rows, **aggregate}


def _offered() -> List[Dict[str, Any]]:
    """The closed list, as the selector renders it."""
    return [{'symbol': entry.symbol, 'index': entry.index,
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
    # **Only an offered fund has a target.** `oldest_window_tried` is where the
    # backward pass has got to, not where it is going: it moves with `reached`,
    # so a ratio taken against it reads full from the first chunk and stays
    # there. An owner who set an off-list ticker through `PUT /api/settings`
    # would watch a finished bar wait for a figure that is hours away. No
    # target, no bar, and the panel says how far back it has got instead.
    target = offered.inception if offered else None
    today = now.date()

    ratio = None
    if reached_day is not None and target is not None and target < today:
        covered = (today - reached_day).days
        total = (today - target).days
        ratio = max(0.0, min(1.0, covered / total)) if total else None

    return {'symbol': symbol, 'reached': instants.iso(reached_day),
            'target': instants.iso(target), 'ratio': ratio}


def _by_account(store, snapshot, prices: Dict[date, float], symbol: str) -> (
        Tuple[Dict[str, Any], List[Dict[str, str]], Dict[str, date], Any]):
    """One replay per account over its own window, and a way to redo them all.

    The replays here are #1014's: each account from its **own** first day, which
    is what :func:`_rows` publishes. The aggregate cannot sum them — see
    :func:`_aggregate` — so it is handed ``reseed`` instead, which runs the same
    accounts again from one shared day.
    """
    written = _written_days(store)
    quoted_from = min(prices)
    splits = quotes.read_splits(store, symbol)
    unconverted = _unconverted_days(store, symbol)
    timeline = EventAggregator().replay(snapshot.events or [])

    replayed: Dict[str, Any] = {}
    materials: Dict[str, Any] = {}
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

        # **The seed is the first day the pot exists** (#1025), floored at the
        # fund's own first quoted day. Every wrapper is opened by a deposit and
        # buys days or weeks later, so since #1018 an account's first written
        # days carry a `holdings_value` of `0.0` — written, not `NULL`, because
        # `performance.ALWAYS_WRITTEN` holds the column. Seeded there, `replay`
        # opens on nothing, reads it as an exhausted reference and closes the
        # same day; that one-day window then sets the whole perimeter's
        # intersection and blanks a screen with seven years of events behind
        # it. The pot starts at the first purchase, so the window does too.
        #
        # `(value or 0)` folds the two shapes of *no pot that day* together on
        # purpose: `0.0` is what the column holds, and `NULL` is what a row
        # written before `holdings_value` joined `ALWAYS_WRITTEN` would hold.
        # Neither can be seeded — a comparison needs a position to buy the
        # reference with — so both walk on to the next day rather than opening
        # the replay on nothing.
        seeded = next(((day, value) for day, value in days
                       if day >= quoted_from and (value or 0) > 0), None)
        # No day at all the account held securities while the fund was quoted:
        # there is no comparison to make, not a short one. It leaves the
        # perimeter unnamed — `excluded_accounts` carries the accounts taken
        # out of a comparison they could otherwise have had, and this one never
        # had it. Naming the causes the empty state currently lumps together is
        # #1025's own third point and its own ticket.
        if seeded is None:
            continue
        seed_day, seed = seeded

        window = (seed_day, days[-1][0])
        flows = performance.invested_flows(timeline, account)
        result = counterfactual.replay(
            window, prices, splits, flows, seed, unconverted)
        if result.first_day is None:
            continue
        replayed[account] = (result, dict(days))
        materials[account] = (window[1], flows)

    def reseed(start: date):
        """Every account replayed again from **one** shared day (#1028).

        The aggregate names a period, so its terms have to start in it. An
        account replayed from its own first day carries into that period
        whatever the reference had already drifted by — a head start the
        headline then counts as this period's gap.

        The seed is the same one :func:`counterfactual.replay` always takes:
        the real pot at the close of the shared day, so both curves open on
        the same euro. Nothing else moves — same prices, same splits, same
        flows, each account's own window end — and the smoothed run of #983 is
        built here too, over the shared window, because a date effect measured
        on a different period from the gap beside it is two answers.

        The day walks forward until it is **quoted** and every account has a
        pot on it. A pot of zero cannot be seeded, and an unquoted day cannot
        either — not because ``replay`` refuses it, but because it accepts it:
        it lands the seed on the next quoted day instead, so the position read
        on the closed day would open a series that starts days later, short by
        whatever the portfolio's own holdings did over the gap. That is the
        head start of #1028 again, in miniature. The seed day and the first
        published day are the same day or the equality is not being claimed.
        ``None`` when no such day exists before one of the replays runs out.
        """
        day = start
        end = min(last for last, _ in materials.values())
        while day <= end and not (day in prices and all(
                (replayed[account][1].get(day) or 0) > 0
                for account in materials)):
            day += counterfactual.ONE_DAY
        if day > end:
            return None

        again: Dict[str, Any] = {}
        smoothed: Dict[str, Any] = {}
        for account, (last, flows) in materials.items():
            window = (day, last)
            seed = replayed[account][1][day]
            result = counterfactual.replay(
                window, prices, splits, flows, seed, unconverted)
            if result.first_day is None:
                return None
            again[account] = (result, replayed[account][1])
            smoothed[account] = counterfactual.replay(
                window, prices, splits, counterfactual.smooth(flows, window),
                seed, unconverted)
        return again, smoothed

    # The third value is the first day each replayed account was **written**,
    # before any seeding: it is what tells who truncated the period, and the
    # wrong answer there names a cause the reader can go and check.
    return (replayed, excluded,
            {account: written[account][0][0] for account in replayed}, reseed)


def _perimeter(store, snapshot) -> List[str]:
    """The declared accounts, in id order."""
    declared = snapshot.accounts
    rows = (declared.accounts if declared is not None
            else accounts_module.seeded_only(store))
    return sorted(account.id for account in rows)


def _written_days(store) -> Dict[str, List[Tuple[date, Optional[float]]]]:
    """``{account: [(day, holdings_value), …]}`` — every account, in one query.

    One read and not one per account: `perf_job` writes a row a day per account
    over the whole ledger, and this is the real curve of the comparison, its
    seed and its day axis all at once.

    **`holdings_value` and not `total_value` since #1018.** The comparison is
    about the invested pot, so the cash beside it is out of both sides — the
    column is already written, and nothing new is computed for it.
    """
    days: Dict[str, List[Tuple[date, Optional[float]]]] = {}
    for account, day, value in store.query(
            'SELECT account, day, holdings_value FROM account_metrics '
            'ORDER BY account, day'):
        days.setdefault(account, []).append((day, value))
    return days


def _unconverted_days(store, symbol: str) -> List[date]:
    """The days whose close is stored but has no rate to convert it at."""
    span = quotes.unconverted_span(store, symbol)
    if span is None:
        return []
    return quotes.unconverted_days(store, symbol, span[0], span[1])


def _aggregate(replayed: Dict[str, Any], reseed, opened: Dict[str, date],
               quoted_from: date) -> Dict[str, Any]:
    """Sum the accounts over the period they share.

    ``None`` when they share none: see the empty-intersection guard below.
    """
    # **The period is the intersection**: the latest of the starts, because an
    # account opened later has nothing to say about the years before it, and
    # the earliest of the ends, because a reference exhausted in one account
    # stops the comparison there rather than carrying a frozen figure forward.
    covered_from = max(result.first_day for result, _ in replayed.values())
    covered_to = min(result.last_day for result, _ in replayed.values())

    # **An intersection can be empty**, and then there is no period to sum
    # over: an account closed in 2020 beside one opened in 2022 gives a start
    # after its own end. Every term below would be read at a day one of them
    # never lived, and the screen would state a period running backwards.
    if covered_from > covered_to:
        return None

    # **And the start is enforced, not just printed** (#1028). The replays
    # above each opened on their own account's first day; summed as they are,
    # the older account hands the aggregate a reference that has been drifting
    # since years before the period the screen names, and that drift is inside
    # the headline gap. Re-seeded here, every account opens on `covered_from`
    # with the pot it really held that evening — so both curves start equal,
    # which is the one number that proves the period is the measured one.
    # #1014's table keeps each account's whole life, where it belongs.
    shared = reseed(covered_from)
    if shared is None:
        return None
    replayed, smoothed = shared
    covered_from = max(result.first_day for result, _ in replayed.values())
    # **Read back after the re-seed, never before.** A reference seeded lower
    # is a reference a withdrawal can empty sooner, so the day the comparison
    # ends is a property of these replays and not of the ones `_rows` shows.
    covered_to = min(result.last_day for result, _ in replayed.values())

    # **Why it ended is the boundary account's reason, or none at all.** The
    # period stops at the earliest end; an account whose reference was
    # exhausted *after* that day did not stop anything, and naming its reason
    # against `covered_to` tells the owner a withdrawal emptied the reference
    # on a day nothing happened. Same class of mistake as blaming the fund for
    # a truncation its accounts caused.
    ended = next((result.ended for result, _ in replayed.values()
                  if result.ended and result.last_day == covered_to), None)

    # **Every term read on the covered day**, not on each replay's own last
    # one. The period ends at the *earliest* of the accounts' ends, so an
    # account whose replay ran longer would otherwise contribute a value and a
    # denominator from days the screen says are not in the comparison — and the
    # one account that ended early is exactly the one whose later days are
    # least like the others.
    at_covered = {account: _snapshot_at(result, covered_to)
                  for account, (result, _) in replayed.items()}

    # The third replay, read on the same day as the second and **all or
    # nothing**: different flows can exhaust the reference on a different day,
    # and a date effect summed over the accounts whose smoothed run happened to
    # reach `covered_to` is short by a wrapper without saying so.
    smoothed_at = _smoothed_at(smoothed, covered_to)

    portfolio = _portfolio_at(replayed, covered_to)
    reference = sum(snap.value for snap in at_covered.values() if snap)
    contributed = sum(snap.contributed for snap in at_covered.values() if snap)
    smoothed_value = (None if smoothed_at is None
                      else sum(snap.value for snap in smoothed_at.values()))

    # **Who truncated the period**, because the screen names a cause and a
    # wrong one is worse than none. The fund is the reason only when the
    # perimeter was written *before* the fund was ever quoted; an account
    # opened in 2024 against a fund quoted since 2009 is truncated by itself,
    # and saying otherwise sends the reader looking for a fund history that is
    # sitting right there.
    portfolio_from = min(opened.values())
    return {
        'covered_from': instants.iso(covered_from),
        'covered_to': instants.iso(covered_to),
        'portfolio_from': instants.iso(portfolio_from),
        'truncated_by_fund': portfolio_from < quoted_from,
        'ended': ended,
        # The two terms behind the head figure, and the perimeter they were
        # summed over. No screen reads them today — the head states the gap —
        # but they are what makes that gap checkable, and `gap_gross` alone
        # cannot tell 2 000 against 2 000 from 12 000 against 12 000.
        'accounts': sorted(replayed),
        'portfolio_value': portfolio,
        'reference_value': reference,
        'gap_gross': None if portfolio is None else portfolio - reference,
        'portfolio_return': _return(portfolio, contributed),
        'reference_return': _return(reference, contributed),
        'series': _series(replayed, covered_from, covered_to),
        # **#983: the gap splits in two, and only one of the halves is new.**
        # `gap_gross` is already what the *securities* did — same dates, same
        # flows, different holdings. What was missing is the other half: the
        # same index bought on a schedule instead of on the owner's days, so
        # `date_effect` is what those days cost or earned, and the total
        # against a disciplined index investor is the sum of the two. Published
        # as terms and not as that sum, because a reader who adds them is
        # reading the decomposition and one who is handed the total is not.
        'smoothed_value': smoothed_value,
        'date_effect': (None if smoothed_value is None
                        else reference - smoothed_value),
    }


def _rows(replayed: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Each account's own comparison, over **its own** window (#1014).

    The aggregate has to sum over the intersection — a single headline figure
    names a single period — but that intersection is set by the *youngest*
    account, and opening a CTO in 2024 is what silently takes a PEA's four
    earlier years out of the only screen that judges them. The replays those
    years need are already here: :func:`_by_account` runs every account over
    its own window, and the aggregate was throwing the rest away.

    Every term is read on the account's **own** last day, which is why there is
    no all-or-nothing rule here: a row is not a term of a sum, so one account
    that ended early costs the others nothing. Nothing on a row may be read as
    the aggregate's, and the screen states each row's period beside its figures
    for exactly that reason.
    """
    rows = []
    for account in sorted(replayed):
        result, days = replayed[account]
        # `None` for a replay exhausted on its seed day: it has a period and an
        # empty series, so there is a row and it carries no figures.
        snap = _snapshot_at(result, result.last_day)
        reference = snap.value if snap else None
        portfolio = days.get(result.last_day)
        contributed = snap.contributed if snap else 0.0
        rows.append({
            'account': account,
            'covered_from': instants.iso(result.first_day),
            'covered_to': instants.iso(result.last_day),
            'ended': result.ended,
            'portfolio_value': portfolio,
            'reference_value': reference,
            'gap_gross': (None if portfolio is None or reference is None
                          else portfolio - reference),
            'portfolio_return': _return(portfolio, contributed),
            'reference_return': _return(reference, contributed),
        })
    return rows


def _smoothed_at(smoothed: Dict[str, Any],
                 day: date) -> Optional[Dict[str, Any]]:
    """Every account's smoothed replay on ``day``, or ``None`` if one is short.

    The real replays set the period, so this one only ever has to be *at least*
    as long. When it is not — it never started, or its own flows exhausted the
    reference earlier — there is no date effect at all rather than one summed
    over a subset: a decomposition short by a wrapper reads exactly like one
    that is complete.
    """
    at: Dict[str, Any] = {}
    for account, result in smoothed.items():
        if result.first_day is None or result.last_day < day:
            return None
        snap = _snapshot_at(result, day)
        if snap is None:
            return None
        at[account] = snap
    return at


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


def _snapshot_at(result, day: date):
    """The replay's state on ``day``, or on the last day it covered before it.

    ``None`` only for a replay that never reached ``day``'s side of its own
    window, which the caller treats as nothing — a comparison with no covered
    day contributes no value, no contribution and no tax.
    """
    for snap in reversed(result.series):
        if snap.day <= day:
            return snap
    return None


def _return(value: Optional[float],
            contributed: float) -> Optional[float]:
    """The money-weighted return, on the denominator both sides share.

    ``None`` on a perimeter that has taken more out than it put in: the ratio
    still divides, and it answers with the sign flipped.
    """
    if value is None or contributed <= 0:
        return None
    return (value - contributed) / contributed


def _series(replayed: Dict[str, Any], first: date,
            last: date) -> List[Dict[str, Any]]:
    """The two curves on one day axis, over the shared period only."""
    reference: Dict[date, float] = {}
    for result, _ in replayed.values():
        for snap in result.series:
            if first <= snap.day <= last:
                reference[snap.day] = reference.get(snap.day, 0.0) + snap.value

    points = []
    for day in sorted(reference):
        points.append({
            't': instants.iso(day),
            'portfolio': _portfolio_at(replayed, day),
            'reference': reference[day],
        })
    return points


__all__ = ['comparison', 'NO_REFERENCE', 'REBUILDING', 'NOTHING_TO_COMPARE',
           'SPLITS_UNKNOWN', 'READY']
