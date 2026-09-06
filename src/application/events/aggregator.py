"""Event aggregator for computing portfolio state from events."""

import copy
import math
from datetime import date
from typing import Dict, List, Optional, Tuple

from .schemas import (
    CASH_EVENT_TYPES, DEFAULT_ACCOUNT, Event, EventType, ShareState,
    Timeline, InKindFlow, CashFlow, CashState, declared_value, unit_cost,
)


DUST_FRACTION = 1e-9


class AggregationError(Exception):
    """Exception raised when aggregation fails."""

    def __init__(self, message: str, *, symbol: Optional[str] = None,
                 wanted: Optional[float] = None,
                 owned: Optional[float] = None,
                 day: Optional[date] = None,
                 account: Optional[str] = None):
        super().__init__(message)
        self.symbol = symbol
        self.wanted = wanted
        self.owned = owned
        self.day = day
        self.account = account


class EventAggregator:
    """Aggregates portfolio events into share states."""

    def _event_account(self, event: Event) -> str:
        """Resolve the account bucket for an event."""
        return event.account or DEFAULT_ACCOUNT

    def aggregate(self, events: List[Event]) -> List[Dict]:
        """Aggregate events into share configurations (latest state)."""
        return self.replay(events).current()

    def replay(self, events: List[Event]) -> Timeline:
        """Replay events once into a sparse :class:`Timeline`."""
        timeline = Timeline()
        states: Dict[Tuple[str, str], ShareState] = {}
        cash_states: Dict[str, CashState] = {}
        acquired: Dict[Tuple[str, str], float] = {}

        for event in events:
            account = self._event_account(event)

            if account not in cash_states:
                cash_states[account] = CashState()
                timeline.cash_snapshots[account] = []
            cash = cash_states[account]

            if event.event_type in CASH_EVENT_TYPES:
                self._process_cash_event(cash, event, account, timeline)
                self._snapshot(timeline.cash_snapshots[account], event.date, cash)
                continue

            key = (account, event.symbol)
            if key not in states:
                states[key] = ShareState(
                    name=event.name,
                    symbol=event.symbol,
                    account=account,
                )
                acquired[key] = 0.0
                timeline.snapshots[key] = []
                timeline.order.append(key)

            state = states[key]

            if event.name:
                state.name = event.name

            if event.event_type == EventType.BUY:
                self._process_buy(state, event)
                acquired[key] += event.quantity
            elif event.event_type == EventType.SELL:
                self._process_sell(state, event, acquired[key])
            elif event.event_type == EventType.GRANT:
                self._process_grant(state, event)
                acquired[key] += event.quantity
                timeline.flows.append(InKindFlow(
                    date=event.date, account=account,
                    symbol=event.symbol, quantity=event.quantity,
                    unit_price=event.unit_price))
            elif event.event_type == EventType.DIVIDEND:
                self._process_dividend(state, event)

            self._snapshot(timeline.snapshots[key], event.date, state)

            if self._apply_share_cash(cash, event):
                self._snapshot(timeline.cash_snapshots[account], event.date, cash)

        return timeline

    def _process_cash_event(
        self, cash: CashState, event: Event, account: str, timeline: Timeline
    ) -> None:
        """Apply a DEPOSIT/WITHDRAWAL to the ledger and emit its (signed) CashFlow."""
        fee = event.fee or 0.0
        if event.event_type == EventType.DEPOSIT:
            cash.cash_balance += event.amount - fee
            cash.net_contributed += event.amount
            timeline.flows.append(CashFlow(event.date, account, event.amount))
        else:  # WITHDRAWAL
            cash.cash_balance -= event.amount + fee
            cash.net_contributed -= event.amount
            timeline.flows.append(CashFlow(event.date, account, -event.amount))

    def _apply_share_cash(self, cash: CashState, event: Event) -> bool:
        """Apply a share event's cash effect. Returns True if cash changed."""
        fee = event.fee or 0.0
        if event.event_type == EventType.BUY:
            cash.cash_balance -= event.quantity * event.unit_price + fee
        elif event.event_type == EventType.SELL:
            cash.cash_balance += event.quantity * event.unit_price - fee
        elif event.event_type == EventType.DIVIDEND:
            cash.cash_balance += event.amount - fee
        else:  # GRANT
            if not fee:
                return False
            cash.cash_balance -= fee
        return True

    @staticmethod
    def _snapshot(snaps: List[Tuple[date, object]], on_date: date, state) -> None:
        """Append (or, for a same-date change, replace) an immutable snapshot."""
        snap = copy.copy(state)
        if snaps and snaps[-1][0] == on_date:
            snaps[-1] = (on_date, snap)
        else:
            snaps.append((on_date, snap))

    def _process_buy(self, state: ShareState, event: Event) -> None:
        """Process a BUY: the quantity and the amount it cost, fee absorbed."""
        state.quantity += event.quantity
        state.cost_basis += event.quantity * event.unit_price + (event.fee or 0.0)

    def _process_sell(self, state: ShareState, event: Event,
                      acquired: float) -> None:
        """Process a SELL: a subtraction, and the realized gain it produces."""
        quantity = event.quantity
        fee = event.fee or 0.0

        held = state.quantity + DUST_FRACTION * acquired
        if not (math.isfinite(quantity) and math.isfinite(held)) or quantity > held:
            raise AggregationError(
                f"Cannot sell {quantity} shares of {event.symbol} "
                f"(only {state.quantity} owned) on {event.date}",
                symbol=event.symbol, wanted=quantity, owned=state.quantity,
                day=event.date, account=state.account)
        quantity = min(quantity, state.quantity)

        unit = unit_cost(state.quantity, state.cost_basis) or 0.0
        basis_removed = quantity * unit
        proceeds = quantity * event.unit_price - fee

        state.realized_gain += proceeds - basis_removed
        state.quantity -= quantity
        state.cost_basis -= basis_removed

        if state.quantity <= DUST_FRACTION * acquired:
            state.quantity = 0.0
            state.cost_basis = 0.0

    def _process_grant(self, state: ShareState, event: Event) -> None:
        """Process a GRANT: the quantity, and the price it was declared at."""
        state.quantity += event.quantity
        state.cost_basis += declared_value(
            event.quantity, event.unit_price) + (event.fee or 0.0)

    def _process_dividend(self, state: ShareState, event: Event) -> None:
        """Process a DIVIDEND: it leaves the profit-and-loss entirely."""
        state.received_dividend += event.amount - (event.fee or 0.0)
