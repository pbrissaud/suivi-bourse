"""
SuiviBourse Events Module

This module handles portfolio event imports from CSV/XLSX files
and generates aggregated configuration compatible with the existing schema.
"""

from .schemas import (
    DEFAULT_ACCOUNT, CASH_EVENT_TYPES, Event, EventType, ShareState,
    PurchaseState, EstateState, Account, Portfolio, Timeline, InKindFlow,
    CashFlow, CashState, AccountMetricPoint,
)
from .loader import EventLoader
from .validator import EventValidator
from .aggregator import EventAggregator
from .watcher import EventWatcher

__all__ = [
    'DEFAULT_ACCOUNT',
    'CASH_EVENT_TYPES',
    'Event',
    'EventType',
    'ShareState',
    'PurchaseState',
    'EstateState',
    'Account',
    'Portfolio',
    'Timeline',
    'InKindFlow',
    'CashFlow',
    'CashState',
    'AccountMetricPoint',
    'EventLoader',
    'EventValidator',
    'EventAggregator',
    'EventWatcher',
]
