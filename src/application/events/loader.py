"""Event loader for CSV and XLSX files."""

import csv
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .schemas import Event, EventType

REPLAY_ORDER = {
    EventType.DEPOSIT: 0,
    EventType.BUY: 1,
    EventType.GRANT: 1,
    EventType.DIVIDEND: 2,
    EventType.SELL: 3,
    EventType.WITHDRAWAL: 4,
}

BASE_CURRENCY_COLUMN = 'base_currency'


class EventLoaderError(Exception):
    """Exception raised when loading events fails."""
    pass


class EventLoader:
    """Loads portfolio events from CSV and XLSX files."""

    REQUIRED_COLUMNS = frozenset({'date', 'event_type'})
    OPTIONAL_COLUMNS = frozenset({'symbol', 'name', 'quantity', 'unit_price', 'fee', 'amount', 'notes', 'account'})
    ALL_COLUMNS = REQUIRED_COLUMNS | OPTIONAL_COLUMNS

    def __init__(self, source_path: str):
        """Initialize the event loader."""
        self.source_path = Path(source_path).expanduser()
        self.declared_currency: Optional[str] = None

    def load(self) -> List[Event]:
        """Load all events from the source path."""
        if not self.source_path.exists():
            raise EventLoaderError(f"Source path does not exist: {self.source_path}")

        self.declared_currency = None
        events = []

        if self.source_path.is_file():
            events = self._load_file(self.source_path)
        elif self.source_path.is_dir():
            events = self._load_directory(self.source_path)

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
        """One header cell, as the column name the rest of this module reads."""
        return str(value).strip().lower() if value else ''

    def _load_csv(self, file_path: Path) -> List[Event]:
        """Load events from a CSV file."""
        events = []

        with open(file_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)

            if not reader.fieldnames:
                raise EventLoaderError(f"Empty CSV file: {file_path}")

            fields = list(reader.fieldnames)
            headers = [self._normalize_header(field) for field in fields]

            columns = set(headers)
            missing = self.REQUIRED_COLUMNS - columns
            if missing:
                raise EventLoaderError(
                    f"Missing required columns in {file_path}: {missing}")

            for row_num, raw in enumerate(reader, start=2):
                row = {header: raw.get(field)
                       for header, field in zip(headers, fields)}
                try:
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

            headers = [self._normalize_header(h) for h in rows[0]]
            columns = set(headers)

            missing = self.REQUIRED_COLUMNS - columns
            if missing:
                raise EventLoaderError(
                    f"Missing required columns in {file_path}/{sheet.title}: {missing}")

            for row_num, row_values in enumerate(rows[1:], start=2):
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
        """Parse a row into an Event object."""
        self._note_currency(row)

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

        event_type_str = (self._parse_text(row.get('event_type')) or '').upper()
        if not event_type_str:
            raise ValueError("event_type is required")

        try:
            event_type = EventType(event_type_str)
        except ValueError:
            valid_types = [e.value for e in EventType]
            raise ValueError(
                f"Invalid event_type: {event_type_str}. Valid types: {valid_types}")

        symbol = self._parse_text(row.get('symbol'))
        name = self._parse_text(row.get('name'))

        quantity = self._parse_float(row.get('quantity'), 'quantity')
        unit_price = self._parse_float(row.get('unit_price'), 'unit_price')
        fee = self._parse_float(row.get('fee'), 'fee')
        amount = self._parse_float(row.get('amount'), 'amount')

        notes = self._parse_text(row.get('notes'))

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
        """Read the row's ``base_currency`` cell into the source's declaration."""
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
        """One textual cell, trimmed — ``None`` when it says nothing."""
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
