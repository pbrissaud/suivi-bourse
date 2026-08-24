"""The replay writes ``position`` and ``account_state``, and it alone (#699).

The seam is #695's: a **real** DuckDB store in ``tmp_path``, the real
``ConfigurationManager`` replaying a real ledger onto it. Nothing here asserts
that a method was called — the ticket's rules are rules about *rows*:

1. a replay lays down one row per position, sold ones included, and one per
   account that has a cash ledger;
2. it is a **replacement**: a position the ledger no longer produces leaves with
   the same gesture that rewrites the rest;
3. it happens after the validation, so a ledger that is refused writes nothing;
4. and no other module in the app writes either table.
"""
import re
from pathlib import Path

import pytest

import entries
import positions
from events import EventLoader
from events import export as events_export
from events.aggregator import AggregationError
from events.schemas import CashState
from main import ConfigurationManager


EVENTS_CSV = (
    "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
    "2024-01-02,DEPOSIT,,,,,,3000.00,Opening transfer\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 2024\n"
)

# The same ledger with the position sold out — a row that must survive.
SOLD_CSV = EVENTS_CSV + (
    "2024-09-15,SELL,AAPL,Apple Inc,10,190.00,2.00,,Sold out\n"
)


def _manager(store, tmp_path, csv_text=EVENTS_CSV):
    """A real manager over a store that already holds one file's rows.

    The rows are read in here rather than by the manager, which scans no
    directory since ADR-0032. What the replay is asserted on below is the
    ledger, and the ledger is in the store either way.
    """
    events = tmp_path / "events"
    events.mkdir(exist_ok=True)
    _write(store, events / "2024.csv", csv_text)
    return ConfigurationManager(config_dir=str(tmp_path), opened_store=store)


def _write(store, path, csv_text):
    """One file's rows into the store, by the road the upload takes (#816)."""
    path.write_text(csv_text, encoding="utf-8")
    entries.create_many(store, EventLoader(str(path)).load())


# --------------------------------------------------------------------------- #
# What the replay lays down
# --------------------------------------------------------------------------- #

def test_a_replay_writes_the_position_row(store, tmp_path):
    _manager(store, tmp_path).current()

    (row,) = positions.read_positions(store)
    assert row == {
        'account': 'default',
        'symbol': 'AAPL',
        'name': 'Apple Inc',
        'quantity': 10.0,
        'cost_basis': pytest.approx(1502.5),
        'realized_gain': 0.0,
        'received_dividend': pytest.approx(2.40),
    }


def test_a_replay_writes_the_account_state(store, tmp_path):
    _manager(store, tmp_path).current()

    states = positions.read_account_states(store)
    assert states == {'default': CashState(cash_balance=pytest.approx(1499.9),
                                           net_contributed=3000.0)}


def test_a_sold_position_keeps_its_row_and_its_realized_gain(store, tmp_path):
    """Zero quantity, zero basis — and the figure that is left to read."""
    _manager(store, tmp_path, SOLD_CSV).current()

    (row,) = positions.read_positions(store)
    assert row['quantity'] == 0.0
    assert row['cost_basis'] == 0.0
    assert row['realized_gain'] == pytest.approx(10 * 190.0 - 2.0 - 1502.5)
    assert row['received_dividend'] == pytest.approx(2.40)


def test_an_account_with_no_cash_event_has_no_state_row(store, tmp_path):
    """*Never any cash event* and *a balance of zero* are two states."""
    no_cash = (
        "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes\n"
        "2024-06-01,GRANT,AAPL,Apple Inc,3,,,,Free shares\n"
    )
    _manager(store, tmp_path, no_cash).current()

    assert positions.read_account_states(store) == {}
    assert len(positions.read_positions(store)) == 1


# --------------------------------------------------------------------------- #
# The replacement, and what it takes with it
# --------------------------------------------------------------------------- #

def test_emptying_the_ledger_takes_the_positions_with_it(store, tmp_path):
    """What forgetting an import used to do, done by the gesture that replaced it.

    The bulk deletion over the ledger's own reduction (ADR-0032, #814): the rows
    go, and the two tables the replay owns go with them.
    """
    manager = _manager(store, tmp_path)
    manager.current()
    assert positions.read_positions(store)

    entries.remove_selection(store, events_export.Selection())
    manager.replay()

    assert positions.read_positions(store) == []
    assert positions.read_account_states(store) == {}


def test_a_position_the_ledger_no_longer_names_leaves(store, tmp_path):
    manager = _manager(store, tmp_path)
    manager.current()

    # The ledger stops naming AAPL: the rows it holds are removed and the
    # corrected ones written — which is what *re-drop the corrected file*
    # became once a row could be reached one at a time (ADR-0032).
    entries.remove_selection(store, events_export.Selection())
    _write(store, tmp_path / "events" / "2024.csv",
           EVENTS_CSV.replace("AAPL,Apple Inc", "MSFT,Microsoft"))
    manager.reload()

    assert [r['symbol'] for r in positions.read_positions(store)] == ['MSFT']


def test_a_replay_that_changes_nothing_leaves_the_same_rows(store, tmp_path):
    manager = _manager(store, tmp_path)
    manager.current()
    before = positions.read_positions(store)

    manager.reload(force=True)

    assert positions.read_positions(store) == before


def test_a_ledger_that_cannot_be_replayed_writes_no_position(store, tmp_path):
    """The write is downstream of the refusal, so the previous state stands."""
    manager = _manager(store, tmp_path)
    manager.current()
    before = positions.read_positions(store)

    # Hand-edit the store into an over-sale, the way a broken ledger arrives.
    store.execute(
        'INSERT INTO event (id, date, event_type, account, symbol, name, '
        '                   quantity, unit_price) '
        "VALUES (9999, DATE '2024-10-01', 'SELL', 'default', 'AAPL', "
        "        'Apple Inc', 999, 100.0)")

    with pytest.raises(AggregationError):
        manager.reload(force=True)

    assert positions.read_positions(store) == before


# --------------------------------------------------------------------------- #
# One writer, and the module list says so
# --------------------------------------------------------------------------- #

_WRITE = re.compile(
    r'(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(position|account_state)\b',
    re.IGNORECASE)


def test_no_other_module_writes_the_replays_two_tables():
    """ADR-0006, checked on the source: every row has exactly one writer.

    A second writer is precisely what a sold position would create — its state
    changing at the instant its price stops being fetched — so the rule is worth
    an assertion rather than a comment.
    """
    src = Path(__file__).resolve().parents[1] / 'src'
    offenders = [
        path.relative_to(src).as_posix()
        for path in sorted(src.rglob('*.py'))
        if path.name != 'positions.py' and _WRITE.search(path.read_text())
    ]
    assert offenders == []
