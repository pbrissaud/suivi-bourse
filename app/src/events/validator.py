"""
Event validator for validating portfolio events.
"""

from typing import List, Tuple

from .schemas import Event, EventType


class EventValidationError(Exception):
    """Exception raised when event validation fails."""
    pass


class EventValidator:
    """Validates portfolio events."""

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
        prefix = f"Event #{event_num} ({event.date}, {event.event_type.value}, {event.symbol})"

        if event.event_type == EventType.BUY:
            errors.extend(self._validate_buy(event, prefix))
        elif event.event_type == EventType.SELL:
            errors.extend(self._validate_sell(event, prefix))
        elif event.event_type == EventType.GRANT:
            errors.extend(self._validate_grant(event, prefix))
        elif event.event_type == EventType.DIVIDEND:
            errors.extend(self._validate_dividend(event, prefix))

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
