"""The import in two steps, and the dry run of an event write (§ 3.4, § 3.5)."""
import io

import openpyxl
import pytest

from test_web_api import build_client_and_store

ACCOUNTS = "id,type,label\npea,PEA,PEA\n"
HELD = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2026-09-01,DEPOSIT,pea,,,,,,2000,\n"
    "2026-10-01,BUY,pea,CW8.PA,Amundi MSCI World,1,541.20,1.35,,\n"
    "2026-10-01,DEPOSIT,pea,,,,,,450,\n"
)

HEADER = "date,event_type,symbol,isin,name,quantity,unit_price,fee,amount,notes\n"
UNKNOWN_ISIN = (
    HEADER
    + "2026-10-01,BUY,,LU1681043599,Amundi MSCI World,1,541.20,1.35,,\n"
    + "2026-10-01,DEPOSIT,,,,,,,450,\n"
    + "2026-10-27,BUY,,IE00B5BMR087,iShares Core,3,41.20,1,,\n"
    + "2026-10-28,CARD_TRANSACTION,,,,,,,5,\n"
)

# Semicolons, decimal commas and day-first dates, as a spreadsheet saves them.
FRENCH = (
    "date;event_type;symbol;isin;name;quantity;unit_price;fee;amount;notes\n"
    "06/11/2026;BUY;;LU1681043599;Amundi MSCI World;2;512,30;1,35;;CW8\n"
    "03/11/2026;DIVIDEND;;FR0000120073;Air Liquide;;;;18,40;AI\n"
    "30/09/2026;SELL;;FR0000120271;TotalEnergies;5;58,12;0;;TTE\n"
)


def upload(client, body, name, account='pea', **form):
    data = {'file': (io.BytesIO(body if isinstance(body, bytes) else body.encode()), name),
            'account_id': account, **form}
    return client.post('/api/events/import/preview', data=data,
                       content_type='multipart/form-data')


@pytest.fixture
def ledger(tmp_path):
    client, opened = build_client_and_store(tmp_path, accounts=ACCOUNTS, events=HELD)
    yield client, opened
    opened.close()


def statuses(answer):
    return [(row['row'], row['status']) for row in answer['rows']]


def test_a_file_is_judged_line_by_line(ledger):
    client, _ = ledger
    answer = upload(client, UNKNOWN_ISIN, 'unknown.csv')

    assert answer.status_code == 200
    body = answer.get_json()
    # No ISIN is known to the store yet, but the ledger already calls a security
    # "Amundi MSCI World": the first line is found by its name, and it repeats a
    # held purchase. The other ISIN names nothing the store knows.
    assert statuses(body) == [(1, 'duplicate'), (2, 'duplicate'),
                              (3, 'unknown_security'), (4, 'unreadable')]
    assert body['rows'][0]['matched_on'] == ['symbol', 'date', 'quantity', 'price']
    deposit = body['rows'][1]
    assert deposit['matched_on'] == ['date', 'amount']
    assert deposit['matched_event_id'] is not None
    assert body['rows'][0]['isin'] == 'LU1681043599'
    assert 'CARD_TRANSACTION' in body['rows'][3]['reason']
    assert body['counts'] == {'new': 0, 'duplicate': 2, 'unknown_security': 1,
                              'unreadable': 1}


def test_a_spreadsheet_file_reads_decimal_commas_and_dates(ledger):
    client, _ = ledger
    body = upload(client, FRENCH, 'french.csv').get_json()

    first = body['rows'][0]
    assert (first['date'], first['event_type'], first['quantity'],
            first['unit_price'], first['fee']) == ('2026-11-06', 'BUY', 2.0, 512.3, 1.35)
    assert body['rows'][1]['event_type'] == 'DIVIDEND'
    assert body['rows'][1]['amount'] == 18.4
    assert body['rows'][2]['event_type'] == 'SELL'


def test_association_commits_the_file_and_teaches_the_isin(ledger):
    client, opened = ledger
    body = upload(client, FRENCH, 'french.csv').get_json()
    # Row 1 is found by the name the ledger already gives its security.
    assert statuses(body) == [(1, 'new'), (2, 'unknown_security'),
                              (3, 'unknown_security')]

    answer = client.post('/api/events/import/commit', json={
        'token': body['token'],
        'associate': [{'row': 2, 'security': 'ai.pa'}]})

    assert answer.status_code == 201
    # The SELL has no association: it stays out, and the file is not refused.
    assert answer.get_json() == {'imported': 2, 'duplicate': 0,
                                 'unknown_security': 1, 'unreadable': 0}
    written = opened.query(
        "SELECT symbol, event_type, quantity, unit_price, fee FROM event "
        "WHERE date = DATE '2026-11-06'")
    assert written == [('CW8.PA', 'BUY', 2.0, 512.3, 1.35)]
    assert opened.query("SELECT isin FROM symbol_isin WHERE symbol = 'CW8.PA'") == [
        ('LU1681043599',)]

    # The token is spent; the ISIN is now known to the store, and the lines
    # written are what the same file repeats.
    again = client.post('/api/events/import/commit', json={'token': body['token']})
    assert again.status_code == 404
    second = upload(client, FRENCH, 'french.csv').get_json()
    assert statuses(second) == [(1, 'duplicate'), (2, 'duplicate'),
                                (3, 'unknown_security')]
    assert second['rows'][0]['matched_on'] == ['isin', 'date', 'quantity', 'price']


def test_the_commit_judges_again_and_writes_each_row_once(ledger):
    client, opened = ledger
    csv = ("date,event_type,symbol,quantity,unit_price,fee,amount,notes\n"
           "2026-11-02,BUY,CW8.PA,1,500,,,\n")
    first = upload(client, csv, 'a.csv').get_json()
    second = upload(client, csv, 'b.csv').get_json()
    assert first['counts']['new'] == 1

    one = client.post('/api/events/import/commit', json={'token': first['token']})
    two = client.post('/api/events/import/commit', json={'token': second['token']})

    assert one.get_json()['imported'] == 1
    assert two.get_json() == {'imported': 0, 'duplicate': 1,
                              'unknown_security': 0, 'unreadable': 0}
    assert opened.query("SELECT count(*) FROM event WHERE date = DATE '2026-11-02'") == [(1,)]


def test_an_excel_file_is_read_like_a_csv(ledger):
    client, _ = ledger
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(['date', 'event_type', 'symbol', 'quantity', 'unit_price', 'amount'])
    sheet.append(['2026-11-02', 'BUY', 'CW8.PA', 1, 500, None])
    sheet.append(['2026-11-03', 'DEPOSIT', None, None, None, 100])
    out = io.BytesIO()
    book.save(out)

    body = upload(client, out.getvalue(), 'ledger.xlsx').get_json()

    assert [row['status'] for row in body['rows']] == ['new', 'new']


def test_a_file_that_is_no_ledger_is_refused(ledger):
    client, _ = ledger
    assert upload(client, "a,b\n1,2\n", 'x.csv').status_code == 422
    assert upload(client, "a,b\n1,2\n", 'x.txt').status_code == 422
    assert upload(client, UNKNOWN_ISIN, 'unknown.csv', account='ghost').status_code == 422


def test_a_commit_refuses_a_resolution_for_a_row_that_does_not_exist(ledger):
    client, _ = ledger
    body = upload(client, FRENCH, 'french.csv').get_json()

    answer = client.post('/api/events/import/commit', json={
        'token': body['token'], 'associate': [{'row': 99, 'security': 'X.PA'}]})

    assert answer.status_code == 422


def test_the_effect_of_a_purchase_is_the_cash_it_leaves(ledger):
    client, opened = ledger
    held = opened.query('SELECT count(*) FROM event')

    answer = client.post('/api/events/preview', json={
        'date': '2026-11-07', 'event_type': 'BUY', 'account': 'pea',
        'symbol': 'CW8.PA', 'quantity': 1, 'unit_price': 541.2, 'fee': 1.35})

    assert answer.status_code == 200
    # 2000 + 450 - 542.55 = 1907.45 held; the candidate takes 542.55 more
    body = answer.get_json()
    assert body['amount'] == pytest.approx(542.55)
    assert body['fee'] == pytest.approx(1.35)
    assert body['direction'] == 'debit'
    assert body['cash_before'] == pytest.approx(1907.45)
    assert body['cash_after'] == pytest.approx(1907.45 - 542.55)
    assert opened.query('SELECT count(*) FROM event') == held


def test_the_effect_of_an_edit_leaves_out_the_row_it_replaces(ledger):
    client, opened = ledger
    (event_id,) = opened.query(
        "SELECT id FROM event WHERE event_type = 'DEPOSIT' AND amount = 450")[0]

    answer = client.post('/api/events/preview', json={
        'id': event_id, 'date': '2026-10-01', 'event_type': 'DEPOSIT',
        'account': 'pea', 'amount': 500})

    body = answer.get_json()
    assert body['direction'] == 'credit'
    assert body['cash_before'] == pytest.approx(2000 - 542.55)
    assert body['cash_after'] == pytest.approx(2000 - 542.55 + 500)


def test_the_effect_is_refused_as_the_write_would_be(ledger):
    client, _ = ledger
    oversell = client.post('/api/events/preview', json={
        'date': '2026-11-07', 'event_type': 'SELL', 'account': 'pea',
        'symbol': 'CW8.PA', 'quantity': 5, 'unit_price': 500})
    unknown_account = client.post('/api/events/preview', json={
        'date': '2026-11-07', 'event_type': 'DEPOSIT', 'account': 'ghost', 'amount': 5})
    gone = client.post('/api/events/preview', json={
        'id': 999999, 'date': '2026-11-07', 'event_type': 'DEPOSIT',
        'account': 'pea', 'amount': 5})

    assert oversell.status_code == 409
    assert unknown_account.status_code == 422
    assert gone.status_code == 404


TWO_ACCOUNTS = "id,type,label\npea,PEA,PEA\ncto,CTO,CTO\n"
EXPORT = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2026-09-01,DEPOSIT,pea,,,,,,2000,\n"
    "2026-09-01,DEPOSIT,cto,,,,,,2000,\n"
    "2026-09-02,DEPOSIT,,,,,,,10,\n"
    "2026-09-03,DEPOSIT,nope,,,,,,10,\n"
)


def test_a_full_export_keeps_each_row_in_its_own_account(tmp_path):
    client, opened = build_client_and_store(
        tmp_path, accounts=TWO_ACCOUNTS,
        events="date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
               "2026-09-01,DEPOSIT,pea,,,,,,2000,\n")
    body = upload(client, EXPORT, 'export.csv', account='cto').get_json()

    assert body['has_accounts'] is True
    # Row 1 repeats the PEA deposit; row 2 is the same day and amount in the
    # CTO, whose ledger is empty: a duplicate is sought in the row's own account.
    assert [(r['row'], r['status'], r['account']) for r in body['rows'][:3]] == [
        (1, 'duplicate', 'pea'), (2, 'new', 'cto'), (3, 'new', 'cto')]
    assert body['rows'][3]['status'] == 'unreadable'
    assert 'nope' in body['rows'][3]['reason']

    done = client.post('/api/events/import/commit', json={'token': body['token']})
    assert done.get_json()['imported'] == 2
    rows = opened.query("SELECT account FROM event WHERE event_type = 'DEPOSIT'")
    assert sorted(r[0] for r in rows) == ['cto', 'cto', 'pea']
    opened.close()


def test_a_workbook_is_read_on_every_sheet_in_sheet_order(ledger):
    """The export writes one sheet per year: the round trip keeps every row."""
    from datetime import date

    from application.events import export
    from application.events.schemas import Event, EventType

    events = [Event(date=date(year, 3, 1), event_type=EventType.DEPOSIT,
                    account='pea', amount=100.0 + n)
              for n, year in enumerate((2023, 2023, 2024, 2025, 2025, 2025))]
    book = export.render_events_workbook(events, 'EUR')
    assert len(openpyxl.load_workbook(io.BytesIO(book)).sheetnames) == 3

    client, _ = ledger
    body = upload(client, book, 'export.xlsx').get_json()

    assert len(body['rows']) == len(events)
    assert [row['date'][:4] for row in body['rows']] == [
        '2023', '2023', '2024', '2025', '2025', '2025']


def test_a_ticker_nobody_resolves_is_an_unknown_security(ledger, monkeypatch):
    from application import import_currency
    client, _ = ledger
    csv = (HEADER
           + "2026-11-02,BUY,ZZZZ,,,1,10,0,,\n"
           + "2026-11-02,BUY,GOOD,,,1,10,0,,\n"
           + "2026-11-02,BUY,CW8.PA,,,1,10,0,,\n")
    asked = []

    def look_up(symbol):
        asked.append(symbol)
        return 'EUR' if symbol == 'GOOD' else None

    monkeypatch.setattr(import_currency, '_look_up', look_up)
    body = upload(client, csv, 'tickers.csv').get_json()

    # CW8.PA is held by the ledger: no lookup. GOOD answers. ZZZZ does not.
    assert statuses(body) == [(1, 'unknown_security'), (2, 'new'), (3, 'new')]
    assert sorted(asked) == ['GOOD', 'ZZZZ']

    # Associating the line writes it under the ticker the owner names.
    done = client.post('/api/events/import/commit', json={
        'token': body['token'], 'associate': [{'row': 1, 'security': 'GOOD'}]})
    assert done.get_json()['imported'] == 3


def test_an_unreadable_row_carries_a_code_and_the_file_refusal_too(ledger):
    client, _ = ledger
    body = upload(client, HEADER + "not-a-day,BUY,CW8.PA,,,1,10,0,,\n", 'x.csv').get_json()
    row = body['rows'][0]
    assert (row['status'], row['reason_code'], row['reason_values']) == (
        'unreadable', 'bad_date', {'value': 'not-a-day'})

    refused = upload(client, "a,b\n1,2\n", 'x.csv')
    assert refused.get_json()['code'] == 'header'
    assert upload(client, "a", 'x.txt').get_json()['code'] == 'not_a_ledger'


def test_a_file_with_no_stated_unit_asks_about_a_security_quoted_elsewhere(
        ledger, monkeypatch):
    from application import import_currency
    client, opened = ledger
    opened.execute("INSERT INTO setting (key, value) VALUES ('base_currency', 'EUR') "
                   "ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    monkeypatch.setattr(import_currency, '_look_up',
                        lambda symbol: 'USD' if symbol == 'AAPL' else 'EUR')
    csv = HEADER + "2026-11-02,BUY,AAPL,,,1,200,0,,\n"

    body = upload(client, csv, 'us.csv').get_json()
    assert body['base_currency'] == 'EUR'
    assert body['foreign_lines'] == [{'symbol': 'AAPL', 'currency': 'USD', 'rows': 1}]

    # The app's own export states its unit: nothing to ask.
    stated = ("date,event_type,symbol,quantity,unit_price,base_currency\n"
              "2026-11-02,BUY,AAPL,1,200,EUR\n")
    assert upload(client, stated, 'us.csv').get_json()['foreign_lines'] == []

    # Said to be in dollars, with no rate known, the commit refuses and writes nothing.
    refused = client.post('/api/events/import/commit', json={
        'token': body['token'],
        'foreign': [{'symbol': 'AAPL', 'currency': 'USD', 'amounts_in': 'quote'}]})
    assert refused.status_code == 422
    assert opened.query("SELECT count(*) FROM event WHERE symbol = 'AAPL'") == [(0,)]

    # Said to be in euros, it is written as it is, stamped with that answer.
    body = upload(client, csv, 'us.csv').get_json()
    done = client.post('/api/events/import/commit', json={
        'token': body['token'],
        'foreign': [{'symbol': 'AAPL', 'currency': 'USD', 'amounts_in': 'base'}]})
    assert done.status_code == 201
    assert opened.query("SELECT unit_price FROM event WHERE symbol = 'AAPL'") == [(200.0,)]
