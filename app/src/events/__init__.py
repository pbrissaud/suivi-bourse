"""
SuiviBourse Events Module

This module handles portfolio event imports from CSV/XLSX files
and generates aggregated configuration compatible with the existing schema.
"""

from .schemas import Event, EventType, ShareState, PurchaseState, EstateState
from .loader import EventLoader
from .validator import EventValidator
from .aggregator import EventAggregator
from .watcher import EventWatcher

__all__ = [
    'Event',
    'EventType',
    'ShareState',
    'PurchaseState',
    'EstateState',
    'EventLoader',
    'EventValidator',
    'EventAggregator',
    'EventWatcher',
]
