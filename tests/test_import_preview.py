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

TRADE_REPUBLIC = (
    "datetime,date,account_type,category,type,asset_class,name,symbol,shares,"
    "price,amount,fee,tax,currency\n"
    "2026-10-01T10:00:00,2026-10-01,DEFAULT,TRADING,BUY,FUND,Amundi MSCI World,"
    "LU1681043599,1,541.20,-541.20,0,0,EUR\n"
    "2026-10-01T10:00:00,2026-10-01,DEFAULT,CASH,CUSTOMER_INBOUND,CASH,,,,,450,0,0,EUR\n"
    "2026-10-27T10:00:00,2026-10-27,DEFAULT,TRADING,BUY,FUND,iShares Core,"
    "IE00B5BMR087,3,41.20,-123.60,1,0,EUR\n"
    "2026-10-28T10:00:00,2026-10-28,DEFAULT,CARD,CARD_TRANSACTION,CASH,Shop,,,,-5,0,0,EUR\n"
)

BOURSORAMA = (
    "Date opération;Opération;Valeur;ISIN;Quantité;Cours;Frais;Montant net;Libellé\n"
    "06/11/2026;Achat comptant;Amundi MSCI World;LU1681043599;2;512,30;1,35;1 025,95;CW8\n"
    "03/11/2026;Coupon;Air Liquide;FR0000120073;;;;18,40;AI\n"
    "30/09/2026;Vente comptant;TotalEnergies;FR0000120271;5;58,12;0;290,60;TTE\n"
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


def test_a_trade_republic_file_is_detected_and_judged_line_by_line(ledger):
    client, _ = ledger
    answer = upload(client, TRADE_REPUBLIC, 'tr.csv')

    assert answer.status_code == 200
    body = answer.get_json()
    assert body['format'] == 'Trade Republic'
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


def test_a_french_export_reads_decimal_commas_and_dates(ledger):
    client, _ = ledger
    body = upload(client, BOURSORAMA, 'boursorama.csv').get_json()

    assert body['format'] == 'Boursorama'
    first = body['rows'][0]
    assert (first['date'], first['event_type'], first['quantity'],
            first['unit_price'], first['fee']) == ('2026-11-06', 'BUY', 2.0, 512.3, 1.35)
    assert body['rows'][1]['event_type'] == 'DIVIDEND'
    assert body['rows'][1]['amount'] == 18.4
    assert body['rows'][2]['event_type'] == 'SELL'


def test_association_commits_the_file_and_teaches_the_isin(ledger):
    client, opened = ledger
    body = upload(client, BOURSORAMA, 'boursorama.csv').get_json()
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
    second = upload(client, BOURSORAMA, 'boursorama.csv').get_json()
    assert statuses(second) == [(1, 'duplicate'), (2, 'duplicate'),
                                (3, 'unknown_security')]
    assert second['rows'][0]['matched_on'] == ['isin', 'date', 'quantity', 'price']


def test_the_commit_judges_again_and_writes_each_row_once(ledger):
    client, opened = ledger
    csv = ("date,event_type,symbol,quantity,unit_price,fee,amount,notes\n"
           "2026-11-02,BUY,CW8.PA,1,500,,,\n")
    first = upload(client, csv, 'a.csv').get_json()
    second = upload(client, csv, 'b.csv').get_json()
    assert first['format'] == 'CSV'
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

    assert body['format'] == 'Excel'
    assert [row['status'] for row in body['rows']] == ['new', 'new']


def test_a_file_that_is_no_ledger_is_refused_and_a_format_can_be_named(ledger):
    client, _ = ledger
    assert upload(client, "a,b\n1,2\n", 'x.csv').status_code == 422
    assert upload(client, "a,b\n1,2\n", 'x.txt').status_code == 422
    assert upload(client, TRADE_REPUBLIC, 'tr.csv', format='nope').status_code == 422
    assert upload(client, TRADE_REPUBLIC, 'tr.csv', account='ghost').status_code == 422
    named = upload(client, TRADE_REPUBLIC, 'tr.csv', format='trade_republic')
    assert named.get_json()['format'] == 'Trade Republic'


def test_a_commit_refuses_a_resolution_for_a_row_that_does_not_exist(ledger):
    client, _ = ledger
    body = upload(client, BOURSORAMA, 'boursorama.csv').get_json()

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
