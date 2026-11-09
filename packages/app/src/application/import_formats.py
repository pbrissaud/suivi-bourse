"""The files a broker hands over, read into lines of the ledger (IMPLEMENTATION.md § 3.4).

One engine and a registry of :class:`Profile` s. A profile is a name, the header
columns that tell the file apart, and where each field of an event lives; the
format of a file is **detected from its header line**, or named by the caller.
Reading is lenient per line: a line that cannot be read is a :class:`Line` with
a ``reason``, never a refusal of the file. Only a file that is no ledger at all
(no known header, not a ``.csv``/``.xlsx``) is refused.

The broker profiles follow the columns those exports are known for; none has
been checked against a real statement of every broker, which is why the header
match is on the few columns that name a broker and the rest is looked up by
alternatives.
"""
import csv
import io
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from application import uploads
from application.events.loader import EventLoader
from application.events.schemas import Event, EventType

ISIN = re.compile(r'[A-Z]{2}[A-Z0-9]{9}[0-9]')

#: The kinds of event that name a security, and the ones that move cash alone.
SECURITY_TYPES = frozenset({EventType.BUY, EventType.SELL, EventType.GRANT,
                            EventType.DIVIDEND})

#: What an operation label says, first match wins (folded: lower case, no accent).
_LABELS = (
    ('customer inbound', EventType.DEPOSIT),
    ('customer outbound', EventType.WITHDRAWAL),
    ('virement recu', EventType.DEPOSIT),
    ('virement emis', EventType.WITHDRAWAL),
    ('versement', EventType.DEPOSIT),
    ('deposit', EventType.DEPOSIT),
    ('depot', EventType.DEPOSIT),
    ('retrait', EventType.WITHDRAWAL),
    ('withdrawal', EventType.WITHDRAWAL),
    ('achat', EventType.BUY),
    ('buy', EventType.BUY),
    ('vente', EventType.SELL),
    ('cession', EventType.SELL),
    ('sell', EventType.SELL),
    ('dividende', EventType.DIVIDEND),
    ('dividend', EventType.DIVIDEND),
    ('coupon', EventType.DIVIDEND),
    ('attribution', EventType.GRANT),
    ('grant', EventType.GRANT),
)

_DATE_FORMATS = ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%d.%m.%Y', '%d/%m/%y')


@dataclass(frozen=True)
class Profile:
    """One broker's layout: how to recognise it, and where each field lives.

    Every column name is folded (see :func:`fold`). A field lists alternatives,
    the first one the file has wins.
    """

    key: str
    name: str
    detect: frozenset
    date: Tuple[str, ...]
    kind: Tuple[str, ...]
    symbol: Tuple[str, ...] = ()
    isin: Tuple[str, ...] = ()
    label: Tuple[str, ...] = ()
    quantity: Tuple[str, ...] = ()
    price: Tuple[str, ...] = ()
    fee: Tuple[str, ...] = ()
    amount: Tuple[str, ...] = ()
    notes: Tuple[str, ...] = ()


#: Most specific first; the generic layout, the app's own, closes the list.
PROFILES: Tuple[Profile, ...] = (
    Profile(
        key='bourse_direct', name='Bourse Direct',
        detect=frozenset({'operation', 'courtage', 'code isin'}),
        date=('date operation', 'date'), kind=('operation',),
        isin=('code isin',), label=('valeur',), quantity=('quantite',),
        price=('cours',), fee=('courtage',),
        amount=('montant net', 'montant'), notes=('libelle',)),
    Profile(
        key='fortuneo', name='Fortuneo',
        detect=frozenset({'date operation', 'operation', 'valeur', 'code isin', 'frais'}),
        date=('date operation',), kind=('operation',),
        isin=('code isin',), label=('valeur',), quantity=('quantite',),
        price=('cours',), fee=('frais',),
        amount=('montant net', 'montant'), notes=('libelle',)),
    Profile(
        key='boursorama', name='Boursorama',
        detect=frozenset({'date operation', 'operation', 'isin', 'frais'}),
        date=('date operation',), kind=('operation',),
        isin=('isin',), label=('valeur', 'libelle'), quantity=('quantite',),
        price=('cours', 'prix'), fee=('frais',),
        amount=('montant net', 'montant'), notes=('libelle',)),
    Profile(
        key='trade_republic', name='Trade Republic',
        detect=frozenset({'datetime', 'asset class', 'shares', 'type'}),
        date=('date',), kind=('type',), symbol=('symbol',),
        label=('name',), quantity=('shares',), price=('price',),
        fee=('fee',), amount=('amount',), notes=('description',)),
    Profile(
        key='generic', name='CSV',
        detect=frozenset({'date', 'event type'}),
        date=('date',), kind=('event type',), symbol=('symbol',),
        isin=('isin',), label=('name',), quantity=('quantity',),
        price=('unit price',), fee=('fee',), amount=('amount',),
        notes=('notes',)),
)


@dataclass(frozen=True)
class Line:
    """One line of the file: an event, or the reason it could not be read."""

    n: int
    event: Optional[Event] = None
    isin: Optional[str] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class Reading:
    """A file, read: the format it was read as, and its lines in file order."""

    filename: str
    profile: Profile
    format_name: str
    lines: List[Line]


def fold(value) -> str:
    """A header or a label as comparable text: no accent, lower case, single spaces."""
    text = unicodedata.normalize('NFKD', '' if value is None else str(value))
    text = ''.join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', text).strip()


def read(filename: str, stream, format_key: Optional[str] = None) -> Reading:
    """The uploaded file as lines, or a named refusal (:class:`uploads.UploadRefused`)."""
    name = Path(filename or '').name
    suffix = Path(name).suffix.lower()
    if suffix not in uploads.IMPORT_SUFFIXES:
        raise uploads.UploadRefused(
            f"{name or 'the file'} is not a ledger this app reads: an import "
            f"file is a {' or a '.join(uploads.IMPORT_SUFFIXES)}", file=name or None)
    wanted = _named(format_key)

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
            file=name or None)
    if not table:
        raise uploads.UploadRefused(f"{name} is empty", file=name or None)

    header = [fold(cell) for cell in table[0]]
    profile = wanted or _detected(header)
    if profile is None:
        raise uploads.UploadRefused(
            f"{name} has a header this app does not recognise; the formats it "
            f"reads are {', '.join(p.name for p in PROFILES)}", file=name or None)
    # The same CSV layout read from a workbook is called what it is.
    shown = 'Excel' if suffix == '.xlsx' and profile.key == 'generic' else profile.name
    return Reading(name, profile, shown, _lines(profile, header, table[1:]))


def format_keys() -> Tuple[str, ...]:
    """The keys the ``format`` parameter takes."""
    return tuple(profile.key for profile in PROFILES)


def _named(key: Optional[str]) -> Optional[Profile]:
    if not key:
        return None
    wanted = fold(key).replace(' ', '')
    for profile in PROFILES:
        if wanted in (profile.key.replace('_', ''), fold(profile.name).replace(' ', '')):
            return profile
    if wanted == 'excel':
        return PROFILES[-1]
    raise uploads.UploadRefused(
        f"format {key!r} is not one of {', '.join(format_keys())}")


def _detected(header: Sequence[str]) -> Optional[Profile]:
    columns = set(header)
    return next((p for p in PROFILES if p.detect <= columns), None)


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
    try:
        for sheet in workbook.worksheets:
            rows = [list(row) for row in sheet.iter_rows(values_only=True)]
            if any(any(cell is not None for cell in row) for row in rows):
                return rows
    finally:
        workbook.close()
    return []


def _lines(profile: Profile, header: Sequence[str], rows: Sequence[Sequence]) -> List[Line]:
    where: Dict[str, Optional[int]] = {
        field: next((header.index(c) for c in getattr(profile, field) if c in header), None)
        for field in ('date', 'kind', 'symbol', 'isin', 'label', 'quantity',
                      'price', 'fee', 'amount', 'notes')}
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
        except ValueError as exc:
            lines.append(Line(n, reason=str(exc)))
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
                raise ValueError("a dividend needs an amount")
        else:
            if not quantity:
                raise ValueError("a purchase or a sale needs a quantity")
            if price is None and amount and kind != EventType.GRANT:
                # The net amount carries the fee: buy = qty × price + fee.
                price = (amount - (fee or 0)) / quantity if kind == EventType.BUY \
                    else (amount + (fee or 0)) / quantity
            if price is None and kind != EventType.GRANT:
                raise ValueError("a purchase or a sale needs a unit price")
        if not (symbol or isin or _text(cell('label'))):
            raise ValueError("the line names no security")
    elif not amount:
        raise ValueError("a deposit or a withdrawal needs an amount")

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
    return Line(n, event=event, isin=isin if security else None)


def _day(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = _text(value)
    if text is None:
        raise ValueError("the line has no date")
    text = text.split(' ')[0].split('T')[0]
    for pattern in _DATE_FORMATS:
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    raise ValueError(f"{text!r} is not a date")


def _kind(value) -> EventType:
    label = fold(value)
    for needle, kind in _LABELS:
        if needle in label:
            return kind
    raise ValueError(f"{_text(value) or 'an empty operation'!r} is not an operation the ledger records")


def _text(value) -> Optional[str]:
    if value is None:
        return None
    return str(value).strip() or None


def _number(value, field: str) -> Optional[float]:
    """A cell as a positive quantity of money or shares: the direction is the kind's."""
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} is not a number")
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
        raise ValueError(f"{str(value).strip()!r} is not a number ({field})")
    if number != number or number in (float('inf'), float('-inf')):
        raise ValueError(f"{field} is not a finite number")
    return abs(number)


__all__ = ['PROFILES', 'SECURITY_TYPES', 'ISIN', 'Line', 'Profile', 'Reading',
           'fold', 'format_keys', 'read']
