"""The three boot variables, and the names that went quiet (#740, ADR-0033).

Every test here reads a **dict**. That is the point of the module being pure:
"nothing is set", "a blank value" and "a v4 ``.env`` in full" are three ordinary
arguments rather than three monkeypatched globals, and the process environment
the suite happens to run in cannot make one of them pass by accident.
"""
from pathlib import Path

import pytest

import boot_env
import settings_registry


# --------------------------------------------------------------------- #
# The three values
# --------------------------------------------------------------------- #

def test_nothing_set_gives_the_three_container_defaults():
    """**The defaults describe the container**, and it is the Docker-less
    deployment that overrides them — the reverse of v4, where compose always
    rendered every variable and made the app's own defaults dead code."""
    boot = boot_env.read({})

    assert boot.store_dir == Path('/data')
    assert boot.web_port == 8080
    assert boot.log_level == 'INFO'
    assert boot.unread == ()


def test_the_one_path_is_a_directory_and_never_a_file():
    """The app names its own store file and its write-ahead log inside the one
    it is given. That is what removes the whole class of mistake where the path
    exists but its parent is not mounted — and it is what makes the mount
    observation decidable, since a *directory* can be interrogated before the
    file it will hold exists."""
    boot = boot_env.read({'SB_STORE_DIR': '/var/lib/suivi-bourse'})

    assert boot.store_dir == Path('/var/lib/suivi-bourse')
    # The store file is named by the app, beneath the directory it was given.
    import store

    assert boot.store_dir / store.STORE_FILENAME == \
        Path('/var/lib/suivi-bourse/suivi-bourse.duckdb')


@pytest.mark.parametrize('name', [
    'SB_STORE_DIR', 'SB_WEB_PORT', 'LOG_LEVEL',
])
def test_a_blank_value_counts_as_unset_for_every_one_of_the_three(name):
    """Compose renders an undefined substitution as the **empty string** rather
    than omitting the variable, so ``SB_FOO=${FOO}`` with no ``FOO`` hands the
    container ``SB_FOO=""``. Read literally, every ``int()`` downstream blows up
    at boot and every path becomes the current directory."""
    assert boot_env.read({name: '   '}) == boot_env.read({})


def test_there_is_no_reader_of_booleans_left():
    """The one name that was a flag was the metrics one, and it left with the
    exporter (ADR-0033). A reader kept for the boolean variable that may never
    come is a rule nothing exercises — the same reason the redaction rule left
    with ``INFLUXDB_TOKEN`` rather than waiting for a second secret."""
    assert not hasattr(boot_env, 'flag')
    assert 'flag' not in boot_env.__all__


def test_a_value_that_is_not_an_integer_names_the_variable_it_came_from():
    with pytest.raises(ValueError, match='SB_WEB_PORT'):
        boot_env.read({'SB_WEB_PORT': 'eight thousand'})


def test_there_is_no_variable_that_turns_the_page_off():
    """ADR-0015. Headless is a **usage, not a setting**: the page has no port of
    its own — it is served on the API's socket — so a switch for it would be a
    dial *of the store*, in a product that has just deleted its only
    restart-scoped dial. What an operator stops serving is the page; never the
    API, which is the only non-interactive path to answering the currency.

    The one name that ever looked like the counter-example decided a **socket
    to bind**, and the list of binds is fixed at boot — ADR-0033 took that
    socket, so there is no longer even that to argue with.
    """
    for name in boot_env.READ:
        assert 'WEB_ENABLED' not in name
        assert 'UI_' not in name

    # And setting the name someone will try does nothing at all.
    assert boot_env.read({'SB_WEB_ENABLED': 'false'}).web_port == 8080


# --------------------------------------------------------------------- #
# The complement
# --------------------------------------------------------------------- #

def test_an_unknown_sb_name_is_reported_and_gets_no_instruction():
    """A typo must not send its author hunting for a dial that never existed."""
    names = boot_env.unread({'SB_REGULAR_INTERVALL': '600'})

    assert names == ('SB_REGULAR_INTERVALL',)
    message = boot_env.notice(names)
    assert 'ever read: SB_REGULAR_INTERVALL' in message
    assert 'settings page' not in message


def test_a_dial_that_moved_is_named_with_the_dial_it_became():
    names = boot_env.unread({'SB_REGULAR_INTERVAL': '600'})

    assert names == ('SB_REGULAR_INTERVAL',)
    assert 'SB_REGULAR_INTERVAL → the regular_interval dial' in \
        boot_env.notice(names)


def test_a_variable_that_was_deleted_outright_is_told_it_has_no_successor():
    """"Turn it on the settings page" is wrong for a dial that no longer exists:
    an operator told that ``SB_EXECUTOR_POOL`` lives in the app now goes looking
    for a field that has never existed, and for a ``PUT`` answering ``422``."""
    names = boot_env.unread({'SB_EXECUTOR_POOL': '10'})
    message = boot_env.notice(names)

    assert 'removed and have no replacement: SB_EXECUTOR_POOL' in message
    assert 'settings page' not in message


@pytest.mark.parametrize('name', ['SB_PROMETHEUS_ENABLED', 'SB_METRICS_PORT'])
def test_the_two_names_the_exporter_answered_for_have_no_successor(name):
    """ADR-0033. An owner who had either of these written down must hear it
    **named** at boot, or they go on believing a second socket is being served.

    And it has to be the deleted clause. There is no dial that turns the gauges
    back on — what replaced them is the health body and the runtime tab — so
    *"turn it on the settings page"* would send its reader looking for a field
    that has never existed, and silence would read as a typo.
    """
    names = boot_env.unread({name: 'true'})
    message = boot_env.notice(names)

    assert names == (name,)
    assert name in boot_env.DELETED
    assert f'removed and have no replacement: {name}' in message
    assert 'settings page' not in message
    assert 'ever read' not in message


def test_the_four_never_read_names_stay_out_of_the_notice():
    """They carry the prefix and were **never read by Python**: they belong to
    the compose file and the docker daemon (#654 trap 13). Naming them would
    introduce names the app has never obeyed into a sentence about names it has
    stopped obeying."""
    env = {'SB_VERSION': '5', 'SB_CONFIG_DIR': './data',
           'SB_UID': '501', 'SB_GID': '20'}

    assert boot_env.unread(env) == ()
    assert boot_env.notice(boot_env.unread(env)) is None


def test_a_variable_the_app_still_reads_is_not_in_the_notice():
    assert boot_env.unread({'SB_WEB_PORT': '9000',
                            'SB_STORE_DIR': '/srv/store'}) == ()


def test_the_drop_folders_variable_is_named_as_removed_without_a_successor():
    """ADR-0032, user story 29. The folder ``SB_IMPORT_DIR`` named is gone and a
    file is handed to the app instead, so an install that still sets it must
    hear it **named** at boot — or its owner goes on believing that dropping a
    file somewhere imports it.

    And it has to be the *deleted* clause: there is no dial that brings the
    folder back, so *"turn it on the settings page"* would send its reader
    looking for a field that has never existed, and silence would read as a typo.
    """
    names = boot_env.unread({'SB_IMPORT_DIR': '/srv/drop'})
    message = boot_env.notice(names)

    assert names == ('SB_IMPORT_DIR',)
    assert 'SB_IMPORT_DIR' in boot_env.DELETED
    assert 'removed and have no replacement: SB_IMPORT_DIR' in message
    assert 'settings page' not in message
    assert 'ever read' not in message


def test_a_blank_retired_variable_is_not_reported():
    assert boot_env.unread({'SB_PERF_INTERVAL': ''}) == ()


def test_a_name_outside_the_two_prefixes_is_never_reported():
    """The notice is about *this product's* names. Everything else in a
    container's environment belongs to somebody else."""
    assert boot_env.unread({'PATH': '/usr/bin', 'HOME': '/home/appuser',
                            'COMPOSE_PROJECT_NAME': 'sb'}) == ()


def test_the_notice_is_one_line_and_carries_every_name():
    """Fourteen warnings would bury the sentence that matters, which is not
    *which* name was ignored but *where the setting went*."""
    names = boot_env.unread({'SB_REGULAR_INTERVAL': '600',
                             'SB_PERF_INTERVAL': '120',
                             'INFLUXDB_TOKEN': 'apiv3_x'})
    message = boot_env.notice(names)

    assert message.count('\n') == 0
    for name in names:
        assert name in message


def test_the_whole_of_a_v4_env_is_named_at_once():
    """Eight die, six move: a v4 ``.env`` is two-thirds decorative."""
    v4 = {
        'SB_REGULAR_INTERVAL': '120', 'SB_SCRAPING_INTERVAL': '120',
        'SB_BACKFILL_INTERVAL': '60', 'SB_BACKFILL_DELAY': '10',
        'SB_BACKFILL_CHUNK_DAYS': '365', 'SB_STALENESS_HORIZON': '900',
        'SB_PERF_INTERVAL': '120', 'SB_EXECUTOR_POOL': '10',
        'SB_DYNAMIC_EXECUTOR_POOL': 'true', 'SB_INGESTION_INTERVAL': '300',
        'SB_CONFIG_MODE': 'events',
        'INFLUXDB_HOST': 'http://influxdb:8181',
        'INFLUXDB_TOKEN': 'apiv3_x', 'INFLUXDB_DATABASE': 'suivi_bourse',
        # Read, so absent from the notice; and never read, likewise.
        'SB_WEB_PORT': '8080', 'LOG_LEVEL': 'INFO',
        'SB_VERSION': '4', 'SB_CONFIG_DIR': './data',
    }

    assert len(boot_env.unread(v4)) == 14


# --------------------------------------------------------------------- #
# The invariant: the complement reads the registry, never a second list
# --------------------------------------------------------------------- #

def test_every_dial_in_the_registry_is_recognised_as_one_that_moved():
    """The classification is read off :mod:`settings_registry` rather than off a
    literal, so it cannot describe a dial the product no longer has."""
    for spec in settings_registry.SETTINGS:
        assert boot_env.moved_dial(f'SB_{spec.key.upper()}') == spec.key


def test_adding_a_dial_to_the_registry_reclassifies_it_with_no_edit_here(
        monkeypatch):
    """The invariant of the complement.

    ``SB_RETENTION_DAYS`` is not a dial today, so it reads as a name the app has
    never obeyed. Add it to the registry — the *one* list of dials in the
    product — and the notice tells its owner where it went, with nothing in
    :mod:`boot_env` touched. A second literal list would have agreed on the day
    it was written and not much longer.
    """
    name = 'SB_RETENTION_DAYS'
    assert boot_env.moved_dial(name) is None
    assert 'ever read: SB_RETENTION_DAYS' in \
        boot_env.notice(boot_env.unread({name: '400'}))

    added = settings_registry.SettingSpec(
        'retention_days', '400', settings_registry.INTEGER,
        settings_registry._int, settings_registry.NEXT_CYCLE,
        'How long a price point is kept.', minimum=1, maximum=3650)
    monkeypatch.setitem(settings_registry.BY_KEY, added.key, added)

    assert boot_env.moved_dial(name) == 'retention_days'
    message = boot_env.notice(boot_env.unread({name: '400'}))
    assert 'SB_RETENTION_DAYS → the retention_days dial' in message
    assert 'ever read' not in message


def test_the_read_set_is_exactly_the_inventory():
    """A name absent from the inventory but read somewhere would be reported as
    ignored while being obeyed, which is the one thing worse than silence."""
    assert boot_env.READ == {name for name, _ in boot_env.INVENTORY}
    assert len(boot_env.INVENTORY) == 3


# --------------------------------------------------------------------- #
# The effective view
# --------------------------------------------------------------------- #

def test_the_source_is_factual_and_not_helpful():
    """#654 trap 2. Reporting a variable as "unset, using the default" *because
    it equals the default* would be a guess about what the operator wrote."""
    reported = {e['name']: e
                for e in boot_env.effective({'SB_WEB_PORT': '8080'})}

    assert reported['SB_WEB_PORT']['source'] == 'environment'
    assert reported['SB_WEB_PORT']['set'] is True
    assert reported['SB_STORE_DIR']['source'] == 'default'
    assert reported['SB_STORE_DIR']['set'] is False


def test_the_log_level_reported_is_the_one_the_process_holds():
    """The one of these the app can change while it runs (#654 §6b): the
    variable is merely where the level started."""
    entry = {e['name']: e for e in boot_env.effective(
        {'LOG_LEVEL': 'INFO'}, log_level='DEBUG')}['LOG_LEVEL']

    assert entry['value'] == 'DEBUG'
    assert entry['set'] is True
