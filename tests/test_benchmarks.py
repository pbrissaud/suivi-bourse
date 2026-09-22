"""The closed list of seven, and the properties three readers depend on.

The selector renders it, the nightly probe walks it and the comparison route
validates against it, so a fact stated here wrongly is stated wrongly three
times. None of these assertions can tell you a ticker has been delisted — that
is the probe's job, against the live market. They hold the shape.
"""

from datetime import date

from application import benchmarks


def test_the_list_is_closed_and_names_each_index_once():
    """Closed, and short enough that every entry can say what it costs.

    A free ticker field would answer with a curve for a single stock, a
    currency pair or a typo. The second half is #1019: two entries used to
    track an index already in the list on a strictly shorter history, so
    picking one measured the same thing over fewer years — for a tax-wrapper
    eligibility that enters no arithmetic at all.
    """
    assert len(benchmarks.BENCHMARKS) == 5

    indices = [entry.index for entry in benchmarks.BENCHMARKS]
    assert len(set(indices)) == len(indices)


def test_every_reference_is_named_once():
    """The lookup is a dict, so a duplicate would silently shadow an entry."""
    symbols = [entry.symbol for entry in benchmarks.BENCHMARKS]

    assert len(set(symbols)) == len(symbols)
    assert set(benchmarks.BY_SYMBOL) == set(symbols)


def test_every_reference_declares_an_inception_and_a_currency():
    """What the selector shows before the click, and what the replay converts.

    The inception is the first daily close Yahoo serves, not a legal launch
    date: it is the history that can actually be rebuilt. The replay never
    reads it — the seed anchors on the first quoted day **in the store** — so
    it is a pre-click promise and nothing else.
    """
    for entry in benchmarks.BENCHMARKS:
        assert isinstance(entry.inception, date)
        assert date(2000, 1, 1) < entry.inception < date(2030, 1, 1)
        assert len(entry.currency) == 3 and entry.currency.isupper()
        assert entry.index and not entry.index.startswith(entry.symbol)


def test_a_stored_value_outside_the_list_is_answered_with_none():
    """``PUT /api/settings`` stays open, so the screen meets off-list values.

    It has to render one as a named entry rather than drop it — a reference
    that disappears from its own selector is a reference the owner cannot
    switch away from.
    """
    assert benchmarks.offered('CW8.PA') is benchmarks.BY_SYMBOL['CW8.PA']
    assert benchmarks.offered('AAPL') is None
    assert benchmarks.offered(None) is None
    assert benchmarks.offered('') is None
    # The two #1019 withdrew are exactly that case for an install that had
    # already stored one: the setting survives, the screen renders it, and
    # only the rebuild bar's target goes missing.
    assert benchmarks.offered('WPEA.PA') is None
    assert benchmarks.offered('PE500.PA') is None
