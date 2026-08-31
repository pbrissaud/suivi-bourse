"""The ``account`` table: what is declared, and what may not be undone (#698).

An account is **user data, not a setting** (ADR-0013). The provenance half of
that record is superseded: there is no accounts file any more, an account is
declared in the app and nowhere else (ADR-0034), and what is left of the file
half here is a header reader — :func:`is_accounts_file` — kept because the
**upload** has to recognise a declaration in order to refuse it by name.

Two decisions carry the module.

**There is always at least one account.** The seeded ``default`` row is the one
row every install owns, so nothing in the app branches on *"are accounts
declared"* (ADR-0013): an empty ``account`` column means ``default`` until
something is declared, and an error afterwards. That is v4's rule **minus the
opt-in**, and it is what makes a single-account v4's event files import without
a single edit.

**An account is undeletable while an event names it.** The refusal is the same
whatever asks, and it retires by construction the historical residue the earlier
design merely tolerated. The cascade is refused, never performed.

**Not in this module**: the event rows, which are :mod:`entries`' — the one
writer of them since #816. This module owns the ``account`` table alone, one
writer per row, as the schema's generating rule requires.
"""
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

#: The columns that make a file a declaration of accounts — the columns of the
#: ``account`` table. ``label`` is optional and falls back to the id, the way
#: v4's ``accounts:`` block did; the other two are what the DDL declares
#: ``NOT NULL``.
#:
#: The list itself lives in :mod:`events.schemas`, and this is a second **name**
#: for it rather than a second value. Both names are read at a user and neither
#: imports the other's module: :mod:`main` quotes this one when it says a v4
#: ``settings.yaml`` is named and never read, :mod:`uploads` quotes the other
#: when it turns a declaration away. One tuple serves both, so neither message
#: can drift from the DDL without the other.
ACCOUNT_COLUMNS = ACCOUNT_FILE_COLUMNS
REQUIRED_ACCOUNT_COLUMNS = frozenset({'id', 'type'})

#: What tells an accounts file from an event file: its **header**, never its
#: name (spec #695 § 6 — no filename has a special meaning in v5). ``event_type``
#: is what an event file always carries and an accounts file never does, so a
#: file that somehow held both columns is read as the events file it looks most
#: like and refused by the event loader on its own terms.
_EVENT_MARKER = 'event_type'

#: ``utf-8-sig`` and not ``utf-8``: Excel's own *"CSV UTF-8"* export writes a
#: byte-order mark, which under plain ``utf-8`` turns the first column name into
#: ``﻿id`` — so the file would not even be *recognised* as a declaration,
#: and would be refused as an event file missing its ``date`` column. The codec
#: reads a mark-less file identically, so this costs nothing to a file that
#: never had one.
CSV_ENCODING = 'utf-8-sig'


class AccountSourceError(Exception):
    """What is being declared cannot stand: no id, or no type.

    Raised **before** anything is written, so a refused declaration leaves the
    store exactly as it was — the same all-or-nothing contract an event file
    gets.
    """


class AccountInUse(Exception):
    """The account cannot go: an event names it.

    The one refusal ADR-0013 turns into a construction rather than a
    convention, and the half of that record ADR-0034 leaves standing: the
    cascade is *refused*, never performed.
    """


class UnknownAccount(Exception):
    """No account has that id. A 404 at the API, never a silent create."""


class DuplicateAccount(Exception):
    """That id is taken. Two accounts with one id is what the PK forbids."""


# --------------------------------------------------------------------------- #
# Reading a header — all that is left of the file
# --------------------------------------------------------------------------- #

def is_accounts_file(path: Path) -> bool:
    """Is this file an accounts source? Decided on its header alone.

    Unreadable, empty or headerless files answer ``False``: they are then taken
    for event files and refused by the event loader, which is the refusal that
    names the columns a user is most likely to have meant.
    """
    try:
        header = header_of(Path(path))
    except Exception:
        return False
    if _EVENT_MARKER in header:
        return False
    return REQUIRED_ACCOUNT_COLUMNS.issubset(header)


def header_of(path: Path) -> Set[str]:
    """The column names of the first row, lowercased and stripped.

    **One row, never the file.** It is what decides the kind of an uploaded
    file before anything of it is loaded (:mod:`uploads`), so a workbook is
    opened read-only and its first row pulled lazily — materialising every sheet
    here would put a full parse behind a question answered by one line.
    """
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


# --------------------------------------------------------------------------- #
# Reading the table
# --------------------------------------------------------------------------- #

def read_accounts(store) -> List[Account]:
    """Every row of ``account``, id-sorted. ``default`` is always among them."""
    rows = store.query(
        'SELECT id, type, label FROM account ORDER BY id')
    return [Account(id=r[0], type=r[1], label=r[2]) for r in rows]


def account_ids(store) -> Set[str]:
    """The ids an event may name. Never empty — ``default`` is always in it."""
    return {row[0] for row in store.query('SELECT id FROM account')}


def accounts_are_declared(store) -> bool:
    """Has anything been declared beyond the account every install is given?

    The one predicate the empty-``account``-column rule turns on: blank means
    ``default`` until this is true, and is an error afterwards (spec #695 § 6).

    It is deliberately *not* "does the account table have rows" — it always has
    one — and deliberately not "was a **file** imported" either. An account
    created in the app declares just as much as a file does, so a blank column
    after it is the same omission, and answering otherwise would quietly pile a
    second account's events onto the first, which is the exact mistake the rule
    exists to refuse.
    """
    rows = store.query(
        "SELECT count(*) FROM account WHERE id <> ?", [DEFAULT_ACCOUNT])
    return bool(rows and rows[0][0])


def default_is_declared(store) -> bool:
    """Has anybody declared the row every install is given? (issue #725)

    The companion of :func:`accounts_are_declared`, and it is a different
    question: that one counts rows *beside* ``default``, this one asks whether
    ``default`` itself has stopped being what the schema seeded. Two roads
    reach that, and each of them is a declaration —

    * its owner **renamed** it, which is how an install declares its one account
      (the gesture #729 built the block for at N = 1);
    * its owner **retyped** it, the same clause on the other seeded column.

    There was a third — a **file** taking the row over (#698) — and it left with
    the accounts file itself (ADR-0034): an account is born in the app, so the
    only hand that can have touched this row is its owner's.

    It exists for the reassignment alone. *Events naming ``default``* and
    *events nobody assigned* are the same set only while nobody has declared
    that row, and reading them as one afterwards would take a whole ledger off
    the one line its owner had themselves put a name on.

    The comparison is :func:`as_declared`'s, not a second one: there is no
    *renamed* column to add to a row every install already has (ADR-0001 leaves
    no migration machinery), so what says *nobody declared this* is that it
    still says what the seed said. The other edge follows from the same
    sentence: an owner who names their account exactly what the seed named it
    is naming it, and this answers ``False`` — which costs them the offer and
    never a row.
    """
    row = next((a for a in read_accounts(store) if a.id == DEFAULT_ACCOUNT), None)
    if row is None:
        return False
    declared = as_declared(row)
    return declared.label is not None or declared.type is not None


def declared_portfolio(store) -> Optional[Portfolio]:
    """The declaration the app runs on, or ``None`` when nothing was declared.

    ``None`` is **ergonomics, not a discriminant** (ADR-0013): the store always
    holds at least one account, and every write path resolves an account without
    asking whether any were declared. What this answers is the narrower question
    the *pages* ask — is there a declaration to show — and it is why the seeded
    ``default`` row is left out of the list unless something actually names it:
    an install that declared two accounts should not grow a phantom third whose
    figures are all zero.
    """
    rows = read_accounts(store)
    declared = [a for a in rows if a.id != DEFAULT_ACCOUNT]
    if not declared:
        return None

    fallback = next((a for a in rows if a.id == DEFAULT_ACCOUNT), None)
    if fallback is not None and is_named_by_events(store, DEFAULT_ACCOUNT):
        declared.append(fallback)
    return Portfolio(accounts=declared)


def as_declared(account: Account) -> Account:
    """The row as a **reader** must see it: what nobody declared reads ``None``.

    The seed writes ``Default account`` / ``OTHER`` into a row every install
    owns and nobody asked for, and those two values are English the front must
    not render (ADR-0024) — so the interface names that row from its own
    catalogue until its owner gives it a name, and shows the name they gave the
    moment they do.

    **Which side recognises the seed is the whole decision.** The value is
    written here, in ``store.DEFAULT_ACCOUNT_ROW``, so it is recognised here:
    the wire carries ``null`` and the front folds *nothing declared* into its
    catalogue with no literal of its own. Recognising it in the client instead
    was written and undone — it put a **third copy** of a server-owned string on
    the far side of HTTP, where no compiler and no test spans both ends (the
    front's only faked edge is MSW, so its fixtures would have gone on agreeing
    with themselves). Reworded here for a typo, the seed would then have started
    rendering as a name its owner had typed, silently, every gate green — which
    is the exact failure the rule exists to prevent, arrived from the other side.

    Only the ``default`` row is concerned, and only while it still says what the
    seed said: an owner who names their own account ``Default account`` is
    naming it, and a comparison is what the store's lack of migration machinery
    leaves (ADR-0001) — there is no *renamed* column to add to a row every
    install already has.
    """
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


# --------------------------------------------------------------------------- #
# Writing the table — the app's half
# --------------------------------------------------------------------------- #

def create_account(store, account_id: str, account_type: str,
                   label: Optional[str] = None) -> Account:
    """Declare an account. The app is where one is born, and the only place.

    There is no second population of rows to tell this one from (ADR-0034): a
    declared account is a declared account, and how it was declared is not a
    property of it — the move :mod:`entries` makes for events, arriving here for
    the same reason.
    """
    account_id = _text(account_id)
    account_type = _text(account_type)
    if not account_id:
        raise AccountSourceError("id is required")
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
    """Relabel or retype an account created in the app.

    The id is not among what can change: it is the value events name, so
    changing it would be renaming every event that names it — and an event is
    addressed by its own key, never by a column somebody else may rewrite.
    """
    current = _require(store, account_id)
    new_type = _text(account_type) or current.type
    new_label = _text(label) or current.label
    store.execute('UPDATE account SET type = ?, label = ? WHERE id = ?',
                  [new_type, new_label, account_id])
    return Account(id=account_id, type=new_type, label=new_label)


def delete_account(store, account_id: str) -> None:
    """Remove an account.

    Two refusals, **in this order**: the ``default`` row (there is always at
    least one account), and any account an event names (ADR-0013 — the cascade
    is refused, never performed). A third stood here while a file could declare
    a row and be forgotten; the file is gone (ADR-0034) and the refusal with it.
    """
    _require(store, account_id)
    if account_id == DEFAULT_ACCOUNT:
        raise AccountInUse(
            "The default account is the one every install has, and it cannot "
            "be removed")
    if is_named_by_events(store, account_id):
        raise AccountInUse(
            f"Account {account_id!r} cannot be removed while an event names "
            f"it; forget those events first")
    # The cached figures go with it (issue #700). ``account_metrics.account``
    # references this row, so the perf job's first cycle would otherwise make
    # every declared account undeletable — a constraint error the API renders as
    # a ``503``, in place of the ``200`` this gesture is designed to answer. The
    # series is a cache and rebuilds itself; the refusal that matters is the one
    # above, on an event, which cannot.
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
