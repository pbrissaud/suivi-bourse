"""
Event aggregator for computing portfolio state from events.
"""

import copy
from datetime import date
from typing import Dict, List, Tuple

from .schemas import (
    CASH_EVENT_TYPES, DEFAULT_ACCOUNT, Event, EventType, ShareState,
    PurchaseState, EstateState, Timeline, InKindFlow, CashFlow, CashState,
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
        cash_states: Dict[str, CashState] = {}

        for event in events:
            account = self._event_account(event, accounts_declared)

            # Every account gets a cash ledger, starting at 0.00, on first sight.
            if account not in cash_states:
                cash_states[account] = CashState()
                timeline.cash_snapshots[account] = []
            cash = cash_states[account]

            # Cash events (DEPOSIT/WITHDRAWAL) carry no share: only the ledger moves.
            if event.event_type in CASH_EVENT_TYPES:
                self._process_cash_event(cash, event, account, timeline)
                self._snapshot(timeline.cash_snapshots[account], event.date, cash)
                continue

            # Share events: update the (account, symbol) position...
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

            # ...and apply the event's cash effect (GRANT is cash-neutral).
            if self._apply_share_cash(cash, event):
                self._snapshot(timeline.cash_snapshots[account], event.date, cash)

        return timeline

    def _process_cash_event(
        self, cash: CashState, event: Event, account: str, timeline: Timeline
    ) -> None:
        """Apply a DEPOSIT/WITHDRAWAL to the ledger and emit its (signed) CashFlow.

        The fee always makes the cash worse; ``net_contributed`` tracks the raw
        external contribution (fee excluded). The emitted CashFlow is non-valued.
        """
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
        """Apply a share event's cash effect. Returns True if cash changed.

        BUY debits, SELL and DIVIDEND credit (fee always worsens cash); GRANT is
        cash-neutral.
        """
        fee = event.fee or 0.0
        if event.event_type == EventType.BUY:
            cash.cash_balance -= event.quantity * event.unit_price + fee
        elif event.event_type == EventType.SELL:
            cash.cash_balance += event.quantity * event.unit_price - fee
        elif event.event_type == EventType.DIVIDEND:
            cash.cash_balance += event.amount - fee
        else:  # GRANT
            return False
        return True

    @staticmethod
    def _snapshot(snaps: List[Tuple[date, object]], on_date: date, state) -> None:
        """Append (or, for a same-date change, replace) an immutable snapshot.

        Works for any per-date state (ShareState or CashState). Events are
        date-sorted, so a same-date event just supersedes the day's prior
        snapshot — the timeline keeps exactly one snapshot per change date.
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
