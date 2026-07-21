"""
Tests for events.loader.EventLoader.

The loader reads portfolio events from CSV / XLSX files (or a directory of
them), parses each row into an events.schemas.Event, and returns them sorted
by date. Parse failures inside a row raise ``ValueError`` which the loader
wraps into ``EventLoaderError`` together with the 1-indexed row number
(``enumerate(..., start=2)`` so the first data row is row 2).

Every assertion below is grounded in the actual code in app/src/events/loader.py.
No network / no real InfluxDB / no real yfinance is touched here — the loader
only does local file I/O against paths we create under ``tmp_path``.
"""

from datetime import date

import openpyxl
import pytest

from events import EventLoader
from events.loader import EventLoaderError
from events.schemas import EventType


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
