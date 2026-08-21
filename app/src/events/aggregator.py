"""
Event aggregator for computing portfolio state from events.
"""

import copy
from datetime import date
from typing import Dict, List, Tuple

from .schemas import (
    CASH_EVENT_TYPES, DEFAULT_ACCOUNT, Event, EventType, ShareState,
    Timeline, InKindFlow, CashFlow, CashState, declared_value, unit_cost,
)


#: The share of a position's total acquired quantity below which what a sale
#: leaves behind is **noise from the file, not a holding** (spec #695 § 8,
#: ADR-0017). A real broker export writes a sale of ``0.34898399999999996``
#: against a purchase of ``0.348984`` and leaves ``4×10⁻¹⁷`` of a share standing
#: — enough to keep the position out of the sold state, to keep its scrape job
#: armed forever, and to leave a cost basis of a few billionths of a cent
#: reported as *invested*. The bruise is in the file; the arithmetic is exact,
#: so the normalisation is applied where the file's number lands and nowhere
#: else.
DUST_FRACTION = 1e-9


class AggregationError(Exception):
    """Exception raised when aggregation fails."""
    pass


class EventAggregator:
    """Aggregates portfolio events into share states."""

    def _event_account(self, event: Event) -> str:
        """Resolve the account bucket for an event.

        One line and no branch, which is the point (issue #698, ADR-0013): an
        event's own account, or ``default`` when it names none. **Nothing here
        asks whether accounts are declared** — the store always holds at least
        one account, and whether a blank column was allowed to stay blank is a
        question the validator already answered before the row could get here.
        """
        return event.account or DEFAULT_ACCOUNT

    def aggregate(self, events: List[Event]) -> List[Dict]:
        """
        Aggregate events into share configurations (latest state).

        Thin wrapper over :meth:`replay`: there is a single replay implementation
        and this returns its final state per position.

        Args:
            events: List of events sorted by date.

        Returns:
            List of share dictionaries compatible with the config schema.

        Raises:
            AggregationError: If aggregation fails (e.g., selling more than owned).
        """
        return self.replay(events).current()

    def replay(self, events: List[Event]) -> Timeline:
        """
        Replay events once into a sparse :class:`Timeline`.

        A single replay serves every symbol and every date: the timeline records
        one snapshot per position per date where its state changes, and
        forward-fills on query (``Timeline.at`` / ``position_at``). External
        flows are emitted **without** a price (the aggregator never reads one).

        Positions are keyed by ``(account, symbol)``, the account being the
        event's own or ``default`` (issue #698).

        Args:
            events: List of events sorted by date.

        Returns:
            A Timeline covering all positions.

        Raises:
            AggregationError: If aggregation fails (e.g., selling more than owned).
        """
        timeline = Timeline()
        states: Dict[Tuple[str, str], ShareState] = {}
        cash_states: Dict[str, CashState] = {}
        # Σ acquired per position — BUY *and* GRANT, every quantity that ever
        # entered. It is the scale the dust threshold is read against and it is
        # **not** position state: it never leaves this replay and has no column,
        # because "how much did I ever buy" is a query over the events
        # (``SUM(quantity) WHERE event_type = 'BUY'``) and not a figure the store
        # keeps a second copy of.
        acquired: Dict[Tuple[str, str], float] = {}

        for event in events:
            account = self._event_account(event)

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
                )
                acquired[key] = 0.0
                timeline.snapshots[key] = []
                timeline.order.append(key)

            state = states[key]

            # Update name if provided (use latest name)
            if event.name:
                state.name = event.name

            # Process based on event type
            if event.event_type == EventType.BUY:
                self._process_buy(state, event)
                acquired[key] += event.quantity
            elif event.event_type == EventType.SELL:
                self._process_sell(state, event, acquired[key])
            elif event.event_type == EventType.GRANT:
                self._process_grant(state, event)
                acquired[key] += event.quantity
                # GRANT is an external in-kind flow, carrying the price it was
                # declared at — which is also its cost basis, or neither (#672 D7).
                timeline.flows.append(InKindFlow(
                    date=event.date, account=account,
                    symbol=event.symbol, quantity=event.quantity,
                    unit_price=event.unit_price))
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

        BUY debits, SELL and DIVIDEND credit, and the fee always makes the cash
        worse. A GRANT is cash-neutral **in its award** — nothing was bought —
        but not in its fee: the validator accepts one on the row, the loader
        parses it, and it used to reach neither the cash, nor the basis, nor any
        of ADR-0018's four terms. It is an acquisition cost like a ``BUY``'s, so
        it is debited here and absorbed into the basis by
        :meth:`_process_grant`, which is exactly what ADR-0003 prescribes and
        what keeps the identity closed: the cash falls by the fee, and so does
        the latent gain.
        """
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
        """Process a BUY: the quantity and the amount it cost, fee absorbed.

        There is no average to rebuild. ``cost_basis`` is an amount and a
        purchase adds to it, so the weighted average survives only as the
        *derivation* :func:`~events.schemas.unit_cost` — which is the whole
        point of storing the amount rather than the unit price.

        **The acquisition fee raises the cost basis**, and therefore the unit
        price (the French rule, and the one that needs no apportionment). It
        used to accumulate in a ``purchase.fee`` that also collected *sale*
        fees and never decreased; making that decrease would have reopened
        matching — which of the buy fees leave with the sold shares? — on a
        field nobody read as a convention.
        """
        state.quantity += event.quantity
        state.cost_basis += event.quantity * event.unit_price + (event.fee or 0.0)

    def _process_sell(self, state: ShareState, event: Event,
                      acquired: float) -> None:
        """Process a SELL: a subtraction, and the realized gain it produces.

        The basis removed is ``quantity × PMP`` at this instant, so the
        remaining basis stays the amount paid for the remaining shares and
        nothing has to be rebuilt. **The disposal fee reduces the proceeds**,
        which is what puts it inside the realized gain instead of leaving it
        floating in a term of its own.

        The dust normalisation is applied here and only here (``acquired`` is
        Σ of everything that ever entered the position): a sale that empties a
        position to under :data:`DUST_FRACTION` of it sets ``quantity`` **and**
        ``cost_basis`` to exact zero. It is deliberately not a general clamp —
        the noise arrives on this line, from a file, and a position that is
        genuinely tiny because it is genuinely tiny is not this case.
        """
        quantity = event.quantity
        fee = event.fee or 0.0

        # Overselling stays blocking — but by the same dust threshold, and for
        # the same reason. The file that writes a sale of `0.34898399999999996`
        # against a purchase of `0.348984` writes it the other way round just as
        # often, and refusing *that* one would abort the replay in the gunicorn
        # master over 4×10⁻¹⁷ of a share, leaving the whole portfolio
        # unreachable and unfixable from an app that is down. A tolerance on one
        # side and none on the other is not caution, it is a coin toss on the
        # last bit of a float.
        if quantity > state.quantity + DUST_FRACTION * acquired:
            raise AggregationError(
                f"Cannot sell {quantity} shares of {event.symbol} "
                f"(only {state.quantity} owned) on {event.date}")
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
        """Process a GRANT: the quantity, and the price it was declared at.

        ``unit_price`` present is a **valued award** — the same number the
        performance engine counts as an external contribution, so the latent
        gain is nil on the day of the grant. Absent is **dilution**: no
        contribution and no basis, so the latent gain is the whole value. The
        two feed together or neither — which is why both read the same
        :func:`~events.schemas.declared_value`, the *only* place the optional
        price is interpreted.
        """
        state.quantity += event.quantity
        # The award's declared value, plus what it cost to receive it. The two
        # are added here and not inside ``declared_value``: that function feeds
        # the **contribution** as well, and a fee is not money the owner put in
        # from outside — it is money the portfolio spent. Adding it to the basis
        # alone is what keeps the four terms telescoping, the latent gain
        # falling by exactly what the cash did.
        state.cost_basis += declared_value(
            event.quantity, event.unit_price) + (event.fee or 0.0)

    def _process_dividend(self, state: ShareState, event: Event) -> None:
        """Process a DIVIDEND: it leaves the profit-and-loss entirely.

        ``received_dividend`` accumulates for life and is its own named figure.
        Folding it into a composite made a sold position report a *positive
        latent gain* on shares it no longer held — the quieter half of the same
        −932 € lie.

        **The figure is net of the fee**, because the cash it moved is. A gross
        term beside a net cash balance puts the fee inside ``gain_absolu`` and
        inside none of ADR-0018's four terms — the head *computes* the total
        from the four, so the two headline figures disagree by exactly the
        withholding on the line. ADR-0018's fourth term cannot carry it: it is
        named for what a broker takes from a **transfer**, and ``store_reads``
        sums it over ``DEPOSIT``/``WITHDRAWAL`` alone. So the fee is absorbed
        where its counterpart already goes, exactly as an acquisition fee is
        absorbed into the cost basis and a disposal fee into the proceeds
        (ADR-0003) — the common case being a withholding tax entered as the
        ``fee`` of the dividend line.
        """
        state.received_dividend += event.amount - (event.fee or 0.0)
