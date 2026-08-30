"""The advisories — what the owner's **data** says about itself.

Issue #829, spec #787, ADR-0036 / ADR-0037.

ADR-0036 separated three things that had been sharing the word *advisory*:
**health**, which is whether the app is doing its work; the **installation
facts**, which are what is true of this install and which :mod:`installation_facts`
has always carried; and this, which did not exist until now. An advisory is an
audit on the **portfolio** — a quarter of an account sitting in cash — and it is
neither about the app nor about the install.

Three properties follow from that sentence, and each of them is a decision.

**It is derived on every read and stored nowhere.** There is no row saying an
advisory stands, because there is nothing a row could know that the figures do
not: the condition *is* the figures. So there is no arming, no dropping, no
``first_seen_at`` — the instant this module publishes is the instant it looked,
which is the honest answer to *when was this noticed* for something recomputed
per request.

**The acknowledgement is bounded in time, and that is the whole of ADR-0037's
answer to ADR-0036's objection.** 0036 refused an acknowledgement by name — *"an
acknowledgement that outlived its condition would silence the app the second
time the cash piled up, which is the failure a stored one guarantees"* — and it
was right about a **permanent** one. An advisory is put to sleep for
:data:`ACK_WINDOW` and never ended, so it cannot outlive its condition by more
than that window, and nothing has to observe the condition going false: the
expiry needs no observer.

**The window lives in its own table** (:data:`store.TABLES`, twelfth entry) and
not in a column added to ``installation_fact``. The DDL runs with
``IF NOT EXISTS`` and there is no migration machinery, so a column added there
would exist on no store created before it; and the two acknowledgements are not
one mechanism wearing two lifetimes — an installation fact is acknowledged for
good, on purpose.

**One family today, and the vocabulary is wider than the family.** ADR-0037
names four subjects — health, installation, portfolio, accounts — because the
panel groups by subject and the four are the panel's own headings. What produces
an advisory here is the **cash share of an account**, which is the worked example
0037 and ``CONTEXT.md`` both use; the portfolio's own (*a position that has
outgrown the rest*) is named in the glossary and is not written yet, so the
`portfolio` subject is a heading nothing fills. It is declared all the same:
what a card is grouped under is the server's answer, and a front inventing a
subject for a key it does not know would be a second authority on the grouping.

**The threshold is a constant, and stays one** (ADR-0036): *"a setting nobody
has ever turned is a setting that should not have been written."* It becomes a
dial the day a second value is actually wanted.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from logfmt_logger import getLogger

import instants

logger = getLogger("advisories")

#: How long an acknowledgement puts an advisory to sleep. Thirty days, and the
#: card says so: it is *put to sleep*, never ended, and what ends the condition
#: is the owner investing the cash.
ACK_WINDOW = timedelta(days=30)

#: The four subjects the notifications panel groups by (ADR-0037). Never a word
#: on screen from here — the front holds the phrase, this holds the key.
SUBJECT_HEALTH = 'health'
SUBJECT_INSTALLATION = 'installation'
SUBJECT_PORTFOLIO = 'portfolio'
SUBJECT_ACCOUNTS = 'accounts'

#: The advisory families. One today; the tuple is what a client branches on.
CASH_SHARE = 'cash_share'

#: Above which share of an account's value the cash stops being a rounding and
#: starts being a position nobody took. A **constant**, per ADR-0036, and the
#: figure the maquette draws its chip on.
CASH_SHARE_THRESHOLD = 0.10


class UnknownAdvisory(LookupError):
    """No advisory stands under this key **right now**.

    One class for both refusals — a key no family produces, and a key of a
    family whose figure has moved back under the threshold — because they are
    the same answer to the client: *there is nothing here to acknowledge*. It is
    the shape :class:`installation_facts.FactNotStanding` already gives the
    gesture next door.
    """


@dataclass(frozen=True)
class Advisory:
    """One standing advisory, at the instant it was derived.

    ``key`` is what the acknowledgement addresses and it names the **subject of
    the figure**, not the family: ``cash_share:cto`` is put to sleep on its own,
    where ``cash_share`` would silence every account at once.
    """

    key: str
    #: The family, so a client may branch on a kind without parsing the key.
    kind: str
    #: Which heading of the panel it is grouped under.
    subject: str
    #: What it names right now — the account, the share, the amount.
    detail: Dict[str, Any]
    #: The log line and the headless payload, in English for ever. The interface
    #: composes its own sentence from ``kind`` and ``detail`` (ADR-0024), which
    #: is the split :class:`installation_facts.FactSpec` argues at length.
    message: str
    #: When this process looked. An advisory has no other date: it is recomputed
    #: per read, so *noticed on* is *read on*, and claiming an older instant
    #: would be inventing a memory the product deliberately does not keep.
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


# --------------------------------------------------------------------------- #
# The observations
# --------------------------------------------------------------------------- #

def _observe_cash_share(opened, now: datetime) -> List[Advisory]:
    """The accounts whose cash is more than :data:`CASH_SHARE_THRESHOLD` of them.

    It reads the **newest row of every account's perf series**, which is the
    same source ``/api/accounts`` publishes its figures from, so the chip on the
    rail and the card in the panel cannot disagree about one account. Reading
    ``account_state`` instead would give the cash without the total to divide it
    by, and dividing by a holdings value derived a second way here is exactly
    the second arithmetic ADR-0011 keeps out of this codebase.

    An account with no row at all, a null total, or a total at zero produces
    nothing: a share of nothing is not a small share, it is no figure.
    """
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


#: Every family, in the order a reader meets them. Declared and stable rather
#: than sorted by figure: a panel whose contents reshuffle between two reads is
#: a panel nobody trusts.
OBSERVATIONS = (
    _observe_cash_share,
)


# --------------------------------------------------------------------------- #
# The table, and the listing it filters
# --------------------------------------------------------------------------- #

def acknowledgements(opened, now: Optional[datetime] = None
                     ) -> Dict[str, Acknowledgement]:
    """The acknowledgements **still standing**, by key.

    A row whose ``expires_at`` has passed is not one: it is read as absent here
    rather than deleted on a ``GET``, because a read that writes would date the
    store with the moment somebody opened a page — the same rule
    :func:`installation_facts.listing` keeps one table over. :func:`acknowledge`
    is what sweeps them, inside the transaction it was already opening.
    """
    now = now or datetime.now(timezone.utc)
    return {
        key: Acknowledgement(key, instants.utc(acknowledged_at), instants.utc(expires_at))
        for key, acknowledged_at, expires_at in opened.query(
            'SELECT key, acknowledged_at, expires_at FROM advisory_ack')
        if instants.utc(expires_at) > now
    }


def standing(opened, now: Optional[datetime] = None, *,
             rebuilding: bool = False) -> List[Advisory]:
    """Every advisory this portfolio raises right now, asleep ones included.

    ``rebuilding`` withholds the :data:`SUBJECT_ACCOUNTS` ones, and it is the
    whole of what it does. Those observations divide one figure of an account's
    perf series by another, and while the reconstruction runs that series is not
    a statement about the portfolio — it is a statement about how far the
    backfill got. :func:`performance.account_horizon` blocks every day a held
    symbol has no price for, and the right edge walks left past those blocks:
    an account whose oldest line is quoted nowhere yet can be left publishing a
    run of days from *before its first purchase*, where it did hold nothing but
    cash. ``cash_share`` then reads the newest row of that run and says the
    account is 100 % cash — an alarm, in the reader's own words, about an
    account whose shares page shows them the securities.

    Withheld rather than repaired here, and the two are different tickets: what
    the horizon publishes is the horizon's business (#708, #765, #766), and a
    judgement passed on figures still being reconstructed is this module's. It is
    ADR-0026's rule one table over — *a read in flight is not an absence* — read
    as *a series still being built is not a portfolio to judge*. The advisory
    comes back on its own when the reconstruction concludes, since nothing here
    is stored: it is derived per read (ADR-0036).

    **A subject and not a family**, so the next observation about an account
    inherits the rule instead of rediscovering it. The other three subjects are
    untouched: health, installation and portfolio say nothing that divides one
    day of a series by another.

    The predicate is complete for the cause. The pocket needs a held symbol
    whose backfill is not terminal, which is a window the reconstruction has not
    covered — so a pocket implies a rebuild, and once the rebuild concludes the
    dead ticker is settled and the horizon is whole again.
    """
    now = now or datetime.now(timezone.utc)
    raised: List[Advisory] = []
    for observe in OBSERVATIONS:
        raised.extend(observe(opened, now))
    if rebuilding:
        return [one for one in raised if one.subject != SUBJECT_ACCOUNTS]
    return raised


def listing(opened, now: Optional[datetime] = None, *,
            rebuilding: bool = False) -> List[Advisory]:
    """What the API answers: the advisories that stand and are not asleep.

    An acknowledged advisory **disappears**, exactly as an acknowledged
    installation fact does — and **comes back** when the window wears off, which
    is the half a permanent acknowledgement could never do.

    ``rebuilding`` is :func:`standing`'s, passed through rather than re-read:
    the two answers differ by the acknowledgements alone, and an argument that
    reached one of them and not the other would make the chip and the panel
    disagree about which advisories exist.
    """
    now = now or datetime.now(timezone.utc)
    asleep = acknowledgements(opened, now)
    return [one for one in standing(opened, now, rebuilding=rebuilding)
            if one.key not in asleep]


def acknowledge(opened, key: str,
                now: Optional[datetime] = None, *,
                rebuilding: bool = False
                ) -> Tuple[Advisory, Acknowledgement]:
    """Put one advisory to sleep for :data:`ACK_WINDOW`.

    Raises:
        UnknownAdvisory: nothing stands under ``key`` at this instant — an
            unknown family, or a figure that has moved back under its
            threshold. Acknowledging what does not stand would write a row for a
            condition nobody observed.

    Acknowledging again **re-dates** the window, which is the opposite of the
    installation fact's rule and follows from what the two gestures mean: *seen,
    for good* is asserted once, where *not now* is asked again each time it is
    asked.

    The expired rows are swept here, in the transaction this was opening
    anyway — the one write path the table has, so the sweep costs nothing and
    lives nowhere else.
    """
    now = now or datetime.now(timezone.utc)
    # ``rebuilding`` here too, and for the reason the raise below states: what
    # cannot be listed cannot be put to sleep, or a reader would silence for
    # thirty days an advisory they were never shown — and one the rebuild was
    # about to withdraw on its own.
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
    'SUBJECT_HEALTH', 'SUBJECT_INSTALLATION', 'SUBJECT_PORTFOLIO',
    'SUBJECT_ACCOUNTS',
    'OBSERVATIONS', 'acknowledgements', 'standing', 'listing', 'acknowledge',
]
