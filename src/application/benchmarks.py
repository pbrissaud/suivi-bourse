"""The seven references the comparison of #760 offers, and nothing else.

A **closed** list, on purpose. A free ticker field would let an owner compare
their portfolio against a single stock, a currency pair or a typo, and the
screen would answer with a curve either way. Seven broad-market accumulating
ETFs are the question #760 asks — *would an index fund have done better* — and
the list is short enough that every entry can say what it costs before it is
picked.

One source for three readers, which is why it is a constant and not a table:
the selector renders it, the nightly probe of the closed list walks it, and the
route validates against it. A reference that dropped off Yahoo has to break one
visible thing rather than three quiet ones.

The tickers are Yahoo's own, verified against it on 2026-09-20, and
``inception`` is the first daily close Yahoo actually serves -- not the fund's
legal launch. It is what the selector shows *before* the click, so an owner who
started in 2013 sees that a 2024 fund costs them eleven years of their own
history rather than discovering it afterwards. The replay itself never reads
it: the seed is anchored on the first quoted day **in the store**, which is the
only one the computation can honour.

``pea`` is a French tax-wrapper eligibility, and it enters no computation
whatsoever -- the comparison replays the owner's flows in the owner's own
accounts, under the taxation those accounts already declare. It is here because
the selector groups by it and says so; ungrouped and unexplained it reads as
advice.
"""

from dataclasses import dataclass
from datetime import date
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class Benchmark:
    """One offered reference: what to fetch, what it tracks, what it costs."""

    #: Yahoo's ticker, the one the backfill and the probe ask for.
    symbol: str
    #: The index it follows. The UI names **this** first; the ticker is
    #: subordinate, and the chart legend names the index alone.
    index: str
    #: The currency Yahoo quotes it in. A reference quoted away from the
    #: owner's base currency is replayed through the same conversion as any
    #: holding, and a day with no rate ends the period rather than guessing.
    currency: str
    #: The first daily close Yahoo serves. Truncation, made visible pre-click.
    inception: date
    #: Eligible to a French PEA. Grouped in the selector, absent from the maths.
    pea: bool = False


#: The list, in the order the selector renders it: the general ones, then the
#: PEA group. Seven, and #760 says seven — a longer list stops being a set of
#: answers and becomes a search box with extra steps.
BENCHMARKS: Tuple[Benchmark, ...] = (
    Benchmark('CW8.PA', 'MSCI World', 'EUR', date(2009, 6, 16)),
    Benchmark('CSPX.AS', 'S&P 500', 'EUR', date(2010, 5, 19)),
    Benchmark('MSE.PA', 'Euro Stoxx 50', 'EUR', date(2008, 1, 2)),
    Benchmark('C40.PA', 'CAC 40', 'EUR', date(2008, 1, 2)),
    Benchmark('AEEM.PA', 'MSCI Emerging Markets', 'EUR', date(2010, 11, 30)),
    Benchmark('WPEA.PA', 'MSCI World', 'EUR', date(2024, 4, 2), pea=True),
    Benchmark('PE500.PA', 'S&P 500', 'EUR', date(2019, 4, 25), pea=True),
)

BY_SYMBOL: Dict[str, Benchmark] = {
    benchmark.symbol: benchmark for benchmark in BENCHMARKS}


def offered(symbol: Optional[str]) -> Optional[Benchmark]:
    """The offered reference ``symbol`` names, or ``None``.

    ``None`` is an ordinary answer and not an error: ``PUT /api/settings``
    still writes ``benchmark_symbol`` freely, so a stored value outside this
    list is a value the screen has to render rather than lose.
    """
    return BY_SYMBOL.get(symbol) if symbol else None


__all__ = ['Benchmark', 'BENCHMARKS', 'BY_SYMBOL', 'offered']
