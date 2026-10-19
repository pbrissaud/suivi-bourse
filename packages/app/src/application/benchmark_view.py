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

**Per account is where the materials come from.** The seed is per account
(each wrapper puts its first money into securities on its own day) and so are
the flows (a purchase lands in one account), so each account is replayed on its
own — and then all of them together, for the head.

**The figure and the right to display it travel together.** ``terminal`` rides
on this payload beside the numbers it governs, so the two cannot disagree
between two reads. A gap computed over a half-built series is a *wrong* number
and not a short one — −38 % that quietly repairs itself an hour later, seen by
the owner and by nobody else — and it is the likeliest shipping bug of the
whole ticket. Terminality is read **from the store** and never from
``runtime_state.Recorder``, which is a per-process dict wiped on every restart:
a figure that appears after a deploy and vanishes on the next one is worse than
no figure.

**The period is the whole portfolio's.** The question is what became
of every euro put into securities, whichever wrapper it went through, so the
head replays **all** of them in one reference: from the first day any account
held securities to the last day every account was measured. An account opened
later simply has no money in either side before its first purchase. The
intersection it replaced (#1028, #1032) started on the *youngest* account's
first day, so opening a CTO in 2024 took a PEA's five earlier years out of the
headline — and the head then disagreed with rows the reader naturally adds up.

The end still binds on every account: a total missing a term is not a smaller
total, so the period stops on the earliest of the accounts' last measured days.
In practice every account is written through today and that is the end.

**One pot, not a sum of pots.** The replay is linear — a euro in buys the same
shares whichever account it came from — so one replay of the merged flows is
the sum of the per-account replays, euro for euro. It differs only where that
difference is the point: a withdrawal one account's reference could not have
funded is funded by the others', because the money is the owner's and not the
wrapper's.

**And it is broken down per account** (#1014). ``per_account`` publishes each
account's own replay, over its own life. Those rows add up to the head: same
flows, same seeds, same end.
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

#: Named, terminal, and still nothing to compare. The payload says why in
#: `reason`, because the four causes call for four different sentences and only
#: one of them is an empty ledger (#1207).
NOTHING_TO_COMPARE = 'nothing_to_compare'

#: No event at all: there is no window to compare over.
NO_EVENTS = 'no_events'

#: Events, and no account of the perimeter has a written day yet — the perf
#: pass has not run since they were recorded.
NOT_COMPUTED = 'not_computed'

#: Written days, and none on which an account held securities while the fund
#: was quoted: the comparison is about invested money, not cash.
NOTHING_HELD = 'nothing_held'

#: A seed day — one account's, or the whole portfolio's — carries a close with
#: no exchange rate yet.
NO_RATE_ON_SEED = 'no_rate_on_seed'

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
        return {**head, 'state': NOTHING_TO_COMPARE, 'reason': NO_EVENTS}

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

    replayed, opened, merged, why = _by_account(store, snapshot, prices, symbol)
    if not replayed:
        return {**head, 'state': NOTHING_TO_COMPARE, 'reason': why}

    rows = _rows(replayed)
    aggregate = _aggregate(replayed, merged, opened, min(prices))
    if aggregate is None:
        # The accounts replayed one by one and the whole portfolio did not —
        # its seed fell on a day with no rate. No headline figure can be
        # stated; the rows travel with the state, because each of them can.
        return {**head, 'state': NOTHING_TO_COMPARE,
                'reason': NO_RATE_ON_SEED, 'per_account': rows}

    return {**head, 'state': READY, 'per_account': rows, **aggregate}


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
        Tuple[Dict[str, Any], Dict[str, date], Any, str]):
    """One replay per account over its own window, and one of them all.

    The per-account replays are #1014's: each account from its **own** first
    day, which is what :func:`_rows` publishes. The third value is the whole
    portfolio's replay, which is what the head states. The fourth is why
    nothing replayed, read only when nothing did: no account written yet, a
    seed day waiting on its rate, or no day with securities held (#1207).
    """
    written = _written_days(store)
    quoted_from = min(prices)
    splits = quotes.read_splits(store, symbol)
    unconverted = _unconverted_days(store, symbol)
    # A trailing close still waiting on its rate is part of the reference's
    # history: the window reaches it so `replay` stops on it and says why,
    # rather than ending cleanly the evening before.
    quoted_to = max([max(prices), *unconverted])
    timeline = EventAggregator().replay(snapshot.events or [])

    replayed: Dict[str, Any] = {}
    materials: Dict[str, Any] = {}
    computed = awaiting_rate = False
    for account in _perimeter(store, snapshot):
        days = written.get(account)
        if not days:
            continue
        computed = True

        # **A grant nobody priced is the owner's edge, not a gap to close.** It
        # enters `invested_flows` at `0.0` — nothing was paid for it, which is
        # what the form promises when the price is left blank — so the
        # reference is handed nothing that day and the portfolio keeps the
        # shares. The comparison reads them as outperformance, which is what a
        # free share is. Taking the account out instead hid the whole wrapper
        # from the one screen that judges it, for a line that only helps it.
        # **The seed is the first day the pot exists** (#1025), floored at the
        # fund's own first quoted day. Every wrapper is opened by a deposit and
        # buys days or weeks later, so since #1018 an account's first written
        # days carry a `holdings_value` of `0.0` — written, not `NULL`, because
        # `performance.ALWAYS_WRITTEN` holds the column. Seeded there, `replay`
        # opens on nothing, reads it as an exhausted reference and closes the
        # same day; that one-day window then ends the whole perimeter's period
        # and blanks a screen with seven years of events behind it. The pot
        # starts at the first purchase, so the window does too.
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
        # perimeter unnamed, because it never had a comparison to lose.
        if seeded is None:
            continue
        seed_day, seed = seeded

        # **Both sides end on the same day** (#1050). The reference is fed by
        # the backfill only, and `forward_backfill_window` waits a full day
        # before advancing it, so its last close can trail the portfolio's last
        # written day by two trading days. `replay` would carry that close
        # forward and the head would put today's live portfolio against an
        # index standing still. Ended on its last quote instead, the period
        # stated under the figure is the one both sides were measured on.
        window = (seed_day, min(days[-1][0], quoted_to))
        flows = performance.invested_flows(timeline, account)
        result = counterfactual.replay(
            window, prices, splits, flows, seed, unconverted)
        if result.first_day is None:
            awaiting_rate = awaiting_rate or result.ended == counterfactual.AWAITING_RATE
            continue
        replayed[account] = (result, dict(days))
        materials[account] = (seed_day, seed, window[1], flows)

    # The second value is the first day each replayed account was **written**,
    # before any seeding: it is what tells who truncated the period, and the
    # wrong answer there names a cause the reader can go and check.
    merged = _merged(materials, prices, splits, unconverted)
    why = (NOT_COMPUTED if not computed
           else NO_RATE_ON_SEED if awaiting_rate else NOTHING_HELD)
    return (replayed,
            {account: written[account][0][0] for account in replayed}, merged,
            why)


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


def _merged(materials: Dict[str, Any], prices: Dict[date, float],
            splits, unconverted: List[date]
            ) -> Optional[Tuple[Any, Dict[str, date]]]:
    """Every account's money in **one** reference, from the first seed on.

    Each account enters the pot the way its own replay opens: its seed, plus
    whatever flowed before the first quoted day on or after it, lands on that
    quoted day — so the merged pot buys those shares at the very price the
    account's own replay bought them at, and the head is the sum of the rows.
    Every later flow is the account's own. The earliest account's entry is the
    replay's seed; the others arrive as contributions.

    Returns the replay and the day each account entered it, or ``None`` when
    nothing could be seeded.
    """
    if not materials:
        return None
    end = min(last for _, _, last, _ in materials.values())

    entries: Dict[str, date] = {}
    merged: Dict[date, float] = {}
    for account, (seed_day, seed, _, flows) in materials.items():
        entry = seed_day
        while entry <= end and entry not in prices:
            entry += counterfactual.ONE_DAY
        # Opened after the period ends: no money of it is inside the period,
        # on either side, and the period printed under the head says so.
        if entry > end:
            continue
        entries[account] = entry
        merged[entry] = merged.get(entry, 0.0) + seed + sum(
            amount for day, amount in flows.items() if seed_day < day <= entry)
        for day, amount in flows.items():
            if day > entry:
                merged[day] = merged.get(day, 0.0) + amount

    if not entries:
        return None
    first = min(entries.values())
    seed = merged.pop(first)
    result = counterfactual.replay(
        (first, end), prices, splits, merged, seed, unconverted)
    if result.first_day is None:
        return None
    return result, entries


def _aggregate(replayed: Dict[str, Any], merged,
               opened: Dict[str, date],
               quoted_from: date) -> Optional[Dict[str, Any]]:
    """The whole portfolio against the whole of its money in the reference.

    ``None`` when the merged replay could not open at all.
    """
    if merged is None:
        return None
    result, entries = merged
    covered_from = result.first_day
    covered_to = result.last_day
    accounts = {account: (replayed[account][1], entries[account])
                for account in entries}

    snap = _snapshot_at(result, covered_to)
    portfolio = _portfolio_at(accounts, covered_to)
    reference = snap.value if snap else 0.0
    contributed = snap.contributed if snap else 0.0

    # **Who truncated the period**, because the screen names a cause and a
    # wrong one is worse than none. The fund is the reason only when the
    # perimeter was written *before* the fund was ever quoted; an account
    # opened in 2024 against a fund quoted since 2009 is not truncated at all,
    # and saying otherwise sends the reader looking for a fund history that is
    # sitting right there.
    portfolio_from = min(opened.values())
    return {
        'covered_from': instants.iso(covered_from),
        'covered_to': instants.iso(covered_to),
        'portfolio_from': instants.iso(portfolio_from),
        'truncated_by_fund': portfolio_from < quoted_from,
        'ended': result.ended,
        # The two terms behind the head figure, and the perimeter they were
        # summed over. No screen reads them today — the head states the gap —
        # but they are what makes that gap checkable, and `gap_gross` alone
        # cannot tell 2 000 against 2 000 from 12 000 against 12 000.
        'accounts': sorted(accounts),
        'portfolio_value': portfolio,
        'reference_value': reference,
        'gap_gross': None if portfolio is None else portfolio - reference,
        'portfolio_return': _return(portfolio, contributed),
        'reference_return': _return(reference, contributed),
        'series': _series(result, accounts),
    }


def _rows(replayed: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Each account's own comparison, over **its own** window (#1014).

    The breakdown of the head: the same seeds and the same flows, one account
    at a time, so the rows add up to the head figure whenever every account
    runs to the end of the period — every account written through today.

    Every term is read on the account's **own** last day, which is why there is
    no all-or-nothing rule here: one account that ended early costs the others
    nothing. Its row then says so beside its own period, and only that row
    stops adding up — a withdrawal its own reference could not fund is funded
    by the others' in the head, because the money is the owner's.
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


def _portfolio_at(accounts: Dict[str, Tuple[Dict[date, Any], date]],
                  day: date) -> Optional[float]:
    """The real portfolio's value on ``day``, summed over the perimeter.

    An account counts for nothing before it entered the reference: its money
    is in neither side yet. ``None`` when an account that had entered has no
    value that day: a total missing a term is not a smaller total, and the
    screen says *I cannot tell* rather than handing the reference a walkover.
    """
    total = 0.0
    for days, entry in accounts.values():
        if day < entry:
            continue
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
    """The gain on the money invested, on the denominator both sides share.

    Simple and not annualised: ``(value − contributed) / contributed`` over the
    period — neither the money-weighted return nor the time-weighted one.

    ``None`` on a perimeter that has taken more out than it put in: the ratio
    still divides, and it answers with the sign flipped.
    """
    if value is None or contributed <= 0:
        return None
    return (value - contributed) / contributed


def _series(result, accounts: Dict[str, Tuple[Dict[date, Any], date]]
            ) -> List[Dict[str, Any]]:
    """The two curves on one day axis, over the whole period."""
    return [{'t': instants.iso(snap.day),
             'portfolio': _portfolio_at(accounts, snap.day),
             'reference': snap.value}
            for snap in result.series]


__all__ = ['comparison', 'NO_REFERENCE', 'REBUILDING', 'NOTHING_TO_COMPARE',
           'SPLITS_UNKNOWN', 'READY', 'NO_EVENTS', 'NOT_COMPUTED',
           'NOTHING_HELD', 'NO_RATE_ON_SEED']
