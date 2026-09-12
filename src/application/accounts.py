"""The ``account`` table: what is declared, and what may not be undone (#698).

**And the two tables #752 adds**, because they are the same gesture continued:
``taxation_model`` holds the models their owner wrote, ``account_fact`` holds
what they declared *about an account* — which model it carries, and the day the
wrapper was opened (#918 writes that one; this module declares its column).
Both are declaration, both are written here and nowhere else, and
``.github/scripts/conventions.sh`` says so on the source (ADR-0006, ADR-0044).
The arithmetic is not here: :mod:`application.taxation` is pure and holds the
kinds, and one module cannot be both.
"""
import csv
import json
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from logfmt_logger import getLogger

from application import perf_series
from application import store as store_module
from application import taxation
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


class UnknownTaxationModel(Exception):
    """No model has that id — a reference to nothing, refused where it enters."""


class TaxationModelInUse(Exception):
    """The model cannot go: an account carries it. It **names which**.

    The accounts ride on the exception rather than being re-read by whoever
    catches it: the refusal's whole point is where to go next, and a second query
    for them would run outside the lock the refusal was decided under.
    """

    def __init__(self, message: str, accounts: Sequence[str]):
        super().__init__(message)
        self.accounts = list(accounts)


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
    rows = store.query('SELECT id, label FROM account ORDER BY id')
    return [Account(id=r[0], label=r[1]) for r in rows]


def account_ids(store) -> Set[str]:
    """The ids an event may name. Never empty — ``default`` is always in it."""
    return {row[0] for row in store.query('SELECT id FROM account')}


def accounts_are_declared(store) -> bool:
    """Has anything been declared beyond the account every install is given?"""
    rows = store.query(
        "SELECT count(*) FROM account WHERE id <> ?", [DEFAULT_ACCOUNT])
    return bool(rows and rows[0][0])


def default_is_declared(store) -> bool:
    """Has anybody declared the row every install is given? (issue #725)

    **On the label alone** since #916: the type used to be the other half of this
    answer, and there is no longer a type to answer with.
    """
    return any(as_declared(a).label is not None
               for a in read_accounts(store) if a.id == DEFAULT_ACCOUNT)


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
    seeded_label = store_module.DEFAULT_ACCOUNT_ROW[2]
    return replace(account,
                   label=None if account.label == seeded_label else account.label)


def is_named_by_events(store, account_id: str) -> bool:
    """Does any event name this account? The refusal's whole predicate."""
    rows = store.query(
        'SELECT count(*) FROM event WHERE account = ?', [account_id])
    return bool(rows and rows[0][0])


def refuse_unaddressable_id(account_id: str) -> None:
    """Refuse an id the app's own ``<account_id>`` routes cannot carry (#861).

    The id is the account's **address**: it is what four routes match on —
    ``GET …/history``, ``POST …/reassignment``, ``PATCH`` and ``DELETE`` — and
    Flask's default converter stops at a slash, while a URL resolves ``.`` and
    ``..`` away before the request leaves the browser. An id holding one of the
    three inserts and is then unreachable, unrenameable and **undeletable**,
    with ADR-0013 refusing the cascade that would clean it up.

    It is a function of its own, and not a line inside :func:`create_account`,
    because the dry run has to refuse what the write would refuse: the preview
    judges a file's declarations (:func:`entries.judge`) without going anywhere
    near the writer.
    """
    account_id = _text(account_id)
    if '/' in account_id or account_id in ('.', '..'):
        raise AccountSourceError(
            f"{account_id!r} cannot be an account id: it is the address the "
            f"account is reached at in the app's own URLs, and '/', '.' and "
            f"'..' there name a route that does not exist")


def create_account(store, account_id: str,
                   label: Optional[str] = None) -> Account:
    """Declare an account. The app is where one is born, and the only place.

    **Two fields** since #916: an identifier and a name. The ``type`` column is
    still written, because it is ``NOT NULL`` and no migration machinery exists
    to drop it (#926) — it takes the seed's own word, and nothing reads it.
    """
    account_id = _text(account_id)
    if not account_id:
        raise AccountSourceError("id is required")
    refuse_unaddressable_id(account_id)
    if account_id in account_ids(store):
        raise DuplicateAccount(f"Account {account_id!r} already exists")

    store.execute(
        'INSERT INTO account (id, type, label) VALUES (?, ?, ?)',
        [account_id, store_module.DEFAULT_ACCOUNT_ROW[1],
         _text(label) or account_id])
    logger.info(f"Declared account {account_id}")
    return Account(id=account_id, label=_text(label) or account_id)


def update_account(store, account_id: str, *,
                   label: Optional[str] = None) -> Account:
    """Rename an account created in the app.

    Renaming is the whole of it since #916: there is no second column left to
    change, and a blank keeps the name that is there.
    """
    current = _require(store, account_id)
    new_label = _text(label) or current.label
    store.execute('UPDATE account SET label = ? WHERE id = ?',
                  [new_label, account_id])
    return Account(id=account_id, label=new_label)


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
    # What its owner declared about it goes with it (#752): the row is keyed by
    # the account and references it, so leaving it behind is a foreign key
    # pointing at nothing — and a fact about an account that no longer exists is
    # not a fact about anything.
    store.execute('DELETE FROM account_fact WHERE account = ?', [account_id])
    store.execute('DELETE FROM account WHERE id = ?', [account_id])
    logger.info(f"Removed account {account_id}")


def _require(store, account_id: str) -> Account:
    for account in read_accounts(store):
        if account.id == account_id:
            return account
    raise UnknownAccount(f"No account with id {account_id!r}")


# --------------------------------------------------------------------------- #
# The taxation model, and the facts an account carries (#752, ADR-0042/43/44)
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class TaxationModel:
    """One row of ``taxation_model`` — the owner's own, never a shipped one.

    Nothing is seeded here and nothing ever will be: a seeded row could not be
    corrected (``DO NOTHING`` skips the fix, ``DO UPDATE`` overwrites what its
    owner did to it), and what the app ships carries no money anyway — it is two
    structural fields a form pre-fills and does not store (ADR-0043).
    """
    id: str
    name: str
    kind: str
    parameters: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {'id': self.id, 'name': self.name, 'kind': self.kind,
                'parameters': dict(self.parameters)}


def read_models(store) -> List[TaxationModel]:
    """Every model its owner wrote, name-sorted."""
    rows = store.query(
        'SELECT id, name, kind, parameters FROM taxation_model '
        'ORDER BY name, id')
    return [TaxationModel(id=r[0], name=r[1], kind=r[2],
                          parameters=json.loads(r[3])) for r in rows]


def read_model(store, model_id: str) -> TaxationModel:
    """One model, or :class:`UnknownTaxationModel`."""
    for model in read_models(store):
        if model.id == model_id:
            return model
    raise UnknownTaxationModel(f"No taxation model with id {model_id!r}")


def create_model(store, name: Optional[str], kind: Any,
                 parameters: Any) -> TaxationModel:
    """Write a taxation model. The kind is checked here, once.

    The id is the app's to allocate and the owner never sees it typed: it names
    the row for as long as the row lives (ADR-0027) and carries no meaning, so a
    name corrected does not move what an account points at.
    """
    checked = taxation.validate(kind, parameters)
    label = _text(name)
    if not label:
        raise taxation.ModelRejected("a taxation model is named")

    model = TaxationModel(id=uuid.uuid4().hex, name=label, kind=kind,
                          parameters=checked)
    store.execute(
        'INSERT INTO taxation_model (id, name, kind, parameters) '
        'VALUES (?, ?, ?, ?)',
        [model.id, model.name, model.kind, json.dumps(model.parameters)])
    logger.info(f"Declared taxation model {model.id} ({model.kind})")
    return model


def update_model(store, model_id: str, *, name: Optional[str] = None,
                 kind: Any = None, parameters: Any = None) -> TaxationModel:
    """Correct a model. A blank name keeps the one that is there.

    **The kind and its parameters move together.** They are one value — a kind
    fixes what a row of it must carry — so a kind sent without parameters is
    checked against the parameters that are there, and either it fits or the
    write is refused.
    """
    current = read_model(store, model_id)
    next_kind = current.kind if kind is None else kind
    given = current.parameters if parameters is None else parameters
    checked = taxation.validate(next_kind, given)
    label = _text(name) or current.name

    model = TaxationModel(id=model_id, name=label, kind=next_kind,
                          parameters=checked)
    store.execute(
        'UPDATE taxation_model SET name = ?, kind = ?, parameters = ? '
        'WHERE id = ?',
        [model.name, model.kind, json.dumps(model.parameters), model_id])
    return model


def accounts_carrying(store, model_id: str) -> List[str]:
    """The accounts this model is attached to — the refusal's whole predicate."""
    return [row[0] for row in store.query(
        'SELECT account FROM account_fact WHERE taxation_model = ? '
        'ORDER BY account', [model_id])]


def delete_model(store, model_id: str) -> None:
    """Remove a model, unless an account still carries it.

    ``delete_account``'s own shape: the refusal **names** what holds the row
    back, because *it is in use* without saying where sends its reader hunting
    through their accounts one panel at a time.
    """
    read_model(store, model_id)
    carried = accounts_carrying(store, model_id)
    if carried:
        raise TaxationModelInUse(
            f"Taxation model {model_id!r} cannot be removed while "
            f"{', '.join(repr(a) for a in carried)} carries it; detach it "
            f"there first", carried)
    store.execute('DELETE FROM taxation_model WHERE id = ?', [model_id])
    logger.info(f"Removed taxation model {model_id}")


def taxation_models_by_account(store) -> Dict[str, str]:
    """Which account carries which model. **Absent means absent** (#845)."""
    return {row[0]: row[1] for row in store.query(
        'SELECT account, taxation_model FROM account_fact '
        'WHERE taxation_model IS NOT NULL')}


def set_taxation_model(store, account_id: str,
                       model_id: Optional[str]) -> Optional[str]:
    """Attach a model to an account, or detach the one it carries.

    ``None`` detaches, and detaching leaves **no row** rather than a row saying
    nothing: a missing row is *never declared* and a null column is *unset*, and
    ADR-0044 is written about the class of defect that follows from spelling the
    first as the second. The row survives its own emptiness only once #918 puts
    an opening date beside it — which is why the delete below reads that column
    rather than dropping the row outright.
    """
    _require(store, account_id)
    target = _text(model_id) or None
    if target is not None:
        read_model(store, target)

    store.execute(
        'INSERT INTO account_fact (account, taxation_model) VALUES (?, ?) '
        'ON CONFLICT (account) DO UPDATE SET '
        'taxation_model = excluded.taxation_model',
        [account_id, target])
    store.execute(
        'DELETE FROM account_fact WHERE account = ? '
        'AND taxation_model IS NULL AND opened_on IS NULL', [account_id])
    return target


__all__ = [
    'ACCOUNT_COLUMNS', 'REQUIRED_ACCOUNT_COLUMNS',
    'AccountSourceError', 'AccountInUse', 'UnknownAccount',
    'DuplicateAccount', 'UnknownTaxationModel', 'TaxationModelInUse',
    'TaxationModel', 'read_models', 'read_model', 'create_model',
    'update_model', 'delete_model', 'accounts_carrying',
    'taxation_models_by_account', 'set_taxation_model',
    'is_accounts_file', 'header_of',
    'read_accounts', 'account_ids', 'accounts_are_declared',
    'default_is_declared', 'declared_portfolio',
    'is_named_by_events',
    'refuse_unaddressable_id',
    'create_account', 'update_account', 'delete_account',
]
