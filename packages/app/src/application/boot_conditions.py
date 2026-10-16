"""The lines a bare container says at start-up (issue #741)."""
import logging
from dataclasses import dataclass
from typing import Dict, Optional, Tuple


NO_BASE_CURRENCY = 'base_currency_unanswered'

NO_PORTFOLIO = 'portfolio_empty'


@dataclass(frozen=True)
class Condition:
    """One line: what to say, how loudly, and the pairs that make it parseable."""

    key: str
    level: int
    message: str
    context: Dict[str, str]


def observe(base_currency: Optional[str], recorded_events: int,
            web_port: int) -> Tuple[Condition, ...]:
    """The conditions that stand, in order. An empty tuple says nothing at all."""
    conditions = []

    if not base_currency:
        conditions.append(Condition(
            key=NO_BASE_CURRENCY,
            level=logging.WARNING,
            message=(
                "No reporting currency answered: quotes are recorded as the "
                "exchange gives them, nothing is converted, and no performance "
                "figure is computed at all. Answer it on the settings page, or "
                "headless with one call: curl -X PUT "
                f"http://localhost:{web_port}/api/settings "
                "-H 'Content-Type: application/json' "
                "-d '{\"base_currency\": \"EUR\"}'"),
            context={'condition': NO_BASE_CURRENCY},
        ))

    if not recorded_events:
        conditions.append(Condition(
            key=NO_PORTFOLIO,
            level=logging.INFO,
            message=(
                f"No event recorded yet: open http://localhost:{web_port}/ and "
                f"record a first position, or hand the app a .csv/.xlsx of your "
                f"events from the same page."),
            context={'condition': NO_PORTFOLIO},
        ))

    return tuple(conditions)


__all__ = [
    'NO_BASE_CURRENCY', 'NO_PORTFOLIO',
    'Condition', 'observe',
]
