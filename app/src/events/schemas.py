"""
Data schemas for the events module.
"""

import bisect
from dataclasses import dataclass, field
from datetime import date, datetime  # noqa: F401 — used in dataclass field annotations (eager-evaluated on Python <3.14)
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Union


# Canonical account bucket used when no accounts are declared (opt-out users) or
# for points written before the accounts feature existed. Single source of truth:
# the aggregation layer, main.py, the InfluxDB writer and the Prometheus exporter
# all reference this constant so the tag, the label and the aggregation agree.
DEFAULT_ACCOUNT = "default"


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

    def __post_init__(self):
        # Convert string event_type to enum if needed
        if isinstance(self.event_type, str):
            self.event_type = EventType(self.event_type.upper())


@dataclass
class PurchaseState:
    """Aggregated purchase state for a share."""
    quantity: float = 0.0
    cost_price: float = 0.0
    fee: float = 0.0


@dataclass
class EstateState:
    """Aggregated estate state for a share."""
    quantity: float = 0.0
    received_dividend: float = 0.0


@dataclass
class ShareState:
    """Complete aggregated state for a share."""
    name: str
    symbol: str
    account: str = DEFAULT_ACCOUNT
    purchase: PurchaseState = field(default_factory=PurchaseState)
    estate: EstateState = field(default_factory=EstateState)

    def to_dict(self) -> dict:
        """Convert to dictionary format compatible with the config schema."""
        return {
            'name': self.name,
            'symbol': self.symbol,
            'account': self.account,
            'purchase': {
                'quantity': self.purchase.quantity,
                'cost_price': self.purchase.cost_price,
                'fee': self.purchase.fee,
            },
            'estate': {
                'quantity': self.estate.quantity,
                'received_dividend': self.estate.received_dividend,
            },
        }


@dataclass
class InKindFlow:
    """A non-valued in-kind external flow (currently a GRANT).

    The aggregator emits it *without* a price — valuation at the day's price is
    resolved downstream (performance module), which is why the aggregator never
    needs to know a price.
    """
    date: date
    account: str
    symbol: str
    quantity: float


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

    A typed seam shared by the computation (main), the InfluxDB writer and the
    Prometheus exporter, so a mistyped field fails fast instead of silently
    dropping.
    """
    account: str
    account_type: str
    account_currency: str
    timestamp: datetime
    cash_balance: float
    holdings_value: float
    total_value: float
    net_contributed: float


@dataclass
class Timeline:
    """A sparse replay of portfolio events.

    Holds, per ``(account, symbol)`` position, one snapshot per date where that
    position's state changed (not one per calendar day). ``at()`` /
    ``position_at()`` forward-fill: they return the latest snapshot at or before
    the requested date, so the timeline is agnostic to the query window (the
    window is an InfluxDB property that grows with backfill, not a property of
    the events).
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
        """The latest state of every position (replaces the old full aggregate)."""
        return [self.snapshots[key][-1][1].to_dict() for key in self.order]


@dataclass
class Account:
    """A declared account (opt-in feature, configured in settings.yaml)."""
    id: str
    type: str
    currency: str
    label: str


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
