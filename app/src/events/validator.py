"""
Event validator for validating portfolio events.
"""

from typing import List, Optional, Set, Tuple

from .schemas import CASH_EVENT_TYPES, Event, EventType


class EventValidationError(Exception):
    """Exception raised when event validation fails."""
    pass


class EventValidator:
    """Validates portfolio events."""

    def __init__(self, account_ids: Optional[Set[str]] = None):
        """
        Args:
            account_ids: Set of declared account ids. When provided (accounts are
                declared, opt-in feature), every event must carry an ``account``
                matching one of these ids. When ``None``, accounts are not
                declared and the ``account`` column is ignored.
        """
        self.account_ids = account_ids

    def validate(self, events: List[Event]) -> Tuple[bool, List[str]]:
        """
        Validate a list of events.

        Args:
            events: List of events to validate.

        Returns:
            Tuple of (is_valid, list of error messages).
        """
        errors = []

        for i, event in enumerate(events):
            event_errors = self._validate_event(event, i + 1)
            errors.extend(event_errors)

        return len(errors) == 0, errors

    def validate_or_raise(self, events: List[Event]) -> None:
        """
        Validate events and raise an exception if validation fails.

        Args:
            events: List of events to validate.

        Raises:
            EventValidationError: If validation fails.
        """
        is_valid, errors = self.validate(events)
        if not is_valid:
            error_list = "\n".join(f"  - {e}" for e in errors)
            raise EventValidationError(
                f"Event validation failed with {len(errors)} error(s):\n{error_list}")

    def _validate_event(self, event: Event, event_num: int) -> List[str]:
        """Validate a single event."""
        errors = []
        context = event.symbol or event.account or "?"
        prefix = f"Event #{event_num} ({event.date}, {event.event_type.value}, {context})"

        # When accounts are declared, every event must carry a valid account
        if self.account_ids is not None:
            errors.extend(self._validate_account(event, prefix))

        if event.event_type in CASH_EVENT_TYPES:
            errors.extend(self._validate_cash(event, prefix))
        else:
            # Share events: symbol and name are required (the loader no longer
            # enforces them, so cash events can omit them).
            if not event.symbol:
                errors.append(f"{prefix}: symbol is required")
            if not event.name:
                errors.append(f"{prefix}: name is required")

            if event.event_type == EventType.BUY:
                errors.extend(self._validate_buy(event, prefix))
            elif event.event_type == EventType.SELL:
                errors.extend(self._validate_sell(event, prefix))
            elif event.event_type == EventType.GRANT:
                errors.extend(self._validate_grant(event, prefix))
            elif event.event_type == EventType.DIVIDEND:
                errors.extend(self._validate_dividend(event, prefix))

        return errors

    def _validate_cash(self, event: Event, prefix: str) -> List[str]:
        """Validate a DEPOSIT / WITHDRAWAL event.

        Required: account + amount (> 0). Optional: fee (>= 0). Forbidden:
        symbol / name / quantity / unit_price (cash events carry no share).
        """
        errors = []

        # account is always required for cash events. When accounts are declared
        # _validate_account already enforced presence + validity, so only add the
        # requirement here when accounts are not declared (avoids a duplicate).
        if self.account_ids is None and not event.account:
            errors.append(f"{prefix}: account is required for {event.event_type.value}")

        if event.amount is None:
            errors.append(f"{prefix}: amount is required for {event.event_type.value}")
        elif event.amount <= 0:
            errors.append(
                f"{prefix}: amount must be positive for {event.event_type.value} "
                f"(direction is carried by the event type, never the sign)")

        if event.fee is not None and event.fee < 0:
            errors.append(f"{prefix}: fee cannot be negative")

        forbidden = [
            name for name in ('symbol', 'name', 'quantity', 'unit_price')
            if getattr(event, name) is not None
        ]
        if forbidden:
            errors.append(
                f"{prefix}: {', '.join(forbidden)} not allowed on "
                f"{event.event_type.value} (cash events carry no share)")

        return errors

    def _validate_account(self, event: Event, prefix: str) -> List[str]:
        """Validate the account of an event against the declared account ids."""
        errors = []

        if not event.account:
            errors.append(
                f"{prefix}: account is required (accounts are declared in settings.yaml)")
        elif event.account not in self.account_ids:
            declared = ", ".join(sorted(self.account_ids)) or "none"
            errors.append(
                f"{prefix}: account '{event.account}' is not a declared account id "
                f"(declared: {declared})")

        return errors

    def _validate_buy(self, event: Event, prefix: str) -> List[str]:
        """Validate a BUY event."""
        errors = []

        if event.quantity is None:
            errors.append(f"{prefix}: quantity is required for BUY")
        elif event.quantity <= 0:
            errors.append(f"{prefix}: quantity must be positive for BUY")

        if event.unit_price is None:
            errors.append(f"{prefix}: unit_price is required for BUY")
        elif event.unit_price <= 0:
            errors.append(f"{prefix}: unit_price must be positive for BUY")

        if event.fee is not None and event.fee < 0:
            errors.append(f"{prefix}: fee cannot be negative")

        return errors

    def _validate_sell(self, event: Event, prefix: str) -> List[str]:
        """Validate a SELL event."""
        errors = []

        if event.quantity is None:
            errors.append(f"{prefix}: quantity is required for SELL")
        elif event.quantity <= 0:
            errors.append(f"{prefix}: quantity must be positive for SELL")

        if event.unit_price is None:
            errors.append(f"{prefix}: unit_price is required for SELL")
        elif event.unit_price <= 0:
            errors.append(f"{prefix}: unit_price must be positive for SELL")

        if event.fee is not None and event.fee < 0:
            errors.append(f"{prefix}: fee cannot be negative")

        return errors

    def _validate_grant(self, event: Event, prefix: str) -> List[str]:
        """Validate a GRANT event."""
        errors = []

        if event.quantity is None:
            errors.append(f"{prefix}: quantity is required for GRANT")
        elif event.quantity <= 0:
            errors.append(f"{prefix}: quantity must be positive for GRANT")

        return errors

    def _validate_dividend(self, event: Event, prefix: str) -> List[str]:
        """Validate a DIVIDEND event."""
        errors = []

        if event.amount is None:
            errors.append(f"{prefix}: amount is required for DIVIDEND")
        elif event.amount <= 0:
            errors.append(f"{prefix}: amount must be positive for DIVIDEND")

        return errors
