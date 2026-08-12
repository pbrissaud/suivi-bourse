"""
Data schemas for the events module.
"""

import bisect
from dataclasses import dataclass, field
from datetime import date  # noqa: F401 — used in dataclass field annotations (eager-evaluated on Python <3.14)
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Union


# Canonical account bucket used when no accounts are declared (opt-out users) or
# for points written before the accounts feature existed. Single source of truth:
# the aggregation layer, main.py, the store's writers and the Prometheus exporter
# all reference this constant so the tag, the label and the aggregation agree.
DEFAULT_ACCOUNT = "default"

# The columns of an accounts file (issue #698) — the columns of the ``account``
# table, and the **one** definition of them. Named here rather than in
# :mod:`accounts` because the validator quotes them in the refusal it raises
# when an event names an account nobody declared, and ``accounts`` imports this
# module: one direction, no cycle. ``accounts.ACCOUNT_COLUMNS`` is this tuple
# under the name that module's own messages read best, never a copy of it — two
# lists of columns, both quoted at a user, would drift the day the table gains a
# fourth.
ACCOUNT_FILE_COLUMNS = ('id', 'type', 'label')


class EventType(Enum):
    """Types of portfolio events."""
    BUY = "BUY"
    SELL = "SELL"
    GRANT = "GRANT"
    DIVIDEND = "DIVIDEND"
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"


# Cash events move money in/out of an account and carry no share (symbol/name/
# quantity/unit_price are forbidden on them).
CASH_EVENT_TYPES = frozenset({EventType.DEPOSIT, EventType.WITHDRAWAL})


@dataclass
class Event:
    """Represents a single portfolio event.

    ``symbol``/``name`` are Optional because cash events (DEPOSIT/WITHDRAWAL)
    carry no share.

    The last four fields are **provenance, and provenance is a display** (issue
    #697, spec #695 § 6). ``(source_id, source_sheet, source_row)`` are the
    store's own columns and exist to say *"row 14 of 2024.csv"*; they are never
    an address to write back to. What made #662's opaque token an address was
    that the *file* was the address — in the store a row has a primary key,
    which does not go stale, so nothing here needs to survive an edit.

    ``source_filename`` is the one derived field: it is joined on at read time
    (:func:`ledger.read_events`) so that whoever holds an event can render its
    provenance without going back to the store for the name.

    ``id`` is the ``event`` table's own primary key (issue #764), read by
    :func:`ledger.read_events` like any other column and ``None`` on an event
    that has not been written yet — a row a loader has just parsed out of a
    file, or a draft on its way in. It is what #662's opaque token over
    ``(file, sheet, row)`` was reaching for and could not be: a key does not go
    stale between the read and the write, which is why the apparatus that
    guarded a stale one (the fingerprint as an ``ETag``, its ``409``) has no
    successor here. It addresses **only** what it can address — a row typed in
    the app, ``source_id IS NULL`` — and an imported row carries one too, for
    the same reason every row of a table has a key: refusing to publish it would
    not make the row editable, it would only make the refusal unexplainable.
    """
    date: date
    event_type: EventType
    symbol: Optional[str] = None
    name: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    fee: Optional[float] = None
    amount: Optional[float] = None
    notes: Optional[str] = None
    account: Optional[str] = None
    source_id: Optional[int] = None
    source_sheet: Optional[str] = None
    source_row: Optional[int] = None
    source_filename: Optional[str] = None
    id: Optional[int] = None

    def __post_init__(self):
        # Convert string event_type to enum if needed
        if isinstance(self.event_type, str):
            self.event_type = EventType(self.event_type.upper())


def unit_cost(quantity: float, cost_basis: float) -> Optional[float]:
    """The weighted-average unit price of a position — **derived, never stored**.

    The one named helper the matching convention lives in (ADR-0003, #672 D1):
    cost is matched by *prix moyen pondéré* (CGI art. 150-0 D), which is the
    French tax rule and not a dial, so there is exactly one place that divides.

    ``None`` when the quantity is zero, and that is the truth rather than a
    guard: a position nobody holds has no unit cost price, it has a realized
    gain. Returning ``0.0`` there would read as *"bought for nothing"*, which is
    the class of plausible-looking wrong figure this whole ticket removes.
    """
    return cost_basis / quantity if quantity else None


@dataclass
class ShareState:
    """One position: **a quantity and a cost basis**, and nothing else (ADR-0003).

    A position stopped being two quantities and a unit price with #699. It is a
    *stock*: ``quantity`` of a security, and ``cost_basis`` — the amount paid for
    exactly that quantity, acquisition fees absorbed. The unit price is derived
    by :func:`unit_cost`, which makes three things fall out at once:

    * **a sale is a subtraction**, so ten years of partial sales accumulate no
      rounding drift from rebuilding an average;
    * **a fully sold position reports zero invested by construction** — quantity
      zero, basis zero — rather than through an ``if closed`` branch, which is
      where the phantom −932 € on a sold line came from;
    * **the unit price of a sold position is undefined**, which is what it is.

    There is **no ``closed`` flag** and there is no room for one: *closed* and
    *temporarily flat* differ only by a future event, so the predicate is
    ``quantity == 0`` and nothing computable today separates them.

    ``realized_gain`` is written here by the replay — never by the price scrape,
    whose write path is removed at the exact instant the figure is born. And it
    is a **breakdown** of the absolute gain, never a term added to it: the
    proceeds of the sale are already in the cash balance.
    """
    name: str
    symbol: str
    account: str = DEFAULT_ACCOUNT
    quantity: float = 0.0
    cost_basis: float = 0.0
    realized_gain: float = 0.0
    received_dividend: float = 0.0

    @property
    def unit_cost(self) -> Optional[float]:
        """This position's derived unit price — see :func:`unit_cost`."""
        return unit_cost(self.quantity, self.cost_basis)

    def to_dict(self) -> dict:
        """The position as a plain dict — the columns of the ``position`` table."""
        return {
            'name': self.name,
            'symbol': self.symbol,
            'account': self.account,
            'quantity': self.quantity,
            'cost_basis': self.cost_basis,
            'realized_gain': self.realized_gain,
            'received_dividend': self.received_dividend,
        }


def declared_value(quantity: Optional[float],
                   unit_price: Optional[float]) -> float:
    """What a GRANT declares it was worth — its contribution *and* its basis.

    The one place the optional price is read, so the two terms it feeds cannot
    drift apart (#672 D7): they move **together or neither**, which is what
    keeps ``latent + realized + dividends`` a decomposition of the absolute gain
    rather than three figures that nearly add up.

    A price that cannot be one — absent, zero, negative — is *dilution*, worth
    ``0.0``. It is normalised here rather than refused by the validator because
    that validator runs over the **whole stored ledger** on every build, and the
    column was parsed and silently discarded before #699: a refusal would be
    retroactive, and a row that was legal when imported would fail the boot.
    """
    if not quantity or not unit_price or unit_price <= 0:
        return 0.0
    return quantity * unit_price


@dataclass
class InKindFlow:
    """An in-kind external flow (a GRANT), carrying the price it was declared at.

    ``unit_price`` is the ``unit_price`` cell of the GRANT row — **optional**,
    and its two states are the two tax cases (#672 D7):

    * **present** — a valued award: the contribution *and* the cost basis are
      both ``quantity × unit_price``, so the latent gain is nil on the day of
      the grant;
    * **absent** — free shares by dilution: both are zero, so the latent gain is
      the whole value.

    It feeds the two terms **together or neither**, which is what keeps
    ``latent + realized + dividends`` a decomposition of the absolute gain. The
    number comes from the event and never from ``price_at``: valuing a grant at
    the day's quote made an account's absolute gain *drift as the backfill
    advanced*, with no event having moved.
    """
    date: date
    account: str
    symbol: str
    quantity: float
    unit_price: Optional[float] = None


@dataclass
class CashFlow:
    """A cash external flow (DEPOSIT/WITHDRAWAL), signed at the account level.

    ``amount`` is positive for a DEPOSIT and negative for a WITHDRAWAL — the
    external contribution only, excluding any fee (fees are internal costs). The
    performance module consumes these as the money put in/taken out.
    """
    date: date
    account: str
    amount: float


@dataclass
class CashState:
    """Per-account cash ledger state.

    ``cash_balance`` starts at 0.00 and every event applies its cash effect.
    ``net_contributed`` accumulates the external cash contributions
    (Σ deposits - Σ withdrawals, excluding fees).
    """
    cash_balance: float = 0.0
    net_contributed: float = 0.0


@dataclass
class AccountMetricPoint:
    """One daily point of the ``account_metrics`` series for one account.

    A typed seam shared by the computation (main), the store's writer and the
    Prometheus exporter, so a mistyped field fails fast instead of silently
    dropping.

    ``day`` is a **calendar day**, not an instant (issue #700). v4 stamped the
    point at midnight because InfluxDB had one kind of time; the store has two
    and never mixes them (spec #695 § 3), so the field says what it is and every
    reader stops having to un-stamp it.

    ``account_type`` has **no column** — it was an InfluxDB tag, and the
    declaration is where a page reads it from (ADR-0013). It survives on the
    point because the Prometheus exporter publishes it as a label on
    ``sb_account_info``.

    ``account_currency`` is **gone** with ``Account.currency`` (issue #702,
    ADR-0002): an account has no currency of its own, there is one reporting
    currency for the install, and every figure below is already in it.

    **Every figure is optional since #708**, and the shape is the per-field rule
    (:func:`performance.writable_fields`) made structural: ``holdings_value`` and
    ``gain_absolu`` are written for everybody, the cash-derived four only where
    the account has a cash ledger, ``xirr`` only where it has an external flow.
    ``None`` is written as ``NULL`` and never as a zero — a zero would make *"no
    ledger"* and *"a ledger at zero"* the same row.
    """
    account: str
    account_type: str
    day: date
    cash_balance: Optional[float] = None
    holdings_value: Optional[float] = None
    total_value: Optional[float] = None
    net_contributed: Optional[float] = None
    # Money-weighted performance (only present once computable; xirr requires at
    # least one external flow, so it may be absent).
    xirr: Optional[float] = None
    gain_absolu: Optional[float] = None
    twr_index: Optional[float] = None


@dataclass
class PortfolioTotalPoint:
    """One daily point of the global ``portfolio_totals`` series.

    A table of its own rather than a synthetic ``account`` row: the InfluxDB
    constraint that made it untagged is gone, but its columns will diverge the
    day the global level carries something the per-account level does not.

    The single-currency condition that used to gate it is **gone** with
    ``Account.currency`` (issue #702): accounts cannot disagree about a currency
    they do not have. What gates it now is the reporting currency being answered
    at all — and that gate is above, on the whole perf recompute, since none of
    these figures has a unit until it is.

    Optional field by field like its per-account twin, and for one reason more:
    the global figure is written only where it is writable for **every** account
    (ADR-0018), so a single account with no cash ledger takes the global
    ``total_value`` away while ``holdings_value`` and ``gain_absolu`` stay.
    """
    day: date
    cash_balance: Optional[float] = None
    holdings_value: Optional[float] = None
    total_value: Optional[float] = None
    net_contributed: Optional[float] = None
    xirr: Optional[float] = None
    gain_absolu: Optional[float] = None
    twr_index: Optional[float] = None


@dataclass
class Timeline:
    """A sparse replay of portfolio events.

    Holds, per ``(account, symbol)`` position, one snapshot per date where that
    position's state changed (not one per calendar day). ``at()`` /
    ``position_at()`` forward-fill: they return the latest snapshot at or before
    the requested date, so the timeline is agnostic to the query window (the
    window is a property of the stored series, which grows with backfill, not a
    property of the events).
    """
    # (account, symbol) -> ascending [(change_date, ShareState snapshot)]
    snapshots: Dict[Tuple[str, str], List[Tuple[date, "ShareState"]]] = field(default_factory=dict)
    # account -> ascending [(change_date, CashState snapshot)]
    cash_snapshots: Dict[str, List[Tuple[date, "CashState"]]] = field(default_factory=dict)
    # First-appearance order of the positions (stable output ordering)
    order: List[Tuple[str, str]] = field(default_factory=list)
    # Non-valued external flows collected during the replay (in-kind + cash)
    flows: List[Union[InKindFlow, CashFlow]] = field(default_factory=list)

    @staticmethod
    def state_at(pairs: List[Tuple[date, object]], target_date: date):
        """Forward-fill: the value of the ``(date, value)`` pair at or before
        ``target_date``, or None.

        Pairs must be date-sorted, so this is a binary search — the pair just
        left of the insertion point is the latest change on or before the date.
        Reused for any date-keyed series (position snapshots, cash snapshots,
        price series).
        """
        idx = bisect.bisect_right(pairs, target_date, key=lambda pair: pair[0])
        return pairs[idx - 1][1] if idx else None

    def cash_at(self, account: str, target_date: date) -> Optional["CashState"]:
        """Cash ledger state of an account at ``target_date`` (forward-filled).

        Returns None when the account has no cash-affecting event on or before
        that date — callers treat that as a zero balance (the ledger starts at
        0.00).
        """
        snaps = self.cash_snapshots.get(account)
        if not snaps:
            return None
        return self.state_at(snaps, target_date)

    def position_at(
        self, account: str, symbol: str, target_date: date
    ) -> Optional[dict]:
        """State of one ``(account, symbol)`` position at ``target_date``.

        Returns None when the position has no event on or before that date
        (including before its first event — an empty state, never an error).
        """
        snaps = self.snapshots.get((account, symbol))
        if not snaps:
            return None
        state = self.state_at(snaps, target_date)
        return state.to_dict() if state is not None else None

    def holding_window(self, account: str, symbol: str,
                       today: date) -> Optional[Tuple[date, date]]:
        """``(first day held, last day held)`` for one ``(account, symbol)``.

        The last day is ``today`` while the line stands, the day it emptied
        otherwise — and that day **counts as held**, since the price of the day
        one sells is part of the history one held (the reading
        :func:`carrying.holding_bounds` already makes of an exit). ``None`` when
        the position never carried a quantity at all, which is the shape a
        dividend-only row leaves behind.

        Per ``(account, symbol)`` and deliberately so: it is what bounds the perf
        **horizon** (issue #708, :func:`performance.account_horizon`), which is
        per account, whereas :func:`main.holding_windows` answers the same
        question for the *backfill*, whose unit is the symbol — a price belongs to
        no account (#700). Two questions, two granularities, and collapsing them
        would hold one account at another's dates.

        A buy-back is answered by the position standing again: the scan keeps the
        **last** emptying and forgets the earlier ones, so a line bought in 2020,
        sold in 2022 and bought back in 2024 is held from 2020 through *today*.
        That is the same simplification the backfill window makes, and it is the
        conservative one here — the flat years are counted as held rather than
        skipped.
        """
        snaps = self.snapshots.get((account, symbol))
        if not snaps:
            return None
        acquired: Optional[date] = None
        emptied: Optional[date] = None
        holding = False
        for day, state in snaps:
            if state.quantity:
                if acquired is None:
                    acquired = day
                holding = True
                emptied = None
            elif holding:
                holding = False
                emptied = day
        if acquired is None:
            return None
        return acquired, (today if holding else emptied)

    def at(self, target_date: date) -> List[dict]:
        """Every position's state at ``target_date`` (forward-filled).

        Positions with no event on or before ``target_date`` are omitted.
        """
        result = []
        for key in self.order:
            state = self.state_at(self.snapshots[key], target_date)
            if state is not None:
                result.append(state.to_dict())
        return result

    def current(self) -> List[dict]:
        """The latest state of every position — **sold ones included**.

        Deliberately unfiltered (#672 D5). A position whose quantity has fallen
        to zero must stay here: the replay has to write its realized gain, and
        the page has to show it. What departs on a sold position is its *scrape
        job*, and the filtering line is :meth:`main.SuiviBourseMetrics._held_symbols`
        — never this method, which would take the row away from the two readers
        that need it most.
        """
        return [self.snapshots[key][-1][1].to_dict() for key in self.order]

    def current_cash(self) -> Dict[str, "CashState"]:
        """The latest cash ledger of every account the events touched.

        The other half of what the replay lays down: :meth:`current` is the
        ``position`` table, this is ``account_state``. An account with no event
        is absent rather than zeroed — it has no ledger yet, and inventing one
        would make *"never deposited"* and *"deposited nothing"* the same row.
        """
        return {account: snaps[-1][1]
                for account, snaps in self.cash_snapshots.items() if snaps}


@dataclass
class Account:
    """A declared account — a row of the store's ``account`` table (issue #698).

    Declared by a **file** in the events' format, or from the app; never by a
    settings block, which is the inheritance ADR-0013 corrects. ``source_id`` is
    where it came from: the import that carried it, or ``NULL`` for one created
    in the app — which is also what makes it editable, since what came from a
    file is read-only and revoked with its import.

    **There is no ``currency`` field** (issue #702, ADR-0002). It was kept as an
    always-``None`` placeholder while the v4 currency machinery was still in
    place; it is deleted with that machinery, and deleted rather than left
    unused. There are two levels of currency and not three — the reporting
    currency and the security's quote currency — so *"an account whose positions
    disagree with its currency"* stops being a sentence with a referent, and the
    guard, the test and the degraded screen it needed stop with it.
    """
    id: str
    type: str
    label: str = ''
    source_id: Optional[int] = None

    @property
    def editable(self) -> bool:
        """Can the app change this account? Only if no file provisioned it."""
        return self.source_id is None


@dataclass
class Portfolio:
    """The set of declared accounts."""
    accounts: List[Account] = field(default_factory=list)

    def ids(self) -> Set[str]:
        """Return the set of declared account ids."""
        return {a.id for a in self.accounts}

    def get(self, account_id: str) -> Optional[Account]:
        """Return the declared account with this id, or None."""
        for account in self.accounts:
            if account.id == account_id:
                return account
        return None
