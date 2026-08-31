"""
The settings write path, against a **real** store (issue #701, spec #695).

The seam is the one the whole v5 suite uses: a genuine DuckDB file in
``tmp_path``, DDL applied and seeded. Assertions go on the rows the table
carries, never on the fact that a statement was executed — "only what changed
was written" is a claim about the store's contents, and a mock would report the
intention of writing as the writing itself.
"""

import pytest

from application import settings
from application import settings_registry


def _one_event(store):
    """The cheapest ledger a currency can already have been interpreted in."""
    store.execute("INSERT INTO symbol (symbol) VALUES ('AAPL')")
    store.execute(
        "INSERT INTO event (id, date, event_type, account, symbol, quantity, "
        "unit_price) VALUES (1, DATE '2024-01-15', 'BUY', 'default', 'AAPL', "
        "10, 150.0)")


def test_a_fresh_store_reads_the_code_for_everything(store):
    values = settings.read_all(store)

    assert values['regular_interval'] == 120
    assert values['backfill_chunk_days'] == 365
    # The one dial with no default: unanswered, and it has to stay a third state.
    assert values['base_currency'] is None


def test_saving_returns_what_moved_and_the_store_agrees(store):
    changes = settings.save(store, {'regular_interval': 600})

    assert [(c.key, c.before, c.after) for c in changes] == [
        ('regular_interval', 120, 600)]
    assert settings.read_all(store)['regular_interval'] == 600


def test_reposting_the_same_value_is_not_a_change(store):
    """The criterion the re-arm rests on: a save button is not a reset button.

    ``reschedule_job`` recomputes ``next_run_time`` from *now*, so a write path
    that reported every posted key as changed would put every timer back to zero
    on every click — including the timers of dials nobody touched.
    """
    settings.save(store, {'regular_interval': 600})

    assert settings.save(store, {'regular_interval': 600}) == ()


def test_a_value_equal_to_the_code_default_is_not_a_change(store):
    """The comparison is against the *effective* value, not against the row.

    A fresh store has ``120`` seeded; posting ``120`` changes nothing, and must
    report nothing, or the first save of any form re-arms every symbol.
    """
    assert settings.save(store, {'regular_interval': 120}) == ()


def test_several_dials_move_in_one_call_and_only_those(store):
    changes = settings.save(
        store, {'regular_interval': 600, 'backfill_delay': 10})

    assert [c.key for c in changes] == ['regular_interval']
    assert settings.read_all(store)['backfill_delay'] == 10


def test_a_rejected_body_writes_none_of_its_valid_keys(store):
    """Two passes, and this is why: a half-applied ``PUT`` is a state nobody asked for."""
    with pytest.raises(settings_registry.InvalidSetting):
        settings.save(store, {'regular_interval': 600, 'backfill_delay': -1})

    assert settings.read_all(store)['regular_interval'] == 120


def test_an_unknown_key_is_refused_and_nothing_is_written(store):
    with pytest.raises(settings_registry.InvalidSetting):
        settings.save(store, {'regular_interval': 600, 'colour': 'blue'})

    assert settings.read_all(store)['regular_interval'] == 120
    assert store.query("SELECT count(*) FROM setting WHERE key = 'colour'") == [(0,)]


def test_an_empty_body_is_refused(store):
    with pytest.raises(settings_registry.InvalidSetting):
        settings.save(store, {})


def test_the_currency_is_answered_like_any_other_dial(store):
    """It has no default, so its first save is an insert rather than an update."""
    changes = settings.save(store, {'base_currency': 'EUR'})

    assert [(c.key, c.before, c.after) for c in changes] == [
        ('base_currency', None, 'EUR')]
    assert settings.read_all(store)['base_currency'] == 'EUR'


def test_the_currency_can_still_be_reconsidered_while_the_ledger_is_empty(store):
    """Answering late, or thinking again beforehand, is not the unrecoverable act.

    With no event nothing has been interpreted, so nothing can be
    re-interpreted.
    """
    settings.save(store, {'base_currency': 'EUR'})

    settings.save(store, {'base_currency': 'USD'})

    assert settings.read_all(store)['base_currency'] == 'USD'


def test_the_currency_is_fixed_from_the_first_event(store):
    """ADR-0002's unrecoverable act, refused where it would enter.

    Amounts are recorded *in* the base currency, so a second answer converts
    nothing — it silently re-reads three years of euros as dollars.
    """
    settings.save(store, {'base_currency': 'EUR'})
    _one_event(store)

    with pytest.raises(settings_registry.InvalidSetting, match='reinterpret'):
        settings.save(store, {'base_currency': 'USD'})

    assert settings.read_all(store)['base_currency'] == 'EUR'


def test_re_answering_the_currency_with_the_same_value_is_not_a_change(store):
    """It is not a change, so it is not a reinterpretation either."""
    settings.save(store, {'base_currency': 'EUR'})
    _one_event(store)

    assert settings.save(store, {'base_currency': 'EUR'}) == ()


def test_a_refused_currency_takes_the_rest_of_the_body_with_it(store):
    """The guard runs before the transaction, like every other refusal here."""
    settings.save(store, {'base_currency': 'EUR'})
    _one_event(store)

    with pytest.raises(settings_registry.InvalidSetting):
        settings.save(store, {'regular_interval': 600, 'base_currency': 'USD'})

    assert settings.read_all(store)['regular_interval'] == 120


def test_a_failure_part_way_through_leaves_no_dial_written(store, mocker):
    """One transaction, because a half-written body is a state nobody asked for.

    Without it the store reports the two dials that landed while the running
    process — which never reaches ``apply_settings`` on this path — goes on
    using all four old values until the next restart.
    """
    real_execute = store.execute
    calls = {'n': 0}

    def flaky(sql, parameters=None):
        if sql.startswith('INSERT INTO setting'):
            calls['n'] += 1
            if calls['n'] == 2:
                raise RuntimeError('disk full')
        return real_execute(sql, parameters)

    mocker.patch.object(store, 'execute', side_effect=flaky)

    with pytest.raises(RuntimeError):
        settings.save(store, {'regular_interval': 600, 'backfill_delay': 30,
                              'backfill_chunk_days': 90})

    mocker.stopall()
    values = settings.read_all(store)
    assert (values['regular_interval'], values['backfill_delay'],
            values['backfill_chunk_days']) == (120, 10, 365)


def test_a_number_is_stored_in_the_seed_s_own_form(store):
    """``120.0`` and ``120`` a row apart would fake a change on the next save."""
    settings.save(store, {'regular_interval': 600.0})

    assert store.query(
        "SELECT value FROM setting WHERE key = 'regular_interval'") == [('600',)]


def test_describe_is_the_registry_and_not_a_second_enumeration(store):
    settings.save(store, {'regular_interval': 600})

    described = {row['key']: row for row in settings.describe(store)}

    assert list(described) == [spec.key for spec in settings_registry.SETTINGS]
    assert described['regular_interval']['value'] == 600
    assert described['regular_interval']['default'] == 120
    assert described['regular_interval']['minimum'] == 10
    assert described['regular_interval']['effect'] == settings_registry.REARM_SCRAPE
    assert described['regular_interval']['stored'] is True
    # Never answered, never seeded: the third state survives the round trip.
    assert described['base_currency']['value'] is None
    assert described['base_currency']['stored'] is False


def test_the_required_mark_travels_with_the_dial_it_belongs_to(store):
    """The front reads a mark, never a key (ADR-0035).

    Published like the bounds and the effect, because it is the same kind of
    thing: part of what a dial *is*. Paired with ``stored`` it is the whole of
    the first-run predicate — marked required, nothing stored — which is why
    the two have to arrive together.
    """
    described = {row['key']: row for row in settings.describe(store)}

    assert [key for key, row in described.items() if row['required']] == \
        list(settings_registry.required_keys())
    assert described['base_currency']['required'] is True
    assert described['base_currency']['stored'] is False
    assert described['regular_interval']['required'] is False
