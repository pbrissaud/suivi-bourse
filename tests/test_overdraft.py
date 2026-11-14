"""A withdrawal larger than the account's cash is refused, like a short sale."""
import pytest

from test_web_api import build_client_and_store

ACCOUNTS = "id,type,label\npea,PEA,PEA\n"
HELD = (
    "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2026-09-01,DEPOSIT,pea,,,,,,1000,\n"
    "2026-10-01,DEPOSIT,pea,,,,,,500,\n"
)


@pytest.fixture
def client(tmp_path):
    client, opened = build_client_and_store(tmp_path, accounts=ACCOUNTS, events=HELD)
    yield client
    opened.close()


def withdrawal(day, amount):
    return {'date': day, 'event_type': 'WITHDRAWAL', 'account': 'pea',
            'amount': amount}


@pytest.mark.parametrize('route', ['/api/events', '/api/events/preview'])
def test_a_withdrawal_larger_than_the_cash_is_refused_naming_the_field(client, route):
    answer = client.post(route, json=withdrawal('2026-11-01', 1600))

    assert answer.status_code == 422
    assert answer.get_json()['key'] == 'amount'
    assert answer.get_json()['code'] == 'overdraft'


def test_the_cash_that_exists_that_day_is_what_counts(client):
    # 1500 is held on 11-01, but only 1000 on 09-15: a later deposit does not
    # make the money exist on the day it leaves.
    assert client.post('/api/events', json=withdrawal('2026-09-15', 1200)).status_code == 422
    assert client.post('/api/events', json=withdrawal('2026-11-01', 1500)).status_code == 201


def test_the_effect_of_a_sale_says_what_it_realises(tmp_path):
    held = (
        "date,event_type,account,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2026-09-01,DEPOSIT,pea,,,,,,2000,\n"
        "2026-10-01,BUY,pea,CW8.PA,Amundi MSCI World,1,541.20,1.35,,\n"
    )
    client, _ = build_client_and_store(tmp_path, accounts=ACCOUNTS, events=held)

    def sale(price):
        return client.post('/api/events/preview', json={
            'date': '2026-11-07', 'event_type': 'SELL', 'account': 'pea',
            'symbol': 'CW8.PA', 'quantity': 1, 'unit_price': price}).get_json()

    # Bought at 542.55 all-in: a loss of 50.49 at 492.06, a gain at 600.
    assert sale(492.06)['realised_gain'] == pytest.approx(-50.49)
    assert sale(600)['realised_gain'] == pytest.approx(57.45)


def test_an_edit_is_judged_without_the_row_it_replaces(client):
    created = client.post('/api/events', json=withdrawal('2026-11-01', 1000)).get_json()

    assert client.patch(f"/api/events/{created['id']}",
                        json=withdrawal('2026-11-01', 1500)).status_code == 200
    assert client.patch(f"/api/events/{created['id']}",
                        json=withdrawal('2026-11-01', 1501)).status_code == 422
