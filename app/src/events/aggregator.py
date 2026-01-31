"""
Event aggregator for computing portfolio state from events.
"""

from typing import Dict, List

from .schemas import Event, EventType, ShareState, PurchaseState, EstateState


class AggregationError(Exception):
    """Exception raised when aggregation fails."""
    pass


class EventAggregator:
    """Aggregates portfolio events into share states."""

    def aggregate(self, events: List[Event]) -> List[Dict]:
        """
        Aggregate events into share configurations.

        Args:
            events: List of events sorted by date.

        Returns:
            List of share dictionaries compatible with the config schema.

        Raises:
            AggregationError: If aggregation fails (e.g., selling more than owned).
        """
        # Group events by symbol and process in order
        states: Dict[str, ShareState] = {}

        for event in events:
            if event.symbol not in states:
                states[event.symbol] = ShareState(
                    name=event.name,
                    symbol=event.symbol,
                    purchase=PurchaseState(),
                    estate=EstateState(),
                )

            state = states[event.symbol]

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
            elif event.event_type == EventType.DIVIDEND:
                self._process_dividend(state, event)

        # Convert to list of dicts, preserving symbol order of first appearance
        seen_symbols = []
        for event in events:
            if event.symbol not in seen_symbols:
                seen_symbols.append(event.symbol)

        return [states[symbol].to_dict() for symbol in seen_symbols]

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
