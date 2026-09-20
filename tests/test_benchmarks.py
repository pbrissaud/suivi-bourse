"""The closed list of seven, and the properties three readers depend on.

The selector renders it, the nightly probe walks it and the comparison route
validates against it, so a fact stated here wrongly is stated wrongly three
times. None of these assertions can tell you a ticker has been delisted — that
is the probe's job, against the live market. They hold the shape.
"""

from datetime import date

from application import benchmarks


def test_the_list_is_closed_at_seven():
    """#760's own number, asserted rather than assumed.

    A free ticker field would answer with a curve for a single stock, a
    currency pair or a typo. Seven is short enough that every entry can say
    what it costs — its index, its currency and the history it cannot give you
    — before it is picked.
    """
    assert len(benchmarks.BENCHMARKS) == 7


def test_every_reference_is_named_once():
    """The lookup is a dict, so a duplicate would silently shadow an entry."""
    symbols = [entry.symbol for entry in benchmarks.BENCHMARKS]

    assert len(set(symbols)) == len(symbols)
    assert set(benchmarks.BY_SYMBOL) == set(symbols)


def test_the_pea_group_comes_last_because_that_is_how_it_is_rendered():
    """The order of the constant **is** the order of the selector.

    The group defuses a label that enters no computation: two of the seven are
    PEA-eligible, and ungrouped they read as advice pointing at the worst
    available answer — a 2024 fund that costs a long-standing owner a decade of
    their own history.
    """
    flags = [entry.pea for entry in benchmarks.BENCHMARKS]

    assert flags == sorted(flags)
    assert flags.count(True) == 2


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
