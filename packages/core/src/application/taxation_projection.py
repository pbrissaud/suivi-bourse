"""What one account would owe if everything in it were sold today (#919).

**Pure**, and scalar: no store, no market, no numpy, and ``now`` arrives as an
argument. :mod:`application.taxation` reserves itself for two things — the
kinds and their parameters — and sends the projection here.

Three rules the arithmetic is, and they are the reason this module exists rather
than a formula inlined in the route:

- **the assiette depends on when the kind taxes, and** :func:`projected_base`
  **is its one statement.** A flat or bracketed account is taxed when a line is
  sold, so its assiette is the latent gain of its lines, ``Σ market_value −
  Σ cost_basis``. An aged wrapper (a PEA, an assurance-vie) is taxed when money
  leaves it, so its assiette is the **envelope gain**, ``total_value −
  net_contributed`` (the account's ``gain_absolu``): cash, realised gains and
  dividends kept inside count, and an emptied wrapper owes nothing. The account
  card and the sale simulator both read it there. **Known limit:**
  ``net_contributed`` is net of withdrawals, so after a partial withdrawal the
  gain already taken out (and taxed then) stays in the assiette, and the
  estimate overstates;
- **a gain that is not known is not zero.** One unvalued line makes the assiette
  unknown and the figure does not exist. This module returns ``None`` there, and
  the route publishes no member at all;
- **the floor is at zero, per account.** An account in aggregate loss owes
  nothing; it does not owe a negative that some other account could absorb.

``now`` is **a UTC calendar day**, and the caller is what narrows an instant to
one. That is a contract rather than an accident (#952): the rate turns at UTC
midnight, so a wrapper ages by the reader's own offset late east of Greenwich
and early west of it — up to fourteen hours, once in a wrapper's life, on
precisely the day its owner would look. Nothing here can close that window: the
reader's timezone is not a thing this app knows, and teaching it one for a
threshold crossed once would cost more than the crossing. What the screen and
the MCP description do instead is **name the boundary** where they name the day,
so the figure and the sentence beside it cannot disagree in silence.

Dating the projection off ``account_metrics`` instead was triaged and refused.
It buys no calendar — the perf pass dates its own rows from the same
``datetime.now(timezone.utc).date()`` — and it costs one: the latent gain is
read live off :func:`store_reads.PortfolioReader.positions`, so borrowing the
perf cache's day would put the rate on a day that base is not on. (An aged
wrapper's envelope gain is the newest ``account_metrics`` row's.)

Only the three ``*_realised`` kinds project. ``none`` and ``withholding_income``
return ``None`` here: what a ``none`` model is worth on the screen is ``0 €``,
but that zero is *the model saying so*, not an arithmetic result, and the two
must not be told apart by their value.
"""
from datetime import date
from typing import Any, Dict, List, Mapping, Optional, Tuple

from application import taxation


#: The kinds that have a realised gain to project. The other two do not, and the
#: screen says why rather than showing a figure derived from nothing.
PROJECTED_KINDS = (taxation.FLAT_REALISED, taxation.AGED_FLAT_REALISED,
                   taxation.BRACKETED_REALISED)


def _checked(kind: str,
             parameters: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The parameters as the record would accept them **today**, or ``None``.

    **A row is checked when it is written, and read back for ever after.** The
    store holds what some earlier version accepted: a model missing a parameter
    that became required, a rate a hand edit left as a string, a bound this
    version added. None of those is hypothetical — the arithmetic below indexes
    and multiplies them, so an unreadable row reaches a caller as ``KeyError``
    or ``TypeError`` rather than as an answer, and :mod:`api` serves that on the
    route every page reads.

    So the guard is here rather than at each call site: three public functions
    read these parameters, and a fourth will when the MCP surface grows one.
    :func:`taxation.validate` is the same check the write ran, which is what
    makes *unreadable* mean exactly *the record would refuse it now* — and it
    normalises on the way through, so a rate stored as ``"0.3"`` is a rate.
    """
    try:
        return taxation.validate(kind, parameters)
    except taxation.ModelRejected:
        return None


def projected_tax(*, kind: str, parameters: Mapping[str, Any],
                  latent_gain: Optional[float],
                  opened_on: Optional[date] = None,
                  first_payment: Optional[date] = None,
                  now: date) -> Optional[float]:
    """One account's tax at one instant, or ``None`` when there is none to state.

    ``latent_gain`` is the assiette :func:`projected_base` states for the
    kind, the envelope gain of an aged wrapper and the latent gain of the lines
    otherwise, already ``None`` where it is unknown.
    """
    if kind not in PROJECTED_KINDS:
        return None
    checked = _checked(kind, parameters)
    if checked is None:
        return None

    if kind == taxation.AGED_FLAT_REALISED:
        return _aged(checked, latent_gain,
                     age_date(checked, opened_on, first_payment), now)
    if kind == taxation.FLAT_REALISED:
        return _flat(checked, latent_gain)
    return _bracketed(checked, latent_gain)


def projected_base(kind: str, latent_gain: Optional[float],
                   total_value: Optional[float],
                   envelope_gain: Optional[float]) -> Optional[float]:
    """The assiette of ``kind``, from the account's latent gain and its newest
    ``total_value`` and ``gain_absolu`` (the envelope gain).

    The latent gain for every kind but the aged one, which reads the envelope
    gain: zero for an emptied wrapper, unknown while one held line is unvalued
    (``latent_gain`` is then ``None``).
    """
    if kind != taxation.AGED_FLAT_REALISED or latent_gain is None:
        return latent_gain
    if not total_value:
        return 0.0
    return envelope_gain


def projected_split(*, kind: str, parameters: Mapping[str, Any],
                    latent_gain: Optional[float],
                    opened_on: Optional[date] = None,
                    first_payment: Optional[date] = None,
                    now: date) -> Optional[Tuple[float, float]]:
    """:func:`projected_tax` as ``(income tax, social levy)``, or ``None``.

    The two are owed to different authorities and the screen names them
    separately; their sum is :func:`projected_tax` to the cent. The levy is
    ``social_rate`` on the same floored assiette, the one
    :func:`projected_base` states for the kind, so the
    income part is the projection of the model **without** it.
    """
    checked = _checked(kind, parameters) if kind in PROJECTED_KINDS else None
    if checked is None:
        return None
    facts = dict(kind=kind, latent_gain=latent_gain, opened_on=opened_on,
                 first_payment=first_payment, now=now)
    income = projected_tax(
        parameters={k: v for k, v in checked.items() if k != 'social_rate'},
        **facts)
    if income is None:
        return None
    return income, _positive(latent_gain) * checked.get('social_rate', 0.0)


def age_date(parameters: Mapping[str, Any],
             opened_on: Optional[date],
             first_payment: Optional[date]) -> Optional[date]:
    """The day the threshold is counted from — and ``age_basis`` is what says it.

    Under ``opening`` it is the declared date alone. Under ``first_payment`` it
    is the ledger's earliest payment, which is what the model says (a PEA's five
    years run from its first deposit, not from the day the account was opened),
    and the declared date only where the ledger has no payment yet. The form
    renders and sends ``opened_on`` only under ``opening``, so the fallback is
    what keeps a payment-less wrapper from projecting nothing.
    """
    if parameters.get('age_basis') == taxation.OPENING:
        return opened_on
    return first_payment or opened_on


def threshold_day(parameters: Mapping[str, Any],
                  start: Optional[date]) -> Optional[date]:
    """The day the threshold is reached, past or future — **one rule, one home**.

    Both the arithmetic and the footing that names the day the rate changes read
    it here rather than each deciding what *reached* means: spelled twice, the
    card could name a rate the figure beside it contradicts.

    ``None`` where the sum runs off the end of the calendar. :data:`taxation.
    MAX_THRESHOLD_YEARS` bounds the *span* and nothing bounds the *start*: a
    wrapper declared as opened in 9999 plus a two-century threshold is a date
    Python has no year for, and the guard belongs on the read. The write is
    checked once; this is asked on every page that lists the accounts, and a row
    written before the bound existed would otherwise 500 the very page its owner
    would repair it from.
    """
    if start is None:
        return None
    try:
        return _anniversary(
            start, start.year + int(parameters['threshold_years']))
    except ValueError:
        return None


def _anniversary(start: date, year: int) -> date:
    """The same day of ``year`` — 29 February falling back to the 28th.

    Raises :class:`ValueError` past year 9999, which :func:`threshold_day` is
    what answers for.
    """
    try:
        return start.replace(year=year)
    except ValueError:
        return start.replace(year=year, day=28)


def _aged(parameters: Mapping[str, Any], gain: Optional[float],
          start: Optional[date], now: date) -> Optional[float]:
    """The rate turns on the wrapper's age, and ``social_rate`` does not.

    A mature PEA is exempt of *income* tax and still owes its social levy; an
    assurance-vie past its eighth year owes a reduced rate **plus** the same
    levy. Adding the levy on one side only is the mistake this shape exists to
    make unavailable.
    """
    if start is None or gain is None:
        return None
    rate = _aged_rate(parameters, start, now)
    return None if rate is None else _positive(gain) * rate


def _aged_rate(parameters: Mapping[str, Any], start: date,
               now: date) -> Optional[float]:
    """The rate in force on ``now``, levy folded in. Reached **on** the
    anniversary, which :func:`threshold_day` is the single statement of.

    ``None`` where that day runs off the calendar: a threshold that can never be
    reached is not a reason to publish the rate before it as though it were
    measured.
    """
    day = threshold_day(parameters, start)
    if day is None:
        return None
    rate = parameters['rate_after'] if now >= day else parameters['rate_before']
    return _with_levy(rate, parameters)


def _flat(parameters: Mapping[str, Any],
          gain: Optional[float]) -> Optional[float]:
    if gain is None:
        return None
    return _positive(gain) * _with_levy(parameters['rate'], parameters)


def _with_levy(rate: float, parameters: Mapping[str, Any]) -> float:
    """``social_rate`` is optional on both kinds that have one, and absent means
    nothing rather than a rate the app would have to invent."""
    return rate + parameters.get('social_rate', 0.0)


def _bracketed(parameters: Mapping[str, Any],
               gain: Optional[float]) -> Optional[float]:
    """Progressive, slice by slice: each rung taxes only what falls inside it.

    The ladder arrives checked by :func:`taxation.validate` — climbing, and with
    an open top rung — so the walk needs no defence of its own shape.
    """
    if gain is None:
        return None
    remaining = _positive(gain)
    tax = 0.0
    floor = 0.0
    for rung in parameters['brackets']:
        if remaining <= 0.0:
            break
        bound = rung['upper_bound']
        slice_ = remaining if bound is None else min(remaining, bound - floor)
        tax += slice_ * rung['rate']
        remaining -= slice_
        floor = bound if bound is not None else floor
    # **The belt, and the braces are in :func:`taxation._brackets`.** The floor
    # at zero is this module's stated rule, and a walk that could return a
    # negative under *any* ladder would leave that rule resting on a validator
    # one import away.
    return _positive(tax) + _positive(gain) * parameters.get('social_rate', 0.0)


def _positive(gain: float) -> float:
    """The floor at zero, taken **per account**: a loss owes nothing, and it
    does not owe a negative for another account to absorb."""
    return gain if gain > 0.0 else 0.0


def applied_rates(*, kind: str, parameters: Mapping[str, Any],
                  opened_on: Optional[date] = None,
                  first_payment: Optional[date] = None,
                  now: date) -> Optional[List[float]]:
    """The rate or rates that produced the figure, as fractions.

    **Published rather than re-derived in the browser.** The rule is the same
    one :func:`projected_tax` applies — which side of the threshold, the levy
    folded in — and a second reading of it in another language drifts on exactly
    the accounts nobody tests: the card would name a rate the figure beside it
    contradicts, and neither would look wrong.

    One rate for the two flat families. A ladder has no single rate to name, so
    it names its rungs and the reader places their own gain among them.
    """
    checked = _checked(kind, parameters)
    if checked is None:
        return None
    if kind == taxation.FLAT_REALISED:
        return [_with_levy(checked['rate'], checked)]
    if kind == taxation.AGED_FLAT_REALISED:
        start = age_date(checked, opened_on, first_payment)
        if start is None:
            return None
        rate = _aged_rate(checked, start, now)
        return None if rate is None else [rate]
    if kind == taxation.BRACKETED_REALISED:
        return [_with_levy(rung['rate'], checked) for rung in checked['brackets']]
    return None


def rate_changes_on(*, kind: str, parameters: Mapping[str, Any],
                    opened_on: Optional[date] = None,
                    first_payment: Optional[date] = None,
                    now: date) -> Optional[date]:
    """The day the rate changes, or ``None`` where nothing is coming.

    Nothing is coming covers three cases and they are one absence: the model is
    not aged, it has no date to age from, and the threshold is already behind.
    The kink is the most interesting thing this arithmetic knows and is
    otherwise invisible — an owner three months from their wrapper's fifth
    anniversary sees one figure with no hint it is about to fall.
    """
    if kind != taxation.AGED_FLAT_REALISED:
        return None
    checked = _checked(kind, parameters)
    if checked is None:
        return None
    day = threshold_day(checked,
                        age_date(checked, opened_on, first_payment))
    if day is None or day <= now:
        return None
    return day


__all__ = ['PROJECTED_KINDS', 'age_date', 'applied_rates', 'projected_base',
           'projected_split',
           'projected_tax',
           'rate_changes_on', 'threshold_day']
