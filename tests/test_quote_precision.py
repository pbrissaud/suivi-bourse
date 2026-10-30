"""The close the venue quoted, not Yahoo's float32 of it (#1458).

Yahoo holds its prices in single precision and serves them widened to double:
173.82 arrives as ``173.82000732421875``, and the store, the CSV export and every
sum downstream carried the tail. Read back at the market edge, once.
"""

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from application import market

UTC = timezone.utc


def _yahoo(value):
    """What Yahoo serves for a price it was given as ``value``."""
    return float(np.float32(value))


class _Ticker:
    info = {'currency': 'EUR'}
    splits = pd.Series(dtype=float)

    def __init__(self, closes):
        self.closes = closes

    def history(self, **kwargs):
        index = pd.to_datetime([day for day, _ in self.closes], utc=True)
        return pd.DataFrame({'Close': [_yahoo(price)
                                       for _, price in self.closes]},
                            index=index)


@pytest.fixture
def served(mocker):
    def _serve(closes):
        mocker.patch.object(market.yf, 'Ticker',
                            lambda symbol: _Ticker(closes))
    return _serve


def test_yahoo_serves_the_noise_this_removes():
    assert _yahoo(173.82) == 173.82000732421875


def test_the_backfill_stores_the_quoted_close(served):
    served([('2026-10-22', 173.82)])
    now = datetime.now(UTC)

    prices, _ = market.price_history('AI.PA', now - timedelta(days=30), now, 0)

    assert prices[0]['price'] == 173.82


def test_the_live_quote_is_the_quoted_close(served):
    served([('2026-10-22', 170.0), ('2026-10-23', 173.82)])

    price, _ = market.latest_quote('AI.PA')

    assert price == 173.82


def test_a_rate_keeps_every_digit_yahoo_has(served):
    """Not rounded to ``priceHint``: that would make 1.1129661 a 1.113."""
    served([('2026-10-23', 1.1129661)])

    assert market.pair_rate('EURUSD=X') == 1.1129661
    assert list(market.pair_series(
        'EURUSD=X', datetime(2026, 10, 1).date(),
        datetime(2026, 10, 30).date()).values()) == [1.1129661]


def test_a_double_that_is_no_float32_is_kept_whole():
    assert market.as_quoted(0.1 + 0.2) == 0.1 + 0.2
