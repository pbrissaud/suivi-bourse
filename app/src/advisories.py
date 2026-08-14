"""The advisories — a tiny table carrying an acknowledgement, and nothing else.

Issue #709, spec #695 § 14, ADR-0008 / ADR-0014 / ADR-0021.

``advisory(key, first_seen_at, acknowledged_at)`` is **not a journal**: no
history, no row per occurrence, a closed list of keys in the whole product. The
sort is made on one question — *can the app work this out again later?* — and
almost nothing survives it. Four advisories are **derivable states**: a ``stat``
on a file for a v4's ``config.yaml`` and its ``settings.yaml``, a read of the
environment for the variables nothing obeys any more, and the process's own
memory for how far the reconstruction has got. **One is a real event**: *"v5
asserted that your v4 amounts were already in your reporting currency"*. It
happens once, at the end of the first reconstruction, by comparing the observed
quote currency to the reporting one — deferred, because at import time no symbol
has been fetched and the app does not know what a line is quoted in — and since
the reconstruction never happens twice, **it is lost if it is not written**.

**Five keys and not six** (ADR-0021, which amends spec #695 § 14 on precisely
this point). A missing base currency is a **live condition**, not an advisory,
and the rule that separates them is the ADR's: *the banner shows conditions the
owner can end; the badge counts facts they can only acknowledge*. Counting it
here produced a permanent badge on an install that had simply not answered yet,
and the two predicates it needs are published already (``/api/config``'s
``stored`` flag and the head's ``currency``), so nothing is lost by its absence.

Logs would be cheaper, and they are not enough, for one reason only: **a log
cannot be acknowledged**. Someone may want to keep their v4 ``config.yaml``
beside their events for ever, and an app that reproaches them for it at every
boot becomes noise one learns to ignore — which would kill the fifth advisory
too, on the day it counts.

Four properties of the mechanism are decisions rather than details.

**The row exists exactly while the advisory stands.** :func:`refresh` arms an
advisory whose observation stands and has no row, and *drops* the row of one
whose observation no longer does. That is what *"no stored existence beyond the
acknowledgement"* means in practice: an acknowledged advisory disappears from the
listing, and if its predicate goes false and true again it is armed anew, with a
fresh ``first_seen_at`` and a fresh log line. The acknowledgement of a fact that
has stopped being true is not a fact worth keeping — and keeping it would make
the next occurrence invisible, which is the one failure this table exists
against.

**An observation has three answers, not two.** ``None`` is *does not stand*, a
mapping is *stands, and here is what it names*, and :data:`UNOBSERVED` is *not
from here* — the reconstruction's progress is process memory, which the gunicorn
master and a web request cannot see at all. Arming needs a positive observation
and **so does disarming**: with only two answers, every restart would drop the
row a running scheduler had armed, then re-arm it a minute later, resetting its
date and logging it a second time.

**The detail is recomputed, never stored.** The table has three columns, so what
an advisory *names* — the path, the variables, the events — is derived at every
read. For the recorded one that is the whole trick: *that the assertion was made*
is what no code can work out again, and it is therefore the row; *which events it
was made about* is a join, and a join does not need a table of its own.

**Not to be confused with the audit.** ``import_source(filename, kind,
imported_at, fingerprint)`` is the provenance trail. Merging the two would give
an advisory box that grows by one row per import and that one stops reading —
both failures at once, the notices lost in the trace and the trace unreadable as
notices.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from logfmt_logger import getLogger

import fx

logger = getLogger("advisories")

#: An advisory the code can decide for itself at any instant. Its row is armed
#: and dropped by :func:`refresh` alone.
DERIVED = 'derived'

#: An advisory that is an **event**: the row *is* the fact, so :func:`refresh`
#: never arms one — :func:`record` does, at the instant it occurs — and the only
#: thing that can drop it is its subject disappearing altogether.
RECORDED = 'recorded'

#: The third answer an observation may give: *not from here*. Distinguished from
#: "does not stand" because the two lead to opposite gestures — see the module
#: docstring.
UNOBSERVED = object()

#: The five keys, and there are no others. They are published over the API and a
#: client may branch on them, so they are stable identifiers rather than prose.
LEGACY_CONFIG_FILE = 'legacy_config_file'
LEGACY_SETTINGS_FILE = 'legacy_settings_file'
UNREAD_ENVIRONMENT = 'unread_environment'
RECONSTRUCTION_RUNNING = 'reconstruction_running'
ASSUMED_BASE_CURRENCY = 'assumed_base_currency'


class UnknownAdvisory(KeyError):
    """A key no advisory carries. The registry is closed, so this is a mistake."""


class AdvisoryNotStanding(LookupError):
    """The key is one of the five, and nothing is standing under it right now.

    Its own class because the API's answer differs from :class:`UnknownAdvisory`
    only in the sentence, never in the status: both are a ``404``, and both mean
    *there is nothing here to acknowledge*.
    """


@dataclass(frozen=True)
class Context:
    """What the derivable observations read, gathered by the caller.

    The predicates live here (:data:`SPECS`) and the *sources* live where they
    belong — the configuration directory on the manager, the environment
    inventory in :mod:`main`, the reconstruction's progress in the scheduler's
    own memory. This dataclass is the seam between them, and it is a frozen bag
    of values rather than a set of callbacks so that a test can state a
    situation in one line.

    Every field defaults to *unobservable* rather than to *absent*, which is the
    same rule as :data:`UNOBSERVED` one level down: a caller that cannot see a
    source says nothing about it, instead of asserting it is not there.
    """

    #: The configuration directory the two v4 files would sit in.
    config_dir: Optional[Path] = None

    #: The ``SB_*`` / ``INFLUXDB_*`` variables that are set and read by nothing
    #: (``main.unread_environment``). ``None`` when the caller did not look.
    unread_variables: Optional[Tuple[str, ...]] = None

    #: ``(series complete, series in the reconstruction)``, from the scheduler's
    #: process memory. ``None`` when this process cannot see it, and **only**
    #: that: ``(0, 0)`` is *nothing to reconstruct*, an answer, and it stands
    #: the advisory down. The two are opposite gestures on the same row —
    #: ``None`` leaves it exactly as it is, so a restart does not re-date and
    #: re-log what a running scheduler armed a minute earlier; ``(0, 0)`` takes
    #: it away, so a notice cannot outlive the portfolio it describes.
    reconstruction: Optional[Tuple[int, int]] = None

    @property
    def reconstruction_concluded(self) -> bool:
        """Every series has reached its first acquisition — *and it was observed*.

        The condition that produces the one advisory that is an event, and it is
        a property here rather than a test written at the call site because the
        two ways of getting it wrong are both silent: an unobserved
        reconstruction is not a concluded one, and a portfolio that was never
        held has not concluded anything either.
        """
        if self.reconstruction is None:
            return False
        complete, total = self.reconstruction
        return total > 0 and complete >= total


@dataclass(frozen=True)
class AdvisorySpec:
    """One advisory: what makes it stand, and what it says when it does.

    ``observe`` answers the three-valued question of the module docstring;
    ``message`` turns what it named into a sentence, and that sentence has two
    readers and neither of them is the interface: **the log line, and a client
    with no interface** (issue #768). One text in one language for that channel,
    which has no reader preference and is grepped rather than read.

    **Until #768 this said the opposite, and the argument was reversed rather
    than narrowed.** It read: *``message`` turns what it named into the sentence
    a human reads, on the API and in the log alike — **one text, one place**,
    because an advisory whose log line and whose screen disagree is worse than
    either alone.* Both halves fell together. The interface composes its own
    sentence from ``key`` and ``detail``, so there are now **two texts in two
    places**, and the screen is deliberately not this one — reversed on a
    measurement rather than on taste: the whole content of the *Notices* block
    was English on a French installation, and the sentences below count with
    ``(s)`` and enumerate with ``', '.join(...)``, which is an operator's plural
    and an operator's list. What the old clause was right about is kept — two
    texts that *disagreed* would still be worse than either alone — and these two
    do not disagree: they serve two audiences under two contracts, a logfmt line
    an operator greps in one language for ever against a paragraph a reader reads
    in theirs, and the front is served the arrays and the counts these sentences
    were built from rather than the string.

    The reader's language is a browser preference with **no dial in the store**
    (ADR-0024), so this process does not know it and ``Accept-Language`` has no
    subject here; the choice and the two forms refused beside it are argued in
    ``lib/advisories.ts``, where it is taken. **Nothing here follows a reader**:
    the sentences below are English and stay English.

    ``level`` is the log level the arming line is emitted at, and it is per
    advisory rather than uniform: a reconstruction in progress is the app working
    as designed, and a ``WARNING`` for it would teach an operator to filter out
    the level the other four need.
    """

    key: str
    kind: str
    observe: Callable[[Any, Context], Any]
    message: Callable[[Mapping[str, Any]], str]
    doc: str
    level: int = logging.WARNING


@dataclass(frozen=True)
class Advisory:
    """A standing advisory: its row, plus what it names *right now*.

    ``detail`` is ``None`` when the observation could not be made from here —
    the row stands, and this process simply cannot say what it covers. The
    message then falls back to :attr:`AdvisorySpec.doc`, which says what the
    advisory is without claiming specifics it has not read.
    """

    key: str
    first_seen_at: datetime
    acknowledged_at: Optional[datetime]
    message: str
    detail: Optional[Dict[str, Any]]

    @property
    def acknowledged(self) -> bool:
        return self.acknowledged_at is not None

    def to_dict(self) -> Dict[str, Any]:
        """The JSON shape. ``acknowledged`` is published beside its date because
        a client branches on the boolean and displays the instant."""
        return {
            'key': self.key,
            'first_seen_at': _iso(self.first_seen_at),
            'acknowledged': self.acknowledged,
            'acknowledged_at': _iso(self.acknowledged_at),
            'message': self.message,
            'detail': self.detail,
        }


# --------------------------------------------------------------------------- #
# The five observations
# --------------------------------------------------------------------------- #

def _legacy_file(filename: str):
    """Observe one v4 file the app names and never reads (ADR-0008).

    A ``stat`` and nothing else, which is the whole reason this advisory has no
    stored existence: the file is either there or it is not, and the app has no
    business remembering an answer it can get in a system call. Deleting the
    file is therefore a way of dismissing the notice, and acknowledging it is the
    way of keeping *both* the file and a quiet screen.
    """
    def observe(opened, context: Context):
        if context.config_dir is None:
            return UNOBSERVED
        path = Path(context.config_dir) / filename
        if not path.exists():
            return None
        return {'path': str(path)}
    return observe


def _observe_unread_environment(opened, context: Context):
    """The ``SB_*`` / ``INFLUXDB_*`` variables that are set and obeyed by nothing.

    The list is **computed** by :func:`main.unread_environment` — the difference
    between what is present and what the inventory names — so this advisory
    cannot drift the way a hand-written list of retired names would.
    """
    if context.unread_variables is None:
        return UNOBSERVED
    if not context.unread_variables:
        return None
    return {'variables': list(context.unread_variables)}


def _observe_reconstruction(opened, context: Context):
    """How far the historical reconstruction has got — process memory only.

    ``None`` for the reconstruction means this process cannot see it (the
    gunicorn master, a test holding a store alone), never that it has finished:
    see :data:`UNOBSERVED`. It is the **only** thing ``None`` says here, and
    :meth:`main.SuiviBourseMetrics.reconstruction_state` never produces it — a
    process that *can* see the scheduler always answers a pair.

    Two pairs stand the advisory down, and they are two situations rather than
    one spelling: ``(n, n)`` is finished, and ``(0, 0)`` is *nothing to
    reconstruct* — a fresh install, or an owner who has just forgotten every
    import. Both are observations, so both **drop the row**. Reading the second
    as *unobservable* is what let the notice outlive its own subject: the
    advisory stayed armed, with no detail and no way back, on an installation
    whose portfolio was empty.
    """
    if context.reconstruction is None:
        return UNOBSERVED
    complete, total = context.reconstruction
    if total <= 0 or complete >= total:
        return None
    return {'complete': complete, 'total': total, 'remaining': total - complete}


def _observe_assumed_base_currency(opened, context: Context):
    """The events whose amounts were taken to be in the reporting currency.

    The comparison is ``symbol_quote.currency`` against the ``base_currency``
    dial, and three things about it are deliberate:

    * **it needs an answered currency.** While the dial is unset the app has
      asserted nothing — every amount is a number with no unit yet — so there is
      nothing to report. Answering it later re-opens the question, and the next
      backfill cycle is what asks it again.
    * **it goes through** :func:`fx.normalise`, so ``GBp`` and ``GBP`` are one
      currency at two scales rather than two currencies. A London line quoted in
      pence beside amounts recorded in pounds is a *unit* problem the conversion
      already owns (ADR-0002); reporting it here would send the owner to
      re-export a file that is correct.
    * **only an event carrying money is concerned.** A ``GRANT`` with no declared
      price asserts nothing about any currency, so naming it would pad the repair
      list with rows there is nothing to repair on.
    """
    base = opened.setting('base_currency')
    if not base:
        return None

    target, _ = fx.normalise(base)
    rows = opened.query(
        'SELECT e.id, e.date, e.event_type, e.symbol, e.account, q.currency '
        'FROM event e JOIN symbol_quote q ON q.symbol = e.symbol '
        'WHERE q.currency IS NOT NULL '
        '  AND (e.unit_price IS NOT NULL OR e.fee IS NOT NULL '
        '       OR e.amount IS NOT NULL) '
        'ORDER BY e.date, e.id')

    events: List[Dict[str, Any]] = []
    for identifier, day, event_type, symbol, account, currency in rows:
        quoted, _ = fx.normalise(currency)
        if quoted is None or quoted == target:
            continue
        events.append({
            'id': identifier,
            'date': day.isoformat() if day is not None else None,
            'event_type': event_type,
            'symbol': symbol,
            'account': account,
            'quote_currency': currency,
        })

    if not events:
        return None
    return {
        'base_currency': base,
        'events': events,
        # Named beside the events because they are the *actionable* unit: one
        # re-export fixes every line of a symbol, and a list of forty event ids
        # is a list nobody reads.
        'symbols': sorted({event['symbol'] for event in events}),
        'currencies': sorted({event['quote_currency'] for event in events}),
    }


# --------------------------------------------------------------------------- #
# The five sentences
# --------------------------------------------------------------------------- #

def _say_legacy_config(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['path']} is still there and this version does not read it: a "
        f"portfolio is a dated event ledger and nothing else. Nothing has been "
        f"erased — describe those positions as dated events in the drop folder, "
        f"or acknowledge this notice to keep the file exactly where it is "
        f"without being reminded of it again.")


def _say_legacy_settings(detail: Mapping[str, Any]) -> str:
    return (
        f"{detail['path']} is still there and this version does not read it: "
        f"accounts are declared by a file in the events' format (id, type, "
        f"label) or from the app, and the drop folder is no longer named by a "
        f"setting. Nothing has been erased — re-declare the accounts it holds, "
        f"or acknowledge this notice.")


def _say_unread_environment(detail: Mapping[str, Any]) -> str:
    variables = detail['variables']
    return (
        f"{len(variables)} environment variable(s) are set and read by nothing: "
        f"{', '.join(variables)}. The settings they named live in the store "
        f"since v5 — set them on the settings page, or with one "
        f"PUT /api/settings — and those that were removed have no replacement "
        f"at all. Unset them, or acknowledge this notice.")


def _say_reconstruction(detail: Mapping[str, Any]) -> str:
    return (
        f"The historical reconstruction is running: {detail['complete']} of "
        f"{detail['total']} series have reached their first acquisition. Your "
        f"performance figures are computed from the history stored so far and "
        f"will keep moving until it is complete.")


def _say_assumed_base_currency(detail: Mapping[str, Any]) -> str:
    base = detail['base_currency']
    return (
        f"Your amounts were read as {base}. {len(detail['events'])} event(s) on "
        f"{len(detail['symbols'])} line(s) quoted in "
        f"{', '.join(detail['currencies'])} ({', '.join(detail['symbols'])}) "
        f"were imported before any price had been observed, so this version took "
        f"the amounts in your files to be {base} already. If your broker "
        f"exported them in the security's own currency, re-export those lines "
        f"in {base} and drop the file again; if they were already in {base}, "
        f"acknowledge this notice.")


#: Every advisory this product has, in the order a reader meets them: what is
#: true of the installation first, then what the app is doing, then what it once
#: assumed. The order is **stable and declared** rather than sorted by date,
#: because a badge whose contents reshuffle between two reads is a badge nobody
#: trusts.
SPECS: Tuple[AdvisorySpec, ...] = (
    AdvisorySpec(
        LEGACY_CONFIG_FILE, DERIVED, _legacy_file('config.yaml'),
        _say_legacy_config,
        'A v4 config.yaml sits in the configuration directory and is not read.'),
    AdvisorySpec(
        LEGACY_SETTINGS_FILE, DERIVED, _legacy_file('settings.yaml'),
        _say_legacy_settings,
        'A v4 settings.yaml sits in the configuration directory and is not read.'),
    AdvisorySpec(
        UNREAD_ENVIRONMENT, DERIVED, _observe_unread_environment,
        _say_unread_environment,
        'Environment variables are set that this version reads for nothing.'),
    AdvisorySpec(
        RECONSTRUCTION_RUNNING, DERIVED, _observe_reconstruction,
        _say_reconstruction,
        'The historical reconstruction has not reached every first acquisition.',
        level=logging.INFO),
    AdvisorySpec(
        ASSUMED_BASE_CURRENCY, RECORDED, _observe_assumed_base_currency,
        _say_assumed_base_currency,
        'Amounts imported from files were taken to be in the reporting currency.'),
)

#: By key, for the lookups the write path and the API do.
BY_KEY: Dict[str, AdvisorySpec] = {spec.key: spec for spec in SPECS}


def spec_for(key: str) -> AdvisorySpec:
    """The spec of ``key``, or :class:`UnknownAdvisory` — the list is closed."""
    try:
        return BY_KEY[key]
    except KeyError:
        raise UnknownAdvisory(key) from None


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class _Row:
    """The three columns, and there are only ever three."""

    key: str
    first_seen_at: datetime
    acknowledged_at: Optional[datetime]


def _rows(opened) -> Dict[str, _Row]:
    """Every row the table holds, by key. It has five at the very most."""
    return {
        key: _Row(key, _utc(first_seen_at), _utc(acknowledged_at))
        for key, first_seen_at, acknowledged_at in opened.query(
            'SELECT key, first_seen_at, acknowledged_at FROM advisory')
    }


def refresh(opened, context: Context,
            now: Optional[datetime] = None) -> List[Advisory]:
    """Re-observe every advisory, arm what stands, drop what no longer does.

    The one function that writes rows for the derivable four, and the reason it
    both arms *and* drops is the criterion it serves: an advisory has no stored
    existence beyond its acknowledgement, so a predicate that goes false takes
    its row — and its acknowledgement — with it, and a predicate that comes back
    is a new advisory with a new date and a new log line.

    A :data:`RECORDED` advisory is never armed here (only :func:`record` does
    that, at the instant it happens) and is dropped only when its subject is
    gone: forgetting the import whose amounts were assumed takes the notice with
    it, there being nothing left to repair.

    Returns the advisories that stand afterwards, acknowledged ones included —
    the caller decides what to show, and :func:`listing` is what the API reads.
    """
    now = now or datetime.now(timezone.utc)
    rows = _rows(opened)
    standing: List[Advisory] = []

    for spec in SPECS:
        detail = spec.observe(opened, context)
        row = rows.get(spec.key)

        if detail is UNOBSERVED:
            # Not from here: the row is left exactly as it is, armed or absent.
            # Dropping it would make every restart re-date and re-log the
            # advisory a running scheduler is perfectly aware of.
            if row is not None:
                standing.append(_advisory(spec, row, None))
            continue

        if detail is None:
            if row is not None:
                _drop(opened, spec.key)
            continue

        if row is None:
            if spec.kind == RECORDED:
                continue
            row = _arm(opened, spec, detail, now)
        standing.append(_advisory(spec, row, detail))

    return standing


def record(opened, key: str, context: Context,
           now: Optional[datetime] = None) -> Optional[Advisory]:
    """Arm a :data:`RECORDED` advisory — the event half, called where it happens.

    Idempotent by construction: a key that already has a row is left alone,
    whatever its acknowledgement. That is what makes it safe to call at the end
    of *every* cycle that concludes the reconstruction rather than only at the
    first one — the process forgets it has finished at each restart, and the
    store does not.

    Answers ``None`` when there was nothing to record: the observation did not
    stand, or the advisory was armed already.
    """
    spec = spec_for(key)
    if spec.kind != RECORDED:
        raise ValueError(
            f"{key} is a derivable advisory; refresh() arms it, not record()")

    detail = spec.observe(opened, context)
    if detail is None or detail is UNOBSERVED:
        return None
    if _rows(opened).get(key) is not None:
        return None

    row = _arm(opened, spec, detail, now or datetime.now(timezone.utc))
    return _advisory(spec, row, detail)


def listing(opened, context: Context) -> List[Advisory]:
    """What the API answers: the rows that stand, each re-derived at this instant.

    A **read**, deliberately: the arming and the dropping belong to the jobs that
    observe the sources, so a ``GET`` never writes and never dates an advisory
    with the moment somebody happened to look at a page.

    An acknowledged row is left out, which is the whole of *"an acknowledged
    advisory disappears"*, and there is no option to ask for it back: this is not
    a journal. It is not *deleted* either — the row is what keeps the
    acknowledgement across a restart, which a *toast* cannot do and which the
    recorded advisory needs, arriving as it does half an hour after the boot.
    """
    rows = _rows(opened)
    shown: List[Advisory] = []
    for spec in SPECS:
        row = rows.get(spec.key)
        if row is None:
            continue
        if row.acknowledged_at is not None:
            continue
        detail = spec.observe(opened, context)
        if detail is UNOBSERVED or detail is None:
            detail = None
        shown.append(_advisory(spec, row, detail))
    return shown


def acknowledge(opened, key: str, context: Optional[Context] = None,
                now: Optional[datetime] = None) -> Advisory:
    """Acknowledge one advisory. The only gesture the table offers.

    Raises:
        UnknownAdvisory: the key is not one of the five.
        AdvisoryNotStanding: it is, and nothing stands under it — there is
            nothing to acknowledge, and pretending otherwise would write a row
            whose predicate has never been observed.

    Acknowledging twice is not an error and does not move the date: the second
    gesture asserts what the first already did.

    ``context`` is only used to build the receipt this answers with, never to
    decide anything: what may be acknowledged is what stands, and what stands is
    the row.
    """
    spec = spec_for(key)
    row = _rows(opened).get(key)
    if row is None:
        raise AdvisoryNotStanding(key)

    if row.acknowledged_at is None:
        acknowledged_at = now or datetime.now(timezone.utc)
        with opened.transaction():
            opened.execute(
                'UPDATE advisory SET acknowledged_at = ? WHERE key = ?',
                [acknowledged_at, key])
        row = _Row(key, row.first_seen_at, acknowledged_at)

    detail = spec.observe(opened, context or Context())
    if detail is UNOBSERVED or detail is None:
        detail = None
    return _advisory(spec, row, detail)


# --------------------------------------------------------------------------- #
# Internals
# --------------------------------------------------------------------------- #

def _arm(opened, spec: AdvisorySpec, detail: Mapping[str, Any],
         now: datetime) -> _Row:
    """Write the row and say it once, in logfmt.

    The log line is emitted **here**, where the row is created, and nowhere else:
    that is what makes *"journalisé une fois, au moment où il se produit"* a
    property of the mechanism rather than a discipline every caller has to keep.
    An advisory that is already armed is not logged again, and one that is
    re-armed after its predicate came back is — it is a new occurrence.

    ``extra['context']`` is what ``logfmt_logger`` renders as ``key=value``
    pairs, so the headless channel is parseable rather than a sentence to grep.
    """
    with opened.transaction():
        opened.execute(
            'INSERT INTO advisory (key, first_seen_at, acknowledged_at) '
            'VALUES (?, ?, NULL) ON CONFLICT (key) DO NOTHING',
            [spec.key, now])
    logger.log(spec.level, spec.message(detail), extra={'context': {
        'advisory': spec.key,
        'first_seen_at': _iso(now),
    }})
    return _Row(spec.key, now, None)


def _drop(opened, key: str) -> None:
    """Take the row away, acknowledgement included. See :func:`refresh`."""
    with opened.transaction():
        opened.execute('DELETE FROM advisory WHERE key = ?', [key])


def _advisory(spec: AdvisorySpec, row: _Row,
              detail: Optional[Mapping[str, Any]]) -> Advisory:
    """Join a row to what its observation named, or to nothing at all."""
    return Advisory(
        key=row.key,
        first_seen_at=row.first_seen_at,
        acknowledged_at=row.acknowledged_at,
        message=spec.message(detail) if detail else spec.doc,
        detail=dict(detail) if detail else None,
    )


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    """Stamp a naive instant as UTC — the store's session is pinned there."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601, or ``None``. One spelling of an instant on the way out."""
    return None if value is None else _utc(value).isoformat()


__all__ = [
    'Advisory', 'AdvisorySpec', 'Context', 'UnknownAdvisory',
    'AdvisoryNotStanding', 'DERIVED', 'RECORDED', 'UNOBSERVED',
    'LEGACY_CONFIG_FILE', 'LEGACY_SETTINGS_FILE', 'UNREAD_ENVIRONMENT',
    'RECONSTRUCTION_RUNNING', 'ASSUMED_BASE_CURRENCY',
    'SPECS', 'BY_KEY', 'spec_for',
    'refresh', 'record', 'listing', 'acknowledge',
]
