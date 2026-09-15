"""What one account would owe if everything in it were sold today (#919).

**Pure**, and scalar: no store, no market, no numpy, and ``now`` arrives as an
argument. :mod:`application.taxation` reserves itself for three things — the
kinds, their parameters, the shipped templates — and sends the projection here.

Three rules the arithmetic is, and they are the reason this module exists rather
than a formula inlined in the route:

- **the assiette is the latent gain, and it is the same one for every kind.**
  ``Σ market_value − Σ cost_basis`` over the account's lines, which is the
  question the screen asks: *what would you owe if you sold everything in this
  account today*. ``gain_absolu`` was read here for the aged family until the
  review of 2026-09-15 and is not: it is ``total_value − net_contributed`` under
  another name, ``net_contributed`` is net of **withdrawals**, so a gain realised
  and taken out years ago stayed in the assiette for ever — an emptied account
  was billed tax on money it no longer held, while the same account under a flat
  model answered zero. One question, one assiette, three kinds;
- **a gain that is not known is not zero.** One unvalued line makes the assiette
  unknown and the figure does not exist. This module returns ``None`` there, and
  the route publishes no member at all;
- **the floor is at zero, per account.** An account in aggregate loss owes
  nothing; it does not owe a negative that some other account could absorb.

Only the three ``*_realised`` kinds project. ``none`` and ``withholding_income``
return ``None`` here: what a ``none`` model is worth on the screen is ``0 €``,
but that zero is *the model saying so*, not an arithmetic result, and the two
must not be told apart by their value.
"""
from datetime import date
from typing import Any, List, Mapping, Optional

from application import taxation


#: The kinds that have a realised gain to project. The other two do not, and the
#: screen says why rather than showing a figure derived from nothing.
PROJECTED_KINDS = (taxation.FLAT_REALISED, taxation.AGED_FLAT_REALISED,
                   taxation.BRACKETED_REALISED)


def projected_tax(*, kind: str, parameters: Mapping[str, Any],
                  latent_gain: Optional[float],
                  opened_on: Optional[date] = None,
                  first_payment: Optional[date] = None,
                  now: date) -> Optional[float]:
    """One account's tax at one instant, or ``None`` when there is none to state.

    ``latent_gain`` is ``Σ market_value − Σ cost_basis`` over the account's
    lines, already ``None`` if one held line of it was unvalued. What the kind
    decides is the *rate*, never the assiette: the three answer one question.
    """
    if kind not in PROJECTED_KINDS:
        return None

    if kind == taxation.AGED_FLAT_REALISED:
        return _aged(parameters, latent_gain,
                     age_date(parameters, opened_on, first_payment), now)
    if kind == taxation.FLAT_REALISED:
        return _flat(parameters, latent_gain)
    return _bracketed(parameters, latent_gain)


def age_date(parameters: Mapping[str, Any],
             opened_on: Optional[date],
             first_payment: Optional[date]) -> Optional[date]:
    """The day the threshold is counted from — and ``age_basis`` is what says it.

    Under ``opening`` it is the declared date alone. Under ``first_payment`` it
    is the declared date where there is one and the ledger's earliest payment
    otherwise, **and that fallback is what makes the feature reachable at all**:
    the shipped ``fr_pea`` template sets ``age_basis: FIRST_PAYMENT``, and the
    form renders and sends ``opened_on`` only under ``opening``. Read the
    declared date alone and every PEA declared through the shortcut this app
    ships projects nothing, for ever, with no repair reachable from the screen.

    This is not #918's bug returning. #918 is a *declared* date overwritten by a
    derived one; here there is no declaration to overwrite, and a declared date
    still wins wherever one exists.
    """
    if parameters.get('age_basis') == taxation.OPENING:
        return opened_on
    return opened_on or first_payment


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
    return _positive(tax)


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
    if kind == taxation.FLAT_REALISED:
        return [_with_levy(parameters['rate'], parameters)]
    if kind == taxation.AGED_FLAT_REALISED:
        start = age_date(parameters, opened_on, first_payment)
        if start is None:
            return None
        rate = _aged_rate(parameters, start, now)
        return None if rate is None else [rate]
    if kind == taxation.BRACKETED_REALISED:
        return [rung['rate'] for rung in parameters['brackets']]
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
    day = threshold_day(parameters,
                        age_date(parameters, opened_on, first_payment))
    if day is None or day <= now:
        return None
    return day


__all__ = ['PROJECTED_KINDS', 'age_date', 'applied_rates', 'projected_tax',
           'rate_changes_on', 'threshold_day']
