"""The ``account`` table: what is declared, and what may not be undone (#698)."""
import csv
from dataclasses import replace
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Set

from logfmt_logger import getLogger

from application import perf_series
from application import store as store_module
from application.events.schemas import (
    ACCOUNT_FILE_COLUMNS, Account, DEFAULT_ACCOUNT, Portfolio)

logger = getLogger("accounts")

ACCOUNT_COLUMNS = ACCOUNT_FILE_COLUMNS
REQUIRED_ACCOUNT_COLUMNS = frozenset({'id', 'type'})

_EVENT_MARKER = 'event_type'

CSV_ENCODING = 'utf-8-sig'


class AccountSourceError(Exception):
    """What is being declared cannot stand: no id, no type, or an id no route
    can carry."""


class AccountInUse(Exception):
    """The account cannot go: an event names it."""


class UnknownAccount(Exception):
    """No account has that id. A 404 at the API, never a silent create."""


class DuplicateAccount(Exception):
    """That id is taken. Two accounts with one id is what the PK forbids."""


def is_accounts_file(path: Path) -> bool:
    """Is this file an accounts source? Decided on its header alone."""
    try:
        header = header_of(Path(path))
    except Exception:
        return False
    if _EVENT_MARKER in header:
        return False
    return REQUIRED_ACCOUNT_COLUMNS.issubset(header)


def header_of(path: Path) -> Set[str]:
    """The column names of the first row, lowercased and stripped."""
    suffix = path.suffix.lower()
    if suffix == '.csv':
        with open(path, 'r', encoding=CSV_ENCODING) as handle:
            first = handle.readline()
        return _normalised(next(csv.reader([first]), []))
    if suffix == '.xlsx':
        return _normalised(_xlsx_first_row(path))
    return set()


def _open_workbook(path: Path):
    try:
        import openpyxl
    except ImportError as exc:  # pragma: no cover - openpyxl is a hard dep
        raise AccountSourceError(
            "openpyxl is required to read .xlsx files") from exc
    return openpyxl.load_workbook(path, read_only=True, data_only=True)


def _xlsx_first_row(path: Path) -> Sequence:
    """The first row of the first worksheet, and not a cell more."""
    workbook = _open_workbook(path)
    try:
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows(max_row=1, values_only=True):
                return row
            return ()
        return ()
    finally:
        workbook.close()


def _text(value) -> str:
    if value is None:
        return ''
    return str(value).strip()


def _normalised(names: Iterable) -> Set[str]:
    return {str(name).lower().strip() for name in names if name is not None}


def read_accounts(store) -> List[Account]:
    """Every row of ``account``, id-sorted. ``default`` is always among them."""
    rows = store.query(
        'SELECT id, type, label FROM account ORDER BY id')
    return [Account(id=r[0], type=r[1], label=r[2]) for r in rows]


def account_ids(store) -> Set[str]:
    """The ids an event may name. Never empty — ``default`` is always in it."""
    return {row[0] for row in store.query('SELECT id FROM account')}


def accounts_are_declared(store) -> bool:
    """Has anything been declared beyond the account every install is given?"""
    rows = store.query(
        "SELECT count(*) FROM account WHERE id <> ?", [DEFAULT_ACCOUNT])
    return bool(rows and rows[0][0])


def default_is_declared(store) -> bool:
    """Has anybody declared the row every install is given? (issue #725)"""
    row = next((a for a in read_accounts(store) if a.id == DEFAULT_ACCOUNT), None)
    if row is None:
        return False
    declared = as_declared(row)
    return declared.label is not None or declared.type is not None


def declared_portfolio(store) -> Optional[Portfolio]:
    """The declaration the app runs on, or ``None`` when nothing was declared."""
    rows = read_accounts(store)
    declared = [a for a in rows if a.id != DEFAULT_ACCOUNT]
    if not declared:
        return None

    fallback = next((a for a in rows if a.id == DEFAULT_ACCOUNT), None)
    if fallback is not None and is_named_by_events(store, DEFAULT_ACCOUNT):
        declared.append(fallback)
    return Portfolio(accounts=declared)


def as_declared(account: Account) -> Account:
    """The row as a **reader** must see it: what nobody declared reads ``None``."""
    if account.id != DEFAULT_ACCOUNT:
        return account
    _, seeded_type, seeded_label = store_module.DEFAULT_ACCOUNT_ROW
    return replace(
        account,
        label=None if account.label == seeded_label else account.label,
        type=None if account.type == seeded_type else account.type,
    )


def is_named_by_events(store, account_id: str) -> bool:
    """Does any event name this account? The refusal's whole predicate."""
    rows = store.query(
        'SELECT count(*) FROM event WHERE account = ?', [account_id])
    return bool(rows and rows[0][0])


def create_account(store, account_id: str, account_type: str,
                   label: Optional[str] = None) -> Account:
    """Declare an account. The app is where one is born, and the only place."""
    account_id = _text(account_id)
    account_type = _text(account_type)
    if not account_id:
        raise AccountSourceError("id is required")
    if '/' in account_id:
        # The id is the account's **address**: it is what the four
        # ``<account_id>`` routes match on, and Flask's default converter stops
        # at a slash. An id holding one inserts and is then unreachable — no
        # history, no reassignment, no rename and no delete — and ADR-0013
        # refuses the cascade that would clean it up (issue #861).
        raise AccountSourceError(
            "id cannot contain '/': it is the account's address in the app's "
            "own URLs, and a slash there names a route that does not exist")
    if not account_type:
        raise AccountSourceError("type is required")
    if account_id in account_ids(store):
        raise DuplicateAccount(f"Account {account_id!r} already exists")

    store.execute(
        'INSERT INTO account (id, type, label) VALUES (?, ?, ?)',
        [account_id, account_type, _text(label) or account_id])
    logger.info(f"Declared account {account_id}")
    return Account(id=account_id, type=account_type,
                   label=_text(label) or account_id)


def update_account(store, account_id: str, *, account_type: Optional[str] = None,
                   label: Optional[str] = None) -> Account:
    """Relabel or retype an account created in the app."""
    current = _require(store, account_id)
    new_type = _text(account_type) or current.type
    new_label = _text(label) or current.label
    store.execute('UPDATE account SET type = ?, label = ? WHERE id = ?',
                  [new_type, new_label, account_id])
    return Account(id=account_id, type=new_type, label=new_label)


def delete_account(store, account_id: str) -> None:
    """Remove an account."""
    _require(store, account_id)
    if account_id == DEFAULT_ACCOUNT:
        raise AccountInUse(
            "The default account is the one every install has, and it cannot "
            "be removed")
    if is_named_by_events(store, account_id):
        raise AccountInUse(
            f"Account {account_id!r} cannot be removed while an event names "
            f"it; forget those events first")
    perf_series.forget_account(store, account_id)
    store.execute('DELETE FROM account WHERE id = ?', [account_id])
    logger.info(f"Removed account {account_id}")


def _require(store, account_id: str) -> Account:
    for account in read_accounts(store):
        if account.id == account_id:
            return account
    raise UnknownAccount(f"No account with id {account_id!r}")


__all__ = [
    'ACCOUNT_COLUMNS', 'REQUIRED_ACCOUNT_COLUMNS',
    'AccountSourceError', 'AccountInUse', 'UnknownAccount',
    'DuplicateAccount',
    'is_accounts_file', 'header_of',
    'read_accounts', 'account_ids', 'accounts_are_declared',
    'default_is_declared', 'declared_portfolio',
    'is_named_by_events',
    'create_account', 'update_account', 'delete_account',
]
