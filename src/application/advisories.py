"""The advisories — what the owner's **data** says about itself."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from logfmt_logger import getLogger

from application import accounts
from application import instants
from application import ledger

logger = getLogger("advisories")

ACK_WINDOW = timedelta(days=30)

SUBJECT_HEALTH = 'health'
SUBJECT_INSTALLATION = 'installation'
SUBJECT_PORTFOLIO = 'portfolio'
SUBJECT_ACCOUNTS = 'accounts'

CASH_SHARE = 'cash_share'
#: A declared opening date **later** than the account's first declared payment.
OPENED_AFTER_FIRST_PAYMENT = 'opened_after_first_payment'
#: An account holding money and carrying no taxation model, so #919's panel has
#: nothing to project and says nothing at all.
NO_TAXATION_MODEL = 'no_taxation_model'

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


def _newest_account_metrics(opened):
    """Each account's newest ``account_metrics`` row: ``(id, label, cash, total)``.

    One join, read by every observer that asks *what is this account worth right
    now* — so the day the newest-day rule moves, it moves once.

    It is **one spelling, not one scan**: each observer still calls it, so the
    aggregation runs once per observer per listing. Sharing the rows would mean
    threading them through ``standing()`` into every observation's signature,
    which is a bigger change than the second scan of a table holding one row per
    account per day costs.
    """
    return opened.query(
        'SELECT m.account, a.label, m.cash_balance, m.total_value '
        'FROM account_metrics m '
        'JOIN account a ON a.id = m.account '
        'JOIN (SELECT account, max(day) AS day FROM account_metrics '
        '      GROUP BY account) newest '
        '  ON newest.account = m.account AND newest.day = m.day '
        'ORDER BY m.account')


def _observe_cash_share(opened, now: datetime) -> List[Advisory]:
    """The accounts whose cash is more than :data:`CASH_SHARE_THRESHOLD` of them."""
    standing: List[Advisory] = []
    for account, label, cash, total in _newest_account_metrics(opened):
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


def _observe_opened_after_first_payment(opened, now: datetime) -> List[Advisory]:
    """A wrapper that received money before it existed (#918).

    One of the two dates is wrong and the app cannot say which — a transfer
    carries a real opening date the ledger has no event for, and a typed year is
    a typed year — so the advisory **states the contradiction** and stops there.

    The other direction raises nothing: a date *earlier* than the first payment
    is exactly what a wrapper transferred to a new broker looks like, which is
    the case the declared date exists for.
    """
    payments = ledger.first_payments(opened)
    # Both halves are read through the module that owns them rather than
    # re-spelled here: a second `SELECT … FROM account_fact` would be a second
    # place to change the day the row's own rules move.
    labels = {row.id: row.label for row in accounts.read_accounts(opened)}

    standing: List[Advisory] = []
    for account, opened_on in sorted(
            accounts.opening_dates_by_account(opened).items()):
        label = labels.get(account)
        first = payments.get(account)
        if first is None or opened_on <= first:
            continue
        detail = {
            'account': account,
            'label': label,
            'opened_on': instants.iso(opened_on),
            'first_payment': instants.iso(first),
        }
        standing.append(Advisory(
            key=f'{OPENED_AFTER_FIRST_PAYMENT}:{account}',
            kind=OPENED_AFTER_FIRST_PAYMENT,
            subject=SUBJECT_ACCOUNTS,
            detail=detail,
            message=_say_opened_after_first_payment(detail),
            observed_at=now,
        ))
    return standing


def _say_opened_after_first_payment(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['label']} is declared as opened on {detail['opened_on']}, "
        f"and it received a payment on {detail['first_payment']}. One of the "
        f"two is wrong.")


def _observe_no_taxation_model(opened, now: datetime) -> List[Advisory]:
    """An account with money in it and no model to tax it by (#919).

    **This is the sentence #919's silence rests on.** A panel that shows no
    projection because no model was ever declared looks exactly like a panel
    whose projection happens to be nothing, and the account's own surface is the
    wrong place to say why: it would be an empty block explaining its own
    emptiness, on every account, for ever. The advisory says it once, in the
    place built for saying it — **the bell**, which carries the sentence and the
    link back to the account. The rail's chip is not that surface: it draws
    ``cash_share``'s percentage and nothing else.

    **Only where there is something to tax.** An account with no value is not
    missing a declaration; it is empty, and asking its owner to describe the
    taxation of nothing is noise. The seeded ``default`` row on a fresh install
    is exactly that case.
    """
    carried = accounts.taxation_models_by_account(opened)

    standing: List[Advisory] = []
    for account, label, _cash, total in _newest_account_metrics(opened):
        if account in carried or total is None or total <= 0:
            continue
        detail = {'account': account, 'label': label, 'total_value': total}
        standing.append(Advisory(
            key=f'{NO_TAXATION_MODEL}:{account}',
            kind=NO_TAXATION_MODEL,
            subject=SUBJECT_ACCOUNTS,
            detail=detail,
            message=_say_no_taxation_model(detail),
            observed_at=now,
        ))
    return standing


def _say_no_taxation_model(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['label']} carries no taxation model, so the app cannot say "
        f"what you would owe on it. Declare one and it will.")


OBSERVATIONS = (
    _observe_cash_share,
    _observe_opened_after_first_payment,
    _observe_no_taxation_model,
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
    'ACK_WINDOW', 'CASH_SHARE', 'CASH_SHARE_THRESHOLD',
    'OPENED_AFTER_FIRST_PAYMENT', 'NO_TAXATION_MODEL',
    'SUBJECT_HEALTH', 'SUBJECT_INSTALLATION', 'SUBJECT_PORTFOLIO',
    'SUBJECT_ACCOUNTS',
    'OBSERVATIONS', 'acknowledgements', 'standing', 'listing', 'acknowledge',
]
