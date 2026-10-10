"""What a sale would raise, and what moving its proceeds into a PEA would meet
(#1108).

**Pure**: no store, no market, ``now`` (a UTC calendar day) injected. The caller
reads the store and hands plain data in, as :mod:`account_facts` does. The
analyst narrates these figures and never computes one: every number about a
sale comes from here.

The position after a sale follows from the single ``build_shares`` row, with no
ledger replay: under weighted average cost a sale removes ``qty × unit_cost``
from the basis and leaves ``unit_cost`` where it was.

The only tax arithmetic is :func:`taxation_projection.projected_tax`, applied to
**the lot** — never the change in the whole account's projected tax.
"""
import math
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from application import taxation
from application.taxation_projection import projected_tax, rate_changes_on

#: The French PEA's contribution ceiling, in the base currency.
PEA_CEILING = 150_000.0

#: The relative slack a quantity is compared with, so a float typed back from
#: the screen still sells the whole line.
_EPSILON = 1e-9

MESSAGES = {
    'pea_ceiling_exceeded':
        'This payment would take the PEA past its contribution ceiling.',
    'pea_ceiling_unknown':
        'Whether this payment fits under the PEA ceiling cannot be told.',
    'pea_eligibility_unknown':
        'Whether the target security is PEA-eligible is not checked.',
    'pea_withdrawal_before_threshold':
        'Withdrawing from this PEA before its fifth anniversary may close it.',
}

#: The ``fr_pea`` template's values, which are what makes an account a PEA.
_PEA_SHAPE = next(template['values'] for template in taxation.TEMPLATES
                  if template['id'] == 'fr_pea')

#: What an arbitrage leaves out, whatever the sale itself does.
ARBITRAGE_NOT_MODELLED = ('progressive_scale_option (#1106)', 'loss_offset',
                          'social_contributions_detail')


class SimulationRefused(Exception):
    """The sale asked for is not one this account can make."""


@dataclass(frozen=True)
class Line:
    """One ``build_shares`` row for ``(account, symbol)``."""
    symbol: str
    quantity: float
    cost_basis: float
    price: Optional[float]          # base currency; None = unvalued


@dataclass(frozen=True)
class Account:
    id: str
    kind: Optional[str]             # taxation kind, None = no model
    parameters: Mapping[str, Any]
    opened_on: Optional[date]
    first_payment: Optional[date]
    lines: Sequence[Line]           # every held line of the account
    net_contributed: Optional[float]


def simulate_sale(account: Account, symbol: str, qty: float, *,
                  now: date) -> Dict[str, Any]:
    """Sell ``qty`` of ``symbol`` out of ``account`` on ``now``, fees at 0."""
    # **The quantity crosses a trust boundary**: #1109 takes it from the model.
    # A NaN passes every comparison below and comes out as a NaN sale with no
    # tax, and a JSON ``true`` would sell one share.
    if not _finite(qty) or qty <= 0:
        raise SimulationRefused(f'cannot sell a quantity of {qty!r}')
    line = next((line for line in account.lines
                 if line.symbol == symbol and line.quantity > 0), None)
    if line is None:
        raise SimulationRefused(f'{symbol} is not held in {account.id}')
    if not _finite(line.price) or line.price <= 0:
        raise SimulationRefused(f'{symbol} has no price in {account.id}')
    held = line.quantity
    if qty > held * (1 + _EPSILON):
        raise SimulationRefused(
            f'cannot sell {qty} of {symbol}, {account.id} holds {held}')

    unit_cost = line.cost_basis / held
    if qty >= held * (1 - _EPSILON):
        qty = held
        after = {'quantity': 0, 'cost_basis': 0, 'unit_cost': None}
    else:
        after = {'quantity': held - qty,
                 'cost_basis': line.cost_basis - qty * unit_cost,
                 'unit_cost': unit_cost}

    proceeds = qty * line.price
    gain = qty * (line.price - unit_cost)
    tax_now, if_withdrawn, reason = _tax(account, gain, proceeds, now)

    not_modelled = ['social_contributions_detail']
    if gain < 0:
        not_modelled.append('loss_offset')
    if account.kind == taxation.BRACKETED_REALISED:
        not_modelled.append('annual_accumulation')

    return {
        'account': account.id, 'symbol': symbol, 'quantity': qty,
        'price': line.price, 'proceeds': proceeds, 'gain': gain,
        'tax_now': tax_now, 'if_withdrawn': if_withdrawn,
        'net_proceeds': None if tax_now is None else proceeds - tax_now,
        'position_after': after, 'reason': reason, 'fees': 0,
        'not_modelled': not_modelled,
    }


def _finite(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _tax(account: Account, gain: float, proceeds: float,
         now: date) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    """``(tax_now, if_withdrawn, reason)`` for the lot, by the account's kind."""
    kind = account.kind
    if kind is None:
        return None, None, 'no_model'
    if kind == taxation.NONE:
        return 0.0, None, 'no_tax_model'
    if kind == taxation.WITHHOLDING_INCOME:
        return None, None, 'not_projectable'
    if kind == taxation.AGED_FLAT_REALISED:
        # The money stays in the wrapper; what it would owe on the way out is
        # the plan's prorata, so the other lines' latent losses lower it.
        return 0.0, _if_withdrawn(account, proceeds, now), None
    return _project(account, gain, now), None, None


def _if_withdrawn(account: Account, proceeds: float,
                  now: date) -> Optional[float]:
    value = latent = 0.0
    for line in account.lines:
        if not line.quantity:
            continue        # a closed line is worth nothing, and that is known
        if not _finite(line.price):
            return None
        market_value = line.quantity * line.price
        value += market_value
        latent += market_value - line.cost_basis
    if value <= 0:
        return None
    return _project(account, proceeds * latent / value, now)


def _project(account: Account, base: float, now: date) -> Optional[float]:
    return projected_tax(kind=account.kind, parameters=account.parameters,
                         latent_gain=base, opened_on=account.opened_on,
                         first_payment=account.first_payment, now=now)


def is_pea(account: Account) -> bool:
    """The shape of the ``fr_pea`` template: declarations carry no wrapper
    type, so this is the only way to tell one. Read off the parameters as the
    record would accept them, so a ``"5"`` a hand edit left is a five."""
    if account.kind != taxation.AGED_FLAT_REALISED:
        return False
    try:
        parameters = taxation.validate(account.kind, account.parameters)
    except taxation.ModelRejected:
        return False
    return all(parameters.get(name) == value
               for name, value in _PEA_SHAPE.items())


def simulate_arbitrage(from_account: Account, symbol: str, qty: float,
                       to_account: Account, *, now: date) -> Dict[str, Any]:
    """Sell out of one account and pay the net proceeds into another."""
    if from_account.id == to_account.id:
        raise SimulationRefused('source and target are the same account')
    sale = simulate_sale(from_account, symbol, qty, now=now)
    payment = sale['net_proceeds']

    warnings: List[Dict[str, Any]] = []
    if is_pea(to_account):
        contributed = to_account.net_contributed
        if contributed is None or payment is None:
            warnings.append(_warning('pea_ceiling_unknown', payment=payment,
                                     ceiling=PEA_CEILING))
        elif contributed + payment > PEA_CEILING:
            warnings.append(_warning(
                'pea_ceiling_exceeded', net_contributed=contributed,
                payment=payment, ceiling=PEA_CEILING,
                excess=contributed + payment - PEA_CEILING))
        warnings.append(_warning('pea_eligibility_unknown'))
    if is_pea(from_account):
        day = rate_changes_on(
            kind=from_account.kind, parameters=from_account.parameters,
            opened_on=from_account.opened_on,
            first_payment=from_account.first_payment, now=now)
        if day is not None:
            warnings.append(_warning(
                'pea_withdrawal_before_threshold',
                threshold_day=day.isoformat(), days_left=(day - now).days))

    return {'sale': sale, 'payment': payment, 'warnings': warnings,
            'not_modelled': list(ARBITRAGE_NOT_MODELLED)}


def _warning(code: str, **figures: Any) -> Dict[str, Any]:
    return {'code': code, 'message': MESSAGES[code], 'figures': figures}


__all__ = ['Account', 'Line', 'PEA_CEILING', 'SimulationRefused', 'is_pea',
           'simulate_arbitrage', 'simulate_sale']
