"""
Event loader for CSV and XLSX files.
"""

import csv
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .schemas import Event, EventType


class EventLoaderError(Exception):
    """Exception raised when loading events fails."""
    pass


class EventLoader:
    """Loads portfolio events from CSV and XLSX files."""

    REQUIRED_COLUMNS = {'date', 'event_type', 'symbol', 'name'}
    OPTIONAL_COLUMNS = {'quantity', 'unit_price', 'fee', 'amount', 'notes'}
    ALL_COLUMNS = REQUIRED_COLUMNS | OPTIONAL_COLUMNS

    def __init__(self, source_path: str):
        """
        Initialize the event loader.

        Args:
            source_path: Path to a file or directory containing event files.
        """
        self.source_path = Path(source_path).expanduser()

    def load(self) -> List[Event]:
        """
        Load all events from the source path.

        Returns:
            List of Event objects sorted by date.

        Raises:
            EventLoaderError: If loading fails.
        """
        if not self.source_path.exists():
            raise EventLoaderError(f"Source path does not exist: {self.source_path}")

        events = []

        if self.source_path.is_file():
            events = self._load_file(self.source_path)
        elif self.source_path.is_dir():
            events = self._load_directory(self.source_path)

        # Sort events by date
        events.sort(key=lambda e: e.date)
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

    def _load_csv(self, file_path: Path) -> List[Event]:
        """Load events from a CSV file."""
        events = []

        with open(file_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)

            if not reader.fieldnames:
                raise EventLoaderError(f"Empty CSV file: {file_path}")

            # Validate columns
            columns = set(reader.fieldnames)
            missing = self.REQUIRED_COLUMNS - columns
            if missing:
                raise EventLoaderError(
                    f"Missing required columns in {file_path}: {missing}")

            for row_num, row in enumerate(reader, start=2):
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

            # First row is headers
            headers = [str(h).lower().strip() if h else '' for h in rows[0]]
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
                    event = self._parse_row(row, file_path, row_num)
                    events.append(event)
                except ValueError as e:
                    raise EventLoaderError(
                        f"Error in {file_path}/{sheet.title} at row {row_num}: {e}")

        workbook.close()
        return events

    def _parse_row(self, row: dict, file_path: Path, row_num: int) -> Event:
        """Parse a row into an Event object."""
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
        event_type_str = row.get('event_type', '').strip().upper() if row.get('event_type') else ''
        if not event_type_str:
            raise ValueError("event_type is required")

        try:
            event_type = EventType(event_type_str)
        except ValueError:
            valid_types = [e.value for e in EventType]
            raise ValueError(
                f"Invalid event_type: {event_type_str}. Valid types: {valid_types}")

        # Parse symbol
        symbol = row.get('symbol', '').strip() if row.get('symbol') else ''
        if not symbol:
            raise ValueError("symbol is required")

        # Parse name
        name = row.get('name', '').strip() if row.get('name') else ''
        if not name:
            raise ValueError("name is required")

        # Parse optional numeric fields
        quantity = self._parse_float(row.get('quantity'), 'quantity')
        unit_price = self._parse_float(row.get('unit_price'), 'unit_price')
        fee = self._parse_float(row.get('fee'), 'fee')
        amount = self._parse_float(row.get('amount'), 'amount')

        # Parse notes
        notes = row.get('notes', '').strip() if row.get('notes') else None

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
        )

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
