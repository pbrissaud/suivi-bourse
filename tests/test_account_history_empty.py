"""Accounts as the app declares them: an empty history, and an id with a charset."""
from test_web_api import build_client_and_store

ACCOUNTS = "id,type,label\npea,PEA,PEA\n"


def test_an_account_with_no_event_has_an_empty_history(tmp_path):
    client, opened = build_client_and_store(tmp_path, accounts=ACCOUNTS)
    # Written under the snapshot's feet, as a declaration just made is.
    opened.execute("INSERT INTO account (id, label) VALUES ('fresh', 'Fresh')")

    answer = client.get('/api/accounts/fresh/history')

    assert answer.status_code == 200
    assert answer.get_json()['points'] == []
    assert client.get('/api/accounts/ghost/history').status_code == 404


def test_an_account_id_typed_in_the_app_is_letters_digits_and_a_few_marks(tmp_path):
    client, _ = build_client_and_store(tmp_path, accounts=ACCOUNTS)

    for bad in ('PEA Mehdi!!', 'mon pea', ''):
        assert client.post('/api/accounts', json={'id': bad}).status_code in (400, 422), bad
    assert client.post('/api/accounts', json={'id': 'a b'}).get_json()['key'] == 'id'
    assert client.post('/api/accounts', json={'id': 'PEA-Mehdi_2.0'}).status_code == 201
