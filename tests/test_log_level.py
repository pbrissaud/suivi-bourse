"""Tests for the runtime log-level toggle — ``main.set_log_level`` (issue #654).

These lived in ``test_config_writer.py`` under the heading "#654's one
survivor", and they survive #711 for the same reason their subject does: the
toggle is not a config write. ``config_writer.py`` is deleted, the level is
never persisted, and ``PUT /api/config/log-level`` is still a route — so the
file went and the coverage had to find a home rather than leave with it.

What ``test_web_api.py`` keeps is the **transport**: the body shape and the 400
on an unknown level. A ``set_log_level`` that moved no handler at all would pass
that test, which is precisely the bug the first test below exists to catch.
"""
import logging
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from application import main


class TestLogLevel:

    def test_the_handler_level_moves_too(self):
        """The trap, and the only reason this is more than one line.

        ``logfmt_logger.getLogger`` attaches a ``StreamHandler`` and sets a
        level **on the handler**. Raising only the logger leaves every debug
        record dropped on the way out — a toggle that reports success and
        changes nothing.
        """
        try:
            main.set_log_level('DEBUG')
            logger = logging.getLogger('suivi_bourse')
            assert logger.level == logging.DEBUG
            assert all(h.level == logging.DEBUG for h in logger.handlers)
            assert logger.handlers, "the app logger has no handler to check"
        finally:
            main.set_log_level('INFO')

    def test_every_named_logger_moves(self):
        try:
            main.set_log_level('WARNING')
            for name in main.MANAGED_LOGGERS:
                assert logging.getLogger(name).level == logging.WARNING
        finally:
            main.set_log_level('INFO')

    def test_the_list_names_every_logger_the_tree_creates(self):
        """The list is explicit, so it is the list that goes stale — on the source.

        `MANAGED_LOGGERS` is spelled out rather than walked off
        `logging.root.manager`, which is the right call: a walk would turn a
        dependency's own logger up with the app. The cost is that a module
        added later is simply not in it, and nothing says so — four were
        missing, `fx` among them, which is the module that most often explains
        why a conversion is absent and therefore the commonest reason to reach
        for DEBUG at all. Read off both source
        packages so the list cannot drift again: the API's own logger lives in
        `src/api`, not beside `main`.
        """
        src = Path(main.__file__).resolve().parents[1]
        named = {match.group(1)
                 for package in ('application', 'api')
                 for path in (src / package).rglob('*.py')
                 for match in re.finditer(r'getLogger\(\s*[\'"]([^\'"]+)[\'"]',
                                          path.read_text(encoding='utf-8'))}

        assert named - set(main.MANAGED_LOGGERS) == set()

    def test_the_boot_turns_the_two_dependencies_to_the_environment_s_level(self):
        """The side effect of a call whose *name* was dead (#862).

        `main` used to bind `scheduler_logger` and `yfinance_logger` and read
        neither back. Removing the assignments must not remove the calls: they
        are what carries `LOG_LEVEL` to APScheduler's and yfinance's own
        loggers at boot, before `MANAGED_LOGGERS` has anything to turn. Nothing
        in the running process can answer for that — the suite has imported
        `main` long ago and `set_log_level` has moved every one of them since —
        so this asks a **subprocess**, on the same reasoning as
        `test_the_pure_modules_are_pure_at_the_import`: a level nobody would
        set by accident, read straight off `logging` after the import alone.
        """
        program = (
            'import sys; sys.path.insert(0, %r)\n'
            'import logging\n'
            'import application.main\n'
            'print(",".join(logging.getLevelName(logging.getLogger(n).level)\n'
            '               for n in ("suivi_bourse", "apscheduler.scheduler",\n'
            '                         "yfinance")))\n'
        ) % str(Path(main.__file__).resolve().parents[1])

        result = subprocess.run(
            [sys.executable, '-c', program], capture_output=True, text=True,
            env={**os.environ, 'LOG_LEVEL': 'CRITICAL'})

        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'CRITICAL,CRITICAL,CRITICAL'

    def test_an_unknown_level_is_refused(self):
        with pytest.raises(ValueError):
            main.set_log_level('CHATTY')

    def test_the_current_level_is_readable(self):
        try:
            main.set_log_level('ERROR')
            assert main.current_log_level() == 'ERROR'
        finally:
            main.set_log_level('INFO')
