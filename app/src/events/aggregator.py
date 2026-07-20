"""
Event aggregator for computing portfolio state from events.
"""

import copy
from datetime import date
from typing import Dict, List, Tuple

from .schemas import (
    DEFAULT_ACCOUNT, Event, EventType, ShareState, PurchaseState, EstateState,
    Timeline, InKindFlow,
)


class AggregationError(Exception):
    """Exception raised when aggregation fails."""
    pass


class EventAggregator:
    """Aggregates portfolio events into share states."""

    def _event_account(self, event: Event, accounts_declared: bool) -> str:
        """Resolve the account bucket for an event.

        When accounts are declared, positions are keyed by the event's own
        account (guaranteed present by validation). Otherwise everything falls
        into the implicit ``default`` account — a single code path either way.
        """
        if accounts_declared and event.account:
            return event.account
        return DEFAULT_ACCOUNT

    def aggregate(self, events: List[Event], accounts_declared: bool = False) -> List[Dict]:
        """
        Aggregate events into share configurations (latest state).

        Thin wrapper over :meth:`replay`: there is a single replay implementation
        and this returns its final state per position.

        Args:
            events: List of events sorted by date.
            accounts_declared: When True, positions are keyed by
                ``(account, symbol)``. When False, everything is aggregated
                under the implicit ``default`` account.

        Returns:
            List of share dictionaries compatible with the config schema.

        Raises:
            AggregationError: If aggregation fails (e.g., selling more than owned).
        """
        return self.replay(events, accounts_declared).current()

    def replay(self, events: List[Event], accounts_declared: bool = False) -> Timeline:
        """
        Replay events once into a sparse :class:`Timeline`.

        A single replay serves every symbol and every date: the timeline records
        one snapshot per position per date where its state changes, and
        forward-fills on query (``Timeline.at`` / ``position_at``). External
        flows are emitted **without** a price (the aggregator never reads one).

        Args:
            events: List of events sorted by date.
            accounts_declared: When True, positions are keyed by
                ``(account, symbol)``; otherwise everything falls under
                ``default``.

        Returns:
            A Timeline covering all positions.

        Raises:
            AggregationError: If aggregation fails (e.g., selling more than owned).
        """
        timeline = Timeline()
        states: Dict[Tuple[str, str], ShareState] = {}

        for event in events:
            account = self._event_account(event, accounts_declared)
            key = (account, event.symbol)

            if key not in states:
                states[key] = ShareState(
                    name=event.name,
                    symbol=event.symbol,
                    account=account,
                    purchase=PurchaseState(),
                    estate=EstateState(),
                )
                timeline.snapshots[key] = []
                timeline.order.append(key)

            state = states[key]

            # Update name if provided (use latest name)
            if event.name:
                state.name = event.name

            # Process based on event type
            if event.event_type == EventType.BUY:
                self._process_buy(state, event)
            elif event.event_type == EventType.SELL:
                self._process_sell(state, event)
            elif event.event_type == EventType.GRANT:
                self._process_grant(state, event)
                # GRANT is an external in-kind flow, emitted non-valued.
                timeline.flows.append(InKindFlow(
                    date=event.date, account=account,
                    symbol=event.symbol, quantity=event.quantity))
            elif event.event_type == EventType.DIVIDEND:
                self._process_dividend(state, event)

            # Record the position's state as of this date (one snapshot per date)
            self._snapshot(timeline.snapshots[key], event.date, state)

        return timeline

    @staticmethod
    def _snapshot(
        snaps: List[Tuple[date, ShareState]], on_date: date, state: ShareState
    ) -> None:
        """Append (or, for a same-date change, replace) an immutable snapshot.

        Events are date-sorted, so a same-date event just supersedes the day's
        prior snapshot — the timeline keeps exactly one snapshot per change date.
        """
        snap = copy.deepcopy(state)
        if snaps and snaps[-1][0] == on_date:
            snaps[-1] = (on_date, snap)
        else:
            snaps.append((on_date, snap))

    def _process_buy(self, state: ShareState, event: Event) -> None:
        """
        Process a BUY event.

        Updates purchase.quantity, purchase.cost_price (weighted average),
        purchase.fee, and estate.quantity.
        """
        quantity = event.quantity
        unit_price = event.unit_price
        fee = event.fee or 0.0

        # Calculate weighted average cost price
        old_total = state.purchase.quantity * state.purchase.cost_price
        new_total = quantity * unit_price

        state.purchase.quantity += quantity
        state.estate.quantity += quantity

        if state.purchase.quantity > 0:
            state.purchase.cost_price = (old_total + new_total) / state.purchase.quantity
        else:
            state.purchase.cost_price = 0.0

        state.purchase.fee += fee

    def _process_sell(self, state: ShareState, event: Event) -> None:
        """
        Process a SELL event.

        Decreases estate.quantity and adds fees to purchase.fee.
        """
        quantity = event.quantity
        fee = event.fee or 0.0

        # Validate we're not selling more than we own
        if quantity > state.estate.quantity:
            raise AggregationError(
                f"Cannot sell {quantity} shares of {event.symbol} "
                f"(only {state.estate.quantity} owned) on {event.date}")

        state.estate.quantity -= quantity
        state.purchase.fee += fee

    def _process_grant(self, state: ShareState, event: Event) -> None:
        """
        Process a GRANT event.

        Only increases estate.quantity (free shares).
        """
        state.estate.quantity += event.quantity

    def _process_dividend(self, state: ShareState, event: Event) -> None:
        """
        Process a DIVIDEND event.

        Increases estate.received_dividend.
        """
        state.estate.received_dividend += event.amount
