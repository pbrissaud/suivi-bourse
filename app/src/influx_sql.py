"""SQL fragments and value guards shared by the InfluxDB writer and reader.

Extracted from ``influxdb_writer.py`` when the read layer for the web UI became
a sibling module rather than a growth of the writer (issue #659, design #655).
The three helpers here are the ones both sides need, and the reason they are a
module rather than a copy is trap 1 of the `data-contract inventory
<https://github.com/pbrissaud/suivi-bourse/issues/650>`_:

    Pre-v4.1 points carry no ``account`` tag. Every share-level aggregate must
    partition on ``COALESCE(account, 'default')``, never on the bare tag — a
    bare ``WHERE account = 'x'`` silently drops the whole pre-v4.1 history.

That rule, and the ``'`` → ``''`` escaping it travels with, has to have exactly
one implementation. A second one in the reader would be a rule that decays: the
writer's version would keep being exercised by the scheduler while the reader's
drifted, and the symptom — history that stops at a version boundary — reads as
missing data, not as a bug.

Deliberately *not* here: anything either side needs alone. The reader's window
and ordering clauses stay in the reader; the writer's point construction stays
in the writer. This module is the shared rule, not a query builder.
"""
import math
from datetime import datetime, timezone
from typing import Any, Optional


def escape_literal(value: str) -> str:
    """Escape a value for use inside a single-quoted SQL string literal.

    Doubles the single quote, which is the SQL standard's own escape. Every
    caller interpolating a tag value into a WHERE clause must route through
    this — tag values come from the events file, which is user-authored.
    """
    return str(value).replace("'", "''")


def symbol_account_where(share_symbol: str, account: Optional[str]) -> str:
    """Build the shared ``share_symbol [+ account]`` SQL WHERE clause.

    Escapes single quotes so ``share_symbol``/``account`` stay safe string
    literals, and scopes by ``COALESCE(account, 'default')`` when an account is
    given — so points written before the account tag existed count as
    ``'default'`` rather than being dropped by a bare ``WHERE account = ...``.

    ``account=None`` means *every* account, which is also the correct scope for
    a market price: a price belongs to no account, and filtering one would
    truncate the history (see ``InfluxDBWriter.get_price_series``).
    """
    where = f"share_symbol = '{escape_literal(share_symbol)}'"
    if account is not None:
        where += f" AND COALESCE(account, 'default') = '{escape_literal(account)}'"
    return where


def is_valid_number(value: Any) -> bool:
    """True when ``value`` is a real number (not None and not NaN).

    yfinance rows can carry NaN (holidays / partial bars); NaN is a float that
    passes ``is not None`` checks and would otherwise be written as a NaN field.
    The reader needs the same guard for the opposite reason — pandas hands NaN
    back for any absent field, and JSON has no NaN, so the boundary normalises
    it to ``None``.
    """
    return value is not None and not (isinstance(value, float) and math.isnan(value))


def utc_z(dt: datetime) -> str:
    """Format ``dt`` as a UTC ISO-8601 'Z' literal safe for SQL.

    Timezone-aware datetimes are normalized to UTC and stripped of their offset
    so the appended 'Z' stays valid — ``isoformat()`` alone would otherwise emit
    ``...+00:00Z`` for aware inputs, which InfluxDB rejects.
    """
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return f"{dt.isoformat()}Z"


__all__ = ['escape_literal', 'symbol_account_where', 'is_valid_number', 'utc_z']
