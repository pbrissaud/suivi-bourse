"""
Tests for events.loader.EventLoader.

The loader reads portfolio events from CSV / XLSX files (or a directory of
them), parses each row into an events.schemas.Event, and returns them sorted
by date. Parse failures inside a row raise ``ValueError`` which the loader
wraps into ``EventLoaderError`` together with the 1-indexed row number
(``enumerate(..., start=2)`` so the first data row is row 2).

Every assertion below is grounded in the actual code in src/application/events/loader.py.
No network / no real InfluxDB / no real yfinance is touched here — the loader
only does local file I/O against paths we create under ``tmp_path``.
"""

from datetime import date

import openpyxl
import pytest

from application.events import EventLoader
from application.events.aggregator import EventAggregator
from application.events.loader import REPLAY_ORDER, EventLoaderError
from application.events.schemas import EventType


HEADER = "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes"


def _write_csv(path, rows):
    """Write ``HEADER`` plus ``rows`` (list of CSV lines) to ``path``."""
    content = HEADER + "\n" + "\n".join(rows) + ("\n" if rows else "")
    path.write_text(content, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# CSV happy path                                                              #
# --------------------------------------------------------------------------- #

def test_csv_happy_path_via_fixture(events_csv):
    """The canonical example CSV loads all rows, already in date order."""
    events = EventLoader(str(events_csv)).load()

    assert len(events) == 7
    # Sorted ascending by date.
    dates = [e.date for e in events]
    assert dates == sorted(dates)
    assert dates[0] == date(2024, 1, 15)
    assert dates[-1] == date(2025, 1, 30)

    first = events[0]
    assert first.event_type is EventType.BUY
    assert first.symbol == "AAPL"
    assert first.name == "Apple Inc"
    assert first.quantity == 10.0
    assert first.unit_price == 150.0
    assert first.fee == 2.5
    assert first.notes == "Initial purchase"


def test_csv_rows_returned_sorted_by_date(tmp_path):
    """Rows written out of order come back sorted ascending by date."""
    csv_path = _write_csv(
        tmp_path / "unsorted.csv",
        [
            "2024-12-01,DIVIDEND,AAPL,Apple Inc,,,,5.00,late",
            "2023-06-01,BUY,AAPL,Apple Inc,5,100.00,1.00,,early",
            "2024-06-15,BUY,MSFT,Microsoft,3,300.00,2.00,,middle",
        ],
    )

    events = EventLoader(str(csv_path)).load()

    assert [e.date for e in events] == [
        date(2023, 6, 1),
        date(2024, 6, 15),
        date(2024, 12, 1),
    ]


# --------------------------------------------------------------------------- #
# Same-day ordering: the entries replay before the exits                      #
# --------------------------------------------------------------------------- #

def test_same_day_sale_listed_above_its_purchase_still_replays(tmp_path):
    """A broker export written newest-first must not refuse its own ledger.

    The ledger is dated to the day, so the intra-day sequence is not a fact the
    model carries: two files holding the same dated facts have to replay
    identically. Listing the SELL above the BUY of the same day used to survive
    the (stable) date sort in file order and made the replay refuse the whole
    import — ``Cannot sell 10.0 shares of AAPL (only 0.0 owned)`` about a file
    that visibly holds the purchase.
    """
    csv_path = _write_csv(
        tmp_path / "newest-first.csv",
        [
            "2024-03-01,SELL,AAPL,Apple Inc,10,180.00,1.00,,sale",
            "2024-03-01,BUY,AAPL,Apple Inc,10,150.00,1.00,,purchase",
        ],
    )

    events = EventLoader(str(csv_path)).load()

    assert [e.event_type for e in events] == [EventType.BUY, EventType.SELL]
    (position,) = EventAggregator().aggregate(events)
    assert position['quantity'] == 0.0
    assert position['realized_gain'] == pytest.approx(298.0)


def test_the_two_orders_of_one_day_load_the_same_way(tmp_path):
    """The same dated facts, written either way round, are one ledger."""
    rows = [
        "2024-03-01,BUY,AAPL,Apple Inc,10,150.00,1.00,,purchase",
        "2024-03-01,SELL,AAPL,Apple Inc,10,180.00,1.00,,sale",
    ]
    ascending = EventLoader(str(_write_csv(tmp_path / "asc.csv", rows))).load()
    descending = EventLoader(
        str(_write_csv(tmp_path / "desc.csv", list(reversed(rows))))).load()

    assert [e.notes for e in ascending] == [e.notes for e in descending]
    assert (EventAggregator().aggregate(ascending)
            == EventAggregator().aggregate(descending))


def test_same_day_cash_and_grant_order_entries_before_exits(tmp_path):
    """Within one day: money in, shares in, dividend, shares out, money out."""
    path = tmp_path / "day.csv"
    path.write_text(
        "date,event_type,symbol,name,quantity,unit_price,amount\n"
        "2024-03-01,WITHDRAWAL,,,,,100\n"
        "2024-03-01,SELL,AAPL,Apple Inc,1,180.00,\n"
        "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,2.40\n"
        "2024-03-01,GRANT,AAPL,Apple Inc,1,150.00,\n"
        "2024-03-01,BUY,AAPL,Apple Inc,10,150.00,\n"
        "2024-03-01,DEPOSIT,,,,,1000\n", encoding="utf-8")

    events = EventLoader(str(path)).load()

    # BUY and GRANT share one rank — both add quantity and basis, and neither
    # can refuse the other — so between those two the file still decides, and
    # the file lists the GRANT first.
    assert [e.event_type for e in events] == [
        EventType.DEPOSIT,
        EventType.GRANT,
        EventType.BUY,
        EventType.DIVIDEND,
        EventType.SELL,
        EventType.WITHDRAWAL,
    ]


def test_two_rows_of_one_day_and_one_nature_keep_their_file_order(tmp_path):
    """The tie-break is the nature and nothing else: the sort stays stable."""
    csv_path = _write_csv(
        tmp_path / "twobuys.csv",
        [
            "2024-03-01,BUY,AAPL,Apple Inc,10,150.00,1.00,,second fill",
            "2024-03-01,BUY,AAPL,Apple Inc,5,151.00,1.00,,first fill",
        ],
    )

    events = EventLoader(str(csv_path)).load()

    assert [e.notes for e in events] == ["second fill", "first fill"]


def test_every_event_type_has_a_replay_rank():
    """A nature with no rank would sort by nothing — the map has to be total."""
    assert set(REPLAY_ORDER) == set(EventType)


def test_empty_numeric_cells_parse_to_none(tmp_path):
    """Blank optional numeric cells become None (not 0.0)."""
    csv_path = _write_csv(
        tmp_path / "div.csv",
        ["2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,2.40,Q1 dividend"],
    )

    (event,) = EventLoader(str(csv_path)).load()

    assert event.event_type is EventType.DIVIDEND
    assert event.quantity is None
    assert event.unit_price is None
    assert event.fee is None
    assert event.amount == 2.40
    assert event.notes == "Q1 dividend"


# --------------------------------------------------------------------------- #
# Missing required columns                                                    #
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("missing_col", ["date", "event_type"])
def test_missing_required_column_raises(tmp_path, missing_col):
    """Dropping either structurally-required header (date/event_type) raises.

    symbol/name are no longer required in the header (cash events carry none);
    their per-type requirement is enforced by the validator, not the loader.
    """
    cols = ["date", "event_type", "symbol", "name",
            "quantity", "unit_price", "fee", "amount", "notes"]
    kept = [c for c in cols if c != missing_col]
    header = ",".join(kept)
    # A data row with a value for every kept column (order matches header).
    values = {
        "date": "2024-01-15", "event_type": "BUY", "symbol": "AAPL",
        "name": "Apple Inc", "quantity": "10", "unit_price": "150.00",
        "fee": "2.50", "amount": "", "notes": "n",
    }
    row = ",".join(values[c] for c in kept)
    path = tmp_path / "missing.csv"
    path.write_text(header + "\n" + row + "\n", encoding="utf-8")

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(path)).load()
    assert missing_col in str(exc.value)


# --------------------------------------------------------------------------- #
# Bad values -> wrapped EventLoaderError WITH the row number                  #
# --------------------------------------------------------------------------- #

def test_bad_date_format_raises_with_row_number(tmp_path):
    csv_path = _write_csv(
        tmp_path / "baddate.csv",
        ["15-01-2024,BUY,AAPL,Apple Inc,10,150.00,2.50,,bad date"],
    )

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(csv_path)).load()
    msg = str(exc.value)
    assert "row 2" in msg
    assert "date" in msg.lower()


def test_unknown_event_type_raises_with_row_number(tmp_path):
    csv_path = _write_csv(
        tmp_path / "badtype.csv",
        ["2024-01-15,FOO,AAPL,Apple Inc,10,150.00,2.50,,bad type"],
    )

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(csv_path)).load()
    msg = str(exc.value)
    assert "row 2" in msg
    assert "FOO" in msg


def test_invalid_numeric_string_raises_with_row_number(tmp_path):
    # Valid first data row (row 2), invalid quantity on row 3.
    csv_path = _write_csv(
        tmp_path / "badnum.csv",
        [
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,ok",
            "2024-02-01,BUY,MSFT,Microsoft,not-a-number,300.00,1.00,,bad",
        ],
    )

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(csv_path)).load()
    msg = str(exc.value)
    assert "row 3" in msg
    assert "quantity" in msg
    assert "not-a-number" in msg


# --------------------------------------------------------------------------- #
# Empty CSV (no header) and unsupported extension                            #
# --------------------------------------------------------------------------- #

def test_empty_csv_no_header_raises(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text("", encoding="utf-8")

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(path)).load()
    assert "Empty CSV" in str(exc.value)


def test_an_excel_utf8_export_loads_despite_its_byte_order_mark(tmp_path):
    """Excel's "CSV UTF-8" writes a BOM, and it used to hide the first column.

    Under plain ``utf-8`` the header reads ``﻿date``, so the file was
    refused for a missing required column that is visibly there — the least
    debuggable refusal the loader can produce (issue #698).
    """
    path = tmp_path / "2024.csv"
    path.write_text(
        "date,event_type,symbol,name,quantity,unit_price\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00\n", encoding="utf-8-sig")

    (event,) = EventLoader(str(path)).load()
    assert event.symbol == "AAPL"


def test_a_csv_headed_in_title_case_loads_like_its_xlsx_twin(tmp_path):
    """Excel capitalises a header by default, and the two routes must agree.

    ``Date,Event_Type,…`` loaded as ``.xlsx`` and was refused as ``.csv`` for
    *Missing required columns: {event_type, date}* — the same file, the same
    header, two answers.
    """
    path = tmp_path / "excel.csv"
    path.write_text(
        "Date,Event_Type,Symbol,Name,Quantity,Unit_Price\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00\n", encoding="utf-8")

    (event,) = EventLoader(str(path)).load()

    assert event.date == date(2024, 1, 15)
    assert event.event_type is EventType.BUY
    assert event.symbol == "AAPL"
    assert event.quantity == 10.0
    assert event.unit_price == 150.0


def test_a_capitalised_optional_column_is_read_and_not_silently_dropped(tmp_path):
    """The quieter half: the required columns pass, the optional one vanishes.

    ``Symbol`` in title case used to leave the header check happy and the cell
    unread, so the row was refused one layer down for a *symbol is required*
    about a cell the reader can see filled in.
    """
    path = tmp_path / "mixed.csv"
    path.write_text(
        "date,event_type,Symbol,Name,Quantity,Unit_Price,Account,Notes\n"
        "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,PEA,bought\n", encoding="utf-8")

    (event,) = EventLoader(str(path)).load()

    assert event.symbol == "AAPL"
    assert event.name == "Apple Inc"
    assert event.account == "PEA"
    assert event.notes == "bought"


def test_a_capitalised_base_currency_column_is_read_on_the_csv_route(tmp_path):
    """``Base_Currency`` is a fact about the file, whatever its case."""
    path = tmp_path / "currency.csv"
    path.write_text(
        "Date,Event_Type,Symbol,Quantity,Unit_Price,Base_Currency\n"
        "2024-01-15,BUY,AAPL,10,150.00,EUR\n", encoding="utf-8")

    loader = EventLoader(str(path))
    loader.load()

    assert loader.declared_currency == "EUR"


def test_a_csv_header_with_stray_whitespace_loads(tmp_path):
    """Whitespace around a header is trimmed, exactly as the XLSX route does."""
    path = tmp_path / "spaced.csv"
    path.write_text(
        " date , event_type , symbol , quantity , unit_price \n"
        "2024-01-15,BUY,AAPL,10,150.00\n", encoding="utf-8")

    (event,) = EventLoader(str(path)).load()

    assert event.symbol == "AAPL"
    assert event.quantity == 10.0


def test_unsupported_extension_through_load_file_raises(tmp_path):
    path = tmp_path / "data.txt"
    path.write_text("whatever", encoding="utf-8")

    loader = EventLoader(str(path))
    with pytest.raises(EventLoaderError) as exc:
        loader._load_file(path)
    assert "Unsupported file format" in str(exc.value)


# --------------------------------------------------------------------------- #
# Directory mode                                                              #
# --------------------------------------------------------------------------- #

def test_directory_merges_and_sorts_across_files(tmp_path):
    d = tmp_path / "events"
    d.mkdir()

    _write_csv(
        d / "2023.csv",
        [
            "2024-06-01,BUY,MSFT,Microsoft,2,300.00,1.00,,file-a-2",
            "2023-06-01,BUY,AAPL,Apple Inc,5,100.00,1.00,,file-a-1",
        ],
    )
    _write_csv(
        d / "2024.csv",
        [
            "2025-01-01,DIVIDEND,AAPL,Apple Inc,,,,5.00,file-b-2",
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,file-b-1",
        ],
    )
    # Files with other extensions must be ignored, not parsed.
    (d / "README.txt").write_text("ignore me", encoding="utf-8")
    (d / "portfolio.json").write_text("{\"nope\": true}", encoding="utf-8")

    events = EventLoader(str(d)).load()

    assert [e.date for e in events] == [
        date(2023, 6, 1),
        date(2024, 1, 15),
        date(2024, 6, 1),
        date(2025, 1, 1),
    ]
    assert len(events) == 4


def test_directory_ignores_non_event_files_only(tmp_path):
    """A directory whose only files are non-.csv/.xlsx yields no events."""
    d = tmp_path / "events"
    d.mkdir()
    (d / "notes.md").write_text("# notes", encoding="utf-8")
    (d / "archive.zip").write_bytes(b"PK\x03\x04")

    assert EventLoader(str(d)).load() == []


# --------------------------------------------------------------------------- #
# XLSX (real workbook via openpyxl)                                           #
# --------------------------------------------------------------------------- #

def _write_xlsx(path, header, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for row in rows:
        ws.append(row)
    wb.save(path)
    return path


def test_xlsx_parses_with_normalized_headers(tmp_path):
    """Header case/whitespace is normalized; rows parse; empties -> None."""
    # Deliberately messy headers: mixed case + surrounding whitespace.
    header = ["  Date ", "Event_Type", "SYMBOL", " Name",
              "Quantity", "Unit_Price", "Fee", "Amount", "Notes"]
    rows = [
        ["2024-03-01", "DIVIDEND", "AAPL", "Apple Inc",
         None, None, None, 2.40, "div"],
        ["2024-01-15", "buy", "AAPL", "Apple Inc",
         10, 150.0, 2.5, None, "purchase"],
    ]
    path = _write_xlsx(tmp_path / "book.xlsx", header, rows)

    events = EventLoader(str(path)).load()

    assert len(events) == 2
    # Returned sorted by date, so the BUY (Jan) comes first.
    buy, dividend = events
    assert buy.date == date(2024, 1, 15)
    assert buy.event_type is EventType.BUY  # lower-case "buy" normalized
    assert buy.symbol == "AAPL"
    assert buy.name == "Apple Inc"
    assert buy.quantity == 10.0
    assert buy.unit_price == 150.0
    assert buy.fee == 2.5
    assert buy.amount is None

    assert dividend.date == date(2024, 3, 1)
    assert dividend.event_type is EventType.DIVIDEND
    assert dividend.quantity is None
    assert dividend.amount == 2.40


def test_xlsx_missing_required_column_raises(tmp_path):
    header = ["date", "symbol", "name",  # no 'event_type'
              "quantity", "unit_price", "fee", "amount", "notes"]
    rows = [["2024-01-15", "AAPL", "Apple Inc", 10, 150.0, 2.5, None, "n"]]
    path = _write_xlsx(tmp_path / "bad.xlsx", header, rows)

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(path)).load()
    assert "event_type" in str(exc.value)


def test_xlsx_numeric_ticker_is_read_as_text(tmp_path):
    """A Tokyo ticker without its suffix arrives as a number, not as a string.

    ``7203`` used to reach ``.strip()`` and raise ``AttributeError`` — which is
    not a ``ValueError``, so the loader let it out unwrapped and the upload's
    broad fallback turned it into *this is not a ledger this app parses*,
    losing the row and the column every other refusal names.
    """
    header = ["date", "event_type", "symbol", "name", "quantity", "unit_price"]
    rows = [["2024-01-15", "BUY", 7203, "Toyota", 10, 2500.0]]
    path = _write_xlsx(tmp_path / "tokyo.xlsx", header, rows)

    (event,) = EventLoader(str(path)).load()

    assert event.symbol == "7203"
    assert event.name == "Toyota"
    assert event.quantity == 10.0


def test_xlsx_numeric_name_and_notes_are_read_as_text(tmp_path):
    """The same coercion on every textual column, not on ``account`` alone."""
    header = ["date", "event_type", "symbol", "name", "quantity",
              "unit_price", "notes", "account"]
    rows = [["2024-01-15", "BUY", "AAPL", 2024, 10, 150.0, 42, 1]]
    path = _write_xlsx(tmp_path / "numbers.xlsx", header, rows)

    (event,) = EventLoader(str(path)).load()

    assert event.name == "2024"
    assert event.notes == "42"
    assert event.account == "1"


def test_xlsx_numeric_event_type_is_refused_by_name(tmp_path):
    """A number where a nature belongs is a refusal that names the row."""
    header = ["date", "event_type", "symbol", "quantity", "unit_price"]
    rows = [["2024-01-15", 42, "AAPL", 10, 150.0]]
    path = _write_xlsx(tmp_path / "numtype.xlsx", header, rows)

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(path)).load()
    msg = str(exc.value)
    assert "row 2" in msg
    assert "42" in msg


def test_symbol_and_name_columns_are_optional(tmp_path):
    """A file without symbol/name columns loads (cash events carry none)."""
    path = tmp_path / "cash.csv"
    path.write_text(
        "date,event_type,amount,account\n"
        "2024-01-15,DEPOSIT,1000,PEA\n", encoding="utf-8")
    events = EventLoader(str(path)).load()
    assert len(events) == 1
    assert events[0].event_type is EventType.DEPOSIT
    assert events[0].symbol is None
    assert events[0].name is None
    assert events[0].amount == 1000.0
    assert events[0].account == "PEA"


# --------------------------------------------------------------------------- #
# Non-existent source path                                                    #
# --------------------------------------------------------------------------- #

def test_nonexistent_source_path_raises(tmp_path):
    missing = tmp_path / "nope" / "does-not-exist"

    with pytest.raises(EventLoaderError) as exc:
        EventLoader(str(missing)).load()
    assert "does not exist" in str(exc.value)
