"""The closed list of seven, against the live market (#760).

The one assertion in this suite that cannot be made against a fake, because
what it checks is precisely whether the fake would be lying: seven tickers are
written into `benchmarks.py` as facts about Yahoo, and a fund that is delisted,
renamed or moved to another venue goes on reading as a perfectly good constant.
The owner finds out by choosing it and waiting two hours for a history that
never arrives.

**Deselected everywhere but the nightly job.** `-m "not network"` on every pull
request, and `.github/workflows/nightly-benchmarks.yml` is the only thing that
runs it. It is the repository's first scheduled workflow, which is why the
failure has to be worth waking up to: a red nightly job that cries wolf is one
nobody reads by the third week.

**It tells a rate limit from a dead ticker**, and that is the whole design of
it. GitHub's IP ranges are shared and Yahoo throttles them, so the failure mode
this probe meets most often is not a delisting at all — and reported as one it
would be exactly the wolf above. A throttled run skips; only a ticker that
answers *nothing* while its neighbours answer fails.
"""
import pytest

pytest.importorskip('yfinance')

import yfinance as yf                                       # noqa: E402
from yfinance.exceptions import YFRateLimitError            # noqa: E402

from application import benchmarks                          # noqa: E402

pytestmark = pytest.mark.network


def _closes(symbol: str):
    """The fund's recent closes, or ``None`` when Yahoo would not say why."""
    try:
        history = yf.Ticker(symbol).history(period='1mo', interval='1d')
    except YFRateLimitError:
        return None
    except Exception as exc:                                # pragma: no cover
        # An exception that is *not* a rate limit is not an answer either: a
        # transport error says nothing about the ticker. Skipping is the honest
        # reading, and the job runs again tomorrow.
        pytest.skip(f"Yahoo could not be reached for {symbol}: {exc}")
    return history


@pytest.mark.parametrize('benchmark', benchmarks.BENCHMARKS,
                         ids=lambda entry: entry.symbol)
def test_an_offered_reference_still_answers(benchmark):
    """A ticker the selector offers is a promise this keeps.

    An empty history is the delisting, the rename and the venue move all at
    once, and from here they are the same fact: *this is not offerable any
    more*. What the failure costs is a line in `benchmarks.py`; what its
    absence costs is an owner choosing a fund and waiting hours for a history
    that is never coming.
    """
    history = _closes(benchmark.symbol)
    if history is None:
        pytest.skip(
            f"Yahoo rate-limited the probe of {benchmark.symbol}. Not a "
            f"verdict on the ticker: GitHub's ranges are shared and throttled, "
            f"and a delisting reported off a 429 is the false alarm that makes "
            f"a nightly job unreadable.")

    assert not history.empty, (
        f"{benchmark.symbol} ({benchmark.index}) returned no close in the last "
        f"month. It is offered by the selector as one of seven, so either the "
        f"ticker moved and `benchmarks.py` follows it, or the fund is gone and "
        f"the entry goes.")


@pytest.mark.parametrize('benchmark', benchmarks.BENCHMARKS,
                         ids=lambda entry: entry.symbol)
def test_an_offered_reference_still_quotes_in_the_currency_it_declares(benchmark):
    """The currency is a fact the replay converts through, not a label.

    A fund that moved venue keeps its name and changes its unit, and the
    comparison would go on replaying a euro portfolio against a dollar series
    with no conversion asked for — a gap made entirely of the exchange rate.
    """
    history = _closes(benchmark.symbol)
    if history is None:
        pytest.skip(f"Yahoo rate-limited the probe of {benchmark.symbol}.")
    if history.empty:
        pytest.skip(f"{benchmark.symbol} answered nothing; the probe above owns "
                    f"that failure and this one would only repeat it.")

    quoted = yf.Ticker(benchmark.symbol).info.get('currency')
    if not quoted:
        pytest.skip(f"Yahoo named no currency for {benchmark.symbol}.")

    assert quoted.upper() == benchmark.currency, (
        f"{benchmark.symbol} quotes in {quoted} and `benchmarks.py` declares "
        f"{benchmark.currency}. The replay converts through the declared one.")
