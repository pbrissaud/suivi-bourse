"""The advisories (issue #829, ADR-0036 / ADR-0037).

Everything runs against a **real store** — the suite's one rule — and the
assertions go on the rows and on what the module answers. That matters
particularly here, because the whole feature is a claim about *what is stored
and what is not*: an advisory has no row, the acknowledgement has one, and the
row carries an expiry the acknowledgement next door deliberately does not.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

import advisories
import store as store_module


NOW = datetime(2026, 8, 26, 8, 10, tzinfo=timezone.utc)


def _account(opened, identifier: str, label: str) -> None:
    opened.execute(
        'INSERT INTO account (id, type, label) VALUES (?, ?, ?) '
        'ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label',
        [identifier, 'CTO', label])


def _metrics(opened, account: str, day: date, cash: float,
             total: float) -> None:
    """One day of an account's perf series — the row the panel reads its share
    off, and the very row ``/api/accounts`` publishes its figures from."""
    opened.execute(
        'INSERT INTO account_metrics (account, day, cash_balance, '
        '                             holdings_value, total_value) '
        'VALUES (?, ?, ?, ?, ?)',
        [account, day, cash, total - cash, total])


def _keys(found):
    return [one.key for one in found]


# --------------------------------------------------------------------------- #
# The table: the twelfth, and it carries the expiry
# --------------------------------------------------------------------------- #

def test_the_product_declares_twelve_tables_and_the_twelfth_is_the_ack():
    """ADR-0037's own clause, on the source rather than in prose.

    The acknowledgement is a **table** and not a column on ``installation_fact``:
    the DDL runs with ``IF NOT EXISTS`` and there is no migration machinery, so
    a column added there would exist on no store created before it.
    """
    assert len(store_module.TABLES) == 12
    assert 'advisory_ack' in store_module.TABLES


def test_the_ack_row_carries_an_expiry_and_the_fact_row_does_not(store):
    """The one structural difference between the two acknowledgements.

    An installation fact is acknowledged **for good**, on purpose; an advisory
    is put to sleep for a window, so the row has to say when it wakes.
    """
    columns = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'advisory_ack'")}
    assert columns == {'key', 'acknowledged_at', 'expires_at'}

    facts = {row[0] for row in store.query(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'installation_fact'")}
    assert 'expires_at' not in facts


# --------------------------------------------------------------------------- #
# The cash share: what raises one, and what does not
# --------------------------------------------------------------------------- #

def test_an_account_sitting_on_cash_raises_one_named_after_it(store):
    _account(store, 'cto', 'CTO Trade Republic')
    _metrics(store, 'cto', date(2026, 8, 26), cash=1430.56, total=5766.22)

    found = advisories.listing(store, NOW)

    assert _keys(found) == ['cash_share:cto']
    one = found[0]
    assert one.kind == advisories.CASH_SHARE
    # The subject is the panel's heading and the server decides it: a front
    # inventing one for a key it does not know would be a second authority.
    assert one.subject == advisories.SUBJECT_ACCOUNTS
    assert one.detail['account'] == 'cto'
    assert one.detail['label'] == 'CTO Trade Republic'
    assert one.detail['share'] == pytest.approx(0.2481, abs=1e-4)
    # No `first_seen_at`: an advisory is derived on every read and stored
    # nowhere, so *noticed on* is *read on* and nothing older is claimed.
    assert one.observed_at == NOW


def test_an_account_whose_cash_is_a_rounding_raises_nothing(store):
    _account(store, 'pea', 'PEA')
    _metrics(store, 'pea', date(2026, 8, 26), cash=400.0, total=15720.10)

    assert advisories.listing(store, NOW) == []


def test_an_account_with_no_figures_at_all_raises_nothing(store):
    """A share of nothing is not a small share; it is no figure.

    An install whose perf cycle has never run has a row for no account, and a
    total at zero is the same absence one step along.
    """
    _account(store, 'pea', 'PEA')
    assert advisories.listing(store, NOW) == []

    _metrics(store, 'pea', date(2026, 8, 26), cash=0.0, total=0.0)
    assert advisories.listing(store, NOW) == []


def test_it_reads_the_newest_day_and_not_the_series(store):
    """The chip on the rail and the card in the panel read one row.

    ``/api/accounts`` publishes the newest point of every account; an advisory
    computed off an older one would comment on a figure nothing on screen shows.
    """
    _account(store, 'cto', 'CTO')
    _metrics(store, 'cto', date(2026, 8, 1), cash=1400.0, total=5000.0)
    _metrics(store, 'cto', date(2026, 8, 26), cash=10.0, total=5000.0)

    assert advisories.listing(store, NOW) == []


# --------------------------------------------------------------------------- #
# The acknowledgement: thirty days, and never for good
# --------------------------------------------------------------------------- #

def _sleeping_account(store):
    _account(store, 'cto', 'CTO Trade Republic')
    _metrics(store, 'cto', date(2026, 8, 26), cash=1430.56, total=5766.22)


def test_acknowledging_puts_it_to_sleep_for_thirty_days(store):
    _sleeping_account(store)

    advisory, acknowledged = advisories.acknowledge(
        store, 'cash_share:cto', NOW)

    assert advisory.key == 'cash_share:cto'
    assert acknowledged.expires_at == NOW + timedelta(days=30)
    assert advisories.ACK_WINDOW == timedelta(days=30)
    # Gone from the listing, exactly as an acknowledged installation fact is.
    assert advisories.listing(store, NOW) == []
    assert advisories.listing(store, NOW + timedelta(days=29)) == []


def test_the_expiry_brings_it_back_with_nobody_observing_anything(store):
    """ADR-0037's answer to ADR-0036's objection, and the whole of it.

    0036 refused an acknowledgement because *"an acknowledgement that outlived
    its condition would silence the app the second time the cash piled up"*.
    Bounded, it cannot: nothing has to notice the condition going false, because
    the expiry needs no observer.
    """
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    back = advisories.listing(store, NOW + timedelta(days=31))

    assert _keys(back) == ['cash_share:cto']


def test_the_condition_is_still_the_condition_while_it_sleeps(store):
    """Asleep is not ended: ``standing`` goes on raising it.

    The panel is the inventory and the chip beside the figure is the reading,
    and only the first of the two is silenced by a gesture made in it.
    """
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    assert _keys(advisories.standing(store, NOW)) == ['cash_share:cto']


def test_acknowledging_again_re_dates_the_window(store):
    """The opposite of the installation fact's rule, and it follows from what
    the two gestures mean: *seen, for good* is asserted once, *not now* is asked
    again each time it is asked."""
    _sleeping_account(store)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    later = NOW + timedelta(days=10)
    _, again = advisories.acknowledge(store, 'cash_share:cto', later)

    assert again.expires_at == later + timedelta(days=30)
    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 1


def test_acknowledging_what_does_not_stand_is_refused_and_writes_nothing(store):
    _sleeping_account(store)

    with pytest.raises(advisories.UnknownAdvisory):
        advisories.acknowledge(store, 'cash_share:nobody', NOW)
    with pytest.raises(advisories.UnknownAdvisory):
        advisories.acknowledge(store, 'not_a_family:cto', NOW)

    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 0


def test_an_expired_row_is_swept_by_the_gesture_and_never_by_a_read(store):
    """A ``GET`` that wrote would date the store with the moment somebody opened
    a page — the rule the listing one table over keeps too."""
    _sleeping_account(store)
    _account(store, 'pea', 'PEA')
    _metrics(store, 'pea', date(2026, 8, 26), cash=900.0, total=1000.0)
    advisories.acknowledge(store, 'cash_share:cto', NOW)

    late = NOW + timedelta(days=40)
    advisories.listing(store, late)
    assert store.query('SELECT count(*) FROM advisory_ack')[0][0] == 1

    advisories.acknowledge(store, 'cash_share:pea', late)
    rows = {row[0] for row in store.query('SELECT key FROM advisory_ack')}
    assert rows == {'cash_share:pea'}
