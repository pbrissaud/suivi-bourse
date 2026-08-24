"""The three lines a bare container says at start-up (issue #741, ADR-0015).

Pure, so every test here reads arguments: *which* lines stand is asserted
without a runtime, a store, or a captured logger. The wiring — that
``build_runtime`` calls this once, in the master — is asserted in
``test_web_boot.py``.
"""
import logging

import boot_conditions
import mounts


def observe(persistence=mounts.PERSISTENT, store_dir='/data',
            base_currency='EUR', recorded_events=3, web_port=8080):
    return boot_conditions.observe(
        persistence=persistence, store_dir=store_dir,
        base_currency=base_currency, recorded_events=recorded_events,
        web_port=web_port)


def keys(conditions):
    return [condition.key for condition in conditions]


# --------------------------------------------------------------------- #
# Only when true
# --------------------------------------------------------------------- #

def test_a_mounted_container_with_a_currency_and_a_ledger_says_nothing():
    """The criterion in one line: **a mounted container prints nothing about
    persistence**, and an install that is complete prints nothing at all."""
    assert observe() == ()


def test_each_condition_stands_on_its_own():
    assert keys(observe(persistence=mounts.EPHEMERAL)) == \
        [boot_conditions.NO_PERSISTENCE]
    assert keys(observe(base_currency=None)) == \
        [boot_conditions.NO_BASE_CURRENCY]
    assert keys(observe(recorded_events=0)) == [boot_conditions.NO_PORTFOLIO]


def test_a_bare_container_on_a_fresh_install_says_all_three_in_order():
    """The order is causality, not severity: a reader about to lose everything
    reads that before being told which URL to open to start typing."""
    assert keys(observe(persistence=mounts.EPHEMERAL, base_currency=None,
                        recorded_events=0)) == [
        boot_conditions.NO_PERSISTENCE,
        boot_conditions.NO_BASE_CURRENCY,
        boot_conditions.NO_PORTFOLIO,
    ]


def test_unknown_persistence_prints_nothing():
    """The whole reason the observation has a third answer (:mod:`mounts`). A
    macOS developer has no mount table to read, and silence there is right where
    *"this container keeps nothing"* would be a fabrication."""
    assert observe(persistence=mounts.UNKNOWN) == ()


def test_a_blank_currency_counts_as_unanswered():
    """``base_currency`` is the one dial with no default, so *"not answered"* and
    *"answered"* are two states and an empty string is the first of them."""
    assert keys(observe(base_currency='')) == \
        [boot_conditions.NO_BASE_CURRENCY]


# --------------------------------------------------------------------- #
# What each line actually says
# --------------------------------------------------------------------- #

def test_the_persistence_line_names_the_directory_to_mount():
    """An operator reading it must not have to work out *which* path — the
    default is the image's and a Docker-less install overrides it."""
    line, = observe(persistence=mounts.EPHEMERAL, store_dir='/srv/store')

    assert '/srv/store' in line.message
    assert line.level == logging.WARNING
    assert line.context == {'condition': boot_conditions.NO_PERSISTENCE,
                            'store_dir': '/srv/store'}


def test_the_currency_line_carries_the_one_non_interactive_path():
    """*Headless means without an interface, not without HTTP* (ADR-0015):
    ``PUT /api/settings`` is the only way to answer the reporting currency
    without a page, so the line spells the call out on this container's own
    port rather than naming a screen an operator has chosen not to serve."""
    line, = observe(base_currency=None, web_port=9090)

    assert 'PUT' in line.message and '/api/settings' in line.message
    assert 'localhost:9090' in line.message
    assert line.level == logging.WARNING


def test_the_empty_portfolio_line_names_the_page_and_no_folder():
    """**It names where the gesture is made, and nothing else** (ADR-0032).

    The line used to offer a drop folder as its second half; the folder is gone,
    and a sentence that still sent a reader to a directory would be sending them
    somewhere nothing is read. Both entrances to the ledger — a file handed to
    the app, a first position typed — are on the page it names.
    """
    line, = observe(recorded_events=0, web_port=9090)

    assert 'localhost:9090' in line.message
    assert '/import' not in line.message
    assert 'import_dir' not in line.context
    # An empty ledger is an ordinary state on a fresh install, not a fault.
    assert line.level == logging.INFO


def test_every_line_carries_its_key_in_the_logfmt_context():
    """``extra['context']`` is what makes the headless channel parseable: a key
    to grep for rather than a sentence that will be reworded (#709's rule)."""
    for condition in observe(persistence=mounts.EPHEMERAL, base_currency=None,
                             recorded_events=0):
        assert condition.context['condition'] == condition.key


def test_no_condition_is_an_advisory():
    """*"This container keeps nothing"* is **never acknowledgeable**: it would go
    quiet while still true, which is the one thing an acknowledgement must not
    buy. The keys therefore live here and not in :mod:`advisories` — asserted on
    the source, because the failure mode is a well-meaning later ticket adding
    one of these to the table that carries acknowledgements."""
    import advisories

    keys_here = {boot_conditions.NO_PERSISTENCE,
                 boot_conditions.NO_BASE_CURRENCY,
                 boot_conditions.NO_PORTFOLIO}

    assert keys_here.isdisjoint({spec.key for spec in advisories.SPECS})
