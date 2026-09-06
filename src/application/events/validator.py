"""Event validator for validating portfolio events."""

import math
from dataclasses import dataclass
from typing import List, Optional, Set, Tuple

from .schemas import CASH_EVENT_TYPES, Event, EventType


NUMERIC_FIELDS = ('quantity', 'unit_price', 'fee', 'amount')


class EventValidationError(Exception):
    """Exception raised when event validation fails."""
    pass


@dataclass(frozen=True)
class ValidationIssue:
    """One refusal, and **which field it is about** (issue #764)."""
    field: Optional[str]
    message: str


class EventValidator:
    """Validates portfolio events."""

    def __init__(self, account_ids: Optional[Set[str]] = None,
                 accounts_declared: bool = False):
        """Args: account_ids: Every account id the store holds — ``default`` among them."""
        self.account_ids = account_ids
        self.accounts_declared = accounts_declared

    def issues(self, events: List[Event]) -> List[ValidationIssue]:
        """Every refusal these events earn, each naming the field it is about."""
        found: List[ValidationIssue] = []
        for i, event in enumerate(events):
            found.extend(self._validate_event(event, i + 1))
        return found

    def validate(self, events: List[Event]) -> Tuple[bool, List[str]]:
        """Validate a list of events."""
        found = self.issues(events)
        return len(found) == 0, [issue.message for issue in found]

    def validate_or_raise(self, events: List[Event]) -> None:
        """Validate events and raise an exception if validation fails."""
        is_valid, errors = self.validate(events)
        if not is_valid:
            error_list = "\n".join(f"  - {e}" for e in errors)
            raise EventValidationError(
                f"Event validation failed with {len(errors)} error(s):\n{error_list}")

    def _validate_event(self, event: Event, event_num: int) -> List[ValidationIssue]:
        """Validate a single event."""
        errors = []
        context = event.symbol or event.account or "?"
        prefix = f"Event #{event_num} ({event.date}, {event.event_type.value}, {context})"

        errors.extend(self._validate_account(event, prefix))
        errors.extend(self._validate_numbers(event, prefix))

        if event.event_type in CASH_EVENT_TYPES:
            errors.extend(self._validate_cash(event, prefix))
        else:
            if not event.symbol:
                errors.append(_issue('symbol', prefix, "symbol is required"))
            if not event.name:
                errors.append(_issue('name', prefix, "name is required"))

            if event.event_type == EventType.BUY:
                errors.extend(self._validate_buy(event, prefix))
            elif event.event_type == EventType.SELL:
                errors.extend(self._validate_sell(event, prefix))
            elif event.event_type == EventType.GRANT:
                errors.extend(self._validate_grant(event, prefix))
            elif event.event_type == EventType.DIVIDEND:
                errors.extend(self._validate_dividend(event, prefix))

        return errors

    def _validate_numbers(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Refuse a cell holding a number JSON cannot spell — on any event."""
        errors = []
        for name in NUMERIC_FIELDS:
            value = getattr(event, name)
            if isinstance(value, float) and not math.isfinite(value):
                errors.append(_issue(
                    name, prefix, f"{name} must be a finite number"))
        return errors

    def _validate_cash(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate a DEPOSIT / WITHDRAWAL event."""
        errors = []

        if event.amount is None:
            errors.append(_issue(
                'amount', prefix,
                f"amount is required for {event.event_type.value}"))
        elif event.amount <= 0:
            errors.append(_issue(
                'amount', prefix,
                f"amount must be positive for {event.event_type.value} "
                f"(direction is carried by the event type, never the sign)"))

        if event.fee is not None and event.fee < 0:
            errors.append(_issue('fee', prefix, "fee cannot be negative"))

        forbidden = [
            name for name in ('symbol', 'name', 'quantity', 'unit_price')
            if getattr(event, name) is not None
        ]
        if forbidden:
            errors.append(_issue(
                forbidden[0], prefix,
                f"{', '.join(forbidden)} not allowed on "
                f"{event.event_type.value} (cash events carry no share)"))

        return errors

    def _validate_account(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate the ``account`` column of one event (issue #698)."""
        if not event.account:
            if self.accounts_declared:
                return [_issue(
                    'account', prefix,
                    "account is required now that accounts are declared "
                    "(blank meant 'default' only while none were)")]
            return []

        if self.account_ids is None or event.account in self.account_ids:
            return []

        declared = ", ".join(sorted(self.account_ids)) or "none"
        return [_issue(
            'account', prefix,
            f"account '{event.account}' is not declared — declare it in "
            f"the app (declared: {declared})")]

    def _validate_buy(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate a BUY event."""
        errors = []

        if event.quantity is None:
            errors.append(_issue('quantity', prefix, "quantity is required for BUY"))
        elif event.quantity <= 0:
            errors.append(_issue('quantity', prefix, "quantity must be positive for BUY"))

        if event.unit_price is None:
            errors.append(_issue('unit_price', prefix, "unit_price is required for BUY"))
        elif event.unit_price <= 0:
            errors.append(_issue('unit_price', prefix, "unit_price must be positive for BUY"))

        if event.fee is not None and event.fee < 0:
            errors.append(_issue('fee', prefix, "fee cannot be negative"))

        return errors

    def _validate_sell(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate a SELL event."""
        errors = []

        if event.quantity is None:
            errors.append(_issue('quantity', prefix, "quantity is required for SELL"))
        elif event.quantity <= 0:
            errors.append(_issue('quantity', prefix, "quantity must be positive for SELL"))

        if event.unit_price is None:
            errors.append(_issue('unit_price', prefix, "unit_price is required for SELL"))
        elif event.unit_price <= 0:
            errors.append(_issue('unit_price', prefix, "unit_price must be positive for SELL"))

        if event.fee is not None and event.fee < 0:
            errors.append(_issue('fee', prefix, "fee cannot be negative"))

        return errors

    def _validate_grant(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate a GRANT event."""
        errors = []

        if event.quantity is None:
            errors.append(_issue('quantity', prefix, "quantity is required for GRANT"))
        elif event.quantity <= 0:
            errors.append(_issue('quantity', prefix, "quantity must be positive for GRANT"))

        if event.fee is not None and event.fee < 0:
            errors.append(_issue('fee', prefix, "fee cannot be negative"))

        return errors

    def _validate_dividend(self, event: Event, prefix: str) -> List[ValidationIssue]:
        """Validate a DIVIDEND event."""
        errors = []

        if event.amount is None:
            errors.append(_issue('amount', prefix, "amount is required for DIVIDEND"))
        elif event.amount <= 0:
            errors.append(_issue('amount', prefix, "amount must be positive for DIVIDEND"))

        if event.fee is not None and event.fee < 0:
            errors.append(_issue('fee', prefix, "fee cannot be negative"))

        return errors


def _issue(field: Optional[str], prefix: str, message: str) -> ValidationIssue:
    """One refusal, rendered exactly as it always was and tagged with its field."""
    return ValidationIssue(field=field, message=f"{prefix}: {message}")
