"""The advisories — what the owner's **data** says about itself."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from logfmt_logger import getLogger

from application import accounts
from application import instants
from application.events.schemas import ACCOUNT_TYPES

logger = getLogger("advisories")

ACK_WINDOW = timedelta(days=30)

SUBJECT_HEALTH = 'health'
SUBJECT_INSTALLATION = 'installation'
SUBJECT_PORTFOLIO = 'portfolio'
SUBJECT_ACCOUNTS = 'accounts'

CASH_SHARE = 'cash_share'
ACCOUNT_TYPE = 'account_type'

CASH_SHARE_THRESHOLD = 0.10


class UnknownAdvisory(LookupError):
    """No advisory stands under this key **right now**."""


@dataclass(frozen=True)
class Advisory:
    """One standing advisory, at the instant it was derived."""

    key: str
    kind: str
    subject: str
    detail: Dict[str, Any]
    message: str
    observed_at: datetime

    def to_dict(self) -> Dict[str, Any]:
        return {
            'key': self.key,
            'kind': self.kind,
            'subject': self.subject,
            'detail': self.detail,
            'message': self.message,
            'observed_at': instants.iso(self.observed_at),
        }


@dataclass(frozen=True)
class Acknowledgement:
    """One row of ``advisory_ack``: the gesture, and when it wears off."""

    key: str
    acknowledged_at: datetime
    expires_at: datetime

    def to_dict(self) -> Dict[str, Any]:
        return {
            'key': self.key,
            'acknowledged_at': instants.iso(self.acknowledged_at),
            'expires_at': instants.iso(self.expires_at),
        }


def _observe_cash_share(opened, now: datetime) -> List[Advisory]:
    """The accounts whose cash is more than :data:`CASH_SHARE_THRESHOLD` of them."""
    rows = opened.query(
        'SELECT m.account, a.label, m.cash_balance, m.total_value '
        'FROM account_metrics m '
        'JOIN account a ON a.id = m.account '
        'JOIN (SELECT account, max(day) AS day FROM account_metrics '
        '      GROUP BY account) newest '
        '  ON newest.account = m.account AND newest.day = m.day '
        'ORDER BY m.account')

    standing: List[Advisory] = []
    for account, label, cash, total in rows:
        if cash is None or total is None or total <= 0:
            continue
        share = cash / total
        if share <= CASH_SHARE_THRESHOLD:
            continue
        detail = {
            'account': account,
            'label': label,
            'share': share,
            'cash_balance': cash,
            'total_value': total,
        }
        standing.append(Advisory(
            key=f'{CASH_SHARE}:{account}',
            kind=CASH_SHARE,
            subject=SUBJECT_ACCOUNTS,
            detail=detail,
            message=_say_cash_share(detail),
            observed_at=now,
        ))
    return standing


def _say_cash_share(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['label']} holds {detail['share'] * 100:.1f}% of its value in "
        f"uninvested cash. Nothing is wrong with that if it is deliberate.")


def _observe_account_type(opened, now: datetime) -> List[Advisory]:
    """The accounts filed under a type outside :data:`ACCOUNT_TYPES` (#916).

    The catalogue is closed on write and the store is tolerant on read, so this
    is the whole of what happens to a row laid down before it: the value keeps
    rendering, verbatim, and a sentence names the account and points at the page
    it is fixed on. Nothing is rewritten, automatically or otherwise.

    One advisory per account rather than one naming a list: the card carries a
    link to the account, and a link cannot point at three of them.
    """
    standing: List[Advisory] = []
    for row in accounts.read_accounts(opened):
        if row.type in ACCOUNT_TYPES:
            continue
        detail = {'account': row.id, 'label': row.label, 'type': row.type}
        standing.append(Advisory(
            key=f'{ACCOUNT_TYPE}:{row.id}',
            kind=ACCOUNT_TYPE,
            subject=SUBJECT_ACCOUNTS,
            detail=detail,
            message=_say_account_type(detail),
            observed_at=now,
        ))
    return standing


def _say_account_type(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['label']} is filed under {detail['type']!r}, which is not an "
        f"account type this app knows. Open the account and pick one.")


OBSERVATIONS = (
    _observe_cash_share,
    _observe_account_type,
)


def acknowledgements(opened, now: Optional[datetime] = None
                     ) -> Dict[str, Acknowledgement]:
    """The acknowledgements **still standing**, by key."""
    now = now or datetime.now(timezone.utc)
    return {
        key: Acknowledgement(key, instants.utc(acknowledged_at), instants.utc(expires_at))
        for key, acknowledged_at, expires_at in opened.query(
            'SELECT key, acknowledged_at, expires_at FROM advisory_ack')
        if instants.utc(expires_at) > now
    }


def standing(opened, now: Optional[datetime] = None, *,
             rebuilding: bool = False) -> List[Advisory]:
    """Every advisory this portfolio raises right now, asleep ones included."""
    now = now or datetime.now(timezone.utc)
    raised: List[Advisory] = []
    for observe in OBSERVATIONS:
        raised.extend(observe(opened, now))
    if rebuilding:
        return [one for one in raised if one.subject != SUBJECT_ACCOUNTS]
    return raised


def listing(opened, now: Optional[datetime] = None, *,
            rebuilding: bool = False) -> List[Advisory]:
    """What the API answers: the advisories that stand and are not asleep."""
    now = now or datetime.now(timezone.utc)
    asleep = acknowledgements(opened, now)
    return [one for one in standing(opened, now, rebuilding=rebuilding)
            if one.key not in asleep]


def acknowledge(opened, key: str,
                now: Optional[datetime] = None, *,
                rebuilding: bool = False
                ) -> Tuple[Advisory, Acknowledgement]:
    """Put one advisory to sleep for :data:`ACK_WINDOW`."""
    now = now or datetime.now(timezone.utc)
    raised = {one.key: one
              for one in standing(opened, now, rebuilding=rebuilding)}
    advisory = raised.get(key)
    if advisory is None:
        raise UnknownAdvisory(key)

    acknowledged = Acknowledgement(key, now, now + ACK_WINDOW)
    with opened.transaction():
        opened.execute('DELETE FROM advisory_ack WHERE expires_at <= ?', [now])
        opened.execute(
            'INSERT INTO advisory_ack (key, acknowledged_at, expires_at) '
            'VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET '
            'acknowledged_at = EXCLUDED.acknowledged_at, '
            'expires_at = EXCLUDED.expires_at',
            [key, acknowledged.acknowledged_at, acknowledged.expires_at])

    logger.info(advisory.message, extra={'context': {
        'advisory': key,
        'acknowledged_until': instants.iso(acknowledged.expires_at),
    }})
    return advisory, acknowledged


__all__ = [
    'Advisory', 'Acknowledgement', 'UnknownAdvisory',
    'ACK_WINDOW', 'CASH_SHARE', 'CASH_SHARE_THRESHOLD', 'ACCOUNT_TYPE',
    'SUBJECT_HEALTH', 'SUBJECT_INSTALLATION', 'SUBJECT_PORTFOLIO',
    'SUBJECT_ACCOUNTS',
    'OBSERVATIONS', 'acknowledgements', 'standing', 'listing', 'acknowledge',
]
