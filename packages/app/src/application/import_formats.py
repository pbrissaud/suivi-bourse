"""The file the app's own export writes, read into lines of the ledger (IMPLEMENTATION.md § 3.4).

The layout is recognised from its **header line**. Reading is lenient per line:
a line that cannot be read is a :class:`Line` with a ``reason``, never a
refusal of the file. Only a file that is no ledger at all (no known header, not
a ``.csv``/``.xlsx``) is refused.
"""
import csv
import io
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from application import uploads
from application.events.loader import EventLoader
from application.events.schemas import Event, EventType

ISIN = re.compile(r'[A-Z]{2}[A-Z0-9]{9}[0-9]')

#: The kinds of event that name a security, and the ones that move cash alone.
SECURITY_TYPES = frozenset({EventType.BUY, EventType.SELL, EventType.GRANT,
                            EventType.DIVIDEND})

_DATE_FORMATS = ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%d.%m.%Y', '%d/%m/%y')


#: The app's own layout (what the export writes): the header columns that tell
#: it apart, and where each field of an event lives. Folded names, the first
#: alternative the file has wins.
DETECT = frozenset({'date', 'event type'})
COLUMNS = {
    'date': ('date',), 'kind': ('event type',), 'symbol': ('symbol',),
    'isin': ('isin',), 'label': ('name',), 'quantity': ('quantity',),
    'price': ('unit price',), 'fee': ('fee',), 'amount': ('amount',),
    'notes': ('notes',), 'account': ('account',),
}


class LineError(ValueError):
    """Why a line is no event: an English sentence, and a code the front words in French."""

    def __init__(self, message: str, code: str, **values: str):
        super().__init__(message)
        self.code = code
        self.values = values


@dataclass(frozen=True)
class Line:
    """One line of the file: an event, or the reason it could not be read."""

    n: int
    event: Optional[Event] = None
    isin: Optional[str] = None
    reason: Optional[str] = None
    #: ``reason`` as a stable code, with the values its sentence quotes.
    reason_code: Optional[str] = None
    reason_values: Optional[Dict[str, str]] = None
    #: The account the line names, when the file has an account column.
    account: Optional[str] = None


@dataclass(frozen=True)
class Reading:
    """A file, read: its lines in file order."""

    filename: str
    lines: List[Line]
    #: Does the file name an account per line (the app's own export does)?
    has_accounts: bool = False
    #: The ``base_currency`` the file states for its amounts (the app's own
    #: export does), else ``None``: its amounts have no stated unit.
    declared_currency: Optional[str] = None


def fold(value) -> str:
    """A header or a label as comparable text: no accent, lower case, single spaces."""
    text = unicodedata.normalize('NFKD', '' if value is None else str(value))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', text).strip()


def read(filename: str, stream) -> Reading:
    """The uploaded file as lines, or a named refusal (:class:`uploads.UploadRefused`)."""
    name = Path(filename or '').name
    suffix = Path(name).suffix.lower()
    if suffix not in uploads.IMPORT_SUFFIXES:
        raise uploads.UploadRefused(
            f"{name or 'the file'} is not a ledger this app reads: an import "
            f"file is a {' or a '.join(uploads.IMPORT_SUFFIXES)}", file=name or None,
            code='not_a_ledger')

    data = stream.read(uploads.MAX_UPLOAD_BYTES + 1)
    if len(data) > uploads.MAX_UPLOAD_BYTES:
        raise uploads.UploadTooLarge(uploads.too_large_detail())

    try:
        table = _xlsx_rows(data) if suffix == '.xlsx' else _csv_rows(data)
    except uploads.UploadRefused:
        raise
    except Exception:
        raise uploads.UploadRefused(
            f"{name} could not be read: it is not a ledger this app parses",
            file=name or None, code='unreadable')
    if not table:
        raise uploads.UploadRefused(f"{name} is empty", file=name or None,
                                    code='empty')

    header = [fold(cell) for cell in table[0]]
    if not DETECT <= set(header):
        raise uploads.UploadRefused(
            f"{name} has a header this app does not recognise; an import file "
            f"carries the columns of the export (at least "
            f"{', '.join(sorted(DETECT))})", file=name or None,
            code='header')
    has_accounts = any(c in header for c in COLUMNS['account'])
    return Reading(name, _lines(header, table[1:]), has_accounts,
                   _declared_currency(header, table[1:]))


def _declared_currency(header: Sequence[str], rows: Sequence[Sequence]) -> Optional[str]:
    """The ``base_currency`` the file's rows state, when it has that column."""
    if 'base currency' not in header:
        return None
    at = header.index('base currency')
    for row in rows:
        if at < len(row) and _text(row[at]):
            return _text(row[at]).upper()
    return None


def _csv_rows(data: bytes) -> List[List]:
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = data.decode('cp1252', errors='replace')
    first = text.splitlines()[0] if text.strip() else ''
    delimiter = EventLoader._sniff_delimiter(first)
    return list(csv.reader(io.StringIO(text, newline=''), delimiter=delimiter))


def _xlsx_rows(data: bytes) -> List[List]:
    import openpyxl
    workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    table: List[List] = []
    try:
        # Every sheet, in workbook order: the export writes one per year, and
        # each carries the header again, which is dropped but the first's.
        for sheet in workbook.worksheets:
            rows = [list(row) for row in sheet.iter_rows(values_only=True)]
            rows = [row for row in rows if any(cell is not None for cell in row)]
            if not rows:
                continue
            if not table:
                table = rows
            elif [fold(c) for c in rows[0]] == [fold(c) for c in table[0]]:
                table.extend(rows[1:])
            else:
                table.extend(rows)
    finally:
        workbook.close()
    return table


def _lines(header: Sequence[str], rows: Sequence[Sequence]) -> List[Line]:
    where: Dict[str, Optional[int]] = {
        field: next((header.index(c) for c in COLUMNS[field] if c in header), None)
        for field in ('date', 'kind', 'symbol', 'isin', 'label', 'quantity',
                      'price', 'fee', 'amount', 'notes', 'account')}
    lines = []
    for row in rows:
        if not any(cell not in (None, '') for cell in row):
            continue
        n = len(lines) + 1

        def cell(field: str):
            i = where[field]
            value = row[i] if i is not None and i < len(row) else None
            return None if value in (None, '') else value
        try:
            lines.append(_line(n, cell))
        except LineError as exc:
            lines.append(Line(n, reason=str(exc), reason_code=exc.code,
                              reason_values=exc.values or None))
        except ValueError as exc:
            lines.append(Line(n, reason=str(exc), reason_code='other'))
    return lines


def _line(n: int, cell) -> Line:
    """One row, or a ``ValueError`` saying why it is no event."""
    day = _day(cell('date'))
    kind = _kind(cell('kind'))
    quantity = _number(cell('quantity'), 'quantity')
    price = _number(cell('price'), 'unit price')
    fee = _number(cell('fee'), 'fee')
    amount = _number(cell('amount'), 'amount')

    symbol = _text(cell('symbol'))
    isin = (_text(cell('isin')) or '').upper() or None
    if symbol and ISIN.fullmatch(symbol.upper()):
        symbol, isin = None, symbol.upper()
    if isin and not ISIN.fullmatch(isin):
        isin = None

    if kind in SECURITY_TYPES:
        if kind == EventType.DIVIDEND:
            if not amount:
                raise LineError("a dividend needs an amount", 'dividend_amount')
        else:
            if not quantity:
                raise LineError("a purchase or a sale needs a quantity", 'trade_quantity')
            if price is None and amount and kind != EventType.GRANT:
                # The net amount carries the fee: buy = qty × price + fee.
                price = (amount - (fee or 0)) / quantity if kind == EventType.BUY \
                    else (amount + (fee or 0)) / quantity
            if price is None and kind != EventType.GRANT:
                raise LineError("a purchase or a sale needs a unit price", 'trade_price')
        if not (symbol or isin or _text(cell('label'))):
            raise LineError("the line names no security", 'no_security')
    elif not amount:
        raise LineError("a deposit or a withdrawal needs an amount", 'cash_amount')

    security = kind in SECURITY_TYPES
    event = Event(
        date=day, event_type=kind,
        symbol=symbol.upper() if symbol else None,
        name=_text(cell('label')) if security else None,
        quantity=quantity if kind not in (EventType.DIVIDEND,) and security else None,
        unit_price=price if security and kind != EventType.DIVIDEND else None,
        fee=fee,
        amount=amount if kind == EventType.DIVIDEND or not security else None,
        notes=_text(cell('notes')))
    return Line(n, event=event, isin=isin if security else None,
                account=_text(cell('account')))


def _day(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = _text(value)
    if text is None:
        raise LineError("the line has no date", 'no_date')
    text = text.split(' ')[0].split('T')[0]
    for pattern in _DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    raise LineError(f"{text!r} is not a date", 'bad_date', value=text)


def _kind(value) -> EventType:
    label = fold(value).upper()
    for kind in EventType:
        if label == kind.value:
            return kind
    raise LineError(f"{_text(value) or 'an empty operation'!r} is not an operation the ledger records",
                    'bad_kind', value=_text(value) or '')


def _text(value) -> Optional[str]:
    if value is None:
        return None
    return str(value).strip() or None


def _number(value, field: str) -> Optional[float]:
    """A cell as a positive quantity of money or shares: the direction is the kind's."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise LineError(f"{field} is not a number", 'bad_number', field=field, value=str(value))
    if isinstance(value, (int, float)):
        return abs(float(value))
    text = re.sub(r'[\s  €$£]', '', str(value))
    if not text:
        return None
    if ',' in text:
        # 1.234,56 or 1234,56: the comma is the decimal point; 1,234.56: the dot is.
        if '.' in text and text.rfind('.') > text.rfind(','):
            text = text.replace(',', '')
        else:
            text = text.replace('.', '').replace(',', '.')
    try:
        number = float(text)
    except ValueError:
        raise LineError(f"{str(value).strip()!r} is not a number ({field})",
                        'bad_number', field=field, value=str(value).strip())
    if number != number or number in (float('inf'), float('-inf')):
        raise LineError(f"{field} is not a finite number", 'bad_number', field=field, value=str(value))
    return abs(number)


__all__ = ['SECURITY_TYPES', 'ISIN', 'Line', 'LineError', 'Reading', 'fold', 'read']
