"""
Event loader for CSV and XLSX files.
"""

import csv
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .schemas import Event, EventType

#: The order the natures of **one calendar day** replay in — the entries before
#: the exits, and the one tie-break the sort has.
#:
#: The ledger is dated to the day (ADR-0001), so where two rows fall on the same
#: date the sequence between them is **not a fact the model carries**: two files
#: holding the same dated facts have to replay identically, whatever order the
#: broker printed them in. Left to the file, a very ordinary export written
#: newest-first sold shares its own first line had not bought yet, and the
#: replay refused the whole import for an oversell of a security the file
#: visibly acquires.
#:
#: The rank is what the aggregator's arithmetic needs, in its order: money in,
#: then shares in (BUY and GRANT are one rank — both add quantity and basis, and
#: neither can refuse the other), then the dividend, then shares out, then money
#: out. It is a **replay order and not a chronology**: the two cash natures are
#: additive and would land anywhere without changing a figure, and they are
#: placed all the same so *entries before exits* is one sentence rather than a
#: rule about shares with an exception beside it.
#:
#: Total over :class:`EventType` on purpose — a nature with no rank would raise
#: rather than sort by nothing — and ``tests/test_loader.py`` holds that.
REPLAY_ORDER = {
    EventType.DEPOSIT: 0,
    EventType.BUY: 1,
    EventType.GRANT: 1,
    EventType.DIVIDEND: 2,
    EventType.SELL: 3,
    EventType.WITHDRAWAL: 4,
}

#: The one column of an event file that is a fact about the **file** rather than
#: about a row (issue #710): the reporting currency its amounts are recorded in.
#: It is written by the export and read here, which is what makes a round trip
#: unable to reinterpret every amount it carries.
#:
#: Named ``base_currency`` and not ``currency`` on purpose. A broker export
#: routinely carries a ``currency`` column meaning the **security's quote**
#: currency, and there are exactly two currency levels in v5 (ADR-0002) — reading
#: one for the other is the silent reinterpretation this column exists against.
BASE_CURRENCY_COLUMN = 'base_currency'


class EventLoaderError(Exception):
    """Exception raised when loading events fails."""
    pass


class EventLoader:
    """Loads portfolio events from CSV and XLSX files."""

    # Only date + event_type are structurally required in the header; whether
    # symbol/name/amount/… are required depends on the event type and is enforced
    # by the validator (cash events carry no share, share events carry no amount).
    REQUIRED_COLUMNS = frozenset({'date', 'event_type'})
    OPTIONAL_COLUMNS = frozenset({'symbol', 'name', 'quantity', 'unit_price', 'fee', 'amount', 'notes', 'account'})
    ALL_COLUMNS = REQUIRED_COLUMNS | OPTIONAL_COLUMNS

    def __init__(self, source_path: str):
        """
        Initialize the event loader.

        Args:
            source_path: Path to a file or directory containing event files.
        """
        self.source_path = Path(source_path).expanduser()
        #: The reporting currency the source **declares**, or ``None`` when it
        #: declares none (issue #710). Set by :meth:`load`, and kept beside the
        #: events rather than on them: it is a fact about the file, and an
        #: ``Event`` that carried one would invite the idea that two rows could
        #: disagree.
        self.declared_currency: Optional[str] = None

    def load(self) -> List[Event]:
        """
        Load all events from the source path.

        Returns:
            List of Event objects sorted by date, and — within one date — by
            nature (:data:`REPLAY_ORDER`), the entries before the exits. The
            sort is stable, so two rows of one day and one nature keep the
            order the file gave them.

        Raises:
            EventLoaderError: If loading fails, or if the source declares two
                different reporting currencies (issue #710).
        """
        if not self.source_path.exists():
            raise EventLoaderError(f"Source path does not exist: {self.source_path}")

        self.declared_currency = None
        events = []

        if self.source_path.is_file():
            events = self._load_file(self.source_path)
        elif self.source_path.is_dir():
            events = self._load_directory(self.source_path)

        # Sort events by date, then by nature within the date: a file is a set
        # of dated facts and never a sequence, so the line order cannot be
        # allowed to decide whether the ledger replays (see REPLAY_ORDER).
        events.sort(key=lambda e: (e.date, REPLAY_ORDER[e.event_type]))
        return events

    def _load_directory(self, directory: Path) -> List[Event]:
        """Load events from all CSV/XLSX files in a directory."""
        events = []

        for file_path in sorted(directory.iterdir()):
            if file_path.suffix.lower() in ('.csv', '.xlsx'):
                try:
                    file_events = self._load_file(file_path)
                    events.extend(file_events)
                except EventLoaderError as e:
                    raise EventLoaderError(f"Error loading {file_path}: {e}")

        return events

    def _load_file(self, file_path: Path) -> List[Event]:
        """Load events from a single file."""
        suffix = file_path.suffix.lower()

        if suffix == '.csv':
            return self._load_csv(file_path)
        elif suffix == '.xlsx':
            return self._load_xlsx(file_path)
        else:
            raise EventLoaderError(f"Unsupported file format: {suffix}")

    @staticmethod
    def _normalize_header(value) -> str:
        """One header cell, as the column name the rest of this module reads.

        Lower-cased and trimmed, and **one definition for both routes**: a
        header is a header whether it arrived through :mod:`csv` or through
        :mod:`openpyxl`, and two spellings of this rule are how the same file
        came to load as ``.xlsx`` and be refused as ``.csv``. Coerced with
        ``str`` for the workbook's sake, where a header cell can come back as a
        number; a blank cell names no column and is ``''``.
        """
        return str(value).strip().lower() if value else ''

    def _load_csv(self, file_path: Path) -> List[Event]:
        """Load events from a CSV file.

        ``utf-8-sig``, like the accounts loader (issue #698): Excel's *"CSV
        UTF-8"* export writes a byte-order mark, which under plain ``utf-8``
        turns ``date`` into ``﻿date`` and gets the file refused for a
        missing required column it visibly has. A file without a mark reads
        identically, so the codec costs nothing.

        **The header is normalised exactly as the XLSX route normalises its
        own.** Excel writes ``Date,Event_Type,…`` by default, and the two
        routes used to give that one header two answers: the workbook loaded
        and the sheet saved out of it as CSV was refused for *missing required
        columns* it visibly carries. The quieter half was worse — a capitalised
        **optional** column passed the header check and was then read as blank,
        so the row was refused a layer down for a ``symbol`` the reader can see
        filled in, and ``Base_Currency`` was dropped without a word.
        """
        events = []

        with open(file_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)

            if not reader.fieldnames:
                raise EventLoaderError(f"Empty CSV file: {file_path}")

            fields = list(reader.fieldnames)
            headers = [self._normalize_header(field) for field in fields]

            # Validate columns
            columns = set(headers)
            missing = self.REQUIRED_COLUMNS - columns
            if missing:
                raise EventLoaderError(
                    f"Missing required columns in {file_path}: {missing}")

            for row_num, raw in enumerate(reader, start=2):
                # Re-keyed on the normalised header, which is also what drops
                # the ``restkey`` of a row longer than its header: a cell under
                # no column is a cell nothing can name.
                row = {header: raw.get(field)
                       for header, field in zip(headers, fields)}
                try:
                    # start=2: row 1 is the header, so the number carried onto
                    # the event is the one the user's editor shows them. It is
                    # a display (issue #697), so it has to match what they see.
                    event = self._parse_row(row, file_path, row_num)
                    events.append(event)
                except ValueError as e:
                    raise EventLoaderError(
                        f"Error in {file_path} at row {row_num}: {e}")

        return events

    def _load_xlsx(self, file_path: Path) -> List[Event]:
        """Load events from an XLSX file."""
        try:
            import openpyxl
        except ImportError:
            raise EventLoaderError(
                "openpyxl is required to load XLSX files. "
                "Install it with: pip install openpyxl")

        events = []
        workbook = openpyxl.load_workbook(file_path, read_only=True, data_only=True)

        for sheet in workbook.worksheets:
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue

            # First row is headers
            headers = [self._normalize_header(h) for h in rows[0]]
            columns = set(headers)

            missing = self.REQUIRED_COLUMNS - columns
            if missing:
                raise EventLoaderError(
                    f"Missing required columns in {file_path}/{sheet.title}: {missing}")

            for row_num, row_values in enumerate(rows[1:], start=2):
                # Skip empty rows
                if not any(row_values):
                    continue

                row = dict(zip(headers, row_values))
                try:
                    event = self._parse_row(row, file_path, row_num,
                                            sheet=sheet.title)
                    events.append(event)
                except ValueError as e:
                    raise EventLoaderError(
                        f"Error in {file_path}/{sheet.title} at row {row_num}: {e}")

        workbook.close()
        return events

    def _parse_row(self, row: dict, file_path: Path, row_num: int,
                   sheet: Optional[str] = None) -> Event:
        """Parse a row into an Event object.

        ``sheet``/``row_num`` say **where in the file** this row is, and they are
        used for one thing only: naming the place in a refusal. They used to be
        carried onto the event as displayable provenance and are not any more
        (ADR-0032, #816) — a row that came out of a file is a row, and the file
        is gone the instant it is parsed.
        """
        # The file's own declaration first (issue #710) — before anything that
        # can reject the row, so a source that states two reporting currencies
        # is refused for *that*, at the row where the second one appears, rather
        # than for whatever the row happens to say next.
        self._note_currency(row)

        # Parse date
        date_value = row.get('date')
        if not date_value:
            raise ValueError("date is required")

        if isinstance(date_value, datetime):
            event_date = date_value.date()
        elif isinstance(date_value, str):
            date_str = date_value.strip()
            try:
                event_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            except ValueError:
                raise ValueError(f"Invalid date format: {date_str}. Expected YYYY-MM-DD")
        else:
            raise ValueError(f"Invalid date type: {type(date_value)}")

        # Parse event type
        event_type_str = (self._parse_text(row.get('event_type')) or '').upper()
        if not event_type_str:
            raise ValueError("event_type is required")

        try:
            event_type = EventType(event_type_str)
        except ValueError:
            valid_types = [e.value for e in EventType]
            raise ValueError(
                f"Invalid event_type: {event_type_str}. Valid types: {valid_types}")

        # Parse symbol / name — optional at the parse level (cash events carry
        # none). Per-type requirements are enforced by the validator.
        symbol = self._parse_text(row.get('symbol'))
        name = self._parse_text(row.get('name'))

        # Parse optional numeric fields
        quantity = self._parse_float(row.get('quantity'), 'quantity')
        unit_price = self._parse_float(row.get('unit_price'), 'unit_price')
        fee = self._parse_float(row.get('fee'), 'fee')
        amount = self._parse_float(row.get('amount'), 'amount')

        # Parse notes
        notes = self._parse_text(row.get('notes'))

        # Parse account (optional column; validation of whether it is required
        # happens in EventValidator once declared accounts are known)
        account = self._parse_text(row.get('account'))

        return Event(
            date=event_date,
            event_type=event_type,
            symbol=symbol,
            name=name,
            quantity=quantity,
            unit_price=unit_price,
            fee=fee,
            amount=amount,
            notes=notes if notes else None,
            account=account if account else None,
        )

    def _note_currency(self, row: dict) -> None:
        """Read the row's ``base_currency`` cell into the source's declaration.

        The value is upper-cased here and its *shape* is not checked at all —
        three letters or not is :mod:`settings_registry`'s rule, and it is the
        import that puts the question to it (``ledger.currency_to_adopt``). What is
        this module's business is the one thing only a reader of the file can
        see: **a source states one reporting currency**. Two different codes in
        one file is not a value to arbitrate between, it is a file that says two
        contradictory things about every amount it carries.

        A blank cell declares nothing and is not a disagreement, which is what
        lets a hand-written file leave the column out entirely — and what lets an
        install that has never answered the question export a file everyone can
        import.
        """
        raw = row.get(BASE_CURRENCY_COLUMN)
        code = '' if raw is None else str(raw).strip().upper()
        if not code:
            return
        if self.declared_currency and self.declared_currency != code:
            raise ValueError(
                f"the file declares two reporting currencies, "
                f"{self.declared_currency!r} then {code!r}; "
                f"{BASE_CURRENCY_COLUMN} is one fact about the whole file")
        self.declared_currency = code

    @staticmethod
    def _parse_text(value) -> Optional[str]:
        """One textual cell, trimmed — ``None`` when it says nothing.

        **A spreadsheet cell is not a string**, and the four textual columns are
        read the same way for it: ``openpyxl`` hands back what the cell holds,
        so a Tokyo ticker written without its suffix arrives as the integer
        ``7203`` and a note that is only digits arrives as a number. ``.strip()``
        raised ``AttributeError`` on it — not a ``ValueError``, so it escaped
        :meth:`_load_xlsx`'s wrapping unnamed, and :mod:`uploads`' broad
        fallback turned it into *this is not a ledger this app parses*, losing
        the row and the column that every other refusal states.

        ``account`` was coerced alone, which is the shape of a defect found once
        and repaired in the one place it was seen. There is one rule and it is
        here.
        """
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def _parse_float(self, value, field_name: str) -> Optional[float]:
        """Parse a value as float, returning None for empty values."""
        if value is None or value == '':
            return None

        if isinstance(value, (int, float)):
            return float(value)

        if isinstance(value, str):
            value = value.strip()
            if not value:
                return None
            try:
                return float(value)
            except ValueError:
                raise ValueError(f"Invalid numeric value for {field_name}: {value}")

        raise ValueError(f"Invalid type for {field_name}: {type(value)}")
