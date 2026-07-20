"""
Data schemas for the events module.
"""

from dataclasses import dataclass, field
from datetime import date  # noqa: F401 — used in the `date: date` field annotation (eager-evaluated on Python <3.14)
from enum import Enum
from typing import List, Optional, Set


# Canonical account bucket used when no accounts are declared (opt-out users) or
# for points written before the accounts feature existed. The events/aggregation
# layer and main.py reference this constant; the lower-level InfluxDB writer and
# Prometheus exporter keep the same literal "default" as a parameter default so
# they stay decoupled from the events domain.
DEFAULT_ACCOUNT = "default"


class EventType(Enum):
    """Types of portfolio events."""
    BUY = "BUY"
    SELL = "SELL"
    GRANT = "GRANT"
    DIVIDEND = "DIVIDEND"


@dataclass
class Event:
    """Represents a single portfolio event."""
    date: date
    event_type: EventType
    symbol: str
    name: str
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
