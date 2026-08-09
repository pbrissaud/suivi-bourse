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

import pytest

import main


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

    def test_an_unknown_level_is_refused(self):
        with pytest.raises(ValueError):
            main.set_log_level('CHATTY')

    def test_the_current_level_is_readable(self):
        try:
            main.set_log_level('ERROR')
            assert main.current_log_level() == 'ERROR'
        finally:
            main.set_log_level('INFO')
