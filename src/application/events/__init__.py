"""
SuiviBourse Events Module

This module handles portfolio event imports from CSV/XLSX files
and generates aggregated configuration compatible with the existing schema.
"""

from .schemas import (
    DEFAULT_ACCOUNT, CASH_EVENT_TYPES, Event, EventType, ShareState,
    unit_cost, Account, Portfolio, Timeline, InKindFlow,
    CashFlow, CashState, AccountMetricPoint, PortfolioTotalPoint,
)

#: The three names that are **not** imported eagerly, and where each lives.
#:
#: ``schemas`` above is the domain's vocabulary and imports nothing but the
#: standard library. The three below are its machinery, and each drags a heavy
#: edge in with it: ``loader`` pulls pandas and openpyxl. Imported here at
#: module level, they were pulled by **anything that touched this package** —
#: including ``performance.py``, ``carrying.py`` and ``retention.py``, which the
#: root ``CLAUDE.md`` lists among the modules that stay pure: no store, no
#: yfinance, ``now`` injected. ``import performance`` failed with
#: ``ModuleNotFoundError: watchdog`` outside the full venv, which was as plain a
#: statement as there is that the rule was not being kept — the fourth name was
#: the drop folder's watcher, and it left with the folder (ADR-0032).
#:
#: :pep:`562` is what lets the call sites stay as they are —
#: ``from events import EventAggregator`` still works, and pays for the
#: aggregator only when it is what you asked for. ``carrying.py`` re-spells a
#: constant rather than importing it "because importing it pulls pandas and
#: openpyxl into a pure view module"; that sentence is what this fixes.
_LAZY = {
    'EventLoader': '.loader',
    'EventValidator': '.validator',
    'ValidationIssue': '.validator',
    'EventAggregator': '.aggregator',
}


def __getattr__(name: str):
    """Import the machinery on first use (:pep:`562`).

    ``AttributeError`` for anything not in the table, which is what the import
    machinery needs to hear before falling back to loading a **submodule** —
    ``from events import export as events_export`` goes down that path.
    """
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module
    value = getattr(import_module(module, __name__), name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(_LAZY))


__all__ = [
    'DEFAULT_ACCOUNT',
    'CASH_EVENT_TYPES',
    'Event',
    'EventType',
    'ShareState',
    'unit_cost',
    'Account',
    'Portfolio',
    'Timeline',
    'InKindFlow',
    'CashFlow',
    'CashState',
    'AccountMetricPoint',
    'PortfolioTotalPoint',
    'EventLoader',
    'EventValidator',
    'ValidationIssue',
    'EventAggregator',
]
