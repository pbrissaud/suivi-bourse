"""
Tests for the web process and its boot split (issue #657, design #651).

The scheduler and the Flask app now share one process, booted by gunicorn either
side of a ``fork()``. What is worth pinning here is not that Flask serves JSON —
it is the *split*:

* :func:`main.build_runtime` runs in the master under ``preload_app``: it must
  **open the store** and load the configuration (so an unreadable store or a
  broken ledger still ends the process once) and must not leave behind a
  thread, a socket, an InfluxDB client or a store connection, none of which
  survive a fork.
* :func:`main.start_runtime` runs in ``post_fork`` and owns all of that.
* the two failure paths differ on purpose — the master exits 1 before any fork,
  ``post_fork`` re-raises so gunicorn halts the arbiter instead of respawning.

The store took the place #658 gave the Cerberus validation (#696): same side of
the fork, different cause, and one extra rule of its own — the master *closes*
what it opened, because DuckDB refuses a second process and a forked child would
be exactly that.

``gunicorn.conf.py`` is exercised as a module: it is executable configuration
(the bind list, the one-worker guard), not a static file.
"""

import importlib.util
import logging
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

import boot_conditions
import main
import store
import web
from events.validator import EventValidationError
from prometheus_exporter import PrometheusExporter


_GUNICORN_CONF = Path(__file__).resolve().parent.parent / "src" / "gunicorn.conf.py"


class _FakeConfigManager:
    """Stands in for ConfigurationManager, recording what the boot asks of it."""

    def __init__(self, shares=None, load_error=None):
        self._shares = [] if shares is None else shares
        self._load_error = load_error
        self.load_calls = 0
        self.named_unread = 0
        self.watcher_started_with = None
        self.watcher_stopped = False
        # The store the ledger is read through (issue #697): handed in on the
        # master's side of the fork and again, as the worker's own connection,
        # on the far side. Recorded rather than used, so the boot's handling of
        # it stays observable here.
        self.attached = []

    def attach_store(self, opened_store):
        self.attached.append(opened_store)

    def reload(self, force=False):
        self.load_calls += 1
        if self._load_error is not None:
            raise self._load_error
        return self.current()

    def current(self):
        return main.ConfigSnapshot(shares=self._shares, events=[],
                                   accounts=None, cache_key=None)

    def load_shares(self, force=False):
        return self.reload(force=force).shares

    def report_unread_files(self):
        self.named_unread += 1
        return []

    def load_accounts(self):
        return None

    def get_events(self):
        return []

    def start_watcher(self, reload_callback):
        self.watcher_started_with = reload_callback

    def stop_watcher(self):
        self.watcher_stopped = True


@pytest.fixture(autouse=True)
def _forget_runtime_singleton():
    """Reset ``web._runtime`` between tests.

    In production it is set once in the master and inherited by the worker
    through the fork; in a test session every ``create_app`` would otherwise
    leave the previous one behind.
    """
    yield
    web._runtime = None


@pytest.fixture(autouse=True)
def _store_in_tmp(monkeypatch, tmp_path):
    """Point the store at ``tmp_path`` for every test in this module.

    ``build_runtime`` opens the store before it does anything else, so without
    this the suite would create one under the developer's real home.
    """
    monkeypatch.setenv(store.STORE_DIR_VAR, str(tmp_path / "store"))


@pytest.fixture
def fake_config(monkeypatch):
    """Install a _FakeConfigManager as the one ``build_runtime`` constructs."""
    cfg = _FakeConfigManager()
    monkeypatch.setattr(main, "ConfigurationManager", lambda **kwargs: cfg)
    return cfg


@pytest.fixture
def open_store(tmp_path):
    """A real, open store, for the routes that must reach one."""
    opened = store.open_store(tmp_path / "served.duckdb")
    try:
        yield opened
    finally:
        opened.close()


def _load_gunicorn_conf(monkeypatch, **env):
    """Execute ``src/gunicorn.conf.py`` under a controlled environment."""
    for name in ("SB_WEB_PORT", "SB_METRICS_PORT", "SB_PROMETHEUS_ENABLED",
                 "LOG_LEVEL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    spec = importlib.util.spec_from_file_location(
        "sb_gunicorn_conf", _GUNICORN_CONF)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# build_runtime — the master half
# ---------------------------------------------------------------------------

def test_build_runtime_validates_the_config_without_starting_anything(
        fake_config, mocker, monkeypatch):
    """The master's whole job: read the config, hold nothing that a fork breaks."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    metrics_cls = mocker.patch.object(main, "SuiviBourseMetrics")
    scheduler_cls = mocker.patch.object(main, "BackgroundScheduler")
    threads_before = threading.active_count()

    runtime = main.build_runtime()

    # The configuration IS loaded here — that is what makes a bad one fatal
    # before the arbiter has anything to respawn — and the v4 file this version
    # no longer reads is named before that (#711).
    assert fake_config.load_calls == 1
    assert fake_config.named_unread == 1
    # ... and nothing else is.
    assert fake_config.watcher_started_with is None
    assert metrics_cls.call_count == 0
    assert scheduler_cls.call_count == 0
    assert runtime.metrics is None
    assert runtime.scheduler is None
    assert threading.active_count() == threads_before


def test_build_runtime_opens_the_store_and_hands_on_its_path_not_its_connection(
        fake_config, monkeypatch):
    """The store is created in the master — and left closed behind it (#696).

    Opening it here is what makes an unreadable store a single named exit. Not
    *keeping* it open is the other half: DuckDB refuses a second process, and a
    worker forked from a master still holding the file is precisely that.
    """
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")

    runtime = main.build_runtime()

    assert runtime.store_path.exists()
    assert runtime.store is None
    # The proof the master let go: a second connection can be opened, which is
    # exactly what ``post_fork`` will do.
    reopened = store.open_store(runtime.store_path)
    assert sorted(reopened.table_names()) == sorted(store.TABLES)
    reopened.close()


def test_build_runtime_reads_the_environment_once_and_wires_both_paths(
        monkeypatch, tmp_path):
    """#740. The store directory and the drop folder are read **together**.

    Two reads of ``os.environ`` at two moments would be two readings of one
    mapping, and the manager reading its own would put a second place in the
    process reaching for the environment — the thing this ticket exists to make
    exactly one.
    """
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setenv(store.STORE_DIR_VAR, str(tmp_path / "vol"))
    monkeypatch.setenv("SB_IMPORT_DIR", str(tmp_path / "drop"))
    seen = {}

    def _capture(**kwargs):
        seen.update(kwargs)
        return _FakeConfigManager()

    monkeypatch.setattr(main, "ConfigurationManager", _capture)

    runtime = main.build_runtime()

    assert runtime.store_path == tmp_path / "vol" / store.STORE_FILENAME
    assert seen["import_dir"] == str(tmp_path / "drop")


def test_the_drop_folder_is_the_import_directory_it_was_handed(tmp_path):
    """``events.source`` was the last thing ``settings.yaml`` was read for; the
    container names the mount instead (ADR-0015), and it arrives as an argument
    rather than being fetched from the environment down here."""
    manager = main.ConfigurationManager(config_dir=str(tmp_path),
                                        import_dir=str(tmp_path / "drop"))

    assert manager.get_events_source() == str(tmp_path / "drop")


def test_build_runtime_stops_on_an_unopenable_store(fake_config, mocker):
    """Nothing is loaded past a store that will not open."""
    mocker.patch.object(
        main.store, "open_store",
        side_effect=store.StoreUnavailable("disk is read-only"))

    with pytest.raises(store.StoreUnavailable):
        main.build_runtime()

    assert fake_config.load_calls == 0


def test_build_runtime_builds_the_exporter_registry_only(fake_config, monkeypatch):
    """The gauges are pure Python; the HTTP server they used to run is gone."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "true")

    runtime = main.build_runtime()

    assert isinstance(runtime.prometheus, PrometheusExporter)
    assert not hasattr(runtime.prometheus, "start")


def test_build_runtime_skips_the_exporter_when_disabled(fake_config, monkeypatch):
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")

    assert main.build_runtime().prometheus is None


# ---------------------------------------------------------------------------
# The mount observation and the three lines (issue #741, ADR-0015)
# ---------------------------------------------------------------------------

def _conditions_said(caplog):
    """The ``condition=`` keys of the logfmt lines the boot emitted, in order."""
    return [record.context['condition'] for record in caplog.records
            if 'condition' in getattr(record, 'context', {})]


def test_a_bare_container_says_the_three_lines_once_each(
        fake_config, monkeypatch, caplog):
    """#741's whole shape: the boot **observes and states** where #677/D12
    refused to start. The fake config publishes no event and the store has no
    ``base_currency`` row, so all three conditions stand at once — which is
    exactly the state of ``docker run`` with nothing attached to it."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: main.mounts.EPHEMERAL)
    caplog.set_level(logging.INFO)

    main.build_runtime()

    assert _conditions_said(caplog) == [
        boot_conditions.NO_PERSISTENCE,
        boot_conditions.NO_BASE_CURRENCY,
        boot_conditions.NO_PORTFOLIO,
    ]


def test_a_mounted_container_says_nothing_at_all_about_persistence(
        fake_config, monkeypatch, caplog):
    """The criterion, stated on the boot rather than on the pure function: a
    container whose store is on a volume must not be told to mount one."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: main.mounts.PERSISTENT)
    caplog.set_level(logging.INFO)

    main.build_runtime()

    assert boot_conditions.NO_PERSISTENCE not in _conditions_said(caplog)


def test_an_unobservable_mount_prints_nothing_and_answers_unknown(
        fake_config, monkeypatch, caplog):
    """The third answer, end to end. On a developer's macOS there is no
    ``/proc/self/mountinfo`` at all, and neither the line nor a *"the store is
    kept"* may be manufactured from that silence.

    ``store_persistence`` on the runtime is where that third answer lives: it is
    what the runtime and store resources publish, and it says ``unknown``
    rather than picking one of the two real answers. The gauge said the same
    thing by being absent, and it is the redundant half (#806, ADR-0033).
    """
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: main.mounts.UNKNOWN)
    caplog.set_level(logging.INFO)

    runtime = main.build_runtime()

    assert boot_conditions.NO_PERSISTENCE not in _conditions_said(caplog)
    assert runtime.store_persistence == main.mounts.UNKNOWN


@pytest.mark.parametrize("state", [main.mounts.EPHEMERAL,
                                   main.mounts.PERSISTENT])
def test_the_boot_carries_the_persistence_in_both_directions(
        fake_config, monkeypatch, state):
    """Observed in the **master**, so it crosses the fork on the runtime object
    the worker inherits — and carried in both directions, because *"the store is
    kept"* is as much of an answer as *"it is not"* and the resources that serve
    it have to be able to say either."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: state)

    runtime = main.build_runtime()

    assert runtime.store_persistence == state


def test_the_observation_interrogates_the_store_directory_it_was_given(
        fake_config, monkeypatch, tmp_path):
    """The **directory**, never the file: the store file does not exist yet on a
    first boot, and #740's *"they are directories, never files"* is what makes
    the question answerable at all."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setenv(store.STORE_DIR_VAR, str(tmp_path / "vol"))
    asked = []

    def _spy(store_dir, *_args, **_kwargs):
        asked.append(store_dir)
        return main.mounts.PERSISTENT

    monkeypatch.setattr(main.mounts, "store_persistence", _spy)

    main.build_runtime()

    assert asked == [tmp_path / "vol"]


def test_the_conditions_are_not_said_when_the_boot_fails_on_the_config(
        monkeypatch, caplog):
    """A boot that ends in an exception has a fatal message to say instead of
    three conditions about a portfolio it never managed to read."""
    monkeypatch.setenv("SB_PROMETHEUS_ENABLED", "false")
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: main.mounts.EPHEMERAL)
    monkeypatch.setattr(
        main, "ConfigurationManager",
        lambda **kwargs: _FakeConfigManager(
            load_error=EventValidationError("row 3: unknown event_type")))
    caplog.set_level(logging.INFO)

    with pytest.raises(EventValidationError):
        main.build_runtime()

    assert _conditions_said(caplog) == []


def test_the_runtime_answers_unknown_until_something_observed_it():
    """The default on ``Runtime`` is not *persistent*. A test runtime, and the
    one a Docker-less checkout builds, has observed nothing — and there is no
    honest reading of that other than :data:`mounts.UNKNOWN`."""
    runtime = main.Runtime(_FakeConfigManager(), None)

    assert runtime.store_persistence == main.mounts.UNKNOWN


def test_build_runtime_propagates_a_broken_config(monkeypatch):
    boom = EventValidationError("row 3: unknown event_type")
    monkeypatch.setattr(
        main, "ConfigurationManager",
        lambda **kwargs: _FakeConfigManager(load_error=boom))

    with pytest.raises(EventValidationError):
        main.build_runtime()


# ---------------------------------------------------------------------------
# The two failure paths — they differ, and the difference is the point
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("error,expected_message", [
    (EventValidationError("row 3 is malformed"),
     "An error occurred while loading events"),
    (store.StoreUnavailable("the file is not a DuckDB database"),
     "The store could not be opened"),
    (ValueError("Invalid value for SB_WEB_PORT"),
     "Configuration error"),
    (RuntimeError("something else entirely"),
     "An unexpected error occurred"),
])
def test_create_app_exits_once_on_every_fatal_branch(
        monkeypatch, mocker, error, expected_message):
    """In the master, a fatal config is a single clean exit — no fork happened.

    ``preload_app`` runs the factory in the arbiter before it spawns anything,
    so ``sys.exit(1)`` here reproduces exactly what the old ``__main__`` did.
    """
    monkeypatch.setattr(
        main, "ConfigurationManager",
        lambda **kwargs: _FakeConfigManager(load_error=error))
    fatal = mocker.patch.object(main.app_logger, "fatal")

    with pytest.raises(SystemExit) as excinfo:
        web.create_app()

    assert excinfo.value.code == 1
    assert expected_message in fatal.call_args[0][0]


def test_start_background_reraises_rather_than_exiting(monkeypatch, mocker):
    """In the worker, the failure must stay an exception.

    Gunicorn reads an exception raised in ``post_fork`` as WORKER_BOOT_ERROR and
    halts the whole arbiter; an ``exit(1)`` would read as an ordinary worker
    death and be respawned forever, failing identically each time.
    """
    web.create_app(runtime=main.Runtime(_FakeConfigManager(), None))
    boom = ValueError("Invalid value for SB_METRICS_PORT")
    monkeypatch.setattr(main, "start_runtime", mocker.Mock(side_effect=boom))
    fatal = mocker.patch.object(main.app_logger, "fatal")

    with pytest.raises(ValueError):
        web.start_background()

    assert "Configuration error" in fatal.call_args[0][0]


def test_start_background_refuses_to_run_without_a_preloaded_runtime():
    """The hooks reach the master's Runtime through the fork and nowhere else."""
    with pytest.raises(RuntimeError, match="preload_app"):
        web.start_background()


# ---------------------------------------------------------------------------
# start_runtime — the worker half
# ---------------------------------------------------------------------------

def test_start_runtime_builds_everything_the_fork_would_have_broken(mocker):
    cfg = _FakeConfigManager()
    exporter = mocker.MagicMock()
    runtime = main.Runtime(cfg, exporter)

    metrics = mocker.MagicMock()
    metrics.shares = []
    metrics_cls = mocker.patch.object(main, "SuiviBourseMetrics", return_value=metrics)
    scheduler = mocker.MagicMock()
    mocker.patch.object(main, "BackgroundScheduler", return_value=scheduler)

    order = []
    metrics.ingest.side_effect = lambda: order.append("ingest")
    scheduler.start.side_effect = lambda: order.append("start")

    main.start_runtime(runtime)

    # The exporter built in the master is handed down, never rebuilt: the gauges
    # the Flask app already serves must be the ones the scrape path updates.
    assert metrics_cls.call_args.kwargs["prometheus_exporter"] is exporter
    assert runtime.metrics is metrics
    assert runtime.scheduler is scheduler
    assert metrics.scheduler is scheduler
    assert cfg.watcher_started_with == metrics.ingest
    # ingest() arms the per-symbol scrape jobs (#616), so it must land before the
    # scheduler starts — the same order the blocking boot had.
    assert order == ["ingest", "start"]
    # ... plus the fixed-cadence interval jobs, of which there are now **two**:
    # the ``ingest`` job left with SB_INGESTION_INTERVAL (issue #697). The
    # ingestion still happens — it is the ``ingest()`` above and the always-on
    # drop-folder watcher — but nothing polls the folder on a timer.
    assert {c.kwargs["id"] for c in scheduler.add_job.call_args_list} == \
        {"backfill", "perf"}


def test_start_runtime_opens_the_workers_own_store(mocker, tmp_path):
    """The connection the process lives on belongs on this side of the fork."""
    metrics = mocker.MagicMock()
    metrics.shares = []
    mocker.patch.object(main, "SuiviBourseMetrics", return_value=metrics)
    mocker.patch.object(main, "BackgroundScheduler")
    runtime = main.Runtime(_FakeConfigManager(), None,
                           store_path=tmp_path / "worker.duckdb")

    main.start_runtime(runtime)

    assert runtime.store is not None
    runtime.store.ping()
    # ... and ``worker_exit`` gives it back.
    main.shutdown_runtime(runtime)
    assert runtime.store is None


def test_start_runtime_uses_a_background_scheduler(mocker):
    """Blocking would never return, and gunicorn's worker owns the foreground."""
    metrics = mocker.MagicMock()
    metrics.shares = []
    mocker.patch.object(main, "SuiviBourseMetrics", return_value=metrics)
    scheduler_cls = mocker.patch.object(main, "BackgroundScheduler")

    main.start_runtime(main.Runtime(_FakeConfigManager(), None))

    scheduler_cls.assert_called_once()
    assert "executors" in scheduler_cls.call_args.kwargs


def test_shutdown_runtime_stops_the_scheduler_the_watcher_and_the_client(mocker):
    cfg = _FakeConfigManager()
    runtime = main.Runtime(cfg, None)
    runtime.scheduler = mocker.MagicMock(running=True)
    runtime.metrics = mocker.MagicMock()

    main.shutdown_runtime(runtime)

    # wait=False: the worker is already leaving, and an in-flight scrape must not
    # hold the shutdown open for a whole yfinance timeout.
    runtime.scheduler.shutdown.assert_called_once_with(wait=False)
    assert cfg.watcher_stopped
    runtime.metrics.close.assert_called_once()


def test_shutdown_runtime_tolerates_a_worker_that_never_booted(mocker):
    """worker_exit runs even when post_fork died on its first line."""
    cfg = _FakeConfigManager()

    main.shutdown_runtime(main.Runtime(cfg, None))

    assert cfg.watcher_stopped


# ---------------------------------------------------------------------------
# The served surface
# ---------------------------------------------------------------------------

def test_health_answers_when_the_store_answers(open_store):
    """The probe reaches the store (#696) — there is no longer anyone else."""
    runtime = main.Runtime(_FakeConfigManager(), None)
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    response = app.test_client().get("/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_health_fails_when_the_store_does_not_answer(open_store):
    """A green probe over a dead store is the blind spot the probe exists for.

    The old rule — never touch the database, an outage is someone else's — lost
    its subject when the database became a file this process opens.
    """
    runtime = main.Runtime(_FakeConfigManager(), None)
    runtime.store = open_store
    app = web.create_app(runtime=runtime)
    open_store.close()

    response = app.test_client().get("/health")

    assert response.status_code == 503
    assert response.mimetype == "application/problem+json"


def test_health_fails_when_no_store_is_open():
    """Before ``post_fork`` there is nothing to be healthy about."""
    app = web.create_app(runtime=main.Runtime(_FakeConfigManager(), None))

    assert app.test_client().get("/health").status_code == 503


def test_metrics_is_not_served_even_with_an_exporter_on_the_runtime(open_store):
    """`/metrics` is nothing to this app any more (ADR-0033).

    Asserted with an exporter **present** on the runtime, because that is the
    only state in which the route could come back: what was removed is the
    mount, not the object. The 404 is the one the app gives any path it does
    not know — there is no `/metrics` branch left to produce a made-up one.
    """
    runtime = main.Runtime(_FakeConfigManager(), PrometheusExporter())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    assert app.test_client().get("/metrics").status_code == 404
    assert app.test_client().get("/metrics/").status_code == 404
    assert app.test_client().get("/health").status_code == 200


# ---------------------------------------------------------------------------
# gunicorn.conf.py — executable configuration
# ---------------------------------------------------------------------------

def test_gunicorn_binds_one_socket(monkeypatch):
    """One socket, and no condition left to evaluate (ADR-0033)."""
    conf = _load_gunicorn_conf(monkeypatch)

    assert conf.bind == ["0.0.0.0:8080"]
    assert conf.workers == 1
    assert conf.preload_app is True


def test_gunicorn_honours_the_web_port_dial(monkeypatch):
    conf = _load_gunicorn_conf(monkeypatch, SB_WEB_PORT="9000")

    assert conf.bind == ["0.0.0.0:9000"]


def test_gunicorn_binds_nothing_beyond_the_web_port(monkeypatch):
    """The metrics variables no longer add a socket, whatever they say.

    Both of them are still in the environment at this point — they leave it with
    the exporter — so the assertion is that they are *inert* here and not that
    they are absent: an owner who kept them in a `.env` gets one socket.
    """
    conf = _load_gunicorn_conf(
        monkeypatch, SB_PROMETHEUS_ENABLED="true", SB_METRICS_PORT="9091")

    assert conf.bind == ["0.0.0.0:8080"]


def test_gunicorn_closes_the_control_socket(monkeypatch):
    """The second door to a second worker.

    ``gunicornc -c "worker add 2"`` raises ``num_workers`` on a *running*
    arbiter, past ``on_starting``. Closing the socket is the only guard that
    covers it.
    """
    conf = _load_gunicorn_conf(monkeypatch)

    assert conf.control_socket_disable is True


def test_every_gunicorn_setting_we_declare_is_one_gunicorn_knows(monkeypatch):
    """Gunicorn silently ignores a config name it does not recognise.

    A typo in ``control_socket_disable`` or ``preload_app`` would therefore
    disable the guard it was written for without a word in the logs. Check the
    names against gunicorn's own registry rather than trusting them.
    """
    import types
    from gunicorn.config import Config

    conf = _load_gunicorn_conf(monkeypatch)
    known = set(Config().settings)
    # Everything the file declares at module level, minus its private helpers
    # (leading underscore), its imports and its hook functions. Modules are
    # excluded **by type** rather than by name: a list of import names is a
    # second inventory that goes stale the day one of them is renamed, which is
    # exactly what #740 did to ``main``.
    names = {n for n in vars(conf)
             if not n.startswith('_')
             and not isinstance(getattr(conf, n), types.ModuleType)}
    declared = {n for n in names if not callable(getattr(conf, n))}

    assert declared <= known, f"gunicorn ignores: {sorted(declared - known)}"
    # The four that carry a guarantee, spelled out so a rename cannot slip past.
    assert {'preload_app', 'workers', 'control_socket_disable', 'bind'} <= declared


def test_gunicorn_refuses_more_than_one_worker(monkeypatch):
    """The guard #651 asked for: extra workers duplicate every write, silently."""
    conf = _load_gunicorn_conf(monkeypatch)

    with pytest.raises(RuntimeError, match="exactly one worker"):
        conf.on_starting(SimpleNamespace(cfg=SimpleNamespace(workers=4)))


def test_gunicorn_boots_with_exactly_one_worker(monkeypatch):
    conf = _load_gunicorn_conf(monkeypatch)

    assert conf.on_starting(SimpleNamespace(cfg=SimpleNamespace(workers=1))) is None


def test_gunicorn_ignores_a_log_level_it_does_not_understand(monkeypatch):
    """LOG_LEVEL predates this file; an unknown value must not fail the boot."""
    assert _load_gunicorn_conf(monkeypatch, LOG_LEVEL="TRACE").loglevel == "info"
    assert _load_gunicorn_conf(monkeypatch, LOG_LEVEL="DEBUG").loglevel == "debug"
