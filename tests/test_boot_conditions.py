"""The lines a bare container says at start-up (issue #741).

Pure, so every test here reads arguments: *which* lines stand is asserted
without a runtime, a store, or a captured logger. The wiring — that
``build_runtime`` calls this once, in the master — is asserted in
``test_web_boot.py``.
"""
import logging

from application import boot_conditions


def observe(base_currency='EUR', recorded_events=3, web_port=8080):
    return boot_conditions.observe(
        base_currency=base_currency, recorded_events=recorded_events,
        web_port=web_port)


def keys(conditions):
    return [condition.key for condition in conditions]


# --------------------------------------------------------------------- #
# Only when true
# --------------------------------------------------------------------- #

def test_a_complete_install_says_nothing():
    assert observe() == ()


def test_each_condition_stands_on_its_own():
    assert keys(observe(base_currency=None)) == \
        [boot_conditions.NO_BASE_CURRENCY]
    assert keys(observe(recorded_events=0)) == [boot_conditions.NO_PORTFOLIO]


def test_a_fresh_install_says_both_in_order():
    assert keys(observe(base_currency=None, recorded_events=0)) == [
        boot_conditions.NO_BASE_CURRENCY,
        boot_conditions.NO_PORTFOLIO,
    ]


def test_a_blank_currency_counts_as_unanswered():
    """``base_currency`` is the one dial with no default, so *"not answered"* and
    *"answered"* are two states and an empty string is the first of them."""
    assert keys(observe(base_currency='')) == \
        [boot_conditions.NO_BASE_CURRENCY]


# --------------------------------------------------------------------- #
# What each line actually says
# --------------------------------------------------------------------- #

def test_the_currency_line_carries_the_one_non_interactive_path():
    """*Headless means without an interface, not without HTTP*:
    ``PUT /api/settings`` is the only way to answer the reporting currency
    without a page, so the line spells the call out on this container's own
    port rather than naming a screen an operator has chosen not to serve."""
    line, = observe(base_currency=None, web_port=9090)

    assert 'PUT' in line.message and '/api/settings' in line.message
    assert 'localhost:9090' in line.message
    assert line.level == logging.WARNING


def test_the_empty_portfolio_line_names_the_page_and_no_folder():
    """**It names where the gesture is made, and nothing else**.

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
    for condition in observe(base_currency=None, recorded_events=0):
        assert condition.context['condition'] == condition.key


def test_no_condition_is_an_installation_fact():
    """Boot conditions are never acknowledgeable, so they stay out of
    :mod:`installation_facts`."""
    from application import installation_facts

    keys_here = {boot_conditions.NO_BASE_CURRENCY,
                 boot_conditions.NO_PORTFOLIO}

    assert keys_here.isdisjoint({spec.key for spec in installation_facts.SPECS})
