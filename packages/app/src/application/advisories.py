"""The advisories — what the owner's **data** says about itself."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from logfmt_logger import getLogger

from application import accounts
from application import instants
from application import ledger
from application import quotes
from application import runtime_state

logger = getLogger("advisories")

ACK_WINDOW = timedelta(days=30)

SUBJECT_HEALTH = 'health'
SUBJECT_INSTALLATION = 'installation'
SUBJECT_PORTFOLIO = 'portfolio'
SUBJECT_ACCOUNTS = 'accounts'

#: **Who an advisory is for** (§ 3.6). ``user`` is the bell: what the owner can
#: act on or should know (a late price, an update). ``system`` is the System
#: page's: what the installation says about itself. Every advisory has one.
REGISTER_USER = 'user'
REGISTER_SYSTEM = 'system'

CASH_SHARE = 'cash_share'
#: A declared opening date **later** than the account's first declared payment.
OPENED_AFTER_FIRST_PAYMENT = 'opened_after_first_payment'
#: A declared opening date on a day that **has not happened yet** (#969).
OPENED_IN_THE_FUTURE = 'opened_in_the_future'
#: An account holding money and carrying no taxation model, so #919's panel has
#: nothing to project and says nothing at all.
NO_TAXATION_MODEL = 'no_taxation_model'

#: A reference ticker that was asked for and answered nothing (#982).
BENCHMARK_NEVER_PRICED = 'benchmark_never_priced'

#: A held symbol whose market is open and whose last stored quote is older than
#: the ``staleness_horizon`` dial. ``user`` register.
LATE_PRICE = 'late_price'
#: A held symbol the market has answered nothing for, though it was asked: the
#: dashboard counts it at its cost and says so until a quote lands. ``user``.
NO_PRICE = 'no_price'
#: A stable release above the running one, as the update check last saw it.
UPDATE_AVAILABLE = 'update_available'

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
    register: str = REGISTER_SYSTEM
    #: ``{'fr': {'title', 'sub'}, 'en': {...}}`` for an advisory whose phrase the
    #: server builds (the ``user`` ones, with the security's **name**); ``None``
    #: where the front still holds the phrase by ``kind``.
    texts: Optional[Dict[str, Dict[str, str]]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            'key': self.key,
            'kind': self.kind,
            'subject': self.subject,
            'register': self.register,
            'detail': self.detail,
            'message': self.message,
            'texts': self.texts,
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
        'SELECT m.account, COALESCE(a.label, a.id), m.cash_balance, m.total_value '
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
            message=(
                f"{detail['label']} holds {detail['share'] * 100:.1f}% of its value in "
                f"uninvested cash. Nothing is wrong with that if it is deliberate."),
            observed_at=now,
        ))
    return standing


def _observe_opened_after_first_payment(opened, now: datetime) -> List[Advisory]:
    """A wrapper that received money before it existed (#918).

    One of the two dates is wrong and the app cannot say which — a transfer
    carries a real opening date the ledger has no event for, and a typed year is
    a typed year — so the advisory **states the contradiction** and stops there.

    The other direction raises nothing: a date *earlier* than the first payment
    is exactly what a wrapper transferred to a new broker looks like, which is
    the case the declared date exists for.

    **A day still to come belongs to the advisory next door** (#969). Saying
    *one of the two is wrong and the app cannot say which* would be false there:
    a day that has not happened is precisely the one the app can name.
    """
    payments = ledger.first_payments(opened)
    # Both halves are read through the module that owns them rather than
    # re-spelled here: a second `SELECT … FROM account_fact` would be a second
    # place to change the day the row's own rules move.
    labels = {row.id: row.label or row.id
              for row in accounts.read_accounts(opened)}

    standing: List[Advisory] = []
    for account, opened_on in sorted(
            accounts.opening_dates_by_account(opened).items()):
        label = labels.get(account)
        first = payments.get(account)
        if first is None or opened_on <= first or opened_on > now.date():
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
            message=(
                f"{detail['label']} is declared as opened on {detail['opened_on']}, "
                f"and it received a payment on {detail['first_payment']}. One of the "
                f"two is wrong."),
            observed_at=now,
        ))
    return standing


def _observe_opened_in_the_future(opened, now: datetime) -> List[Advisory]:
    """A wrapper declared open on a day that has not happened (#969).

    **Contradicted, not refused.** The declaration is kept — a reader mid-typing
    a year is the likeliest way here, and a refusal would throw the rest of the
    form away with it — and the app says out loud that it disagrees.

    It is not a matter of taste: an ``aged_flat_realised`` model counting its
    threshold from ``opening`` never reaches it, so the projection stays at
    ``rate_before`` for ever, on the one card that says what its owner would owe
    if they emptied the account today.
    """
    labels = {row.id: row.label or row.id
              for row in accounts.read_accounts(opened)}

    standing: List[Advisory] = []
    for account, opened_on in sorted(
            accounts.opening_dates_by_account(opened).items()):
        if opened_on <= now.date():
            continue
        detail = {
            'account': account,
            'label': labels.get(account),
            'opened_on': instants.iso(opened_on),
        }
        standing.append(Advisory(
            key=f'{OPENED_IN_THE_FUTURE}:{account}',
            kind=OPENED_IN_THE_FUTURE,
            subject=SUBJECT_ACCOUNTS,
            detail=detail,
            message=(
                f"{detail['label']} is declared as opened on {detail['opened_on']}, a "
                f"day that has not happened yet, so nothing counted from it can be "
                f"right."),
            observed_at=now,
        ))
    return standing


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
            message=(
                f"{detail['label']} carries no taxation model, so the app cannot say "
                f"what you would owe on it. Declare one and it will."),
            observed_at=now,
        ))
    return standing


def _observe_benchmark_never_priced(opened, now: datetime) -> List[Advisory]:
    """A named reference whose series never filled (#982).

    **The trigger is the anchor, and the anchor has to have arrived.**
    ``oldest_window_tried`` moves after every window that came back, an empty
    one included, so its mere presence says only that the backward pass has
    started: a ticker that stopped trading two years ago answers its first
    chunks empty and would be called mistyped while its real history is still
    three cycles away. The claim is *nothing under that name, anywhere*, so the
    anchor must have reached the start of the window being walked — the
    symbol's own first acquisition, or the ledger's first day for a reference
    nobody ever bought, which is what ``tracked_windows`` hands the backfill.

    An empty ledger has no first day, so ``COALESCE`` is ``NULL``, the
    comparison is ``NULL``, and nothing is raised. That is the same silence
    ``tracked_windows`` keeps, reached by the same route.

    "No point after a cycle" would have said all of this about a perfectly good
    ticker on its first network outage, which is the accusation this refuses to
    make.
    """
    standing: List[Advisory] = []
    for symbol in opened.setting('benchmark_symbols'):
        standing.extend(_never_priced(opened, symbol, now))
    return standing


def _never_priced(opened, symbol: str, now: datetime) -> List[Advisory]:
    """One followed reference, checked as :func:`_observe_benchmark_never_priced` says."""
    tried = opened.query(
        'SELECT 1 FROM symbol_quote q '
        'WHERE q.symbol = ? AND q.oldest_window_tried IS NOT NULL '
        '  AND q.oldest_window_tried <= COALESCE( '
        '        (SELECT min(e.date) FROM event e '
        '          WHERE e.symbol = q.symbol '
        "            AND e.event_type IN ('BUY', 'GRANT')), "
        '        (SELECT min(e.date) FROM event e)) '
        '  AND NOT EXISTS (SELECT 1 FROM price_point p '
        '                  WHERE p.symbol = q.symbol)',
        [symbol])
    if not tried:
        return []

    detail = {'symbol': symbol}
    return [Advisory(
        key=f'{BENCHMARK_NEVER_PRICED}:{symbol}',
        kind=BENCHMARK_NEVER_PRICED,
        subject=SUBJECT_HEALTH,
        detail=detail,
        message=(
            f"{detail['symbol']} is named as the comparison fund, but the "
            f"market returned no price for it. Check the ticker."),
        observed_at=now,
    )]


def _names(opened, symbols: List[str]) -> Dict[str, str]:
    """What each symbol is called: the ledger's name, else Yahoo's, else itself."""
    if not symbols:
        return {}
    marks = ', '.join('?' * len(symbols))
    named = {symbol: name for symbol, name in opened.query(
        f'SELECT symbol, min(name) FROM position WHERE name IS NOT NULL '
        f'AND symbol IN ({marks}) GROUP BY symbol', symbols)}
    named.update({symbol: name for symbol, name in opened.query(
        f'SELECT symbol, long_name FROM symbol_quote WHERE long_name IS NOT NULL '
        f'AND symbol IN ({marks})', symbols) if symbol not in named})
    return {symbol: named.get(symbol, symbol) for symbol in symbols}


def _de(name: str) -> str:
    """``de X`` with the elision French asks for before a vowel."""
    return f"d’{name}" if name[:1].lower() in 'aeiouéèêàâîïôû' else f"de {name}"


def _observe_late_price(opened, now: datetime, recorder) -> List[Advisory]:
    """A held symbol whose market is open and whose price stopped (§ 3.6).

    The claim is about the **stored** quote: the last ``price_point`` is older
    than ``staleness_horizon`` while the last scrape pass saw the market open.
    ``recorder`` is process memory, so a worker that has not scraped yet (or a
    test without one) says nothing. A horizon of 0 disables it, like the sonde.
    """
    horizon = opened.setting('staleness_horizon')
    if recorder is None or not horizon or horizon <= 0:
        return []
    open_symbols = sorted(symbol for symbol, record in recorder.scrapes().items()
                          if not record.closed)
    if not open_symbols:
        return []
    marks = ', '.join('?' * len(open_symbols))
    last = dict(opened.query(
        f'SELECT symbol, max(ts) FROM price_point '
        f'WHERE symbol IN ({marks}) GROUP BY symbol', open_symbols))
    late = {symbol: instants.utc(ts) for symbol, ts in last.items()
            if ts is not None and (now - instants.utc(ts)).total_seconds() > horizon}
    names = _names(opened, sorted(late))

    standing: List[Advisory] = []
    for symbol, since in sorted(late.items()):
        name = names[symbol]
        at = since.astimezone().strftime('%H:%M')
        detail = {'symbol': symbol, 'name': name, 'since': instants.iso(since)}
        standing.append(Advisory(
            key=f'{LATE_PRICE}:{symbol}',
            kind=LATE_PRICE,
            subject=SUBJECT_HEALTH,
            detail=detail,
            message=f"The price of {name} has not moved since {at}.",
            observed_at=now,
            register=REGISTER_USER,
            texts={
                'fr': {
                    'title': f"Le cours {_de(name)} n’a pas bougé depuis {at}",
                    'sub': 'La valeur affichée peut être légèrement en retard '
                           '· se corrige au prochain passage',
                },
                'en': {
                    'title': f"The price of {name} has not moved since {at}",
                    'sub': 'The displayed value may be slightly behind '
                           '· fixed on the next pass',
                },
            },
        ))
    return standing


def _observe_no_price(opened, now: datetime, recorder) -> List[Advisory]:
    """A held symbol with **no price at all** after the backfill asked for one.

    « Asked » is what keeps a fresh install quiet: every line is unpriced during
    the first reconstruction, and none of them has failed yet. The claim ends
    on its own the day a quote is stored.
    """
    held = [row[0] for row in opened.query(
        'SELECT DISTINCT symbol FROM position WHERE quantity <> 0')]
    if not held:
        return []
    marks = ', '.join('?' * len(held))
    priced = {row[0] for row in opened.query(
        f'SELECT DISTINCT symbol FROM price_point '
        f'WHERE price_native IS NOT NULL AND symbol IN ({marks})', held)}
    given_up = quotes.given_up()

    def asked(symbol: str) -> bool:
        record = (None if recorder is None
                  else recorder.backfill_of(symbol, runtime_state.BACKWARD))
        return symbol in given_up or (record is not None and record.failures > 0)

    missing = sorted(symbol for symbol in held
                     if symbol not in priced and asked(symbol))
    names = _names(opened, missing)
    standing: List[Advisory] = []
    for symbol in missing:
        name = names[symbol]
        standing.append(Advisory(
            key=f'{NO_PRICE}:{symbol}',
            kind=NO_PRICE,
            subject=SUBJECT_PORTFOLIO,
            detail={'symbol': symbol, 'name': name},
            message=f"No price for {name}.",
            observed_at=now,
            register=REGISTER_USER,
            texts={
                'fr': {
                    'title': f"Aucun cours pour {name}",
                    'sub': 'Comptée à son prix d’achat en attendant '
                           '· vérifiez le symbole',
                },
                'en': {
                    'title': f"No price for {name}",
                    'sub': 'Counted at its purchase price meanwhile '
                           '· check the symbol',
                },
            },
        ))
    return standing


def _observe_update_available(release: Optional[Dict[str, str]],
                              now: datetime) -> List[Advisory]:
    """A newer stable release than the running one, as the check last saw it."""
    if not release:
        return []
    version = release['version']
    return [Advisory(
        key=f'{UPDATE_AVAILABLE}:{version}',
        kind=UPDATE_AVAILABLE,
        subject=SUBJECT_INSTALLATION,
        detail={'version': version, 'url': release['url']},
        message=f"Version {version} is available.",
        observed_at=now,
        register=REGISTER_USER,
        texts={
            'fr': {'title': f"Mise à jour {version} disponible",
                   'sub': 'Notes de version'},
            'en': {'title': f"Update {version} available",
                   'sub': 'Release notes'},
        },
    )]


OBSERVATIONS = (
    _observe_cash_share,
    _observe_opened_after_first_payment,
    _observe_opened_in_the_future,
    _observe_no_taxation_model,
    _observe_benchmark_never_priced,
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
             rebuilding: bool = False, register: Optional[str] = None,
             recorder=None, release: Optional[Dict[str, str]] = None
             ) -> List[Advisory]:
    """Every advisory this portfolio raises right now, asleep ones included.

    ``recorder`` (the scrape records) and ``release`` (the update check's last
    answer) are what the two ``user`` observations read beyond the store; left
    out, they say nothing. ``register`` keeps one register's advisories.
    """
    now = now or datetime.now(timezone.utc)
    raised: List[Advisory] = []
    if register != REGISTER_USER:
        for observe in OBSERVATIONS:
            raised.extend(observe(opened, now))
    if register != REGISTER_SYSTEM:
        raised.extend(_observe_late_price(opened, now, recorder))
        raised.extend(_observe_no_price(opened, now, recorder))
        raised.extend(_observe_update_available(release, now))
    if rebuilding:
        return [one for one in raised if one.subject != SUBJECT_ACCOUNTS]
    return raised


def listing(opened, now: Optional[datetime] = None, *,
            rebuilding: bool = False, register: Optional[str] = None,
            recorder=None, release: Optional[Dict[str, str]] = None
            ) -> List[Advisory]:
    """What the API answers: the advisories that stand and are not asleep."""
    now = now or datetime.now(timezone.utc)
    asleep = acknowledgements(opened, now)
    return [one for one in standing(opened, now, rebuilding=rebuilding,
                                    register=register, recorder=recorder,
                                    release=release)
            if one.key not in asleep]


def acknowledge(opened, key: str,
                now: Optional[datetime] = None, *,
                rebuilding: bool = False, recorder=None,
                release: Optional[Dict[str, str]] = None
                ) -> Tuple[Advisory, Acknowledgement]:
    """Put one advisory to sleep for :data:`ACK_WINDOW`."""
    now = now or datetime.now(timezone.utc)
    raised = {one.key: one
              for one in standing(opened, now, rebuilding=rebuilding,
                                  recorder=recorder, release=release)}
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
    'OPENED_AFTER_FIRST_PAYMENT', 'OPENED_IN_THE_FUTURE',
    'NO_TAXATION_MODEL', 'LATE_PRICE', 'NO_PRICE', 'UPDATE_AVAILABLE',
    'REGISTER_USER', 'REGISTER_SYSTEM',
    'SUBJECT_HEALTH', 'SUBJECT_INSTALLATION', 'SUBJECT_PORTFOLIO',
    'SUBJECT_ACCOUNTS',
    'OBSERVATIONS', 'acknowledgements', 'standing', 'listing', 'acknowledge',
]
