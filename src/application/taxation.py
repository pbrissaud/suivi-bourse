"""The taxation model — a closed ``kind``, its typed parameters, and the little
structure the app is allowed to ship (#752).

**Pure**, in the sense ``CLAUDE.md`` gives the word: no store, no yfinance, no
clock. It says what a model *is* and refuses what is not one; writing a model
down is :mod:`application.accounts`'s business, and projecting a figure out of
one is #919's.

Three things live here and nothing else:

- **the kinds**, a closed enumeration. A row carrying an unknown kind is a
  store written by a newer version, and it is refused rather than projected as
  zero;
- **each kind's parameters**, declared beside its constant, so a reader of the
  enumeration knows what a row of that kind must carry.
- **the wrapper templates**, and they carry **no money**. A template is *not
  stored*: it fills two fields of a form and does not survive the submission.

It does not survive the check: the Portuguese regime has **two** thresholds,
five years and eight, and the reduced rates are conditional on 35 % of the
premiums having been paid in the first half of the contract. The owner reaches
it through `bracketed_realised`, or types the shape they are in.
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: An exempt holding, or an account its owner does not want projected.
NONE = 'none'
#: A flat rate on the realised gain — FR compte-titres, BE, DE, IT, PT.
FLAT_REALISED = 'flat_realised'
#: A rate that changes with the wrapper's age — FR PEA, FR assurance-vie.
AGED_FLAT_REALISED = 'aged_flat_realised'
#: Progressive brackets on the realised gain — DK, ES, PT.
BRACKETED_REALISED = 'bracketed_realised'
#: A withholding on income received — all eight countries surveyed.
WITHHOLDING_INCOME = 'withholding_income'

#: The age a threshold is counted from. **Not always the opening date**:
#: a PEA's five years run from the *first payment*, and the two
#: coincide often enough to hide the mistake and not always enough to make it
#: safe. #918 is what writes the date itself.
OPENING = 'opening'
FIRST_PAYMENT = 'first_payment'
AGE_BASES = (OPENING, FIRST_PAYMENT)

#: A rate, a count of years, a basis, or a ladder. The four are all a parameter
#: can be, and the enumeration is what makes a new kind an addition.
RATE = 'rate'
YEARS = 'years'
AGE_BASIS = 'age_basis'
BRACKETS = 'brackets'


class ModelRejected(Exception):
    """What is being declared is not a taxation model this app can hold."""


#: Every kind, with its parameters as ``(name, type, required)``. The order is
#: the order a form asks them in.
PARAMETERS: Dict[str, Tuple[Tuple[str, str, bool], ...]] = {
    NONE: (),
    FLAT_REALISED: (
        ('rate', RATE, True),
        ('social_rate', RATE, False),
    ),
    AGED_FLAT_REALISED: (
        ('rate_before', RATE, True),
        ('rate_after', RATE, True),
        ('threshold_years', YEARS, True),
        ('age_basis', AGE_BASIS, True),
        ('social_rate', RATE, False),
    ),
    BRACKETED_REALISED: (
        ('brackets', BRACKETS, True),
    ),
    WITHHOLDING_INCOME: (
        ('rate', RATE, True),
    ),
}

KINDS = tuple(PARAMETERS)

#: The wrappers whose *structure* ships, nested under the one kind that has
#: any. An id, and the two fields picking it fills.
TEMPLATES: Tuple[Dict[str, Any], ...] = (
    {'id': 'fr_pea', 'kind': AGED_FLAT_REALISED,
     'values': {'threshold_years': 5, 'age_basis': FIRST_PAYMENT}},
    {'id': 'fr_assurance_vie', 'kind': AGED_FLAT_REALISED,
     'values': {'threshold_years': 8, 'age_basis': OPENING}},
)


def catalogue() -> Dict[str, Any]:
    """The kinds and the templates, on the wire.

    Served rather than duplicated in the front: the enumeration is code and has
    one home, and a second copy over there would drift the day a kind is added.
    What the front holds is the *words* — one message key per kind and per
    template, in both catalogues.
    """
    return {
        'kinds': [
            {'kind': kind,
             'parameters': [{'name': name, 'type': type_, 'required': required}
                            for name, type_, required in parameters]}
            for kind, parameters in PARAMETERS.items()
        ],
        'age_bases': list(AGE_BASES),
        'templates': [dict(template) for template in TEMPLATES],
    }


def validate(kind: Any, parameters: Any) -> Dict[str, Any]:
    """The parameters of ``kind``, checked and normalised — or ``ModelRejected``.

    Checked **when it is written**, which is the half a closed enumeration buys
    over a formula field: what comes back is what goes in the column,
    so a reader never meets a rate that is a string or a ladder out of order.
    """
    # **The type is checked before the lookup.** A JSON body may carry anything
    # where the kind goes, and `[] in PARAMETERS` is a `TypeError` rather than a
    # `False` — which would leave the route answering *an unexpected error* about
    # a value it was written to refuse.
    if not isinstance(kind, str) or kind not in PARAMETERS:
        raise ModelRejected(
            f"{kind!r} is not a taxation model kind; the kinds are "
            f"{', '.join(KINDS)}")
    if parameters is None:
        parameters = {}
    if not isinstance(parameters, dict):
        raise ModelRejected("the parameters of a taxation model are an object")

    declared = {name for name, _, _ in PARAMETERS[kind]}
    for name in parameters:
        if name not in declared:
            raise ModelRejected(
                f"{name!r} is not a parameter of {kind!r}")

    checked: Dict[str, Any] = {}
    for name, type_, required in PARAMETERS[kind]:
        value = parameters.get(name)
        if value is None or value == '':
            if required:
                raise ModelRejected(f"{kind!r} needs {name!r}")
            continue
        checked[name] = _CHECKS[type_](name, value)
    _refuse_more_than_everything(checked)
    return checked


def _refuse_more_than_everything(checked: Dict[str, Any]) -> None:
    """A gain cannot owe more than itself, and the levy adds to the rate.

    :func:`_rate` bounds each value to ``[0, 1]`` on its own and nothing bounds
    the sum, so ``rate 0,9`` beside ``social_rate 0,9`` is two ordinary-looking
    entries that project **180 %** of a gain and print it as a fact.
    """
    levy = checked.get('social_rate', 0.0)
    for name in ('rate', 'rate_before', 'rate_after'):
        rate = checked.get(name)
        if rate is not None and rate + levy > 1.0:
            raise ModelRejected(
                f"{name} and social_rate come to {(rate + levy) * 100:.1f}% "
                f"together, and a gain cannot owe more than itself")


def _rate(name: str, value: Any) -> float:
    """A rate is a **fraction**, never a percentage: ``0.128``, not ``12.8``."""
    number = _number(name, value)
    if not 0.0 <= number <= 1.0:
        raise ModelRejected(
            f"{name} is a rate between 0 and 1, and {number} is not one")
    return number


#: The longest threshold a wrapper may declare. No schedule surveyed goes past
#: thirty, and the bound is what keeps a typo out of date arithmetic: an
#: anniversary a hundred thousand years out overflows the calendar of every
#: reader downstream rather than producing a wrong answer.
MAX_THRESHOLD_YEARS = 200


def _years(name: str, value: Any) -> int:
    number = _number(name, value)
    if number < 0 or number != int(number):
        raise ModelRejected(
            f"{name} is a whole number of years, and {value!r} is not one")
    if number > MAX_THRESHOLD_YEARS:
        raise ModelRejected(
            f"{name} is at most {MAX_THRESHOLD_YEARS} years, and {value!r} is "
            f"not")
    return int(number)


def _age_basis(name: str, value: Any) -> str:
    if value not in AGE_BASES:
        raise ModelRejected(
            f"{name} is one of {', '.join(AGE_BASES)}, and {value!r} is not")
    return str(value)


def _brackets(name: str, value: Any) -> List[Dict[str, Any]]:
    """A ladder, bottom to top, whose **last rung has no ceiling**.

    The open top is what makes the ladder total: a set of bounded brackets says
    nothing about the gain above the highest of them, and a projection over it
    would have to invent a rate.
    """
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ModelRejected(f"{name} is a list of brackets")
    if not value:
        raise ModelRejected(f"{name} needs at least one bracket")

    ladder: List[Dict[str, Any]] = []
    previous: Optional[float] = None
    for index, rung in enumerate(value):
        if not isinstance(rung, dict):
            raise ModelRejected(f"a bracket of {name} is an object")
        last = index == len(value) - 1
        bound = rung.get('upper_bound')
        rate = _rate(f"{name}[{index}].rate", rung.get('rate'))
        if last:
            if bound not in (None, ''):
                raise ModelRejected(
                    f"the top bracket of {name} has no upper bound: it is what "
                    f"every gain above the one below it is taxed at")
            ladder.append({'upper_bound': None, 'rate': rate})
            continue
        if bound in (None, ''):
            raise ModelRejected(
                f"only the top bracket of {name} may have no upper bound")
        number = _number(f"{name}[{index}].upper_bound", bound)
        # **The first rung is checked too.** The climbing test below compares
        # against the rung before, so index 0 has nothing to be refused by — and
        # a ceiling at or below zero makes the slice under it negative, which
        # #919's walk turns into a *negative* tax on a real gain.
        if number <= 0:
            raise ModelRejected(
                f"the brackets of {name} climb from zero: {number} is not a "
                f"ceiling")
        if previous is not None and number <= previous:
            raise ModelRejected(
                f"the brackets of {name} climb: {number} does not come after "
                f"{previous}")
        previous = number
        ladder.append({'upper_bound': number, 'rate': rate})
    return ladder


def _number(name: str, value: Any) -> float:
    """A finite number, or a refusal — and ``Infinity`` is not one.

    Python's own JSON reader accepts ``Infinity`` and ``NaN``, which no other
    parser writes and no schedule contains. Left through, the first would reach
    ``int(inf)`` in :func:`_years` and surface as *an unexpected error*.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ModelRejected(f"{name} is a number, and {value!r} is not one")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ModelRejected(f"{name} is a number, and {value!r} is not one")
    if number != number or number in (float('inf'), float('-inf')):
        raise ModelRejected(f"{name} is a number, and {value!r} is not one")
    return number


_CHECKS = {
    RATE: _rate,
    YEARS: _years,
    AGE_BASIS: _age_basis,
    BRACKETS: _brackets,
}


__all__ = [
    'NONE', 'FLAT_REALISED', 'AGED_FLAT_REALISED', 'BRACKETED_REALISED',
    'WITHHOLDING_INCOME',
    'OPENING', 'FIRST_PAYMENT', 'AGE_BASES', 'MAX_THRESHOLD_YEARS',
    'KINDS', 'TEMPLATES',
    'ModelRejected', 'catalogue', 'validate',
]
