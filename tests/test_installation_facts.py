"""The installation facts (issue #709, spec #695 § 14, ADR-0021).

Everything here runs against a **real store** — the suite's one rule — and the
assertions go on the rows and on what the module answers, never on a call having
happened. That matters more than usual here: the whole feature is *"the table
holds only what the code cannot recompute"*, which is a claim about rows and can
only be checked on rows.
"""
import logging
from datetime import date, datetime, timezone

import pytest

from application import installation_facts as facts
from application import quotes


def _quote(opened, symbol: str, currency: str) -> None:
    """Declare a symbol and record what it is quoted in, as the scrape would."""
    opened.execute('INSERT INTO symbol (symbol) VALUES (?) '
                   'ON CONFLICT (symbol) DO NOTHING', [symbol])
    quotes.record_quote(
        opened, symbol, datetime(2024, 6, 3, tzinfo=timezone.utc), 100.0,
        attributes={'currency': currency})


def _event(opened, identifier: int, symbol: str, unit_price=150.0,
           event_type='BUY', quantity=1.0, amount=None) -> None:
    opened.execute(
        'INSERT INTO event (id, date, event_type, account, symbol, quantity, '
        '                   unit_price, amount) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [identifier, date(2024, 1, 15), event_type, 'default', symbol,
         quantity, unit_price, amount])


def _keys(found):
    return [fact.key for fact in found]


def _row_count(opened) -> int:
    return opened.query('SELECT count(*) FROM installation_fact')[0][0]


# --------------------------------------------------------------------------- #
# The registry: three keys, the predicate and the log's text in code
# --------------------------------------------------------------------------- #

def test_the_registry_is_closed_at_three_keys():
    """ADR-0021 amends spec #695 § 14: the currency is a condition, not an
    installation fact.

    And ADR-0032 took two: ``legacy_config_file`` and ``legacy_settings_file``
    were a ``stat`` on a v4 file found in the folder the app read, and there is
    no folder. Their sentence is said at the refusal of the upload instead, at
    the instant of the gesture — so the keys are gone from the catalogue and
    from the listing alike, rather than moved.
    """
    assert [spec.key for spec in facts.SPECS] == [
        facts.UNREAD_ENVIRONMENT,
        facts.RECONSTRUCTION_RUNNING,
        facts.ASSUMED_BASE_CURRENCY,
    ]
    assert 'base_currency' not in facts.BY_KEY
    assert 'legacy_config_file' not in facts.BY_KEY
    assert 'legacy_settings_file' not in facts.BY_KEY
    # Exactly one of them is an event; the other two are recomputed.
    assert [spec.key for spec in facts.SPECS
            if spec.kind == facts.RECORDED] == [
        facts.ASSUMED_BASE_CURRENCY]


def test_the_table_stores_three_columns_and_no_text_at_all(store):
    """No sentence is written down — so an upgrade can correct any of them.

    Any, plural, since #768: the operator's line lives in
    ``installation_facts.py`` and the reader's in the front's catalogue. What the table holds is the
    acknowledgement, which is the one thing neither of them can be recomputed
    from.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'installation_fact'")}
    assert columns == {'key', 'first_seen_at', 'acknowledged_at'}


def test_an_unknown_key_is_refused_rather_than_invented(store):
    with pytest.raises(facts.UnknownFact):
        facts.spec_for('there_is_no_such_installation_fact')


# --------------------------------------------------------------------------- #
# The two derivable ones: recomputed from their source, no stored existence
# --------------------------------------------------------------------------- #

def test_a_retired_variable_arms_and_its_unsetting_disarms(store):
    """The state is derivable, so unsetting the variable removes the row.

    Nothing of the installation fact survives its own predicate — the property
    the two ``stat``-based installation facts used to carry, held here by the
    one derivable observation that is left with a subject the owner can end
    (ADR-0032).
    """
    context = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))

    found = facts.refresh(store, context)
    assert facts.UNREAD_ENVIRONMENT in _keys(found)
    assert dict(found[0].detail)['variables'] == ['SB_EXECUTOR_POOL']

    gone = facts.Context(unread_variables=())
    assert _keys(facts.refresh(store, gone)) == []
    assert _row_count(store) == 0


def test_unread_variables_arm_and_are_named(store):
    context = facts.Context(
        unread_variables=('SB_EXECUTOR_POOL', 'INFLUXDB_TOKEN'))
    found = facts.refresh(store, context)
    assert _keys(found) == [facts.UNREAD_ENVIRONMENT]
    assert found[0].detail['variables'] == ['SB_EXECUTOR_POOL', 'INFLUXDB_TOKEN']
    assert 'SB_EXECUTOR_POOL' in found[0].message


def test_a_running_reconstruction_arms_and_its_conclusion_disarms(store):
    running = facts.Context(reconstruction=(1, 3))
    found = facts.refresh(store, running)
    assert _keys(found) == [facts.RECONSTRUCTION_RUNNING]
    assert found[0].detail == {'complete': 1, 'total': 3, 'remaining': 2}

    facts.refresh(store, facts.Context(reconstruction=(3, 3)))
    assert _row_count(store) == 0


def test_a_reconstruction_with_nothing_left_to_do_disarms_as_well(store):
    """``(0, 0)`` is an observation — *nothing to reconstruct* — not an absence.

    The other way an armed reconstruction ends: not by finishing, but by losing
    its subject, when the owner forgets every import. Spelt ``None`` it read as
    ``UNOBSERVED`` and the row stood for ever on an empty portfolio, which is
    the permanent noise this table exists against.
    """
    facts.refresh(store, facts.Context(reconstruction=(1, 3)))
    assert _row_count(store) == 1

    facts.refresh(store, facts.Context(reconstruction=(0, 0)))
    assert _row_count(store) == 0


def test_nothing_to_reconstruct_never_concludes_anything(store):
    """``(0, 0)`` disarms the sibling and **produces** nothing.

    ``reconstruction_concluded`` demands ``total > 0``: an empty portfolio has
    concluded no reconstruction, so it cannot be the moment the recorded
    installation fact is born — which would otherwise assert something about
    amounts on an install carrying none.
    """
    assert facts.Context(reconstruction=(0, 0)).reconstruction_concluded \
        is False
    assert facts.Context(reconstruction=(3, 3)).reconstruction_concluded \
        is True
    assert facts.Context().reconstruction_concluded is False


def test_a_source_this_process_cannot_see_neither_arms_nor_disarms(store):
    """``UNOBSERVED`` is the third answer, and it is what survives a restart.

    With only *stands* and *does not stand*, a boot before ``start_runtime`` —
    which has no scheduler and therefore no reconstruction memory — would drop
    the row the previous run armed, re-arm it a minute later, and log it twice
    with a date that means nothing.
    """
    facts.refresh(store, facts.Context(reconstruction=(1, 3)))
    assert _row_count(store) == 1

    # A caller that knows nothing about any of the sources: every row stands.
    found = facts.refresh(store, facts.Context())
    assert _keys(found) == [facts.RECONSTRUCTION_RUNNING]
    assert found[0].detail is None
    assert _row_count(store) == 1


# --------------------------------------------------------------------------- #
# Logged once, in logfmt, when it happens
# --------------------------------------------------------------------------- #

def test_a_fact_is_logged_once_and_carries_its_key(store, caplog):
    context = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))

    with caplog.at_level(logging.INFO, logger='installation_facts'):
        facts.refresh(store, context)
        facts.refresh(store, context)
        facts.refresh(store, context)

    lines = [record for record in caplog.records
             if record.context.get(
                 'installation_fact') == facts.UNREAD_ENVIRONMENT]
    assert len(lines) == 1
    # ``context`` is what ``logfmt_logger`` renders as key=value pairs, so the
    # headless channel is parseable rather than a sentence to grep.
    assert lines[0].context['first_seen_at']
    assert 'SB_EXECUTOR_POOL' in lines[0].getMessage()


def test_a_readvised_predicate_is_logged_again(store, caplog):
    standing = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))
    gone = facts.Context(unread_variables=())

    with caplog.at_level(logging.INFO, logger='installation_facts'):
        facts.refresh(store, standing)
        facts.refresh(store, gone)
        facts.refresh(store, standing)

    lines = [record for record in caplog.records
             if record.context.get(
                 'installation_fact') == facts.UNREAD_ENVIRONMENT]
    assert len(lines) == 2


# --------------------------------------------------------------------------- #
# The acknowledgement: it persists, it hides, and it re-arms
# --------------------------------------------------------------------------- #

def test_an_acknowledged_fact_disappears_from_the_listing(store):
    context = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))
    facts.refresh(store, context)

    acknowledged = facts.acknowledge(store, facts.UNREAD_ENVIRONMENT)
    assert acknowledged.acknowledged is True
    assert acknowledged.acknowledged_at is not None

    assert facts.listing(store, context) == []
    # The row stays: it is what carries the acknowledgement across a restart.
    # It is not offered back either — this is not a journal.
    assert _row_count(store) == 1


def test_the_acknowledgement_survives_a_restart(tmp_path):
    """What a *toast* cannot do, and what the recorded installation fact needs.

    A real file, reopened — the assertion is about persistence, so a store in
    memory would assert nothing at all.
    """
    from application import store as store_module

    context = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))

    opened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        facts.refresh(opened, context)
        facts.acknowledge(opened, facts.UNREAD_ENVIRONMENT)
    finally:
        opened.close()

    reopened = store_module.open_store(tmp_path / 'store.duckdb')
    try:
        assert facts.listing(reopened, context) == []
        facts.refresh(reopened, context)
        assert facts.listing(reopened, context) == []
    finally:
        reopened.close()


def test_an_acknowledged_fact_rearms_when_its_predicate_comes_back(store):
    context = facts.Context(unread_variables=('SB_EXECUTOR_POOL',))

    facts.refresh(store, context)
    facts.acknowledge(store, facts.UNREAD_ENVIRONMENT)
    first_seen = store.query(
        'SELECT first_seen_at FROM installation_fact WHERE key = ?',
        [facts.UNREAD_ENVIRONMENT])[0][0]

    facts.refresh(store, facts.Context(unread_variables=()))
    assert _row_count(store) == 0

    facts.refresh(store, context)

    standing = facts.listing(store, context)
    assert _keys(standing) == [facts.UNREAD_ENVIRONMENT]
    assert standing[0].acknowledged is False
    assert standing[0].first_seen_at >= first_seen.replace(tzinfo=timezone.utc)


def test_acknowledging_what_is_not_standing_is_refused(store):
    with pytest.raises(facts.FactNotStanding):
        facts.acknowledge(store, facts.UNREAD_ENVIRONMENT)
    with pytest.raises(facts.UnknownFact):
        facts.acknowledge(store, 'no_such_key')


def test_acknowledging_twice_does_not_move_the_date(store):
    facts.refresh(
        store, facts.Context(unread_variables=('SB_EXECUTOR_POOL',)))

    first = facts.acknowledge(store, facts.UNREAD_ENVIRONMENT)
    second = facts.acknowledge(store, facts.UNREAD_ENVIRONMENT)
    assert first.acknowledged_at == second.acknowledged_at


# --------------------------------------------------------------------------- #
# The one that is an event
# --------------------------------------------------------------------------- #

def test_the_assumed_currency_fact_names_the_events_it_covers(store):
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'AAPL', 'USD')
    _quote(store, 'MC.PA', 'EUR')
    _event(store, 1, 'AAPL')
    _event(store, 2, 'MC.PA')

    recorded = facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context())

    assert recorded is not None
    assert recorded.detail['base_currency'] == 'EUR'
    assert recorded.detail['symbols'] == ['AAPL']
    assert recorded.detail['currencies'] == ['USD']
    assert [event['id'] for event in recorded.detail['events']] == [1]
    # Actionable rather than accusatory: it says what was assumed and what to do.
    assert 'EUR' in recorded.message and 'AAPL' in recorded.message
    assert 'acknowledge' in recorded.message


def test_the_assumed_currency_fact_is_produced_once(store):
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'AAPL', 'USD')
    _event(store, 1, 'AAPL')

    assert facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context()) is not None
    assert facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context()) is None
    assert _row_count(store) == 1

    # And a *refresh* never arms it: the row is the event, and only the end of a
    # reconstruction may produce it.
    facts.acknowledge(store, facts.ASSUMED_BASE_CURRENCY)
    facts.refresh(store, facts.Context())
    assert _row_count(store) == 1


def test_a_refresh_never_arms_the_recorded_installation_fact(store):
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'AAPL', 'USD')
    _event(store, 1, 'AAPL')

    facts.refresh(store, facts.Context())
    assert _row_count(store) == 0


def test_nothing_is_asserted_while_the_reporting_currency_is_unanswered(store):
    """No dial, no assertion: an amount with no settled unit interprets nothing."""
    _quote(store, 'AAPL', 'USD')
    _event(store, 1, 'AAPL')
    assert facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context()) is None


def test_pence_and_pounds_are_one_currency_at_two_scales(store):
    """``GBp`` is a unit problem the conversion owns (ADR-0002), not a mismatch."""
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'GBP') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'VOD.L', 'GBp')
    _event(store, 1, 'VOD.L')
    assert facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context()) is None


def test_an_event_carrying_no_money_asserts_nothing(store):
    """A dilution ``GRANT`` declares no price, so it names no currency."""
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'AAPL', 'USD')
    _event(store, 1, 'AAPL', unit_price=None, event_type='GRANT')
    assert facts.record(
        store, facts.ASSUMED_BASE_CURRENCY, facts.Context()) is None


def test_forgetting_the_events_takes_the_notice_with_them(store):
    store.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                  "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    _quote(store, 'AAPL', 'USD')
    _event(store, 1, 'AAPL')
    facts.record(store, facts.ASSUMED_BASE_CURRENCY, facts.Context())

    store.execute('DELETE FROM event')
    facts.refresh(store, facts.Context())
    assert _row_count(store) == 0


# --------------------------------------------------------------------------- #
# Not the audit
# --------------------------------------------------------------------------- #

def test_the_table_never_grows_with_the_imports(store, tmp_path):
    """This table is not a trace of what happened, and three imports prove it.

    ``import_source`` was the trace and it is gone (ADR-0032); merged into this
    one, the installation fact box would have grown by a row per import and
    stopped being read — both failures at once. The check is on the row count,
    because that is what "not a journal" means, and it holds for the gesture
    that replaced the folder just as it held for the folder.
    """
    from application import entries
    from application.events import EventLoader

    header = ('date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n')
    for year in (2022, 2023, 2024):
        path = tmp_path / f'{year}.csv'
        path.write_text(
            header + f'{year}-01-15,BUY,AAPL,Apple Inc,1,150.00,,,\n',
            encoding='utf-8')
        entries.create_many(store, EventLoader(str(path)).load())

    assert store.query('SELECT count(*) FROM event') == [(3,)]
    assert _row_count(store) == 0
