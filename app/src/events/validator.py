"""
Event validator for validating portfolio events.
"""

from typing import List, Optional, Set, Tuple

from .schemas import (
    ACCOUNT_FILE_COLUMNS, CASH_EVENT_TYPES, Event, EventType,
)


class EventValidationError(Exception):
    """Exception raised when event validation fails."""
    pass


class EventValidator:
    """Validates portfolio events.

    The account rules are issue #698's, and they are two halves of one sentence:

    * **an ``account`` value must name a declared account.** The store always
      holds at least one (``default``), so this is checked whether or not the
      user ever declared anything — a typo'd id is refused the same way in every
      install, and the message names the account to declare.
    * **a blank ``account`` means ``default`` until an account is declared, and
      is an error afterwards.** That is v4's rule minus its opt-in, which is
      what makes a single-account v4's event files import without a single edit;
      after a declaration, a blank cell is far likelier to be an omission than a
      choice, and guessing would pile a second account's events onto the first.
    """

    def __init__(self, account_ids: Optional[Set[str]] = None,
                 accounts_declared: bool = False):
        """
        Args:
            account_ids: Every account id the store holds — ``default`` among
                them. ``None`` means no store was consulted, and the account
                column is then only checked for shape (the pure-format tests,
                and any caller validating a file before it has a ledger).
            accounts_declared: True once something beyond the seeded ``default``
                account exists, which is what turns a blank ``account`` column
                from "means default" into an error.
        """
        self.account_ids = account_ids
        self.accounts_declared = accounts_declared

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

        Required: amount (> 0). Optional: fee (>= 0). Forbidden: symbol / name /
        quantity / unit_price (cash events carry no share).

        The account is **not** a per-type requirement any more (issue #698).
        v4 demanded one here even with no account declared, which under the new
        rule would force a single-account v4 user to write ``default`` in a
        column that means ``default`` when blank — a required cell whose only
        legal value is the one it already implies.
        """
        errors = []

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
        """Validate the ``account`` column of one event (issue #698).

        The message on an unknown id **names the account to declare**, because
        that is the whole gesture the user has left to make: drop a file with
        ``id``, ``type``, ``label``, or declare it in the app.
        """
        if not event.account:
            if self.accounts_declared:
                return [f"{prefix}: account is required now that accounts are "
                        f"declared (blank meant 'default' only while none were)"]
            return []

        if self.account_ids is None or event.account in self.account_ids:
            return []

        declared = ", ".join(sorted(self.account_ids)) or "none"
        return [f"{prefix}: account '{event.account}' is not declared — declare "
                f"it in an accounts file ({', '.join(ACCOUNT_FILE_COLUMNS)}) or "
                f"in the app (declared: {declared})"]

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
        """Validate a GRANT event.

        ``unit_price`` becomes **meaningful** with #699 — present it is a valued
        award, absent it is dilution — and it is deliberately **not validated**
        here. The column was already parsed and silently thrown away, so a
        stored ledger may hold any value in it, and this validator runs over the
        *whole store* on every build (``_load_from_store``), not only over a
        file someone just dropped. A new refusal here is therefore retroactive:
        a row that was legal when it was imported would fail the boot in the
        gunicorn master, with no way to repair it from an app that is down. A
        value that cannot be a price is normalised where it is read instead —
        ``aggregator._process_grant`` and ``performance._grant_value``, together
        — which is also the pair the spec's *"no format change is necessary"*
        asks for.
        """
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
