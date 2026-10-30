"""A broker statement turned into proposed events (#1120).

The store is real under ``tmp_path``; the Yahoo search is injected. What a
statement comes to is derived from the stored extraction, the owner's edits and
the ledger, at every read.
"""
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

from application import accounts as accounts_module
from application import entries
from application.events.schemas import Event, EventType
from application import statements
from application.statements import (
    Extraction, ExtractedLine, InvalidStatement, reconcile, resolve,
    statement_key, total_check,
)
from test_mcp_server import build_runtime

AS_OF = date(2026, 6, 30)


@pytest.fixture
def opened(tmp_path):
    runtime, opened = build_runtime(tmp_path)
    accounts_module.create_account(opened, 'pea')
    accounts_module.create_account(opened, 'cto')
    entries.create_many(opened, [
        Event(date(2026, 1, 5), EventType.BUY, 'CW8.PA', 'Amundi MSCI World',
              quantity=10, unit_price=500.0, account='pea'),
        Event(date(2026, 2, 5), EventType.BUY, 'AAPL', 'Apple Inc',
              quantity=5, unit_price=150.0, account='pea'),
        Event(date(2026, 2, 5), EventType.BUY, 'MC.PA', 'LVMH',
              quantity=1, unit_price=700.0, account='cto')])
    return opened


def never(query):
    raise AssertionError(f'Yahoo was asked about {query}')


def line(name='AMUNDI MSCI WORLD', **members):
    return ExtractedLine(name=name, **members)


def extraction(*lines, kind='positions', as_of=AS_OF, **members):
    return Extraction(kind=kind, as_of=as_of, lines=list(lines), **members)


def positions(opened, *lines, search=never, **members):
    return resolve(opened, 'pea', extraction(*lines, **members), search)


def close(opened, symbol, day, price):
    opened.execute(
        'INSERT INTO price_point (symbol, ts, price_native, price_converted, '
        'fx_rate) VALUES (?, ?, ?, ?, 1.0)',
        [symbol, datetime(day.year, day.month, day.day, 17, 0,
                          tzinfo=timezone.utc), price, price])


def kinds(reading):
    return [(d.event.event_type.value, d.event.symbol, d.event.quantity)
            for d in reading.drafted]


# --------------------------------------------------------------- the shape --

def test_an_isin_that_is_not_one_is_refused_whole():
    with pytest.raises(ValidationError):
        line(isin='fr0010315770')
    with pytest.raises(ValidationError):
        extraction(currency='euro')
    with pytest.raises(ValidationError):
        extraction(*[line()] * (statements.LINES_MAX + 1))


# ----------------------------------------------------------------- resolve --

def test_a_ticker_the_ledger_names_wins_without_asking_yahoo(opened):
    statement = positions(opened, line(ticker='cw8.pa', quantity=12))

    assert statement['lines'][0]['symbol'] == 'CW8.PA'
    assert statement['lines'][0]['n'] == 1


def test_a_ticker_the_ledger_does_not_name_is_not_trusted(opened):
    statement = positions(opened, line(ticker='CW8', quantity=12))

    assert statement['lines'][0]['symbol'] is None


def test_an_isin_with_one_hit_resolves_to_it(opened):
    asked = []

    def search(query):
        asked.append(query)
        return [{'symbol': 'ESE.PA', 'name': 'x', 'exchange': 'PAR'}]
    statement = positions(opened, line(isin='FR0011550185', quantity=3),
                          line(isin='FR0011550185', quantity=2), search=search)

    assert [l['symbol'] for l in statement['lines']] == ['ESE.PA', 'ESE.PA']
    assert asked == ['FR0011550185']


def test_an_isin_with_several_hits_prefers_the_one_the_ledger_names(opened):
    hits = [{'symbol': 'CW8.MI'}, {'symbol': 'CW8.PA'}, {'symbol': 'CW8.DE'}]

    statement = positions(opened, line(isin='FR0010315770', quantity=3),
                          search=lambda query: hits)

    assert statement['lines'][0]['symbol'] == 'CW8.PA'


@pytest.mark.parametrize('answer', [
    [{'symbol': 'CW8.MI'}, {'symbol': 'CW8.DE'}], [], None])
def test_an_isin_with_no_decisive_hit_is_left_to_the_owner(opened, answer):
    statement = positions(opened, line(isin='FR0010315770', quantity=3),
                          search=lambda query: answer)

    [kept] = statement['lines']
    assert kept['symbol'] is None and kept['isin'] == 'FR0010315770'
    assert kept['name'] == 'AMUNDI MSCI WORLD'


def test_a_line_the_app_cannot_read_is_dropped_and_counted(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12),
                          line(ticker='AAPL'), line(ticker='AAPL', quantity=-1))

    assert [l['n'] for l in statement['lines']] == [1]
    assert statement['dropped'] == 2


def test_an_operations_line_is_read_as_an_event_or_dropped(opened):
    statement = resolve(opened, 'pea', extraction(
        line(ticker='CW8.PA', date=date(2026, 3, 3), event_type='BUY',
             quantity=2, unit_price=510.0),
        line('VIREMENT', date=date(2026, 3, 4), event_type='DEPOSIT',
             amount=1000.0),
        line(ticker='CW8.PA', date=date(2026, 3, 5), event_type='BUY'),
        line(ticker='CW8.PA', event_type='SELL', quantity=1, unit_price=1.0),
        kind='operations', as_of=None), never)

    assert [l['n'] for l in statement['lines']] == [1, 2]
    assert statement['lines'][1]['symbol'] is None  # cash has no title
    assert statement['dropped'] == 2


# ------------------------------------------------------ reconcile: positions --

def test_a_larger_quantity_is_a_buy_of_the_gap_marked_statement_and_gap(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12,
                                       unit_price=512.4),
                          line('APPLE', ticker='AAPL', quantity=5))

    reading = reconcile(opened, statement)

    [only] = reading.drafted
    assert kinds(reading) == [('BUY', 'CW8.PA', 2)]
    assert only.event.date == AS_OF and only.event.account == 'pea'
    assert only.event.amount is None and only.event.unit_price == 512.4
    assert only.marks == ['statement', 'gap'] and only.price_source == 'statement'


def test_a_smaller_quantity_is_a_sell_and_an_absent_title_is_sold_to_zero(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=4,
                                       unit_price=512.4))
    close(opened, 'AAPL', date(2026, 6, 29), 190.0)

    reading = reconcile(opened, statement)

    assert kinds(reading) == [('SELL', 'CW8.PA', 6), ('SELL', 'AAPL', 5)]
    assert reading.drafted[1].event.name == 'Apple Inc'


def test_the_account_is_the_one_declared_not_the_whole_ledger(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=10,
                                       unit_price=500.0),
                          line('APPLE', ticker='AAPL', quantity=5))

    assert reconcile(opened, statement).drafted == []  # MC.PA is cto's


def test_an_event_on_the_day_of_the_statement_is_counted(opened):
    entries.create(opened, Event(AS_OF, EventType.BUY, 'CW8.PA',
                                 'Amundi MSCI World', quantity=2,
                                 unit_price=510.0, account='pea'))
    statement = positions(opened, line(ticker='CW8.PA', quantity=12,
                                       unit_price=512.4),
                          line('APPLE', ticker='AAPL', quantity=5))

    assert reconcile(opened, statement).drafted == []


def test_an_event_after_the_statement_is_not(opened):
    entries.create(opened, Event(date(2026, 7, 1), EventType.SELL, 'CW8.PA',
                                 'Amundi MSCI World', quantity=10,
                                 unit_price=510.0, account='pea'))
    statement = positions(opened, line(ticker='CW8.PA', quantity=10,
                                       unit_price=500.0),
                          line('APPLE', ticker='AAPL', quantity=5))

    assert reconcile(opened, statement).drafted == []


def test_two_lines_of_one_title_are_summed(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=7,
                                       unit_price=512.4),
                          line(ticker='CW8.PA', quantity=5),
                          line('APPLE', ticker='AAPL', quantity=5))

    assert kinds(reconcile(opened, statement)) == [('BUY', 'CW8.PA', 2)]


def test_no_sale_to_zero_while_a_line_waits_for_its_ticker(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=10,
                                       unit_price=500.0),
                          line('A TITLE', isin='FR0010315770', quantity=3,
                               unit_price=9.0), search=lambda q: [])

    reading = reconcile(opened, statement)

    assert reading.drafted == [] and reading.pending_held == 1
    assert [u['n'] for u in reading.unresolved] == [2]
    # The owner picks AAPL's own title for it: the sale is no longer on hold.
    chosen = reconcile(opened, statement, {'symbols': {'2': 'aapl'}})
    assert chosen.unresolved == [] and chosen.pending_held == 0
    assert kinds(chosen) == [('SELL', 'AAPL', 2)]


def test_a_gap_without_a_statement_price_takes_the_last_close_and_says_so(opened):
    close(opened, 'CW8.PA', date(2026, 6, 26), 520.0)
    close(opened, 'CW8.PA', date(2026, 7, 2), 999.0)
    statement = positions(opened, line(ticker='CW8.PA', quantity=12),
                          line('APPLE', ticker='AAPL', quantity=5))

    [gap] = reconcile(opened, statement).drafted

    assert gap.event.unit_price == 520.0 and gap.price_source == 'close'
    assert gap.marks == ['statement', 'gap', 'estimated_price']


def test_no_close_at_all_leaves_the_price_to_the_owner(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12),
                          line('APPLE', ticker='AAPL', quantity=5))

    reading = reconcile(opened, statement)

    [gap] = reading.drafted
    assert gap.event.unit_price is None and gap.price_source is None
    assert reading.unpriced() == [gap]


def test_an_edited_price_is_the_one_used_and_is_no_longer_an_estimate(opened):
    close(opened, 'CW8.PA', date(2026, 6, 26), 520.0)
    statement = positions(opened, line(ticker='CW8.PA', quantity=12),
                          line('APPLE', ticker='AAPL', quantity=5))

    [gap] = reconcile(opened, statement, {'prices': {'cw8.pa': 530}}).drafted

    assert gap.event.unit_price == 530 and gap.price_source == 'owner'
    assert 'estimated_price' not in gap.marks


@pytest.mark.parametrize('edits, where', [
    ({'prices': {'AAPL': 10}}, 'AAPL has no gap line'),
    ({'prices': {'CW8.PA': 0}}, 'must be a number above zero'),
    ({'prices': {'CW8.PA': float('nan')}}, 'must be a number above zero'),
    ({'prices': {'CW8.PA': True}}, 'must be a number above zero'),
    ({'symbols': {'1': 'AAPL'}}, 'line 1 is not waiting'),
    ({'symbols': {'9': 'AAPL'}}, 'line 9 is not waiting'),
])
def test_an_edit_that_names_nothing_it_may_change_is_refused(opened, edits, where):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12,
                                       unit_price=1.0),
                          line('APPLE', ticker='AAPL', quantity=5))

    with pytest.raises(InvalidStatement, match=where):
        reconcile(opened, statement, edits)


def test_a_positions_statement_without_a_day_is_refused(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12),
                          as_of=None)

    with pytest.raises(InvalidStatement, match='gives no date'):
        reconcile(opened, statement)


# ----------------------------------------------------- reconcile: operations --

def test_operations_are_events_marked_statement_with_their_own_numbers(opened):
    statement = resolve(opened, 'pea', extraction(
        line(ticker='CW8.PA', date=date(2026, 3, 3), event_type='BUY',
             quantity=2, unit_price=510.0, fee=1.5, amount=1021.5),
        line('VIREMENT', date=date(2026, 3, 4), event_type='DEPOSIT',
             amount=1000.0),
        kind='operations', as_of=None), never)

    reading = reconcile(opened, statement)

    buy, deposit = reading.drafted
    assert buy.marks == ['statement'] and buy.event.fee == 1.5
    assert buy.event.amount == 1021.5 and buy.event.account == 'pea'
    assert deposit.event.symbol is None and deposit.event.amount == 1000.0


def test_an_operations_line_without_a_title_waits_and_the_owner_names_it(opened):
    statement = resolve(opened, 'pea', extraction(
        line('UNKNOWN', isin='FR0010315770', date=date(2026, 3, 3),
             event_type='BUY', quantity=2, unit_price=510.0),
        kind='operations', as_of=None), lambda q: [])

    assert reconcile(opened, statement).drafted == []
    [chosen] = reconcile(opened, statement, {'symbols': {'1': 'CW8.PA'}}).drafted
    assert chosen.event.symbol == 'CW8.PA' and chosen.event.name == 'UNKNOWN'


def test_a_price_is_never_edited_on_an_operations_statement(opened):
    statement = resolve(opened, 'pea', extraction(
        line(ticker='CW8.PA', date=date(2026, 3, 3), event_type='BUY',
             quantity=2, unit_price=510.0), kind='operations', as_of=None),
        never)

    with pytest.raises(InvalidStatement, match='prices'):
        reconcile(opened, statement, {'prices': {'CW8.PA': 1}})


def test_the_statement_key_ignores_the_fee_and_rounds_the_amount_half_to_even():
    base = Event(date(2026, 3, 3), EventType.BUY, 'cw8.pa', 'x', quantity=2,
                 unit_price=510.0, amount=1020.0, fee=0.0, account='pea')

    assert statement_key(base) == statement_key(
        Event(date(2026, 3, 3), EventType.BUY, 'CW8.PA', 'y', quantity=2,
              unit_price=510.0, amount=1020.004, fee=1.5, account='pea'))
    assert statement_key(base) != statement_key(
        Event(date(2026, 3, 3), EventType.BUY, 'CW8.PA', 'y', quantity=2,
              unit_price=510.0, amount=1020.01, account='pea'))
    # 0.125 and 0.135 sit on a tie in binary: Python's round decides.
    assert statement_key(
        Event(date(2026, 3, 3), EventType.DEPOSIT, amount=0.125))[-1] == 0.12
    # A buy without an amount is worth what it cost.
    assert statement_key(
        Event(date(2026, 3, 3), EventType.BUY, 'CW8.PA', quantity=2,
              unit_price=510.0, account='pea')) == statement_key(base)


# ------------------------------------------------------------- total check --

def checked(total, *lines):
    return total_check({'kind': 'positions', 'total': total,
                        'lines': [dict(quantity=q, unit_price=p)
                                  for q, p in lines]})


def test_a_total_off_by_more_than_half_a_percent_warns():
    assert checked(48210.0, (2, 22990.0)) == {
        'stated': 48210.0, 'read': 45980.0, 'gap_pct': -4.6}


def test_a_total_within_half_a_percent_says_nothing():
    assert checked(46000.0, (2, 22990.0)) is None


def test_a_line_without_a_price_makes_the_total_unverifiable():
    assert checked(100.0, (2, None)) == 'unverifiable'


def test_no_total_no_check():
    assert checked(None, (2, 10.0)) is None
    assert total_check({'kind': 'operations', 'total': 5.0, 'lines': []}) is None


def test_the_dropped_lines_are_counted_by_a_reading_of_the_other_kind(opened):
    statement = positions(opened, line(ticker='CW8.PA', quantity=12,
                                       unit_price=512.4))

    read = reconcile(opened, {**statement, 'kind': 'operations'})

    assert read.drafted == [] and read.dropped == 1


def test_a_number_json_cannot_spell_is_not_kept(opened):
    statement = positions(
        opened, line(ticker='CW8.PA', quantity=12, unit_price=float('nan')),
        total=float('inf'))

    [kept] = statement['lines']
    assert 'unit_price' not in kept and statement['total'] is None


def test_a_price_of_zero_in_the_statement_is_no_price(opened):
    close(opened, 'CW8.PA', date(2026, 6, 26), 520.0)
    statement = positions(opened, line(ticker='CW8.PA', quantity=12,
                                       unit_price=0.0),
                          line('APPLE', ticker='AAPL', quantity=5))

    [gap] = reconcile(opened, statement).drafted

    assert gap.event.unit_price == 520.0 and gap.price_source == 'close'
