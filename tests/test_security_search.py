"""``GET /api/securities`` and ``market.search_securities`` (#1268).

``market.yf.Search`` is the one faked edge; the autouse guard in ``conftest``
refuses any call a test did not fake.
"""
import pytest
from yfinance.exceptions import YFRateLimitError

from application import market
from test_web_api import build_client


def _quote(symbol, quote_type='EQUITY', **members):
    return {'symbol': symbol, 'quoteType': quote_type, **members}


@pytest.fixture
def search(monkeypatch):
    """Fake ``yf.Search``: ``search.quotes`` is the answer, ``search.calls`` the asks."""
    class Fake:
        quotes = []
        error = None
        calls = []

        def __call__(self, query, **kwargs):
            self.calls.append((query, kwargs))
            if self.error is not None:
                raise self.error
            return type('Search', (), {'quotes': self.quotes})()

    fake = Fake()
    fake.calls = []
    monkeypatch.setattr(market.yf, 'Search', fake)
    monkeypatch.setattr(
        market.time, 'sleep',
        lambda seconds: pytest.fail('the search must never sleep'))
    return fake


def _get(tmp_path, query='zeta'):
    return build_client(tmp_path).get('/api/securities', query_string={'q': query})


def test_the_search_keeps_securities_and_drops_other_quote_types(tmp_path, search):
    search.quotes = [_quote('ZZA.PA'), _quote('ZZ=F', 'FUTURE'),
                     _quote('ZZE', 'ETF'), _quote('ZZ-USD', 'CRYPTOCURRENCY'),
                     _quote('ZZF', 'MUTUALFUND'), _quote('ZZI', 'INDEX'),
                     {'quoteType': 'EQUITY'}]

    body = _get(tmp_path).get_json()

    assert [line['symbol'] for line in body['securities']] == [
        'ZZA.PA', 'ZZE', 'ZZ-USD', 'ZZF']
    assert body['query'] == 'zeta'


def test_a_name_is_the_long_name_with_its_padding_collapsed(tmp_path, search):
    search.quotes = [
        _quote('ZZA.PA', longname='Zeta  Alpha', shortname='ZETA', exchDisp='Paris',
               exchange='PAR'),
        _quote('ZZB', shortname='ZETA   BETA     ', exchange='NYQ'),
        _quote('ZZC')]

    assert _get(tmp_path).get_json()['securities'] == [
        {'symbol': 'ZZA.PA', 'name': 'Zeta Alpha', 'exchange': 'Paris'},
        {'symbol': 'ZZB', 'name': 'ZETA BETA', 'exchange': 'NYQ'},
        {'symbol': 'ZZC', 'name': None, 'exchange': None}]


def test_the_search_returns_at_most_eight_lines_in_yahoos_order(tmp_path, search):
    search.quotes = [_quote(f'Z{n}') for n in range(10)]

    securities = _get(tmp_path).get_json()['securities']

    assert [line['symbol'] for line in securities] == [f'Z{n}' for n in range(8)]


def test_the_search_is_bounded_by_the_interactive_timeout(tmp_path, search):
    search.quotes = []

    _get(tmp_path)

    (query, kwargs), = search.calls
    assert query == 'zeta'
    assert kwargs['timeout'] == market.INTERACTIVE_TIMEOUT_S
    assert kwargs['raise_errors'] is True


def test_a_provider_that_fails_answers_null_not_an_error(tmp_path, search):
    search.error = RuntimeError('network down')

    response = _get(tmp_path)

    assert response.status_code == 200
    assert response.get_json()['securities'] is None


def test_a_rate_limited_provider_answers_null_and_is_never_retried(tmp_path, search):
    search.error = YFRateLimitError()

    response = _get(tmp_path)

    assert response.get_json()['securities'] is None
    assert len(search.calls) == 1


def test_an_empty_answer_is_an_empty_list(tmp_path, search):
    search.quotes = []

    assert _get(tmp_path).get_json()['securities'] == []


@pytest.mark.parametrize('query', ['', ' ', 'a', ' a ', 'x' * 65])
def test_a_query_under_two_or_over_sixty_four_characters_is_refused(
        tmp_path, search, query):
    response = _get(tmp_path, query)

    assert response.status_code == 422
    assert response.get_json()['key'] == 'q'
    assert search.calls == []


def test_an_unfaked_search_is_refused_by_the_suite():
    with pytest.raises(RuntimeError, match='did not fake it'):
        market.yf.Search('zeta')
