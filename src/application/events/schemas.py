"""Data schemas for the events module."""

import bisect
from dataclasses import dataclass, field
from datetime import date  # noqa: F401 — used in dataclass field annotations (eager-evaluated on Python <3.14)
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Union


DEFAULT_ACCOUNT = "default"

ACCOUNT_FILE_COLUMNS = ('id', 'type', 'label')


class EventType(Enum):
    """Types of portfolio events."""
    BUY = "BUY"
    SELL = "SELL"
    GRANT = "GRANT"
    DIVIDEND = "DIVIDEND"
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"


CASH_EVENT_TYPES = frozenset({EventType.DEPOSIT, EventType.WITHDRAWAL})


@dataclass
class Event:
    """One dated line of the ledger — and ``id`` is its **address** (ADR-0027).

    A key names one row for as long as that row lives, and promises nothing
    beyond it: the id is absent from the CSV export, so an event exported and
    re-imported comes back under another one.

    What makes an address safe to hold between the read and the write is not
    the key — it is **the allocator**. :meth:`store.Store.reserve` climbs and
    never descends, so a deleted row's key is not handed to the next writer,
    and a write aiming at a row that has gone meets ``UnknownEntry`` rather
    than landing on a stranger.

    That is why #662's apparatus — the opaque token over ``(file, sheet, row)``,
    the content fingerprint as an ``ETag`` and its ``409`` — has no successor
    here: the refusal it existed to buy is bought by the allocator, and bought
    **for the life of the process**. A restart re-seeds from the highest key the
    table still holds and can reissue one freed before it; a client holding a key across a restart is
    holding it across an app that went down. Were that bound ever to prove too
    short, the token is what comes back.
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
    id: Optional[int] = None

    def __post_init__(self):
        if isinstance(self.event_type, str):
            self.event_type = EventType(self.event_type.upper())


def unit_cost(quantity: float, cost_basis: float) -> Optional[float]:
    """The weighted-average unit price of a position — **derived, never stored**."""
    return cost_basis / quantity if quantity else None


@dataclass
class ShareState:
    """One position: **a quantity and a cost basis**, and nothing else (ADR-0003)."""
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
    """What a GRANT declares it was worth — its contribution *and* its basis."""
    if not quantity or not unit_price or unit_price <= 0:
        return 0.0
    return quantity * unit_price


@dataclass
class InKindFlow:
    """An in-kind external flow (a GRANT), carrying the price it was declared at."""
    date: date
    account: str
    symbol: str
    quantity: float
    unit_price: Optional[float] = None


@dataclass
class CashFlow:
    """A cash external flow (DEPOSIT/WITHDRAWAL), signed at the account level."""
    date: date
    account: str
    amount: float


@dataclass
class CashState:
    """Per-account cash ledger state."""
    cash_balance: float = 0.0
    net_contributed: float = 0.0


@dataclass
class AccountMetricPoint:
    """One daily point of the ``account_metrics`` series for one account."""
    account: str
    day: date
    cash_balance: Optional[float] = None
    holdings_value: Optional[float] = None
    total_value: Optional[float] = None
    net_contributed: Optional[float] = None
    xirr: Optional[float] = None
    gain_absolu: Optional[float] = None
    twr_index: Optional[float] = None


@dataclass
class PortfolioTotalPoint:
    """One daily point of the global ``portfolio_totals`` series."""
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
    """A sparse replay of portfolio events."""
    snapshots: Dict[Tuple[str, str], List[Tuple[date, "ShareState"]]] = field(default_factory=dict)
    cash_snapshots: Dict[str, List[Tuple[date, "CashState"]]] = field(default_factory=dict)
    order: List[Tuple[str, str]] = field(default_factory=list)
    flows: List[Union[InKindFlow, CashFlow]] = field(default_factory=list)

    @staticmethod
    def state_at(pairs: List[Tuple[date, object]], target_date: date):
        """Forward-fill: the value of the ``(date, value)`` pair at or before ``target_date``, or None."""
        idx = bisect.bisect_right(pairs, target_date, key=lambda pair: pair[0])
        return pairs[idx - 1][1] if idx else None

    def cash_at(self, account: str, target_date: date) -> Optional["CashState"]:
        """Cash ledger state of an account at ``target_date`` (forward-filled)."""
        snaps = self.cash_snapshots.get(account)
        if not snaps:
            return None
        return self.state_at(snaps, target_date)

    def position_at(
        self, account: str, symbol: str, target_date: date
    ) -> Optional[dict]:
        """State of one ``(account, symbol)`` position at ``target_date``."""
        snaps = self.snapshots.get((account, symbol))
        if not snaps:
            return None
        state = self.state_at(snaps, target_date)
        return state.to_dict() if state is not None else None

    def holding_window(self, account: str, symbol: str,
                       today: date) -> Optional[Tuple[date, date]]:
        """``(first day held, last day held)`` for one ``(account, symbol)``."""
        snaps = self.snapshots.get((account, symbol))
        if not snaps:
            return None
        acquired: Optional[date] = None
        emptied: Optional[date] = None
        holding = False
        for day, state in snaps:
            if day > today:
                break
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
        """Every position's state at ``target_date`` (forward-filled)."""
        result = []
        for key in self.order:
            state = self.state_at(self.snapshots[key], target_date)
            if state is not None:
                result.append(state.to_dict())
        return result

    def current(self) -> List[dict]:
        """The latest state of every position — **sold ones included**."""
        return [self.snapshots[key][-1][1].to_dict() for key in self.order]

    def current_cash(self) -> Dict[str, "CashState"]:
        """The latest cash ledger of every account the events touched."""
        return {account: snaps[-1][1]
                for account, snaps in self.cash_snapshots.items() if snaps}


@dataclass
class Account:
    """A declared account — a row of the store's ``account`` table (issue #698)."""
    id: str
    type: str
    label: str = ''


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
