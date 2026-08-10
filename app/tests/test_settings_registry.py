"""
The settings registry — a pure module, so a pure test (#696/#701, ADR-0014).

Values in, values out, no store and no clock: the same seam
``test_scheduling.py`` and ``test_performance.py`` have. What is worth pinning
is the direction of the arrow — **the code says what a dial is worth, and the
table is its mirror** — because the failure it prevents is silent: a boot that
overwrote a human's answer with a default would look exactly like a boot that
worked.

Since #701 the module also carries the bounds and the effect, which is what
makes it the *single* list: four enumerations of the same six dials would agree
on the day they were written and not much longer.
"""

import pytest

import settings_registry as registry


def test_the_registry_is_the_single_list_of_dials():
    """One list, read by the API, the effective-configuration view and the form.

    Six dials, and the count is the point: four of v4's were deleted rather
    than moved (the executor-pool pair, the ingestion interval, the perf
    interval), which is what leaves the settings page a single class of field.
    """
    assert [spec.key for spec in registry.SETTINGS] == [
        'regular_interval', 'backfill_interval', 'backfill_delay',
        'backfill_chunk_days', 'staleness_horizon', 'base_currency',
    ]
    assert set(registry.BY_KEY) == {spec.key for spec in registry.SETTINGS}


def test_the_reporting_currency_has_no_default_and_is_never_seeded():
    """"Not answered yet" and "answered" are two states, and must stay two.

    A default here would silently interpret every amount already imported, and
    ADR-0002 makes the currency immutable once posed — so the wrong guess would
    be permanent.
    """
    assert registry.default_for('base_currency') is None
    assert 'base_currency' not in registry.seeded_defaults()


def test_every_other_dial_has_a_default_and_it_parses():
    seeded = registry.seeded_defaults()

    assert set(seeded) == {spec.key for spec in registry.SETTINGS} - {'base_currency'}
    assert all(isinstance(registry.default_for(key), int) for key in seeded)


def test_defaults_carries_the_unanswered_currency_as_none():
    """The boot state of every dial in one mapping, holes included."""
    assert registry.defaults()['regular_interval'] == 120
    assert registry.defaults()['base_currency'] is None


def test_a_stored_value_wins_over_the_default():
    assert registry.resolve('regular_interval', '600') == 600


@pytest.mark.parametrize('stored', [None, '', '   '])
def test_absent_or_blank_falls_back_to_the_code(stored):
    assert registry.resolve('regular_interval', stored) == 120


def test_zero_is_a_value_and_not_an_absence():
    """``staleness_horizon = 0`` disables the sonde. It is an answer."""
    assert registry.resolve('staleness_horizon', '0') == 0


def test_an_unknown_key_raises_rather_than_inventing_a_dial():
    with pytest.raises(KeyError):
        registry.resolve('regular_intervals', '120')


# --------------------------------------------------------------------- #
# validate — the rule the write path enforces (issue #701)
# --------------------------------------------------------------------- #

def test_every_dial_says_what_changing_it_triggers():
    """The effect is part of the registry, not of the route that applies it."""
    effects = {spec.key: spec.effect for spec in registry.SETTINGS}

    assert effects['regular_interval'] == registry.REARM_SCRAPE
    assert effects['backfill_interval'] == registry.REARM_BACKFILL_JOB
    assert effects['backfill_delay'] == registry.NEXT_CYCLE


def test_every_integer_dial_is_bounded_on_both_sides():
    """An unbounded dial is a dial the table would happily take a 0 for."""
    for spec in registry.SETTINGS:
        if spec.kind == registry.INTEGER:
            assert spec.minimum is not None, spec.key
            assert spec.maximum is not None, spec.key


@pytest.mark.parametrize('value', [600, '600', 600.0])
def test_a_number_and_the_string_of_it_are_the_same_request(value):
    """JSON hands a handler either; the registry must not care which."""
    assert registry.validate('regular_interval', value) == 600


def test_an_unknown_key_is_refused_rather_than_stored():
    with pytest.raises(registry.InvalidSetting) as excinfo:
        registry.validate('regular_intervals', 120)
    assert excinfo.value.key == 'regular_intervals'


@pytest.mark.parametrize('value', [5, 0, -1])
def test_below_the_minimum_is_refused(value):
    """``regular_interval = 0`` is a busy loop against Yahoo Finance."""
    with pytest.raises(registry.InvalidSetting, match='at least'):
        registry.validate('regular_interval', value)


def test_above_the_maximum_is_refused():
    with pytest.raises(registry.InvalidSetting, match='at most'):
        registry.validate('regular_interval', 86401)


@pytest.mark.parametrize('value', ['abc', '12x', 12.5])
def test_a_value_that_is_not_a_whole_number_is_refused(value):
    with pytest.raises(registry.InvalidSetting, match='whole number'):
        registry.validate('regular_interval', value)


def test_a_boolean_is_not_a_number_even_though_python_thinks_so():
    """``True`` is an ``int`` in Python and would have stored as ``1``."""
    with pytest.raises(registry.InvalidSetting, match='boolean'):
        registry.validate('regular_interval', True)


@pytest.mark.parametrize('value', [None, '', '   '])
def test_a_blank_request_is_refused_where_a_blank_row_is_a_default(value):
    """The asymmetry is deliberate — an emptied field is not a reset gesture.

    The same blank reads two ways depending on which side it arrives from: a
    blank *row* is a store nobody has answered, a blank *request* is a form
    field someone emptied. Answering the second with the default would make
    "I cleared this by accident" indistinguishable from "I want the default".
    """
    assert registry.resolve('regular_interval', value) == 120
    with pytest.raises(registry.InvalidSetting):
        registry.validate('regular_interval', value)


def test_zero_passes_where_zero_is_the_documented_off_switch():
    assert registry.validate('staleness_horizon', 0) == 0


def test_the_currency_is_a_string_and_its_own_ticket_validates_it():
    """No ISO check here: #701 stores it, the currency ticket interprets it."""
    assert registry.validate('base_currency', ' EUR ') == 'EUR'


def test_the_stored_form_of_a_number_is_byte_identical_to_the_seed():
    """``120`` and ``120.0`` a row apart would fake a change on every save."""
    assert registry.stored_form('regular_interval', 120.0) == '120'
    assert registry.stored_form('regular_interval', 120) == \
        registry.seeded_defaults()['regular_interval']
