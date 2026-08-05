"""Tests for the configuration write path (issue #662, design #653).

#662 says it plainly: this is the one part of the map that can **destroy user
data**, so it earns the most. What is tested here is therefore not the routes
(five lines each, and covered in ``test_web_api.py``) but the three properties
the sequence exists to guarantee:

* a **rejected candidate leaves the file byte-identical** — the validate-then-
  replace order, which is what makes "there is nothing to roll back" true;
* a **stale fingerprint is refused** rather than applied to whichever row the
  address now happens to name;
* a **workbook is never written**, because saving one loaded with
  ``data_only=True`` writes the cached values over the formulas.

Plus the rule that makes the ledger usable at all, and that is easy to get
backwards: an installation whose files are *already* invalid must still accept
an edit, or the repair tool is locked behind the thing it repairs.
"""
from pathlib import Path

import pytest
import yaml

import main
from config_writer import (
    BACKUP_SUFFIX,
    ENTRY_FILE,
    Clobber,
    ConfigWriter,
    InvalidCandidate,
    ReadOnlySource,
    SourceUnwritable,
    StaleFingerprint,
    UnknownRow,
    WrongMode,
    _replace_accounts_block,
)
from events.editor import EventEditorReader, decode_id, encode_id

HEADER = "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account\n"

VALID = HEADER + (
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase,\n"
    "2024-03-01,DIVIDEND,AAPL,Apple Inc,,,,8.50,Q1 2024,\n"
)


def build(tmp_path, files=None, settings=None):
    """A writer over a real ConfigurationManager on a real directory."""
    events_dir = tmp_path / 'events'
    events_dir.mkdir(exist_ok=True)
    # `is None`, not falsy: an explicitly empty mapping means "no CSV at all",
    # which is what the workbook tests need.
    for name, content in ({'2024.csv': VALID} if files is None else files).items():
        (events_dir / name).write_text(content, encoding='utf-8')
    if settings is not None:
        (tmp_path / 'settings.yaml').write_text(settings, encoding='utf-8')

    manager = main.ConfigurationManager(config_dir=str(tmp_path))
    return ConfigWriter(manager), manager, events_dir


def ledger(events_dir):
    return EventEditorReader(str(events_dir)).list_records()


def token_of(events_dir, index):
    return ledger(events_dir)[index].id


def etag_of(events_dir, index):
    return ledger(events_dir)[index].etag


# --------------------------------------------------------------------------- #
# The sequence: validate, then replace
# --------------------------------------------------------------------------- #

class TestValidateThenReplace:
    """The order is the design, so the order is what is asserted."""

    def test_rejected_candidate_leaves_the_file_byte_identical(self, tmp_path):
        """The property the whole module exists for.

        Not "the change is undone" — *nothing is written*. Comparing bytes
        rather than parsed events is deliberate: a rollback that rewrote the
        file with the same events would still have reformatted it, and a
        configuration directory is a set of files a human also edits by hand.
        """
        writer, _, events_dir = build(tmp_path)
        before = (events_dir / '2024.csv').read_bytes()

        # Selling 400 shares of a position holding 10: well-formed rows, an
        # aggregate the replay refuses.
        with pytest.raises(InvalidCandidate):
            writer.add_event({
                'date': '2024-06-01', 'event_type': 'SELL', 'symbol': 'AAPL',
                'name': 'Apple Inc', 'quantity': '400', 'unit_price': '190',
            })

        assert (events_dir / '2024.csv').read_bytes() == before
        assert not (events_dir / ENTRY_FILE).exists()

    def test_rejection_carries_the_errors_verbatim(self, tmp_path):
        """#653: the response says *which* row, not merely 'invalid'."""
        writer, _, _ = build(tmp_path)

        with pytest.raises(InvalidCandidate) as excinfo:
            writer.add_event({
                'date': '2024-06-01', 'event_type': 'SELL', 'symbol': 'AAPL',
                'name': 'Apple Inc', 'quantity': '400', 'unit_price': '190',
            })

        assert excinfo.value.errors
        assert any('AAPL' in error for error in excinfo.value.errors)

    def test_a_write_leaves_no_temp_file_behind(self, tmp_path):
        """The staged file is renamed, never merely closed.

        And its suffix is invisible to the loader, so even a leaked one could
        not be read as events — checked here because the day it leaks is the day
        nobody is looking.
        """
        writer, _, events_dir = build(tmp_path)
        writer.add_event({
            'date': '2024-06-01', 'event_type': 'GRANT', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': '1',
        })

        names = sorted(p.name for p in events_dir.iterdir())
        assert names == ['2024.csv', ENTRY_FILE]

    def test_the_snapshot_is_republished_from_disk(self, tmp_path):
        """``reload(force=True)`` — a re-read, not a hand-off of the candidate.

        What is published must be what a restart would load, which is only true
        if the disk is what was read.
        """
        writer, manager, _ = build(tmp_path)
        manager.reload()
        assert len(manager.current().shares) == 1

        result = writer.add_event({
            'date': '2024-02-01', 'event_type': 'BUY', 'symbol': 'MSFT',
            'name': 'Microsoft', 'quantity': '5', 'unit_price': '380',
        })

        assert result.reloaded is True
        assert {share['symbol'] for share in manager.current().shares} == {'AAPL', 'MSFT'}


# --------------------------------------------------------------------------- #
# Creating, editing, deleting
# --------------------------------------------------------------------------- #

class TestEventWrites:

    def test_a_created_event_lands_in_the_entry_file(self, tmp_path):
        """The server picks the file; the result names it.

        The client never sends one — #653 keeps files out of the event contract
        so the store stays replaceable — so the *response* is the only place the
        UI can learn where the row went.
        """
        writer, _, events_dir = build(tmp_path)
        result = writer.add_event({
            'date': '2024-06-01', 'event_type': 'GRANT', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': '1', 'notes': 'Bonus',
        })

        assert result.source == ENTRY_FILE
        assert result.record.event.symbol == 'AAPL'
        text = (events_dir / ENTRY_FILE).read_text(encoding='utf-8')
        assert text.startswith('date,event_type,symbol,name,quantity,')
        assert 'GRANT' in text

    def test_a_created_event_is_addressable_immediately(self, tmp_path):
        """The returned id and etag are the ones a fresh GET would hand out."""
        writer, _, events_dir = build(tmp_path)
        result = writer.add_event({
            'date': '2024-06-01', 'event_type': 'GRANT', 'symbol': 'AAPL',
            'name': 'Apple Inc', 'quantity': '1',
        })

        fresh = [r for r in ledger(events_dir) if r.source == ENTRY_FILE]
        assert [result.record.id, result.record.etag] == [fresh[0].id, fresh[0].etag]

    def test_an_unparsable_submitted_row_is_refused_by_itself(self, tmp_path):
        """The one thing the invalid → invalid tolerance never forgives."""
        writer, _, events_dir = build(tmp_path)
        before = (events_dir / '2024.csv').read_bytes()

        with pytest.raises(InvalidCandidate) as excinfo:
            writer.add_event({
                'date': '15/01/2024', 'event_type': 'BUY', 'symbol': 'AAPL',
                'name': 'Apple Inc', 'quantity': '1', 'unit_price': '150',
            })

        assert 'Invalid date format' in excinfo.value.errors[0]
        assert (events_dir / '2024.csv').read_bytes() == before

    def test_an_edit_touches_only_the_named_fields(self, tmp_path):
        """PATCH is partial: the columns the body omits keep their cells.

        The notes column is the tell — an edit of the quantity that silently
        blanked a comment would be a data loss nobody would report as a bug.
        """
        writer, _, events_dir = build(tmp_path)
        writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                            {'quantity': '12'})

        row = ledger(events_dir)[0]
        assert row.event.quantity == 12.0
        assert row.event.notes == 'Initial purchase'
        assert row.event.unit_price == 150.0

    def test_an_unknown_column_in_the_body_is_ignored(self, tmp_path):
        """A client cannot add a column to a file by naming it."""
        writer, _, events_dir = build(tmp_path)
        writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                            {'quantity': '12', 'sneaky': 'x'})

        header = (events_dir / '2024.csv').read_text(encoding='utf-8').splitlines()[0]
        assert 'sneaky' not in header

    def test_a_column_the_app_does_not_know_survives_an_edit(self, tmp_path):
        """The other direction: the user's own extra column is not dropped.

        ``fingerprint`` deliberately ignores unknown columns so they do not
        invalidate every id in the file; that only stays safe if writing back
        keeps them.
        """
        writer, _, events_dir = build(tmp_path, files={'2024.csv': (
            "date,event_type,symbol,name,quantity,unit_price,fee,amount,notes,account,broker\n"
            "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial,,Boursorama\n"
        )})
        writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                            {'quantity': '11'})

        text = (events_dir / '2024.csv').read_text(encoding='utf-8')
        assert 'broker' in text.splitlines()[0]
        assert 'Boursorama' in text

    def test_a_deleted_row_disappears_and_shifts_the_ones_after_it(self, tmp_path):
        """The trap the front carries: an address is a position.

        Asserting the shift rather than avoiding it — an id that survived a
        deletion would mean the address had become content-addressed, which
        #653 rejected because duplicate events are legitimate.
        """
        writer, _, events_dir = build(tmp_path)
        second_id = token_of(events_dir, 1)

        writer.delete_event(token_of(events_dir, 0), etag_of(events_dir, 0))

        rows = ledger(events_dir)
        assert len(rows) == 1
        assert rows[0].event.event_type.value == 'DIVIDEND'
        assert rows[0].id != second_id


# --------------------------------------------------------------------------- #
# The guard
# --------------------------------------------------------------------------- #

class TestFingerprintGuard:

    def test_a_stale_fingerprint_is_refused(self, tmp_path):
        """The scenario in one test: reorder the file, then PATCH.

        The token still resolves — it is a position, and the position still
        exists — so without the fingerprint this write would land on the
        dividend while claiming to edit the purchase.
        """
        writer, _, events_dir = build(tmp_path)
        token, etag = token_of(events_dir, 0), etag_of(events_dir, 0)

        lines = (events_dir / '2024.csv').read_text(encoding='utf-8').splitlines(True)
        (events_dir / '2024.csv').write_text(
            lines[0] + lines[2] + lines[1], encoding='utf-8')
        before = (events_dir / '2024.csv').read_bytes()

        with pytest.raises(StaleFingerprint):
            writer.update_event(token, etag, {'quantity': '99'})

        assert (events_dir / '2024.csv').read_bytes() == before

    def test_a_stale_fingerprint_is_refused_on_delete_too(self, tmp_path):
        """Deleting the wrong row is the worse half of the same bug."""
        writer, _, events_dir = build(tmp_path)
        token = token_of(events_dir, 0)

        with pytest.raises(StaleFingerprint):
            writer.delete_event(token, 'not-the-etag')

        assert len(ledger(events_dir)) == 2

    def test_a_row_that_no_longer_exists_is_a_miss_not_a_write(self, tmp_path):
        writer, _, events_dir = build(tmp_path)
        with pytest.raises(UnknownRow):
            writer.update_event(encode_id('2024.csv', '', 99), 'x', {'quantity': '1'})

    def test_a_token_pointing_outside_the_directory_is_refused(self, tmp_path):
        """base64 is not a signature.

        The id is *opaque*, which is a contract about who interprets it and
        never a claim that it cannot be forged — so the containment check is
        here, in the only place that can make it.
        """
        writer, _, _ = build(tmp_path)
        with pytest.raises(UnknownRow):
            writer.update_event(
                encode_id('../settings.yaml', '', 2), 'x', {'quantity': '1'})


# --------------------------------------------------------------------------- #
# xlsx
# --------------------------------------------------------------------------- #

def write_workbook(path, rows, sheet_title='2024'):
    openpyxl = pytest.importorskip('openpyxl')
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = sheet_title
    sheet.append(['date', 'event_type', 'symbol', 'name', 'quantity',
                  'unit_price', 'fee', 'amount', 'notes', 'account'])
    for row in rows:
        sheet.append(row)
    workbook.save(path)


def build_with_workbook(tmp_path, rows):
    """A writer over a directory holding *only* a workbook.

    The workbook has to exist before the manager does: mode detection scans the
    events source, and an empty directory reads as a manual installation.
    """
    write_workbook(tmp_path / 'events' / '2024.xlsx', rows)
    return build(tmp_path, files={})


class TestWorkbooks:

    def test_a_workbook_row_cannot_be_edited(self, tmp_path):
        """The refusal that protects a spreadsheet's formulas.

        openpyxl is loaded ``data_only=True`` so the ledger can read the cached
        values; saving from that state writes those values *over* the formulas
        that produced them. There is no partial version of this — the whole path
        refuses.
        """
        writer, _, events_dir = build_with_workbook(tmp_path, [
            ['2024-01-15', 'BUY', 'AAPL', 'Apple Inc', 10, 150.0, 2.5, None,
             'Initial', None]])
        before = (events_dir / '2024.xlsx').read_bytes()

        with pytest.raises(ReadOnlySource):
            writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                                {'quantity': '11'})

        assert (events_dir / '2024.xlsx').read_bytes() == before

    def test_a_workbook_row_cannot_be_deleted_either(self, tmp_path):
        writer, _, events_dir = build_with_workbook(tmp_path, [
            ['2024-01-15', 'BUY', 'AAPL', 'Apple Inc', 10, 150.0, 2.5, None,
             'Initial', None]])

        with pytest.raises(ReadOnlySource):
            writer.delete_event(token_of(events_dir, 0), etag_of(events_dir, 0))

    def test_conversion_replaces_the_workbook_without_doubling_its_events(self, tmp_path):
        """The trap the two renames exist for.

        If both files were visible at once every event in them would be counted
        twice — and a duplicate event is *legitimate* (#653), so nothing
        downstream would object; the portfolio would simply be twice its size.
        The workbook survives under a suffix the loader does not read.
        """
        writer, manager, events_dir = build_with_workbook(tmp_path, [
            ['2024-01-15', 'BUY', 'AAPL', 'Apple Inc', 10, 150.0, 2.5, None, 'Initial', None],
        ])

        result = writer.convert_file('2024.xlsx')

        assert result.source == '2024.csv'
        assert (events_dir / ('2024.xlsx' + BACKUP_SUFFIX)).is_file()
        assert not (events_dir / '2024.xlsx').exists()

        shares = manager.reload(force=True).shares
        assert len(shares) == 1
        assert shares[0]['estate']['quantity'] == 10

    def test_conversion_keeps_the_rows_editable_afterwards(self, tmp_path):
        """The point of offering it: the CSV can then be fixed row by row."""
        writer, _, events_dir = build_with_workbook(tmp_path, [
            ['2024-01-15', 'BUY', 'AAPL', 'Apple Inc', 10, 150.0, 2.5, None, 'Initial', None],
        ])
        writer.convert_file('2024.xlsx')

        row = ledger(events_dir)[0]
        assert row.editable is True
        writer.update_event(row.id, row.etag, {'quantity': '11'})
        assert ledger(events_dir)[0].event.quantity == 11.0

    def test_a_broken_workbook_can_still_be_converted(self, tmp_path):
        """Otherwise the escape hatch is shut exactly when it is needed.

        The rows are the same rows; only their address changes. Comparing the
        errors verbatim would have read every one of them as new, because the
        provenance prefix moves from ``2024.xlsx/2024 row N`` to
        ``2024.csv row N``.
        """
        writer, _, events_dir = build_with_workbook(tmp_path, [
            ['2024-01-15', 'BUY', 'AAPL', 'Apple Inc', 10, 150.0, 2.5, None, 'Initial', None],
            ['not-a-date', 'BUY', 'MSFT', 'Microsoft', 5, 380.0, 2.5, None, '', None],
        ])

        writer.convert_file('2024.xlsx')

        rows = ledger(events_dir)
        assert [r.source for r in rows] == ['2024.csv', '2024.csv']
        assert rows[1].error is not None


# --------------------------------------------------------------------------- #
# The invalid → invalid regime
# --------------------------------------------------------------------------- #

BROKEN = HEADER + (
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase,\n"
    "not-a-date,BUY,MSFT,Microsoft,5,380.00,2.50,,Typo here,\n"
)


class TestAlreadyInvalid:
    """The rule that makes the ledger a repair tool rather than a mirror."""

    def test_an_edit_is_accepted_when_the_files_are_already_broken(self, tmp_path):
        """Refusing here would lock the user out of the only fix.

        The app is already running on its previous snapshot (or refusing to
        boot); an edit cannot make that worse, and the alternative — refuse
        every write until the file is valid — means the file can only be fixed
        outside the UI, which is the UI admitting it has no reason to exist.
        """
        writer, _, events_dir = build(tmp_path, files={'2024.csv': BROKEN})

        result = writer.update_event(token_of(events_dir, 0),
                                     etag_of(events_dir, 0), {'quantity': '12'})

        assert ledger(events_dir)[0].event.quantity == 12.0
        assert result.reloaded is False
        assert any('Invalid date format' in error for error in result.errors)

    def test_fixing_the_broken_row_republishes(self, tmp_path):
        """The journey's end: the edit that makes it valid is the one that lands."""
        writer, manager, events_dir = build(tmp_path, files={'2024.csv': BROKEN})

        result = writer.update_event(token_of(events_dir, 1),
                                     etag_of(events_dir, 1),
                                     {'date': '2024-02-01'})

        assert result.reloaded is True
        assert result.errors == []
        assert {s['symbol'] for s in manager.current().shares} == {'AAPL', 'MSFT'}

    def test_the_submitted_row_still_has_to_parse(self, tmp_path):
        """Tolerance is about what was already there, not about what is sent."""
        writer, _, events_dir = build(tmp_path, files={'2024.csv': BROKEN})

        with pytest.raises(InvalidCandidate):
            writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                                {'date': 'yesterday'})

    def test_a_valid_installation_still_refuses_a_breaking_edit(self, tmp_path):
        """The transition #658 made fatal, and the one that stays refused."""
        writer, _, events_dir = build(tmp_path)
        before = (events_dir / '2024.csv').read_bytes()

        with pytest.raises(InvalidCandidate):
            writer.update_event(token_of(events_dir, 0), etag_of(events_dir, 0),
                                {'quantity': ''})

        assert (events_dir / '2024.csv').read_bytes() == before


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #

class TestImport:
    """Stricter than editing, and the asymmetry is the decision."""

    def test_a_clean_file_is_accepted(self, tmp_path):
        writer, manager, events_dir = build(tmp_path)
        result = writer.import_file('2025.csv', (
            HEADER + "2025-02-01,BUY,MSFT,Microsoft,5,380.00,2.50,,,\n"
        ).encode('utf-8'))

        assert result.reloaded is True
        assert (events_dir / '2025.csv').is_file()
        assert {s['symbol'] for s in manager.current().shares} == {'AAPL', 'MSFT'}

    def test_a_file_that_breaks_the_portfolio_is_refused_whole(self, tmp_path):
        """Wholesale, unlike an edit — and nothing lands.

        The user still holds the file they tried to upload, so a rejection costs
        them a correction rather than the ability to repair anything.
        """
        writer, _, events_dir = build(tmp_path)
        with pytest.raises(InvalidCandidate) as excinfo:
            writer.import_file('2025.csv', (
                HEADER + "2025-02-01,SELL,AAPL,Apple Inc,400,190.00,2.00,,,\n"
            ).encode('utf-8'))

        assert excinfo.value.errors
        assert not (events_dir / '2025.csv').exists()

    def test_an_import_stays_possible_on_an_already_broken_directory(self, tmp_path):
        """Measured against the errors already there, not against zero.

        A directory with one bad row would otherwise refuse every import
        forever — including the corrected file that would have replaced it.
        """
        writer, _, events_dir = build(tmp_path, files={'2024.csv': BROKEN})
        result = writer.import_file('2025.csv', (
            HEADER + "2025-02-01,DIVIDEND,AAPL,Apple Inc,,,,3.00,,\n"
        ).encode('utf-8'))

        assert (events_dir / '2025.csv').is_file()
        assert result.reloaded is False

    def test_an_import_never_replaces_an_existing_file(self, tmp_path):
        writer, _, events_dir = build(tmp_path)
        before = (events_dir / '2024.csv').read_bytes()

        with pytest.raises(Clobber):
            writer.import_file('2024.csv', (HEADER).encode('utf-8'))

        assert (events_dir / '2024.csv').read_bytes() == before

    def test_a_path_in_the_filename_is_stripped(self, tmp_path):
        """Only the basename is ever used — an upload names a file, not a place."""
        writer, _, events_dir = build(tmp_path)
        writer.import_file('../../evil.csv', (
            HEADER + "2025-02-01,DIVIDEND,AAPL,Apple Inc,,,,3.00,,\n"
        ).encode('utf-8'))

        assert (events_dir / 'evil.csv').is_file()
        assert not (tmp_path.parent / 'evil.csv').exists()

    def test_a_foreign_format_is_refused(self, tmp_path):
        writer, _, _ = build(tmp_path)
        with pytest.raises(Exception):
            writer.import_file('portfolio.pdf', b'%PDF-1.4')


# --------------------------------------------------------------------------- #
# The accounts: block
# --------------------------------------------------------------------------- #

WITH_ACCOUNTS = """\
# Deployment settings — hand-edited, and this comment proves it survives.
mode: events
events:
  watch: true  # a trailing comment too

accounts:
# The column-zero sequence style every YAML dumper emits, and the one the
# repo's own data.example/settings.yaml uses. The splice has to survive it.
- id: pea
  type: PEA
  currency: EUR
  label: Mon PEA
"""

ACCOUNT_EVENTS = HEADER + (
    "2024-01-02,DEPOSIT,,,,,,1000.00,Versement,pea\n"
    "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,Initial purchase,pea\n"
)


class TestAccountsBlock:

    def test_only_the_block_is_rewritten(self, tmp_path):
        """A settings file is hand-edited; a YAML round-trip would eat the notes.

        Everything outside the block keeps its exact bytes — comments, the
        trailing one on ``source:``, the blank line. That is why this is a line
        splice rather than ``safe_dump`` of the whole document.
        """
        writer, _, _ = build(tmp_path, files={'2024.csv': ACCOUNT_EVENTS},
                             settings=WITH_ACCOUNTS)

        writer.set_accounts([
            {'id': 'pea', 'type': 'PEA', 'currency': 'EUR', 'label': 'PEA Boursorama'},
        ])

        text = (tmp_path / 'settings.yaml').read_text(encoding='utf-8')
        assert 'hand-edited, and this comment proves it survives' in text
        assert '# a trailing comment too' in text
        assert 'PEA Boursorama' in text
        assert yaml.safe_load(text)['events']['watch'] is True

    def test_the_new_block_is_published_without_a_restart(self, tmp_path):
        """#658 joined settings.yaml to the mtime cache key; this is that, used."""
        writer, manager, _ = build(tmp_path, files={'2024.csv': ACCOUNT_EVENTS},
                                   settings=WITH_ACCOUNTS)
        manager.reload()

        result = writer.set_accounts([
            {'id': 'pea', 'type': 'PEA', 'currency': 'EUR', 'label': 'Renommé'},
        ])

        assert result.reloaded is True
        assert manager.current().accounts.get('pea').label == 'Renommé'

    def test_dropping_an_account_the_events_still_use_is_refused(self, tmp_path):
        """The rejection that is worth the whole endpoint.

        The block itself is perfectly well-formed. What it does is strand every
        event carrying ``pea`` (``validator.py:128-138``), and since #658 that is
        **fatal at boot** — the failure would land on the next restart, long
        after the click that caused it.
        """
        writer, _, _ = build(tmp_path, files={'2024.csv': ACCOUNT_EVENTS},
                             settings=WITH_ACCOUNTS)
        before = (tmp_path / 'settings.yaml').read_bytes()

        with pytest.raises(InvalidCandidate) as excinfo:
            writer.set_accounts([
                {'id': 'cto', 'type': 'CTO', 'currency': 'EUR', 'label': 'CTO'},
            ])

        assert any('pea' in error for error in excinfo.value.errors)
        assert (tmp_path / 'settings.yaml').read_bytes() == before

    def test_a_malformed_block_is_refused(self, tmp_path):
        writer, _, _ = build(tmp_path, files={'2024.csv': ACCOUNT_EVENTS},
                             settings=WITH_ACCOUNTS)

        with pytest.raises(ValueError):
            writer.set_accounts([{'id': 'pea'}])

    def test_duplicate_ids_are_refused(self, tmp_path):
        writer, _, _ = build(tmp_path, files={'2024.csv': ACCOUNT_EVENTS},
                             settings=WITH_ACCOUNTS)

        with pytest.raises(ValueError):
            writer.set_accounts([
                {'id': 'pea', 'type': 'PEA', 'currency': 'EUR', 'label': 'A'},
                {'id': 'pea', 'type': 'CTO', 'currency': 'EUR', 'label': 'B'},
            ])

    def test_declaring_accounts_on_a_settings_file_that_has_none(self, tmp_path):
        """The block is appended when the file has no ``accounts:`` key at all."""
        writer, _, _ = build(
            tmp_path,
            files={'2024.csv': HEADER
                   + "2024-01-15,BUY,AAPL,Apple Inc,10,150.00,2.50,,,cto\n"},
            settings="mode: events\nevents:\n  watch: false\n")

        writer.set_accounts([
            {'id': 'cto', 'type': 'CTO', 'currency': 'EUR', 'label': 'CTO'},
        ])

        settings = yaml.safe_load(
            (tmp_path / 'settings.yaml').read_text(encoding='utf-8'))
        assert settings['accounts'][0]['id'] == 'cto'
        assert settings['mode'] == 'events'

    def test_declaring_accounts_over_events_that_carry_none_is_refused(self, tmp_path):
        """A finding, not a limitation, and it belongs in the UI's hands.

        Declaring the first account is a **breaking** change to every event
        already on disk: ``validator.py:128-138`` makes the column required the
        moment any account exists, so a portfolio built without one becomes
        invalid at the instant of the declaration — and since #658 that is fatal
        at boot. The order that works is the reverse: fill the ``account``
        column first (it is ignored while nothing is declared), then declare.
        """
        writer, _, _ = build(tmp_path, settings="mode: events\n")
        with pytest.raises(InvalidCandidate) as excinfo:
            writer.set_accounts([
                {'id': 'cto', 'type': 'CTO', 'currency': 'EUR', 'label': 'CTO'},
            ])

        assert any('account is required' in error for error in excinfo.value.errors)


class TestBlockSplice:
    """The splice on its own — it is fiddly, and its failure mode is silent."""

    def test_a_block_at_the_end_is_replaced(self):
        text = "mode: events\naccounts:\n  - id: a\n"
        assert _replace_accounts_block(text, 'accounts:\n  - id: b\n') == \
            "mode: events\naccounts:\n  - id: b\n"

    def test_a_sequence_at_column_zero_is_part_of_the_block(self):
        """The style every YAML dumper writes, and the one that broke this.

        ``- id: a`` sits in column zero, so a rule reading "the block ends at
        the next line in column zero" ended it on its own first entry — and
        appended the new block *below* the old one. Two ``accounts:`` keys is
        not a merge, it is invalid YAML, which since #658 means the next restart
        does not come back. Found by writing a rename to a real settings file
        and then opening it.
        """
        text = "mode: events\naccounts:\n- id: a\n  type: PEA\nevents:\n  watch: true\n"
        assert _replace_accounts_block(text, 'accounts:\n- id: b\n') == \
            "mode: events\naccounts:\n- id: b\nevents:\n  watch: true\n"

    def test_a_comment_inside_a_column_zero_block_does_not_split_it(self):
        """The same failure one level down: half the entries left behind."""
        text = "accounts:\n- id: a\n# a note\n- id: b\nevents:\n  watch: true\n"
        assert _replace_accounts_block(text, 'accounts:\n- id: c\n') == \
            "accounts:\n- id: c\nevents:\n  watch: true\n"

    def test_a_blank_line_before_the_next_key_is_kept_with_it(self):
        text = "accounts:\n- id: a\n\nevents:\n  watch: true\n"
        assert _replace_accounts_block(text, 'accounts:\n- id: b\n') == \
            "accounts:\n- id: b\n\nevents:\n  watch: true\n"

    def test_what_follows_the_block_is_kept(self):
        """The terminator is the next line at column zero.

        Including a comment: one sitting above ``events:`` belongs to
        ``events:``, so ending the block *before* it is what keeps it attached
        to what it describes.
        """
        text = "accounts:\n  - id: a\n# about events\nevents:\n  watch: true\n"
        assert _replace_accounts_block(text, 'accounts:\n  - id: b\n') == \
            "accounts:\n  - id: b\n# about events\nevents:\n  watch: true\n"

    def test_an_empty_block_removes_it(self):
        text = "mode: events\naccounts:\n  - id: a\nevents:\n  watch: true\n"
        assert _replace_accounts_block(text, '') == \
            "mode: events\nevents:\n  watch: true\n"

    def test_a_file_without_a_block_gets_one_appended(self):
        assert _replace_accounts_block("mode: events\n", 'accounts:\n  - id: a\n') == \
            "mode: events\naccounts:\n  - id: a\n"

    def test_a_file_without_a_trailing_newline_still_appends_cleanly(self):
        assert _replace_accounts_block("mode: events", 'accounts:\n') == \
            "mode: events\naccounts:\n"

    def test_an_empty_block_on_a_file_without_one_changes_nothing(self):
        assert _replace_accounts_block("mode: events\n", '') == "mode: events\n"


# --------------------------------------------------------------------------- #
# The states of the installation
# --------------------------------------------------------------------------- #

class TestInstallationStates:

    def test_manual_mode_has_no_ledger_to_write_to(self, tmp_path):
        """Not an empty ledger — a different kind of installation.

        The page shows ``config.yaml``'s positions read-only instead, and
        offers no conversion: an aggregated position carries no dates, so
        synthesising events would mean inventing a purchase date, which then
        drives the backfill target and the money-weighted return.
        """
        (tmp_path / 'config.yaml').write_text("shares: []\n", encoding='utf-8')
        manager = main.ConfigurationManager(config_dir=str(tmp_path))
        writer = ConfigWriter(manager)

        editable, reason = writer.can_write()
        assert editable is False
        assert 'manual mode' in reason
        with pytest.raises(WrongMode):
            writer.add_event({'date': '2024-01-01', 'event_type': 'BUY'})

    def test_an_unwritable_directory_is_named_up_front(self, tmp_path):
        """The visible end of the map's PaaS fog.

        A platform that regenerates from ``docker-compose.yaml`` never runs
        ``make init``, so the container runs as ``1000:1000`` over someone
        else's files. The page asks once and hides its buttons, instead of
        every save failing with a stack trace from inside a temp file.
        """
        writer, _, events_dir = build(tmp_path)
        events_dir.chmod(0o500)
        try:
            if Path(events_dir).stat().st_uid == 0:
                pytest.skip("running as root: the mode bits do not apply")
            editable, reason = writer.can_write()
            assert editable is False
            assert 'not writable' in reason
            with pytest.raises(SourceUnwritable):
                writer.add_event({
                    'date': '2024-06-01', 'event_type': 'GRANT',
                    'symbol': 'AAPL', 'name': 'Apple Inc', 'quantity': '1',
                })
        finally:
            events_dir.chmod(0o700)

    def test_a_writable_events_installation_says_so(self, tmp_path):
        writer, _, _ = build(tmp_path)
        assert writer.can_write() == (True, None)

    def test_the_file_list_carries_the_lock(self, tmp_path):
        """What the badge is drawn from."""
        writer, _, events_dir = build(tmp_path)
        write_workbook(events_dir / '2025.xlsx', [
            ['2025-01-15', 'BUY', 'MSFT', 'Microsoft', 5, 380.0, 2.5, None, '', None],
        ])

        files = {entry['name']: entry for entry in writer.list_files()}
        assert files['2024.csv']['editable'] is True
        assert files['2024.csv']['rows'] == 2
        assert files['2025.xlsx']['editable'] is False


# --------------------------------------------------------------------------- #
# The log level toggle (issue #654's one survivor)
# --------------------------------------------------------------------------- #

class TestLogLevel:

    def test_the_handler_level_moves_too(self):
        """The trap, and the only reason this is more than one line.

        ``logfmt_logger.getLogger`` attaches a ``StreamHandler`` and sets a
        level **on the handler**. Raising only the logger leaves every debug
        record dropped on the way out — a toggle that reports success and
        changes nothing.
        """
        import logging

        try:
            main.set_log_level('DEBUG')
            logger = logging.getLogger('suivi_bourse')
            assert logger.level == logging.DEBUG
            assert all(h.level == logging.DEBUG for h in logger.handlers)
            assert logger.handlers, "the app logger has no handler to check"
        finally:
            main.set_log_level('INFO')

    def test_every_named_logger_moves(self):
        import logging

        try:
            main.set_log_level('WARNING')
            for name in main.MANAGED_LOGGERS:
                assert logging.getLogger(name).level == logging.WARNING
        finally:
            main.set_log_level('INFO')

    def test_an_unknown_level_is_refused(self):
        with pytest.raises(ValueError):
            main.set_log_level('CHATTY')

    def test_the_current_level_is_readable(self):
        try:
            main.set_log_level('ERROR')
            assert main.current_log_level() == 'ERROR'
        finally:
            main.set_log_level('INFO')


def test_decode_round_trips_an_xlsx_address():
    """The address is ``(file, sheet, row)`` — never ``(file, row)``.

    ``row_num`` restarts at 2 in every worksheet, so two rows of one workbook
    share a row number and the sheet is what tells them apart.
    """
    address = decode_id(encode_id('2024.xlsx', 'Sheet 1', 7))
    assert (address.file, address.sheet, address.row) == ('2024.xlsx', 'Sheet 1', 7)
