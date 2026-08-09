"""
The settings registry — a pure module, so a pure test (#696, ADR-0014).

Values in, values out, no store and no clock: the same seam
``test_scheduling.py`` and ``test_performance.py`` have. What is worth pinning
is the direction of the arrow — **the code says what a dial is worth, and the
table is its mirror** — because the failure it prevents is silent: a boot that
overwrote a human's answer with a default would look exactly like a boot that
worked.
"""

import pytest

import settings_registry as registry


def test_the_registry_is_the_single_list_of_dials():
    """One list, read by the API, the effective-configuration view and the form.

    Six dials, and the count is the point: three of v4's were deleted rather
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
