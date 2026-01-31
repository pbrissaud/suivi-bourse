"""
Data schemas for the events module.
"""

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Optional


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
    purchase: PurchaseState = field(default_factory=PurchaseState)
    estate: EstateState = field(default_factory=EstateState)

    def to_dict(self) -> dict:
        """Convert to dictionary format compatible with the config schema."""
        return {
            'name': self.name,
            'symbol': self.symbol,
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
