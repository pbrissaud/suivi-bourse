"""The closed list of five, against the live market (#760).

The one assertion in this suite that cannot be made against a fake, because
what it checks is precisely whether the fake would be lying: five tickers are
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

**It talks to `yfinance` directly, and that is the one place in this repository
that may.** `market.py` is the market edge and flattens a rate limit, a
transport error and a dead ticker into the same ``None`` — which is the right
answer for a backfill that will simply retry, and the wrong one here, where
telling those apart is the entire job. Both calls below go through
:func:`_asked` so the two halves cannot drift on what counts as a failure.
"""
import pytest

pytest.importorskip('yfinance')

import yfinance as yf                                       # noqa: E402
from yfinance.exceptions import YFRateLimitError            # noqa: E402

from application import benchmarks                          # noqa: E402

pytestmark = pytest.mark.network


#: What "Yahoo did not answer" is allowed to look like. Narrow on purpose: a
#: probe that swallows every exception reports a green night on a bug of its
#: own, and this job's whole value is that its red means something.
TRANSIENT = (YFRateLimitError, TimeoutError, ConnectionError, OSError)


def _asked(symbol: str, call):
    """Run one Yahoo call under the **same** policy as every other.

    Two calls, one rule, because a probe whose two halves disagree about what
    counts as a failure is a probe nobody can read: a rate limit skips, a
    transport error skips, and anything else propagates as the bug it is.
    """
    try:
        return call()
    except TRANSIENT as exc:
        pytest.skip(
            f"Yahoo did not answer for {symbol} ({type(exc).__name__}). Not a "
            f"verdict on the ticker: GitHub's ranges are shared and throttled, "
            f"and a delisting reported off a 429 is the false alarm that makes "
            f"a nightly job unreadable.")


def _closes(symbol: str):
    """The fund's recent closes. Skips when Yahoo would not say."""
    return _asked(symbol, lambda: yf.Ticker(symbol).history(
        period='1mo', interval='1d'))


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

    assert not history.empty, (
        f"{benchmark.symbol} ({benchmark.index}) returned no close in the last "
        f"month. It is offered by the selector as one of five, so either the "
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
    if history.empty:
        pytest.skip(f"{benchmark.symbol} answered nothing; the probe above owns "
                    f"that failure and this one would only repeat it.")

    quoted = _asked(benchmark.symbol,
                    lambda: yf.Ticker(benchmark.symbol).info).get('currency')
    if not quoted:
        pytest.skip(f"Yahoo named no currency for {benchmark.symbol}.")

    assert quoted.upper() == benchmark.currency, (
        f"{benchmark.symbol} quotes in {quoted} and `benchmarks.py` declares "
        f"{benchmark.currency}. The replay converts through the declared one.")
