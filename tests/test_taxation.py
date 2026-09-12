"""A taxation model is a closed ``kind`` plus typed parameters (#752, ADR-0042).

Two halves, and the seam between them is the point of the ticket:

- :mod:`application.taxation` is **pure** — it says what a model is and refuses
  what is not one, with no store anywhere near it;
- :mod:`application.accounts` is the **writer** of the two tables, on a real
  DuckDB store in ``tmp_path``, and every assertion here is on a **row**.

What is deliberately *not* asserted is that a function was called. The rules are
rules about rows and about which gestures the store refuses.
"""
import json
from datetime import date, datetime, timezone

import pytest

from application import accounts as accounts_module
from application import ledger
from application import store as store_module
from application import taxation


# --------------------------------------------------------------------------- #
# The catalogue is code, and it ships no money
# --------------------------------------------------------------------------- #

def test_the_five_kinds_are_the_record_s_five():
    """ADR-0042's own table, on the source rather than in prose."""
    assert taxation.KINDS == (
        'none', 'flat_realised', 'aged_flat_realised', 'bracketed_realised',
        'withholding_income')


def test_a_shipped_template_carries_structure_and_never_a_rate():
    """The whole of what the app is allowed to ship (ADR-0042, ADR-0043).

    Every rate, bracket bound and social rate in the survey is *per tax year* and
    several move with a budget law, so the owner types theirs. What ships is what
    is **not money** — a count of years and the day it runs from — and this test
    is what keeps a rate from creeping into the constant.
    """
    assert taxation.TEMPLATES
    for template in taxation.TEMPLATES:
        # One kind of five has any structure at all, which is why the shortcut is
        # nested under it rather than offered beside the kind.
        assert template['kind'] == taxation.AGED_FLAT_REALISED
        assert set(template['values']) == {'threshold_years', 'age_basis'}


def test_the_portuguese_unit_linked_is_not_shipped():
    """#752 asked that the figure be confirmed, and it does not survive the check.

    ADR-0042 lists *PT unit-linked* beside the PEA and the assurance-vie under
    ``aged_flat_realised``. The Portuguese regime has **two** thresholds — five
    years and eight — and its reduced rates are conditional on 35 % of the
    premiums having been paid in the first half of the contract. One
    ``threshold_years`` cannot say that, and shipping ``8`` would silently drop
    the five-year tier: a stale bundled figure of exactly the kind that record
    says is worse than an absent one.
    """
    assert [template['id'] for template in taxation.TEMPLATES] == [
        'fr_pea', 'fr_assurance_vie']


def test_the_pea_counts_from_the_first_payment_and_not_from_the_opening():
    """ADR-0042's own warning, held on the constant.

    *"A PEA's five years run from the first payment."* The two coincide often
    enough to hide the mistake and not always enough to make it safe.
    """
    pea = next(t for t in taxation.TEMPLATES if t['id'] == 'fr_pea')
    assert pea['values'] == {'threshold_years': 5,
                             'age_basis': taxation.FIRST_PAYMENT}


def test_the_catalogue_on_the_wire_states_each_kind_s_parameters():
    published = taxation.catalogue()
    aged = next(entry for entry in published['kinds']
                if entry['kind'] == taxation.AGED_FLAT_REALISED)
    assert [p['name'] for p in aged['parameters']] == [
        'rate_before', 'rate_after', 'threshold_years', 'age_basis',
        'social_rate']
    # `social_rate` is the one optional parameter of the five, and it is a second
    # rate on the same base rather than a decoration: a mature PEA owes 0 % of
    # income tax and the whole of the social charges.
    assert [p['required'] for p in aged['parameters']] == [
        True, True, True, True, False]


# --------------------------------------------------------------------------- #
# What is refused, and it is refused when it is written
# --------------------------------------------------------------------------- #

def test_a_kind_outside_the_enumeration_is_refused():
    with pytest.raises(taxation.ModelRejected):
        taxation.validate('wealth_tax', {'rate': 0.01})


def test_a_required_parameter_missing_is_refused():
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.FLAT_REALISED, {})


def test_an_optional_parameter_absent_stays_absent():
    """*No social charge* is not *a social charge of nothing* (#845)."""
    assert taxation.validate(taxation.FLAT_REALISED, {'rate': 0.3}) == {
        'rate': 0.3}


def test_a_rate_is_a_fraction_and_a_percentage_is_refused():
    """``0.128`` is what is stored; ``12.8`` is a form's unit, not the store's."""
    assert taxation.validate(taxation.FLAT_REALISED, {'rate': '0.128'}) == {
        'rate': 0.128}
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.FLAT_REALISED, {'rate': 12.8})


def test_a_parameter_the_kind_does_not_declare_is_refused():
    """Checked **when it is written**, which is what a closed kind buys."""
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.WITHHOLDING_INCOME,
                          {'rate': 0.3, 'threshold_years': 5})


def test_an_age_basis_outside_the_two_is_refused():
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.AGED_FLAT_REALISED, {
            'rate_before': 0.3, 'rate_after': 0.1, 'threshold_years': 5,
            'age_basis': 'the_holder_s_birthday'})


def test_the_top_bracket_has_no_ceiling_and_the_others_climb():
    ladder = taxation.validate(taxation.BRACKETED_REALISED, {'brackets': [
        {'upper_bound': 10_000, 'rate': 0.2},
        {'upper_bound': None, 'rate': 0.3},
    ]})
    assert ladder == {'brackets': [
        {'upper_bound': 10_000.0, 'rate': 0.2},
        {'upper_bound': None, 'rate': 0.3},
    ]}


def test_a_ladder_that_never_ends_is_refused():
    """A set of bounded brackets says nothing about the gain above the last one."""
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.BRACKETED_REALISED, {'brackets': [
            {'upper_bound': 10_000, 'rate': 0.2},
            {'upper_bound': 50_000, 'rate': 0.3},
        ]})


def test_a_ladder_out_of_order_is_refused():
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.BRACKETED_REALISED, {'brackets': [
            {'upper_bound': 50_000, 'rate': 0.2},
            {'upper_bound': 10_000, 'rate': 0.25},
            {'upper_bound': None, 'rate': 0.3},
        ]})


def test_none_is_a_model_and_carries_nothing():
    """Not a placeholder: it is the right answer for an exempt holding."""
    assert taxation.validate(taxation.NONE, {}) == {}


# --------------------------------------------------------------------------- #
# The two tables (ADR-0044): one writer, and an absent row is an absence
# --------------------------------------------------------------------------- #

def test_a_store_created_before_this_ticket_opens_reads_and_writes(tmp_path):
    """The DDL runs with ``IF NOT EXISTS``, so the new tables cost nothing.

    Written the long way round on purpose: a store is created **without** the two
    tables, closed, and reopened by the current code. Nothing is done to it, and
    the account it already held is still there with no fact row beside it.
    """
    import duckdb

    before = ';'.join(
        statement for statement in store_module.DDL.split(';')
        if 'taxation_model' not in statement and 'account_fact' not in statement)

    path = tmp_path / 'old.duckdb'
    old = duckdb.connect(str(path))
    old.execute("SET TimeZone='UTC'")
    old.execute(before)
    old.execute("INSERT INTO account (id, type, label) VALUES ('pea', 'OTHER', 'PEA')")
    # The store this test is about: twelve tables, and neither of the two.
    held = {row[0] for row in old.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'main'").fetchall()}
    assert held == set(store_module.TABLES) - {'taxation_model', 'account_fact'}
    old.close()

    opened = store_module.open_store(path)
    assert [a.id for a in accounts_module.read_accounts(opened)] == ['pea']
    assert accounts_module.taxation_models_by_account(opened) == {}
    model = accounts_module.create_model(
        opened, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})
    accounts_module.set_taxation_model(opened, 'pea', model.id)
    assert accounts_module.taxation_models_by_account(opened) == {'pea': model.id}


def test_an_account_with_no_model_has_no_row_at_all(store):
    """**An absent row is an absence** (ADR-0044, #845): no sentinel, no null."""
    accounts_module.create_account(store, 'pea', 'PEA')
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0
    assert accounts_module.taxation_models_by_account(store) == {}


def test_detaching_a_model_leaves_no_row_behind(store):
    """*Never declared* and *declared as nothing* are two sentences."""
    accounts_module.create_account(store, 'pea', 'PEA')
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})

    accounts_module.set_taxation_model(store, 'pea', model.id)
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 1

    accounts_module.set_taxation_model(store, 'pea', None)
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0


def test_the_account_fact_table_declares_its_opening_date_column(store):
    """#918 writes it; this ticket declares it (ADR-0044).

    A column added later would exist on no store created between the two
    releases, so the table is declared once with the columns the settled design
    needs.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'account_fact'")}
    assert columns == {'account', 'taxation_model', 'opened_on'}


def test_a_shipped_template_is_never_a_row(store):
    """The table holds the owner's own and nothing else — nothing is seeded."""
    assert accounts_module.read_models(store) == []


def test_a_model_is_written_with_its_parameters_as_one_json_value(store):
    """One column, not a column per parameter (ADR-0042).

    A nullable column per field would make *this kind has no such parameter*
    indistinguishable from *this row has not set it*, and it is what makes a kind
    added later an addition rather than a migration.
    """
    model = accounts_module.create_model(
        store, 'Mon PEA', taxation.AGED_FLAT_REALISED,
        {'rate_before': 0.128, 'rate_after': 0.0, 'threshold_years': 5,
         'age_basis': taxation.FIRST_PAYMENT, 'social_rate': 0.186})

    row = store.query(
        'SELECT name, kind, parameters FROM taxation_model WHERE id = ?',
        [model.id])[0]
    assert row[0] == 'Mon PEA'
    assert row[1] == taxation.AGED_FLAT_REALISED
    assert json.loads(row[2])['threshold_years'] == 5


def test_a_model_is_corrected_and_the_account_carrying_it_does_not_move(store):
    accounts_module.create_account(store, 'pea', 'PEA')
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})
    accounts_module.set_taxation_model(store, 'pea', model.id)

    accounts_module.update_model(store, model.id, name='Corrected',
                                 parameters={'rate': 0.28})

    assert accounts_module.read_model(store, model.id).parameters == {'rate': 0.28}
    assert accounts_module.taxation_models_by_account(store) == {'pea': model.id}


def test_correcting_a_model_into_a_shape_its_parameters_do_not_fit_is_refused(store):
    """The kind and its parameters are one value, and they move together."""
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})
    with pytest.raises(taxation.ModelRejected):
        accounts_module.update_model(store, model.id,
                                     kind=taxation.BRACKETED_REALISED)
    assert accounts_module.read_model(store, model.id).kind == taxation.FLAT_REALISED


def test_removing_a_model_an_account_carries_is_refused_and_names_it(store):
    """``delete_account``'s own shape: the refusal says where to go."""
    accounts_module.create_account(store, 'pea', 'PEA')
    accounts_module.create_account(store, 'cto', 'CTO')
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})
    accounts_module.set_taxation_model(store, 'pea', model.id)
    accounts_module.set_taxation_model(store, 'cto', model.id)

    with pytest.raises(accounts_module.TaxationModelInUse) as refused:
        accounts_module.delete_model(store, model.id)
    assert 'pea' in str(refused.value) and 'cto' in str(refused.value)
    assert accounts_module.accounts_carrying(store, model.id) == ['cto', 'pea']

    accounts_module.set_taxation_model(store, 'pea', None)
    accounts_module.set_taxation_model(store, 'cto', None)
    accounts_module.delete_model(store, model.id)
    assert accounts_module.read_models(store) == []


def test_attaching_a_model_that_does_not_exist_is_refused(store):
    accounts_module.create_account(store, 'pea', 'PEA')
    with pytest.raises(accounts_module.UnknownTaxationModel):
        accounts_module.set_taxation_model(store, 'pea', 'no-such-model')
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0


def test_removing_an_account_takes_what_was_declared_about_it(store):
    """A fact about an account that no longer exists is a fact about nothing."""
    accounts_module.create_account(store, 'pea', 'PEA')
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})
    accounts_module.set_taxation_model(store, 'pea', model.id)

    accounts_module.delete_account(store, 'pea')

    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0
    # The model itself stays: it is reusable, and it belonged to no account.
    assert [m.id for m in accounts_module.read_models(store)] == [model.id]


# --------------------------------------------------------------------------- #
# What a JSON body may carry where a value goes
# --------------------------------------------------------------------------- #

def test_a_kind_that_is_not_even_a_string_is_refused_rather_than_raised():
    """``[] in PARAMETERS`` is a ``TypeError``, not a ``False``.

    A body may carry anything where the kind goes, and the route is written to
    answer `422` — so the type is checked before the lookup, or the refusal
    surfaces as *an unexpected error*.
    """
    for nonsense in ([], {}, 7, None):
        with pytest.raises(taxation.ModelRejected):
            taxation.validate(nonsense, {})


def test_an_infinite_rate_is_refused():
    """Python's JSON reader accepts ``Infinity``; no schedule contains one."""
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.FLAT_REALISED, {'rate': float('inf')})
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.AGED_FLAT_REALISED, {
            'rate_before': 0.3, 'rate_after': 0.1,
            'threshold_years': float('inf'), 'age_basis': taxation.OPENING})


def test_a_bracket_with_no_bound_where_one_is_needed_is_refused():
    """The shape a blank field reaches the server as — never a zero.

    The form skips a scalar left blank, and a ladder has no *skip* to be skipped
    by: an empty bound arrives as ``null`` and is refused, where a coerced ``0``
    would be stored as *up to 0* and be perfectly valid.
    """
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.BRACKETED_REALISED, {'brackets': [
            {'upper_bound': None, 'rate': 0.2},
            {'upper_bound': None, 'rate': 0.3},
        ]})
    with pytest.raises(taxation.ModelRejected):
        taxation.validate(taxation.BRACKETED_REALISED, {'brackets': [
            {'upper_bound': 10_000, 'rate': None},
            {'upper_bound': None, 'rate': 0.3},
        ]})


# --------------------------------------------------------------------------- #
# The opening date: declared, and only declared (#918)
# --------------------------------------------------------------------------- #

def test_an_account_declares_the_day_it_was_opened(store):
    """A **day**, held as one, and read back as one.

    The date the owner cares about is exactly the one no event carries — a PEA
    opened in 2015 and transferred to a broker whose ledger starts in 2022 —
    which is why it is declared rather than derived.
    """
    accounts_module.create_account(store, 'pea', 'PEA')

    assert accounts_module.set_opened_on(
        store, 'pea', date(2015, 6, 1)) == date(2015, 6, 1)
    assert store.query('SELECT opened_on FROM account_fact') == [
        (date(2015, 6, 1),)]
    assert accounts_module.opening_dates_by_account(store) == {
        'pea': date(2015, 6, 1)}


def test_an_account_with_no_opening_date_has_no_row_at_all(store):
    """An account without one is ordinary — no row, no null, no sentinel."""
    accounts_module.create_account(store, 'pea', 'PEA')

    assert accounts_module.opening_dates_by_account(store) == {}
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0


def test_the_two_facts_share_a_row_and_outlive_each_other(store):
    """One row per account, and taking one fact away leaves the other alone.

    This is the case ``set_taxation_model``'s own docstring was written against:
    the row survives its own emptiness only while something is still declared in
    it, and it goes when nothing is.
    """
    accounts_module.create_account(store, 'pea', 'PEA')
    model = accounts_module.create_model(
        store, 'Flat', taxation.FLAT_REALISED, {'rate': 0.3})

    accounts_module.set_taxation_model(store, 'pea', model.id)
    accounts_module.set_opened_on(store, 'pea', date(2015, 6, 1))
    assert store.query(
        'SELECT taxation_model, opened_on FROM account_fact') == [
            (model.id, date(2015, 6, 1))]

    accounts_module.set_taxation_model(store, 'pea', None)
    assert store.query('SELECT taxation_model, opened_on FROM account_fact') \
        == [(None, date(2015, 6, 1))]

    accounts_module.set_opened_on(store, 'pea', None)
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0


def test_an_opening_date_that_is_not_a_day_is_refused(store):
    """The column holds a day, and a string that looks like one is not one."""
    accounts_module.create_account(store, 'pea', 'PEA')

    with pytest.raises(accounts_module.AccountSourceError):
        accounts_module.set_opened_on(store, 'pea', '2015-06-01')
    # And an **instant** is not one either, though it is a `date` to Python:
    # the column would truncate it, and the guard that says a day stays a day
    # would be the thing that let one through.
    with pytest.raises(accounts_module.AccountSourceError):
        accounts_module.set_opened_on(
            store, 'pea', datetime(2015, 6, 1, 8, 30, tzinfo=timezone.utc))
    assert store.query('SELECT count(*) FROM account_fact')[0][0] == 0


def test_the_earliest_payment_is_a_deposit_and_nothing_else(store):
    """What the form offers is a figure of the **ledger**, per account.

    A `BUY` is money moving inside the wrapper and a `WITHDRAWAL` is money
    leaving it; neither opens anything. And it is derived on every read: no
    column holds it, because a declared fact and a derived one do not share a
    row (ADR-0006).
    """
    accounts_module.create_account(store, 'pea', 'PEA')
    accounts_module.create_account(store, 'cto', 'CTO')
    for key, (day, kind, account) in enumerate((
            ('2022-03-04', 'BUY', 'pea'),
            ('2022-05-10', 'DEPOSIT', 'pea'),
            ('2023-01-02', 'DEPOSIT', 'pea'),
            ('2021-01-02', 'WITHDRAWAL', 'cto'))):
        store.execute(
            'INSERT INTO event (id, date, event_type, account, amount) '
            'VALUES (?, CAST(? AS DATE), ?, ?, 100)',
            [key, day, kind, account])

    assert ledger.first_payments(store) == {'pea': date(2022, 5, 10)}
