"""The accounts list, assembled **once** for the two surfaces that serve it —
the browser's ``/api/accounts`` and the agent's ``list_accounts`` (#920).

It lived in the route, and the tool re-assembled it by hand: the same
declaration, the same join, the same :func:`portfolio_view.build_accounts` — and
then nothing. So every member #752, #918 and #948 hung on an account reached one
reader and not the other, until there were eight of them and the agent could say
less about a wrapper than the panel four paces away. Copying the eight across
would have bought one ticket's worth of agreement. The payload is built here
instead, and a ninth member is added in one place or it does not exist.

**The store and the snapshot arrive resolved**, because the two surfaces do not
fail the same way: the route raises, and the tool raises *in words* — an unread
store is a failure to read and not an empty portfolio. Neither sentence belongs
here.
"""
from datetime import date, datetime
from typing import Any, Dict, List, NotRequired, Optional, TypedDict

from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import instants
from application import ledger
from application import portfolio_view
from application import quotes
from application import simulation
from application import taxation
from application import taxation_projection
from application.store_reads import PortfolioReader

logger = getLogger(__name__)

#: The kinds with an assiette to read, which since the review of 2026-09-15 is
#: every kind that projects: the three read the same latent gain and differ only
#: in the rate they apply to it.
_NEEDS_POSITIONS = taxation_projection.PROJECTED_KINDS


class Account(TypedDict):
    # The id events carry. `default` is the bucket of the unassigned.
    id: str
    # What the owner called it. `NOT NULL` in the store, nullable because
    # `AccountSummary` publishes it so; the front folds it in `lib/accounts.ts`,
    # and reads its own catalogue on `default` while it still wears the seeded
    # name (#745).
    label: Optional[str]
    # The account's **newest** `account_metrics` row, ridden on this resource
    # rather than on a second one. Every member is nullable *by field* since
    # #708, and `as_of` — a **day**, never an instant — is `null` on an account
    # no cycle has written anything for.
    as_of: Optional[str]
    cash_balance: Optional[float]
    holdings_value: Optional[float]
    total_value: Optional[float]
    net_contributed: Optional[float]
    gain_absolu: Optional[float]
    # Money-weighted, annualised **since the origin**: it has no window to narrow.
    xirr: Optional[float]
    # Base 100 since the account's own first day, and never rendered as is: two
    # indices from two origins are not a comparison, so the front rebases the
    # series to the visible window.
    twr_index: Optional[float]
    # Not a column of `account_metrics`: derived from `event` bounded by this
    # row's own day, as `/api/portfolio-totals` derives the global one. `null`
    # where no day was written; zero is a **figure** (a free transfer).
    transfer_fees: Optional[float]
    # `account_facts.declared_only` drops each of these where there is none.
    # The taxation model this account carries (#752) — absent where none.
    taxation_model: NotRequired[str]
    # The day the wrapper was opened, **as its owner declared it** (#918). It
    # cannot be derived: a transferred PEA's ledger starts years late.
    opened_on: NotRequired[str]
    # The earliest declared `DEPOSIT`, derived on every read and stored nowhere:
    # the opening date the form pre-fills where none is declared.
    first_payment: NotRequired[str]
    # The day the index counts from. Absent is the only absence here.
    twr_since: NotRequired[str]
    # The `kind` of the carried model — the words, not the arithmetic (#919).
    taxation_kind: NotRequired[str]
    # What this account would owe if everything in it were sold today (#919),
    # **absent** wherever there is no figure: no model, a kind with no realised
    # gain, an aged wrapper with no date, an assiette one unvalued line makes
    # unknown. A projected zero and a zero nobody could compute differ.
    projected_tax: NotRequired[float]
    # The latent gain `projected_tax` was computed on — not the head's `Gain`,
    # which adds realised, dividends and fees.
    projected_base: NotRequired[float]
    # The rate or rates that produced `projected_tax`, as fractions: one per
    # flat family, one per rung of a ladder. Published so the front never
    # re-reads the rule.
    projected_rates: NotRequired[List[float]]
    # The day an aged rate changes, where the threshold is still ahead.
    projected_rate_changes_on: NotRequired[str]


class AccountsPayload(TypedDict):
    # **Mandatory in the client contract** (#745). `false` is the install that
    # declared nothing, and it is not an empty array: the seeded `default` row
    # is always there.
    declared: bool
    accounts: List[Account]


def accounts_payload(store, snapshot, now: datetime) -> AccountsPayload:
    """The **declared** accounts, each with its newest perf figures and facts."""
    accounts = snapshot.accounts
    roster = declaration(store, snapshot)

    reader = PortfolioReader(store)
    rows = reader.latest_account_metrics()
    through = {row['account']: row['day'] for row in rows}
    # **The model rides on the account, and only where there is one** (#752).
    # It is a *declaration*, so it is read off the store rather than off the
    # published snapshot — and an account carrying none gets no member at all
    # rather than a `null` the front would have to tell from *not yet read*
    # (#845).
    carried = accounts_module.taxation_models_by_account(store)
    opened_on = accounts_module.opening_dates_by_account(store)
    # **The pre-fill, served and never stored** (#918). It is the ledger's own
    # figure — the earliest declared payment — and the form offers it where the
    # account has declared no opening date. Derived here rather than written
    # anywhere: a declared fact and a derived one do not share a row.
    payments = ledger.first_payments(store)
    # **The projection is computed here, not in the browser** (#919): the rates
    # are a declaration the front never holds, and a figure this load-bearing is
    # not re-derived in two languages. The assiette for the kinds that read
    # one is folded off `build_shares`, so the tax rests on the valuation the
    # shares table already renders rather than on a second opinion of it.
    models = {model.id: model
              for model in accounts_module.read_models(store)}
    usable = _usable(models, carried, roster)
    latent = _latent_gains(reader, store, snapshot, now, roster, usable)
    twr_since = reader.twr_origin_by_account()
    return {
        'declared': accounts is not None,
        'accounts': [
            # `now.date()` is the UTC day, which is the narrowing #952 is
            # about and :mod:`taxation_projection` states the contract for.
            # It rides beside a `latent` read live off the same `now`, and the
            # two staying on one day is the reason it is not taken from the
            # perf cache's newest row instead.
            _with_account_facts(summary.to_dict(), carried, opened_on, payments,
                                usable, latent, twr_since, now.date())
            for summary in portfolio_view.build_accounts(
                roster, rows, reader.transfer_fees_by_account(through))
        ],
    }


def declaration(store, snapshot) -> list:
    """The declared accounts, or the seeded one where nothing was declared."""
    accounts = snapshot.accounts
    rows = (accounts.accounts if accounts is not None
            else accounts_module.seeded_only(store))
    return [accounts_module.as_declared(row) for row in rows]


def simulation_account(store, snapshot, now: datetime, account_id: str,
                       selling: str) -> simulation.Account:
    """The :class:`simulation.Account` of ``account_id`` (#1109).

    **The symbol being sold is priced at the market, every other line at its
    carried value** — the one ``list_accounts`` projects on, so a delisted line
    valued at its cost there does not leave the plan unmeasurable here. A sale
    is never made at a carried price: an unpriced ``selling`` stays unpriced,
    and is refused as such.

    Refuses an account nobody declared, and one carrying a model this version
    refuses: that account *has* a model, and simulating it as ``no_model``
    would say otherwise.
    """
    roster = declaration(store, snapshot)
    declared = sorted(account.id for account in roster)
    if account_id not in declared:
        raise simulation.SimulationRefused(
            f"no account {account_id!r}; the declared accounts are: "
            f"{', '.join(declared)}")

    carried = accounts_module.taxation_models_by_account(store)
    models = {model.id: model
              for model in accounts_module.read_models(store)}
    usable = _usable(models, carried, roster)
    if account_id in carried and account_id not in usable:
        raise simulation.SimulationRefused(
            f"account {account_id!r} carries a taxation model this version "
            f"refuses; repair it in the app before simulating")

    reader = PortfolioReader(store)
    opened_on = accounts_module.opening_dates_by_account(store)
    payments = ledger.first_payments(store)
    terminal = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    shares = portfolio_view.build_shares(reader.positions(), terminal)

    model = usable.get(account_id)
    return simulation.Account(
        id=account_id,
        kind=None if model is None else model.kind,
        parameters={} if model is None else model.parameters,
        opened_on=opened_on.get(account_id),
        first_payment=payments.get(account_id),
        lines=[simulation.Line(symbol=share.symbol,
                               quantity=holding.quantity or 0,
                               cost_basis=holding.cost_basis or 0,
                               price=_line_price(share, holding, selling))
               for share in shares for holding in share.accounts
               if holding.account == account_id])


def _line_price(share, holding, selling: str) -> Optional[float]:
    """The base-currency price a line enters the simulation at."""
    if share.symbol == selling or not holding.quantity:
        return share.price
    if holding.market_value is None:
        return None
    return holding.market_value / holding.quantity


def _usable(models: dict, carried: dict, declaration) -> Dict[str, Any]:
    """The declared models this version still accepts, by account id.

    **Checked early, which is the whole of it** — not checked fewer times.
    :mod:`taxation_projection` still validates what it reads at each of its own
    entry points, and should: it is reached from elsewhere. What moved is *when*
    the first check happens. The gate below read the declared model's **kind**
    alone, so an account carrying a model an earlier version wrote and this one
    refuses paid the whole `reader.positions()` read on every load of every page
    that lists the accounts, and `_projection` threw the result away at the end
    of it. The account slowest to answer was the one its owner had to open to
    repair the model.

    A refused row is logged here, once, and then simply is not in this map: the
    payload cannot tell *refused* from *never declared*, and does not need to —
    both publish no projection, and `taxation_model` rides on the declaration
    either way.
    """
    usable: Dict[str, Any] = {}
    for account in declaration:
        model = models.get(carried.get(account.id))
        if model is None:
            continue
        try:
            taxation.validate(model.kind, model.parameters)
        except taxation.ModelRejected as exc:
            logger.warning(
                f"account {account.id} carries taxation model {model.id} "
                f"({model.kind}), which this version refuses: {exc}. No "
                f"projection is published for it.")
            continue
        usable[account.id] = model
    return usable


def _latent_gains(reader, store, snapshot, now: datetime, declaration,
                  usable: dict) -> dict:
    """The per-account assiette — **read only where something reads it**.

    `reader.positions()` is the portfolio's hot read, and this payload is asked
    for by every page that needs the account list: the settings, the ledger and
    the ⌘K palette among them. Running it there to derive a figure no declared
    model consumes is the whole cost of the feature paid by readers who do not
    have it. Resolving the models first is one dictionary lookup per account,
    and it turns the read into something proportional to the feature being in
    use.
    """
    if not any(getattr(usable.get(account.id), 'kind', None)
               in _NEEDS_POSITIONS for account in declaration):
        return {}
    terminal = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    return portfolio_view.latent_gains_by_account(
        portfolio_view.build_shares(reader.positions(), terminal),
        [account.id for account in declaration])


def _with_account_facts(row: dict, carried: dict, opened_on: dict,
                        payments: dict, usable: dict, latent: dict,
                        twr_since: dict, today: date) -> dict:
    """The facts an account carries where there is one to carry: the three it
    was declared with, the day its index counts from, and the projection where
    there is a model to project it through."""
    return {**row, **declared_only({
        'taxation_model': carried.get(row['id']),
        'opened_on': instants.iso(opened_on.get(row['id'])),
        'first_payment': instants.iso(payments.get(row['id'])),
        # **The index says what day it is based at** (#887). `twr_index` is
        # anchored at 100 on the first day of whatever series was handed to
        # `_fill_twr`, and these series do not share one: an account opened
        # earlier has been indexing for longer than the aggregate, which starts
        # at the latest of its terms' horizons. So two of these figures compared
        # point to point answer a question nobody asked. The anchor rides with
        # the figure — the only way a reader can rebase them onto a window they
        # do share, and the reason the tool's description can now tell it to.
        'twr_since': instants.iso(twr_since.get(row['id'])),
        **_projection(row, opened_on, payments, usable, latent, today),
    })}


def _projection(row: dict, opened_on: dict, payments: dict, usable: dict,
                latent: dict, today: date) -> dict:
    """What this account would owe if it were emptied today, the kind that says
    how to read it, and the rates that produced it.

    **The words are the front's and the arithmetic is not.** The kind rides so
    the panel can tell a declared exemption from a measured zero without a second
    read of the model catalogue; the rates ride so no second implementation of
    *which side of the threshold* exists to drift from this one.

    The figure itself is absent in several cases and they reach the reader as
    one member's absence: a kind with no realised gain, an aged wrapper with no
    date to age it from, a threshold day that runs off the end of the calendar,
    and an assiette one unvalued line makes unknown. The list is open on
    purpose — the arithmetic decides, and the reader is told only that there is
    no figure.

    **A model the record would no longer accept publishes nothing at all**, not
    even its kind — and it is :func:`_usable` that decided so, before the
    positions were read. What arrives here is a model this version accepts, or
    nothing, and both produce no card. That matters on screen: an absent figure
    under a *present* card renders as the em dash of an unknown assiette, which
    tells the owner their positions are unvalued when what is actually wrong is
    the model. The log names the row so there is a trail; the model stays
    visible and repairable in the form, which reads it unchecked on purpose.
    """
    model = usable.get(row['id'])
    if model is None:
        return {}
    facts = dict(kind=model.kind, parameters=model.parameters,
                 opened_on=opened_on.get(row['id']),
                 first_payment=payments.get(row['id']), now=today)
    tax = taxation_projection.projected_tax(
        latent_gain=latent.get(row['id']), **facts)
    changes_on = taxation_projection.rate_changes_on(**facts)
    return {
        'taxation_kind': model.kind,
        'projected_tax': tax,
        # **The base rides with the figure**, and only where there is a figure.
        # The panel states a `Gain` of its own four paces up — latent *plus*
        # realised, dividends and fees — and the projection reads the latent
        # term alone. Two figures called a gain, one screen, and applying the
        # rate this card names to the gain the head names misses by a factor of
        # three on a real account. Published rather than re-derived from
        # `projected_tax / rate`, which is not the base on a ladder and is a
        # division by zero on a mature wrapper.
        'projected_base': None if tax is None else latent.get(row['id']),
        'projected_rates': taxation_projection.applied_rates(**facts),
        'projected_rate_changes_on': instants.iso(changes_on),
    }


def declared_only(facts: dict) -> dict:
    """The facts there are — **an absence reaches the reader as one** (#845), never as a `null` it would have to tell from *not yet read*."""
    return {name: value for name, value in facts.items() if value is not None}


__all__ = ['accounts_payload', 'declaration', 'declared_only', 'simulation_account']
