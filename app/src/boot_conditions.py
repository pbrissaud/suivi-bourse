"""The three lines a bare container says at start-up (issue #741, ADR-0015).

Three conditions, each printed **once and only when it is true**, in logfmt:

1. **no persistence** — this container keeps nothing;
2. **no reporting currency** — so nothing is converted and nothing is computed;
3. **no portfolio** — so the URL where the first event is recorded.

They are **conditions**, in ADR-0021's exact sense — *the banner shows
conditions the owner can end; the badge counts facts they can only acknowledge*
— and that is why none of them is an installation fact (#709): there is no row,
no ``first_seen_at`` and above all **no acknowledgement**. "This container
keeps nothing" acknowledged would go quiet while it is still true, which is the
one thing an acknowledgement must never buy. They do not count towards a page's
screen obligations either: they live in the terminal and in ``/metrics``, and
the store's own block on the data page reads the published fact instead.

Pure, in the taste of :mod:`boot_env` and :mod:`settings_registry`: the text and
the predicate are here, the logging is one call in :mod:`main`. What that buys
is the test — the three sentences and *which of them stands* are asserted
against a dict, with no runtime, no store and no capture of a logger.

The order is fixed and it is the order of causality rather than of severity: a
reader who is about to lose everything should read that before being told which
URL to open to start typing.
"""
import logging
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

import mounts

#: This container's store lives in the writable layer.
NO_PERSISTENCE = 'store_ephemeral'

#: The one question the app asks has not been answered (ADR-0002, ADR-0021).
NO_BASE_CURRENCY = 'base_currency_unanswered'

#: The ledger is empty — an ordinary state on a fresh install, hence INFO.
NO_PORTFOLIO = 'portfolio_empty'


@dataclass(frozen=True)
class Condition:
    """One line: what to say, how loudly, and the pairs that make it parseable.

    ``context`` is what ``logfmt_logger`` renders as ``key=value``, the way an
    installation fact's is (#709), so a headless install can *grep for a key*
    rather than for a sentence that will be reworded.
    """

    key: str
    level: int
    message: str
    context: Dict[str, str]


def observe(persistence: str, store_dir, base_currency: Optional[str],
            recorded_events: int, web_port: int) -> Tuple[Condition, ...]:
    """The conditions that stand, in order. An empty tuple says nothing at all.

    ``persistence`` is :mod:`mounts`' three-valued observation, and only
    :data:`mounts.EPHEMERAL` produces a line: **unknown prints nothing**, which
    is the whole reason the observation has a third answer. A macOS developer
    running the app outside a container has no mount table to read, and a
    silence there is right where *"this container keeps nothing"* would be a
    fabrication.
    """
    conditions = []

    if persistence == mounts.EPHEMERAL:
        conditions.append(Condition(
            key=NO_PERSISTENCE,
            level=logging.WARNING,
            message=(
                f"This container keeps nothing: {store_dir} is the container's "
                f"writable layer, so the store — the ledger, the prices and the "
                f"figures alike — goes when the container does. Mount a volume "
                f"on {store_dir} to keep it."),
            context={'condition': NO_PERSISTENCE, 'store_dir': str(store_dir)},
        ))

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
        # **The place the gesture is made, and nothing else** (ADR-0032). The
        # line used to offer a drop folder as its second half, which stopped
        # being information the day the folder stopped being read: there is one
        # ledger and two entrances to it, and both are on the page named here —
        # a file handed to the app, or a first position typed.
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
    'NO_PERSISTENCE', 'NO_BASE_CURRENCY', 'NO_PORTFOLIO',
    'Condition', 'observe',
]
