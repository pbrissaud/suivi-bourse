"""Everything runs against a **real store** — the suite's one rule — and the
assertions go on the rows and on what the module answers. That matters
particularly here, because the whole feature is a claim about *what is stored
and what is not*: an advisory has no row, the acknowledgement has one, and the
row carries an expiry the acknowledgement next door deliberately does not.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import pytest

from application import accounts
from application import advisories
from application import entries
from application import quotes
from application import settings
from application import taxation
from application import store as store_module
from application.events.schemas import Event, EventType


NOW = datetime(2026, 8, 26, 8, 10, tzinfo=timezone.utc)


def _account(opened, identifier: str, label: str, *, model: bool = True) -> None:
    """A **fully declared** account by default — taxation model included.

    The default is `True` because every observer but one is about something
    else, and an account carrying no model raises `no_taxation_model` on its
    own (#919): without this, half this file would be asserting on an advisory
    it is not about. The tests that *are* about it pass `model=False`.
    """
    opened.execute(
        'INSERT INTO account (id, label) VALUES (?, ?) '
        'ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label',
        [identifier, label])
    if model:
        accounts.set_taxation_model(opened, identifier, _flat_model(opened).id)


def _flat_model(opened):
    """The one flat model this file declares, written **through its writer**.

    :mod:`application.accounts` is where a model is born, and it checks the kind
    on the way in; a raw ``INSERT`` here would seed a row the application would
    refuse and quietly stop exercising that check. Reused rather than re-created
    because a model belongs to no account and this file only ever needs one.
    """
    for existing in accounts.read_models(opened):
        return existing
    return accounts.create_model(opened, 'Flat', taxation.FLAT_REALISED,
                                 {'rate': 0.3})


def _metrics(opened, account: str, day: date, cash: float,
             total: Optional[float]) -> None:
    """One day of an account's perf series — the row the panel reads its share
    off, and the very row ``/api/accounts`` publishes its figures from.

    ``total=None`` writes the row a cycle leaves when it has a cash balance and
    no valuation: a ``NULL`` worth, which is not a worth of zero.
    """
    opened.execute(
        'INSERT INTO account_metrics (account, day, cash_balance, '
        '                             holdings_value, total_value) '
        'VALUES (?, ?, ?, ?, ?)',
        [account, day, cash, None if total is None else total - cash, total])


def _keys(found):
    return [one.key for one in found]


# --------------------------------------------------------------------------- #
# The table: one of sixteen, and it carries the expiry
# --------------------------------------------------------------------------- #

def test_the_product_declares_sixteen_tables_and_one_of_them_is_the_ack():
    """The acknowledgement is a **table** and not a column on
    ``installation_fact``: a declared fact is its own thing, with its own
    writer, its own absence and its own lifetime.

    **Sixteen since #760**, and the count is a number this suite states
    deliberately rather than a constant nobody may change: #752 added
    ``taxation_model`` and ``account_fact``, #926 added ``schema_step``, #760
    added ``symbol_split``, and each said by how much in its own acceptance
    criteria.

    It is still a table, because the reason was never that a column was
    impossible — it was that a declared fact has its own writer, its own
    absence and its own lifetime.
    """
    assert len(store_module.TABLES) == 16
    assert 'advisory_ack' in store_module.TABLES


def test_the_ack_row_carries_an_expiry_and_the_fact_row_does_not(store):
    """The one structural difference between the two acknowledgements.

    An installation fact is acknowledged **for good**, on purpose; an advisory
    is put to sleep for a window, so the row has to say when it wakes.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'advisory_ack'")}
    assert columns == {'key', 'acknowledged_at', 'expires_at'}

    facts = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'installation_fact'")}
    assert 'expires_at' not in facts


# --------------------------------------------------------------------------- #
# The cash share: what raises one, and what does not
# --------------------------------------------------------------------------- #

def test_an_account_sitting_on_cash_raises_one_named_after_it(store):
    _account(store, 'cto', 'CTO Trade Republic')
    _metrics(store, 'cto', date(2026, 8, 26), cash=1430.56, total=5766.22)

    found = advisories.listing(store, NOW)

    assert _keys(found) == ['cash_share:cto']
    one = found[0]
    assert one.kind == advisories.CASH_SHARE
    # The subject is the panel's heading and the server decides it: a front
    # inventing one for a key it does not know would be a second authority.
    assert one.subject == advisories.SUBJECT_ACCOUNTS
    assert one.detail['account'] == 'cto'
    assert one.detail['label'] == 'CTO Trade Republic'
    assert one.detail['share'] == pytest.approx(0.2481, abs=1e-4)
    assert one.message == (
        'CTO Trade Republic holds 24.8% of its value in uninvested cash. '
        'Nothing is wrong with that if it is deliberate.')
    # No `first_seen_at`: an advisory is derived on every read and stored
    # nowhere, so *noticed on* is *read on* and nothing older is claimed.
    assert one.observed_at == NOW


def test_an_account_whose_cash_is_a_rounding_raises_nothing(store):
    _account(store, 'pea', 'PEA')
    _metrics(store, 'pea', date(2026, 8, 26), cash=400.0, total=15720.10)

    assert advisories.listing(store, NOW) == []


def test_an_account_with_no_figures_at_all_raises_nothing(store):
    """A share of nothing is not a small share; it is no figure.

    An install whose perf cycle has never run has a row for no account, and a
    total at zero is the same absence one step along.
    """
    _account(store, 'pea', 'PEA')
    assert advisories.listing(store, NOW) == []

    _metrics(store, 'pea', date(2026, 8, 26), cash=0.0, total=0.0)
    assert advisories.listing(store, NOW) == []


def test_it_reads_the_newest_day_and_not_the_series(store):
    """The chip on the rail and the card in the panel read one row.

    ``/api/accounts`` publishes the newest point of every account; an advisory
    computed off an older one would comment on a figure nothing on screen shows.
    """
    _account(store, 'cto', 'CTO')
    _metrics(store, 'cto', date(2026, 8, 1), cash=1400.0, total=5000.0)
    _metrics(store, 'cto', date(2026, 8, 26), cash=10.0, total=5000.0)

    assert advisories.listing(store, NOW) == []


# --------------------------------------------------------------------------- #
# The reconstruction withholds them (the horizon's pocket)
# --------------------------------------------------------------------------- #

def _pocket(store):
    """The series a rebuild can leave behind, and it is not a portfolio.

    ``account_horizon`` blocks every day a held symbol has no price for and
    walks the right edge left past those blocks, so an account holding a line
    quoted nowhere *yet* can be left publishing a run of days from **before its
    first purchase** — days on which it really did hold nothing but cash. The
    newest row of that run is what the observation reads.
    """
    _account(store, 'pea', 'PEA LCL')
    _metrics(store, 'pea', date(2019, 11, 20), cash=1030.0, total=1030.0)


def test_a_reconstruction_withholds_what_it_would_say_about_an_account(store):
    """*100 % of its value in cash*, about a day seven years old.

    The figure is arithmetically right and the sentence is a falsehood: it
    reads a series that is not about now, and it tells the owner their account
    holds no securities while the shares page shows them the securities.
    """
    _pocket(store)

    assert _keys(advisories.listing(store, NOW)) == ['cash_share:pea']
    assert advisories.listing(store, NOW, rebuilding=True) == []
    # The chip beside the figure reads the wider answer, and it is withheld from
    # that one too: two readings of one set cannot disagree about what exists.
    assert advisories.standing(store, NOW, rebuilding=True) == []


def test_the_reconstruction_withholds_nothing_of_the_other_subjects(store):
    """A subject, and only that subject.

    Health, installation and portfolio say nothing that divides one day of a
    series by another, so nothing about them is waiting on a backfill. The rule
    is written on ``subject`` rather than on ``cash_share`` so the next account
    observation inherits it — which is also what this asserts, on the only
    surface that can: every family withheld is an accounts family.
    """
    _pocket(store)

    withheld = {one.key for one in advisories.standing(store, NOW)} - {
        one.key for one in advisories.standing(store, NOW, rebuilding=True)}
    subjects = {one.subject for one in advisories.standing(store, NOW)
                if one.key in withheld}

    assert subjects == {advisories.SUBJECT_ACCOUNTS}


def test_what_cannot_be_listed_cannot_be_put_to_sleep(store):
    """The gesture follows the listing, and it has to.

    Acknowledging binds for thirty days. An advisory the rebuild is withholding
    is one the reader was never shown and one the rebuild is about to withdraw
    on its own, so a gesture that reached it would silence, for a month, a
    condition nobody observed — which is the very thing :func:`acknowledge`
    refuses on a figure back under its threshold.
    """
    _pocket(store)

    with pytest.raises(advisories.UnknownAdvisory):
        advisories.acknowledge(store, 'cash_share:pea', NOW, rebuilding=True)

    assert store.query('SELECT count(*) FROM advisory_ack') == [(0,)]


# --------------------------------------------------------------------------- #
# The acknowledgement: thirty days, and never for good
# --------------------------------------------------------------------------- #

def _sleeping_account(store):
    _account(store, 'cto', 'CTO Trade Republic')
    _metrics(store, 'cto', date(2026, 8, 26), cash=1430.56, total=5766.22)


def test_acknowledging_puts_it_to_sleep_for_thirty_days(store):
    _sleeping_account(store)

    advisory, acknowledged = advisories.acknowledge(
        store, 'cash_share:cto', NOW)

    assert advisory.key == 'cash_share:cto'
    assert acknowledged.expires_at == NOW + timedelta(days=30)
    assert advisories.ACK_WINDOW == timedelta(days=30)
    # Gone from the listing, exactly as an acknowledged installation fact is.
    assert advisories.listing(store, NOW) == []
    assert advisories.listing(store, NOW + timedelta(days=29)) == []


def test_the_expiry_brings_it_back_with_nobody_observing_anything(store):
    """0036 refused an acknowledgement because *"an acknowledgement that outlived
    its condition would silence the app the second time the cash piled up"*.
    Bounded, it cannot: nothing has to notice the condition going false,
    because the expiry needs no observer.
    """
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    back = advisories.listing(store, NOW + timedelta(days=31))

    assert _keys(back) == ['cash_share:cto']


def test_the_condition_is_still_the_condition_while_it_sleeps(store):
    """Asleep is not ended: ``standing`` goes on raising it.

    The panel is the inventory and the chip beside the figure is the reading,
    and only the first of the two is silenced by a gesture made in it.
    """
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    assert _keys(advisories.standing(store, NOW)) == ['cash_share:cto']


def test_acknowledging_again_re_dates_the_window(store):
    """The opposite of the installation fact's rule, and it follows from what
    the two gestures mean: *seen, for good* is asserted once, *not now* is asked
    again each time it is asked."""
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    later = NOW + timedelta(days=10)
    _, again = advisories.acknowledge(store, 'cash_share:cto', later)

    assert again.expires_at == later + timedelta(days=30)
    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 1


def test_acknowledging_what_does_not_stand_is_refused_and_writes_nothing(store):
    _sleeping_account(store)

    with pytest.raises(advisories.UnknownAdvisory):
        advisories.acknowledge(store, 'cash_share:nobody', NOW)
    with pytest.raises(advisories.UnknownAdvisory):
        advisories.acknowledge(store, 'not_a_family:cto', NOW)

    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 0


def test_an_expired_row_is_swept_by_the_gesture_and_never_by_a_read(store):
    """A ``GET`` that wrote would date the store with the moment somebody opened
    a page — the rule the listing one table over keeps too."""
    _sleeping_account(store)
    _account(store, 'pea', 'PEA')
    _metrics(store, 'pea', date(2026, 8, 26), cash=900.0, total=1000.0)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    late = NOW + timedelta(days=40)
    advisories.listing(store, late)
    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 1

    advisories.acknowledge(store, 'cash_share:pea', late)
    rows = {row[0] for row in store.query('SELECT key FROM advisory_ack')}
    assert rows == {'cash_share:pea'}


# --------------------------------------------------------------------------- #
# The opening date contradicted by the ledger (#918)
# --------------------------------------------------------------------------- #

def _payment(opened, account: str, day: date, key: int = 0) -> None:
    """One declared payment — a ``DEPOSIT``, which is what opens a wrapper."""
    opened.execute(
        'INSERT INTO event (id, date, event_type, account, amount) '
        'VALUES (?, CAST(? AS DATE), ?, ?, 1000)',
        [key, day.isoformat(), 'DEPOSIT', account])


def test_a_wrapper_that_received_money_before_it_existed_raises_one(store):
    """The contradiction, stated — and **not** arbitrated.

    One of the two dates is wrong and the app cannot say which: a transfer
    carries a real opening date no event of this ledger knows, and a typed year
    is a typed year. So both are in the detail, and the sentence says they
    disagree.
    """
    _account(store, 'pea', 'PEA Bourso')
    _payment(store, 'pea', date(2019, 3, 4))
    accounts.set_opened_on(store, 'pea', date(2021, 1, 1))

    found = advisories.listing(store, NOW)

    assert _keys(found) == ['opened_after_first_payment:pea']
    one = found[0]
    assert one.kind == advisories.OPENED_AFTER_FIRST_PAYMENT
    assert one.subject == advisories.SUBJECT_ACCOUNTS
    assert one.detail == {
        'account': 'pea',
        'label': 'PEA Bourso',
        'opened_on': '2021-01-01',
        'first_payment': '2019-03-04',
    }
    assert one.message == (
        'PEA Bourso is declared as opened on 2021-01-01, and it received a '
        'payment on 2019-03-04. One of the two is wrong.')
    assert one.observed_at == NOW


def test_a_date_earlier_than_the_first_payment_raises_nothing(store):
    """It is exactly what a transferred wrapper looks like — the case the
    declared date exists for, and the reason it cannot be derived."""
    _account(store, 'pea', 'PEA')
    _payment(store, 'pea', date(2022, 1, 10))
    accounts.set_opened_on(store, 'pea', date(2015, 6, 1))

    assert advisories.listing(store, NOW) == []


def test_the_same_day_raises_nothing(store):
    """A wrapper funded the day it was opened is the ordinary case."""
    _account(store, 'pea', 'PEA')
    _payment(store, 'pea', date(2022, 1, 10))
    accounts.set_opened_on(store, 'pea', date(2022, 1, 10))

    assert advisories.listing(store, NOW) == []


def test_neither_half_alone_raises_anything(store):
    """A declared date with no payment says nothing, and a payment with no
    declared date has nothing to contradict."""
    _account(store, 'pea', 'PEA')
    accounts.set_opened_on(store, 'pea', date(2021, 1, 1))
    assert advisories.listing(store, NOW) == []

    _account(store, 'cto', 'CTO')
    _payment(store, 'cto', date(2019, 3, 4), key=1)
    assert advisories.listing(store, NOW) == []


def test_it_is_acknowledgeable_like_any_other(store):
    _account(store, 'pea', 'PEA')
    _payment(store, 'pea', date(2019, 3, 4))
    accounts.set_opened_on(store, 'pea', date(2021, 1, 1))

    advisories.acknowledge(store, 'opened_after_first_payment:pea', NOW)

    assert advisories.listing(store, NOW) == []
    # Still true, and still said where the figure is: the acknowledgement is a
    # *not now*, never an observation that the condition went false.
    assert _keys(advisories.standing(store, NOW)) == [
        'opened_after_first_payment:pea']


# --------------------------------------------------------------------------- #
# The opening date that has not happened yet (#969)
# --------------------------------------------------------------------------- #

def test_a_wrapper_opened_on_a_day_to_come_raises_one(store):
    """Kept and contradicted, never refused: the declaration stands in the store
    and the app says out loud that it disagrees."""
    _account(store, 'pea', 'PEA Bourso')
    accounts.set_opened_on(store, 'pea', date(2099, 1, 1))

    found = advisories.listing(store, NOW)

    assert _keys(found) == ['opened_in_the_future:pea']
    one = found[0]
    assert one.kind == advisories.OPENED_IN_THE_FUTURE
    assert one.subject == advisories.SUBJECT_ACCOUNTS
    assert one.detail == {
        'account': 'pea',
        'label': 'PEA Bourso',
        'opened_on': '2099-01-01',
    }
    assert one.message == (
        'PEA Bourso is declared as opened on 2099-01-01, a day that has not '
        'happened yet, so nothing counted from it can be right.')
    assert one.observed_at == NOW
    # And the row is still there, unarbitrated.
    assert accounts.opening_dates_by_account(store)['pea'] == date(2099, 1, 1)


def test_today_raises_nothing(store):
    """An account opened this morning is an account opened this morning."""
    _account(store, 'pea', 'PEA')
    accounts.set_opened_on(store, 'pea', NOW.date())

    assert advisories.listing(store, NOW) == []


def test_a_day_to_come_says_so_rather_than_blaming_the_ledger(store):
    """**One sentence, the true one.** A 2099 opening over a 2019 payment is
    also *later than the first payment*, but that advisory says the app cannot
    tell which of the two is wrong — and here it can."""
    _account(store, 'pea', 'PEA')
    _payment(store, 'pea', date(2019, 3, 4))
    accounts.set_opened_on(store, 'pea', date(2099, 1, 1))

    assert _keys(advisories.listing(store, NOW)) == ['opened_in_the_future:pea']


def test_it_is_acknowledgeable_like_any_other_too(store):
    _account(store, 'pea', 'PEA')
    accounts.set_opened_on(store, 'pea', date(2099, 1, 1))

    advisories.acknowledge(store, 'opened_in_the_future:pea', NOW)

    assert advisories.listing(store, NOW) == []
    assert _keys(advisories.standing(store, NOW)) == ['opened_in_the_future:pea']


# --------------------------------------------------------------------------- #
# The account nothing can be projected for (#919)
# --------------------------------------------------------------------------- #

def test_an_account_with_money_and_no_model_says_why_its_panel_is_silent(store):
    """**The sentence #919's silence rests on.**

    A panel showing no projection because no model was declared looks exactly
    like a panel whose projection is nothing, and the account's own surface is
    the wrong place to say so: it would be an empty block explaining its own
    emptiness, on every account, for ever.
    """
    _account(store, 'cto', 'CTO Trade Republic', model=False)
    _metrics(store, 'cto', date(2026, 8, 26), cash=0.0, total=5766.22)

    (one,) = [found for found in advisories.listing(store, NOW)
              if found.kind == advisories.NO_TAXATION_MODEL]

    assert one.key == 'no_taxation_model:cto'
    assert one.subject == advisories.SUBJECT_ACCOUNTS
    assert one.detail['account'] == 'cto'
    assert one.message == (
        'CTO Trade Republic carries no taxation model, so the app cannot say '
        'what you would owe on it. Declare one and it will.')


def test_an_account_carrying_a_model_raises_nothing(store):
    _account(store, 'cto', 'CTO Trade Republic')
    _metrics(store, 'cto', date(2026, 8, 26), cash=0.0, total=5766.22)

    assert [one for one in advisories.listing(store, NOW)
            if one.kind == advisories.NO_TAXATION_MODEL] == []


def test_an_empty_account_is_not_missing_a_declaration(store):
    """An account with no value is not undeclared; it is empty. Asking its owner
    to describe the taxation of nothing is noise, and the seeded row on a fresh
    install is exactly that case."""
    _account(store, 'default', 'Default', model=False)
    _metrics(store, 'default', date(2026, 8, 26), cash=0.0, total=0.0)

    assert [one for one in advisories.listing(store, NOW)
            if one.kind == advisories.NO_TAXATION_MODEL] == []


def test_an_account_whose_worth_is_unwritten_raises_nothing(store):
    """A ``total_value`` of ``NULL`` is **not** a total of zero, and neither of
    them is *an account worth taxing*. A cycle that wrote a cash balance and no
    valuation leaves exactly this row, and reading it as *money with no model*
    would raise the advisory off a figure the app does not have.
    """
    _account(store, 'cto', 'CTO Trade Republic', model=False)
    _metrics(store, 'cto', date(2026, 8, 26), cash=120.0, total=None)

    assert [one for one in advisories.listing(store, NOW)
            if one.kind == advisories.NO_TAXATION_MODEL] == []


def test_an_account_no_cycle_has_written_raises_nothing_either(store):
    """No `account_metrics` row is no claim about the account's worth, and an
    advisory on a silence would fire on every account of a fresh install."""
    _account(store, 'cto', 'CTO Trade Republic', model=False)

    assert [one for one in advisories.listing(store, NOW)
            if one.kind == advisories.NO_TAXATION_MODEL] == []


# --------------------------------------------------------------------------- #
# The reference ticker the market answered nothing for (#982)
# --------------------------------------------------------------------------- #

BENCHMARK = 'CW8.PA'


#: The ledger's first day, which is where a reference nobody bought is walked
#: from — ``tracked_windows``' own expression, and the date the anchor has to
#: reach before the advisory will say anything.
LEDGER_ORIGIN = date(2020, 3, 2)


def _tracked(opened, symbol: str = BENCHMARK) -> None:
    """A reference **named on the dial**, with the row the backfill gives it.

    Three halves, all through the app's own writers: :func:`settings.save` is
    the one road to a dial, ``declare_symbol`` is what the backfill calls for a
    symbol no event will ever declare, and the deposit is the ledger's first
    day — without one there is no window to walk and nothing is tracked at all.
    A ``symbol_quote`` row references the symbol row, so an advisory read
    against a hand-inserted ledger would be read against a shape the product
    cannot produce.
    """
    settings.save(opened, {'benchmark_symbol': symbol})
    entries.declare_symbol(opened, symbol)
    _account(opened, 'main', 'Main')
    entries.create(opened, Event(LEDGER_ORIGIN, EventType.DEPOSIT,
                                 account='main', amount=1000.0))


def _flat_advisories(opened):
    return [one for one in advisories.listing(opened, NOW)
            if one.kind == advisories.BENCHMARK_NEVER_PRICED]


def test_a_reference_the_market_returned_nothing_for_says_so(store):
    """**The one symbol nobody would notice was broken.**

    A mistyped held line is caught by its own position going unvalued; a
    mistyped reference is held by no one, so nothing goes missing and nothing
    comes out wrong — the comparison is simply absent, which is exactly what an
    installation that never named a reference looks like. This sentence is the
    only place the app says the difference out loud.
    """
    _tracked(store)
    quotes.record_window_tried(store, BENCHMARK, LEDGER_ORIGIN)

    assert _keys(advisories.listing(store, NOW)) == [
        f'benchmark_never_priced:{BENCHMARK}']
    one = advisories.listing(store, NOW)[0]
    assert one.kind == advisories.BENCHMARK_NEVER_PRICED
    assert one.subject == advisories.SUBJECT_HEALTH
    assert one.detail == {'symbol': BENCHMARK}
    assert one.message == (
        f'{BENCHMARK} is named as the comparison reference, but the market '
        'returned no price for it. Check the ticker.')
    assert one.observed_at == NOW


def test_a_reference_no_window_has_come_back_for_yet_is_not_accused(store):
    """**The state of a perfectly good ticker on its first network outage.**

    ``oldest_window_tried`` is written only once a window has come back, so its
    absence beside an empty series says nothing about the ticker: it says the
    backfill has not reached the market yet. A trigger reading *no point after
    a cycle* would tell an owner whose connection dropped that their reference
    is mistyped, and be believed.

    Both shapes of that silence are here — no quote row at all, and a quote row
    whose backward anchor is still ``NULL`` because only the forward pass has
    come back — because the second is the one an anchor-blind query would raise
    on.
    """
    _tracked(store)

    assert _flat_advisories(store) == []

    quotes.record_forward_window_tried(store, BENCHMARK, date(2026, 8, 25))

    assert quotes.oldest_window_tried(store, BENCHMARK) is None
    assert _flat_advisories(store) == []


def test_a_reference_still_being_walked_backwards_is_not_accused(store):
    """**The anchor moves on an empty chunk too, so its presence proves nothing.**

    ``backfill.backward`` records the window it tried as soon as the fetch came
    back, empty or not, and then walks one chunk further next cycle. A ticker
    that stopped trading two years ago therefore answers its first chunks with
    nothing while its real history is still several cycles away — and an
    anchor-blind query would call it mistyped, every cycle, until the prices
    land and prove it was not.

    So the anchor has to have **arrived**: not merely set, but down to the
    first day of the window being walked.
    """
    _tracked(store)

    quotes.record_window_tried(store, BENCHMARK,
                               LEDGER_ORIGIN + timedelta(days=365))
    assert _flat_advisories(store) == []

    quotes.record_window_tried(store, BENCHMARK,
                               LEDGER_ORIGIN + timedelta(days=1))
    assert _flat_advisories(store) == []

    quotes.record_window_tried(store, BENCHMARK, LEDGER_ORIGIN)
    assert [one.kind for one in _flat_advisories(store)] == [
        advisories.BENCHMARK_NEVER_PRICED]


def test_an_empty_ledger_tracks_no_reference_and_accuses_none(store):
    """No first day means no window, and no window means nothing was asked for.

    The same silence ``ConfigSnapshot.tracked_windows`` keeps on an empty
    ledger, reached here by the ``COALESCE`` falling to ``NULL``.
    """
    settings.save(store, {'benchmark_symbol': BENCHMARK})
    entries.declare_symbol(store, BENCHMARK)
    quotes.record_window_tried(store, BENCHMARK, date(2020, 1, 1))

    assert _flat_advisories(store) == []


def test_a_symbol_no_dial_names_raises_nothing(store):
    """The advisory is about *the reference*, never about any empty series.

    A held line with no prices is the backfill's business and the banner's;
    raising this one on it would put a sentence about a mistyped benchmark
    under a symbol the ledger declares.
    """
    entries.declare_symbol(store, BENCHMARK)
    quotes.record_window_tried(store, BENCHMARK, LEDGER_ORIGIN)

    assert _flat_advisories(store) == []


def test_a_reference_whose_series_filled_raises_nothing(store):
    """The ordinary case: the market answered, and there is a comparison to
    draw. One point is enough — the claim is *never priced*, not *priced
    thinly*, and a short series is the backfill's own business."""
    _tracked(store)
    quotes.record_window_tried(store, BENCHMARK, date(2024, 1, 1))
    quotes.record_quote(store, BENCHMARK,
                        datetime(2024, 1, 2, 17, 0, tzinfo=timezone.utc),
                        500.0, {}, 500.0, 1.0)

    assert _flat_advisories(store) == []


def test_it_is_acknowledgeable_like_any_other_as_well(store):
    """A reference the owner knows is dead — a ticker Yahoo will never serve —
    is a standing truth they have already read, and the sentence goes to sleep
    like every other rather than sitting on the page for ever."""
    _tracked(store)
    quotes.record_window_tried(store, BENCHMARK, LEDGER_ORIGIN)

    advisories.acknowledge(store, f'benchmark_never_priced:{BENCHMARK}', NOW)

    assert _flat_advisories(store) == []
    assert _keys(advisories.standing(store, NOW)) == [
        f'benchmark_never_priced:{BENCHMARK}']
