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
from typing import Any, Dict

from logfmt_logger import getLogger

from application import accounts as accounts_module
from application import instants
from application import ledger
from application import portfolio_view
from application import quotes
from application import taxation
from application import taxation_projection
from application.store_reads import PortfolioReader

logger = getLogger(__name__)

#: The kinds with an assiette to read, which since the review of 2026-09-15 is
#: every kind that projects: the three read the same latent gain and differ only
#: in the rate they apply to it.
_NEEDS_POSITIONS = taxation_projection.PROJECTED_KINDS


def accounts_payload(store, snapshot, now: datetime) -> Dict[str, Any]:
    """The **declared** accounts, each with its newest perf figures and facts."""
    accounts = snapshot.accounts
    declaration = (
        accounts.accounts if accounts is not None
        else [row for row in accounts_module.read_accounts(store)
              if row.id == accounts_module.DEFAULT_ACCOUNT])
    declaration = [accounts_module.as_declared(row) for row in declaration]

    reader = PortfolioReader(store)
    rows = reader.latest_account_metrics()
    through = {
        row['account']: row['day'] for row in rows
        if row.get('account') is not None and row.get('day') is not None
    }
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
    # not re-derived in two languages. The assiette for the two kinds that read
    # one is folded off `build_shares`, so the tax rests on the valuation the
    # shares table already renders rather than on a second opinion of it.
    models = {model.id: model
              for model in accounts_module.read_models(store)}
    latent = _latent_gains(reader, store, snapshot, now, declaration, carried,
                           models)
    twr_since = reader.twr_origin_by_account()
    return {
        'declared': accounts is not None,
        'accounts': [
            _with_account_facts(summary.to_dict(), carried, opened_on, payments,
                                models, latent, twr_since, now.date())
            for summary in portfolio_view.build_accounts(
                declaration, rows, reader.transfer_fees_by_account(through))
        ],
    }


def _latent_gains(reader, store, snapshot, now: datetime, declaration,
                  carried: dict, models: dict) -> dict:
    """The per-account assiette — **read only where something reads it**.

    `reader.positions()` is the portfolio's hot read, and this payload is asked
    for by every page that needs the account list: the settings, the ledger and
    the ⌘K palette among them. Running it there to derive a figure no declared
    model consumes is the whole cost of the feature paid by readers who do not
    have it. Resolving the models first is one dictionary lookup per account,
    and it turns the read into something proportional to the feature being in
    use.
    """
    wanted = False
    for account in declaration:
        model = models.get(carried.get(account.id))
        if model is not None and model.kind in _NEEDS_POSITIONS:
            wanted = True
            break
    if not wanted:
        return {}
    terminal = quotes.terminal_symbols(store, snapshot.backfill_windows(), now)
    return portfolio_view.latent_gains_by_account(
        portfolio_view.build_shares(reader.positions(), terminal),
        [account.id for account in declaration])


def _with_account_facts(row: dict, carried: dict, opened_on: dict,
                        payments: dict, models: dict, latent: dict,
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
        **_projection(row, carried, opened_on, payments, models, latent, today),
    })}


def _projection(row: dict, carried: dict, opened_on: dict, payments: dict,
                models: dict, latent: dict, today: date) -> dict:
    """What this account would owe if it were emptied today, the kind that says
    how to read it, and the rates that produced it.

    **The words are the front's and the arithmetic is not.** The kind rides so
    the panel can tell a declared exemption from a measured zero without a second
    read of the model catalogue; the rates ride so no second implementation of
    *which side of the threshold* exists to drift from this one.

    The figure itself is absent in four cases and they reach the reader as one
    member's absence: a kind with no realised gain, an aged wrapper with no date
    to age it from, an assiette one unvalued line makes unknown, and a model
    whose kind needs the positions read this request did not take.

    **A model the record would no longer accept publishes nothing at all**, not
    even its kind. The arithmetic already refuses it (`taxation_projection`
    checks what it reads, the store holding whatever an earlier version wrote),
    so the figure would be absent either way — but an absent figure under a
    present card renders as *the em dash of an unknown assiette*, which tells the
    owner their positions are unvalued when what is actually wrong is the model.
    No card, and the log names the row so there is a trail; the model stays
    visible and repairable in the form, which reads it unchecked on purpose.
    """
    model = models.get(carried.get(row['id']))
    if model is None:
        return {}
    try:
        taxation.validate(model.kind, model.parameters)
    except taxation.ModelRejected as exc:
        logger.warning(
            f"account {row['id']} carries taxation model {model.id} "
            f"({model.kind}), which this version refuses: {exc}. No projection "
            f"is published for it.")
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


__all__ = ['accounts_payload', 'declared_only']
