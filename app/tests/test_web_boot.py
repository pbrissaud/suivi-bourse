"""
Tests for the web process and its boot sequence (issue #838, ADR-0039).

The scheduler and the Flask app share one process, and since ADR-0039 that
process does not fork. What is worth pinning here is not that Flask serves JSON
— it is the **sequence**:

* :func:`boot.sequence` takes five steps in one order — the environment, the
  store and the ledger, the application, the jobs, the socket — and gives the
  scheduler and the store back on the way out, whichever way it left;
* :func:`boot.run` turns a failure at *any* of them into **one** non-zero exit.
  That used to differ by side of the fork: the master exited 1 before forking
  and ``post_fork`` re-raised so gunicorn would halt the arbiter rather than
  respawn a worker that would fail identically. There is no arbiter, so there is
  one answer;
* :func:`main.build_runtime` opens the store **once**, for the life of the
  process. The second connection existed because a DuckDB file descriptor cannot
  cross a ``fork()`` — the master proved the file openable and closed it again,
  the worker opened its own — and there is no fork.

What is deliberately gone: a module executed as configuration.
``gunicorn.conf.py`` had tests of its own here — a bind list, a one-worker
guard, a closed control socket. The two guards went with the arbiter they
defended against, and the bind is one argument of :func:`boot.serve`.
"""

import asyncio
import logging
import threading
import time
from datetime import date
from types import SimpleNamespace

import pytest

import boot
import boot_conditions
import boot_env
import entries
import main
import market
import store
import web
from events.schemas import Event, EventType
from events.validator import EventValidationError


class _FakeConfigManager:
    """Stands in for ConfigurationManager, recording what the boot asks of it."""

    def __init__(self, shares=None, load_error=None):
        self._shares = [] if shares is None else shares
        self._load_error = load_error
        self.load_calls = 0
        self.named_unread = 0
        # The store the ledger is read through (issue #697, ADR-0039): handed in
        # at construction, and taken away again only by a boot that will not
        # finish. Recorded rather than used, so the boot's handling of it stays
        # observable here — two entries used to be the ordinary case, one per
        # side of the fork.
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
    """Install a _FakeConfigManager as the one ``build_runtime`` constructs.

    It records the connection it is constructed with in ``attached``, which is
    the same list :meth:`attach_store` writes to: what the boot hands the manager
    and what it takes back read as one sequence.
    """
    cfg = _FakeConfigManager()

    def _construct(**kwargs):
        cfg.attached.append(kwargs.get("opened_store"))
        return cfg

    monkeypatch.setattr(main, "ConfigurationManager", _construct)
    return cfg


@pytest.fixture(autouse=True)
def _close_what_the_boot_opened(monkeypatch):
    """Close every store a boot opened in this module.

    ``build_runtime`` **keeps** its connection now (ADR-0039), which is the whole
    point of the ticket and a nuisance for exactly one caller: a test session,
    which goes on after the boot it provoked. In production the process exits
    and the file descriptor goes with it.
    """
    opened = []
    real = store.open_store

    def _tracking(path, *args, **kwargs):
        conn = real(path, *args, **kwargs)
        opened.append(conn)
        return conn

    monkeypatch.setattr(store, "open_store", _tracking)
    yield
    for conn in opened:
        conn.close()


@pytest.fixture
def open_store(tmp_path):
    """A real, open store, for the routes that must reach one."""
    opened = store.open_store(tmp_path / "served.duckdb")
    try:
        yield opened
    finally:
        opened.close()


# ---------------------------------------------------------------------------
# build_runtime — the store and the configuration
# ---------------------------------------------------------------------------

def test_build_runtime_validates_the_config_without_starting_anything(
        fake_config, mocker):
    """Its whole job: read the config, start nothing. The scheduler is step four."""
    workloads_cls = mocker.patch.object(main.workloads, "Workloads")
    scheduler_cls = mocker.patch.object(main, "BackgroundScheduler")
    threads_before = threading.active_count()

    runtime = main.build_runtime()

    # The configuration IS loaded here — that is what makes a bad one fatal
    # before the arbiter has anything to respawn — and the v4 file this version
    # no longer reads is named before that (#711).
    assert fake_config.load_calls == 1
    assert fake_config.named_unread == 1
    # ... and nothing else is.
    assert workloads_cls.call_count == 0
    assert scheduler_cls.call_count == 0
    assert runtime.workloads is None
    assert runtime.scheduler is None
    assert threading.active_count() == threads_before


def test_build_runtime_opens_the_store_and_keeps_it(fake_config):
    """One connection, for the life of the process (#696, ADR-0039).

    Opening it here is what makes an unreadable store a single named exit.
    *Keeping* it is what ADR-0039 changed: the file descriptor used to be closed
    again because it could not cross a ``fork()``, and the worker opened a second
    one on the far side.
    """
    runtime = main.build_runtime()

    assert runtime.store_path.exists()
    assert runtime.store is not None
    assert sorted(runtime.store.table_names()) == sorted(store.TABLES)
    # And it is the one the ledger is read through: handed to the manager at
    # construction, and never taken back.
    assert fake_config.attached == [runtime.store]


def test_the_boot_opens_the_store_exactly_once(fake_config, mocker):
    """The count is the assertion, because the second open left no trace.

    A store opened twice reads exactly like a store opened once — same file,
    same schema, same rows — so the only thing that says *"this happened once"*
    is the call. It is what the two connections used to cost, and what a fork
    made unavoidable.
    """
    opens = mocker.spy(store, "open_store")
    running = mocker.MagicMock()
    running.shares = []
    mocker.patch.object(main.workloads, "Workloads", return_value=running)
    mocker.patch.object(main, "BackgroundScheduler")

    main.start_runtime(main.build_runtime())

    assert opens.call_count == 1


def test_a_boot_that_will_not_finish_gives_the_file_back(monkeypatch):
    """The connection is only worth keeping for a process that is going to serve.

    A failure past the open leaves nothing holding the store: the manager is
    detached and the file closed on the way out, and the exception is what
    reaches ``boot.run``.
    """
    cfg = _FakeConfigManager(
        load_error=EventValidationError("row 3: unknown event_type"))
    handed = []

    def _construct(**kwargs):
        handed.append(kwargs.get("opened_store"))
        cfg.attached.append(kwargs.get("opened_store"))
        return cfg

    monkeypatch.setattr(main, "ConfigurationManager", _construct)

    with pytest.raises(EventValidationError):
        main.build_runtime()

    assert cfg.attached == [handed[0], None]
    # Closed, said the way ``/health`` says it: the store no longer answers.
    with pytest.raises(Exception):
        handed[0].ping()


def test_build_runtime_reads_the_environment_once_and_hands_no_folder_on(
        monkeypatch, tmp_path):
    """#740, ADR-0032. **One** read of ``os.environ``, and one path in it.

    Two reads at two moments would be two readings of one mapping, and the
    manager reading its own would put a second place in the process reaching for
    the environment — the thing #740 exists to make exactly one. The second path
    left with the drop folder: the manager is handed a store and nothing else,
    so there is no directory for it to be told about.
    """
    monkeypatch.setenv(store.STORE_DIR_VAR, str(tmp_path / "vol"))
    monkeypatch.setenv("SB_IMPORT_DIR", str(tmp_path / "drop"))
    seen = {}

    def _capture(**kwargs):
        seen.update(kwargs)
        return _FakeConfigManager()

    monkeypatch.setattr(main, "ConfigurationManager", _capture)

    runtime = main.build_runtime()

    assert runtime.store_path == tmp_path / "vol" / store.STORE_FILENAME
    assert set(seen) == {"opened_store"}


def test_build_runtime_stops_on_an_unopenable_store(fake_config, mocker):
    """Nothing is loaded past a store that will not open."""
    mocker.patch.object(
        store, "open_store",
        side_effect=store.StoreUnavailable("disk is read-only"))

    with pytest.raises(store.StoreUnavailable):
        main.build_runtime()

    assert fake_config.load_calls == 0


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
    rather than picking one of the two real answers. The gauge that said the
    same thing by being absent was the redundant half, and it has since gone
    (#806, #808, ADR-0033).
    """
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
    monkeypatch.setattr(main.mounts, "store_persistence",
                        lambda *_args, **_kwargs: state)

    runtime = main.build_runtime()

    assert runtime.store_persistence == state


def test_the_observation_interrogates_the_store_directory_it_was_given(
        fake_config, monkeypatch, tmp_path):
    """The **directory**, never the file: the store file does not exist yet on a
    first boot, and #740's *"they are directories, never files"* is what makes
    the question answerable at all."""
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
    runtime = main.Runtime(_FakeConfigManager())

    assert runtime.store_persistence == main.mounts.UNKNOWN


def test_build_runtime_propagates_a_broken_config(monkeypatch):
    boom = EventValidationError("row 3: unknown event_type")
    monkeypatch.setattr(
        main, "ConfigurationManager",
        lambda **kwargs: _FakeConfigManager(load_error=boom))

    with pytest.raises(EventValidationError):
        main.build_runtime()


# ---------------------------------------------------------------------------
# The one failure path — there used to be two, and the fork was the difference
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
def test_the_boot_names_every_fatal_branch_and_exits_one(
        monkeypatch, mocker, error, expected_message):
    """A fatal configuration is one named line and one non-zero exit.

    The branch list is the one ``__main__`` carried before gunicorn and it
    outlived it. What ADR-0039 removed is the *second* answer: the master exited
    1 and ``post_fork`` re-raised, because an exit code in a worker read as an
    ordinary death and was respawned forever, failing identically each time.
    """
    monkeypatch.setattr(
        main, "ConfigurationManager",
        lambda **kwargs: _FakeConfigManager(load_error=error))
    fatal = mocker.patch.object(main.app_logger, "fatal")

    assert boot.run({}) == 1
    assert fatal.call_count == 1
    assert expected_message in fatal.call_args[0][0]


# ---------------------------------------------------------------------------
# start_runtime — the scheduler and its jobs
# ---------------------------------------------------------------------------

def test_start_runtime_builds_everything_the_fork_would_have_broken(mocker):
    cfg = _FakeConfigManager()
    runtime = main.Runtime(cfg)

    running = mocker.MagicMock()
    running.shares = []
    mocker.patch.object(main.workloads, "Workloads", return_value=running)
    scheduler = mocker.MagicMock()
    mocker.patch.object(main, "BackgroundScheduler", return_value=scheduler)

    order = []
    running.ingest.side_effect = lambda: order.append("ingest")
    scheduler.start.side_effect = lambda: order.append("start")

    main.start_runtime(runtime)

    assert runtime.workloads is running
    assert runtime.scheduler is scheduler
    assert running.scheduler is scheduler
    # ingest() arms the per-symbol scrape jobs (#616), so it must land before the
    # scheduler starts — the same order the blocking boot had.
    assert order == ["ingest", "start"]
    # ... plus the fixed-cadence interval jobs, of which there are now **two**:
    # the ``ingest`` job left with SB_INGESTION_INTERVAL (issue #697). The
    # ingestion still happens — it is the ``ingest()`` above and the replay that
    # follows a write — but nothing polls anything on a timer, and since
    # ADR-0032 there is no folder left to poll.
    assert {c.kwargs["id"] for c in scheduler.add_job.call_args_list} == \
        {"backfill", "perf"}


def test_start_runtime_opens_no_store_and_serves_the_one_it_was_given(
        mocker, tmp_path):
    """It opened one, and that was the fork's doing (ADR-0039).

    Its first act used to be ``store.open_store``, because the connection
    ``build_runtime`` had proved openable was closed before the fork. There is
    one connection now and this step is handed it.
    """
    running = mocker.MagicMock()
    running.shares = []
    mocker.patch.object(main.workloads, "Workloads", return_value=running)
    mocker.patch.object(main, "BackgroundScheduler")
    opened = store.open_store(tmp_path / "the-one.duckdb")
    opens = mocker.spy(store, "open_store")
    runtime = main.Runtime(_FakeConfigManager(),
                           store_path=tmp_path / "the-one.duckdb",
                           opened_store=opened)

    main.start_runtime(runtime)

    assert opens.call_count == 0
    assert runtime.store is opened
    runtime.store.ping()
    # ... and the teardown gives it back.
    main.shutdown_runtime(runtime)
    assert runtime.store is None


def test_start_runtime_uses_a_background_scheduler(mocker):
    """Blocking would never return, and uvicorn's event loop owns the foreground."""
    running = mocker.MagicMock()
    running.shares = []
    mocker.patch.object(main.workloads, "Workloads", return_value=running)
    scheduler_cls = mocker.patch.object(main, "BackgroundScheduler")

    main.start_runtime(main.Runtime(_FakeConfigManager()))

    scheduler_cls.assert_called_once()
    assert "executors" in scheduler_cls.call_args.kwargs


def test_shutdown_runtime_stops_the_scheduler_and_gives_the_store_back(mocker):
    """Two gestures, and there is no third (issue #850).

    A ``close()`` on the workloads stood between them and released nothing: the
    InfluxDB client left with the database, and the store's connection was never
    that object's — it is the runtime's, and it is given back last, once nothing
    is left running that could still write into it.
    """
    cfg = _FakeConfigManager()
    runtime = main.Runtime(cfg, opened_store=mocker.MagicMock())
    opened = runtime.store
    runtime.scheduler = mocker.MagicMock(running=True)
    runtime.workloads = mocker.MagicMock()

    main.shutdown_runtime(runtime)

    # wait=False: the process is already leaving, and an in-flight scrape must
    # not hold the shutdown open for a whole yfinance timeout.
    runtime.scheduler.shutdown.assert_called_once_with(wait=False)
    opened.close.assert_called_once()
    assert runtime.store is None


def test_shutdown_runtime_tolerates_a_boot_that_never_got_that_far():
    """The teardown is a ``finally``: it runs on a boot that died on step two."""
    main.shutdown_runtime(main.Runtime(_FakeConfigManager()))


# ---------------------------------------------------------------------------
# The served surface
# ---------------------------------------------------------------------------

def test_health_answers_when_the_store_answers(open_store):
    """The probe reaches the store (#696) — there is no longer anyone else."""
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    response = app.test_client().get("/health")

    assert response.status_code == 200
    # The two registers, on the one answer (#818, ADR-0036): the code above is
    # the orchestrator's, and the body below names the three jobs for a person.
    body = response.get_json()
    assert set(body["jobs"]) == {"scrape", "backfill", "performance"}
    for job in body["jobs"].values():
        assert set(job) >= {"status", "at", "verdict"}


def test_health_says_a_stopped_scheduler_in_its_body(open_store):
    """A worker whose scheduler is gone will not run a job again.

    It is the one problem the sidebar's dot could already detect before this
    body existed, and it survives it — in the body, where every other reason to
    look now lives, and not in the code: an arbiter cannot repair a scheduler
    that stopped for a reason a restart will reproduce.
    """
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    response = app.test_client().get("/health")

    assert response.status_code == 200
    assert response.get_json()["scheduler_running"] is False
    assert response.get_json()["status"] == "attention"


def test_a_body_that_cannot_be_built_does_not_fail_the_probe(open_store):
    """The two registers held apart at their sharpest point (#818).

    The status code answers one question — *should this container be restarted*
    — and the body is not part of it. A defect in the shaping is not an answer
    to that question, and letting one through would restart a container for a
    reason a restart reproduces exactly. ``instants.utc`` writes down what
    that failure looks like when it happens: an exception deep in the
    arithmetic, surfacing one storey up as a verdict on the store that is not
    true. So what the body cannot say, it says it could not say.
    """
    class _UnreadableConfig(_FakeConfigManager):
        def current(self):
            raise RuntimeError("the snapshot is not there")

    runtime = main.Runtime(_UnreadableConfig())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    response = app.test_client().get("/health")

    assert response.status_code == 200
    assert response.get_json()["jobs"] is None
    assert "the snapshot is not there" in response.get_json()["error"]


def test_healthz_is_not_the_name_of_this_route(open_store):
    """`/healthz` was examined and declined (ADR-0036).

    A Kubernetes idiom addressed to a reader this product does not have: it
    ships as one self-hosted container whose probe is written into its own
    image. What #818 changed is what the route **answers**, not what it is
    called, and the rename stays refused rather than merely unperformed.

    Asserted on the **URL map** and not on a status code, because a status code
    would be lying about the wrong thing: `/healthz` is an unknown client-side
    path, so a build carrying the front answers it with the SPA shell and a
    `200` — as it does every path it does not know. What is true in both builds
    is that no rule is registered under that name, and that the probe's body is
    reachable under one name only.
    """
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    rules = {rule.rule for rule in app.url_map.iter_rules()}
    assert "/health" in rules
    assert "/healthz" not in rules
    assert "jobs" in app.test_client().get("/health").get_json()


def test_health_fails_when_the_store_does_not_answer(open_store):
    """A green probe over a dead store is the blind spot the probe exists for.

    The old rule — never touch the database, an outage is someone else's — lost
    its subject when the database became a file this process opens.
    """
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)
    open_store.close()

    response = app.test_client().get("/health")

    assert response.status_code == 503
    assert response.mimetype == "application/problem+json"


def test_health_fails_when_no_store_is_open():
    """Before the store is open there is nothing to be healthy about."""
    app = web.create_app(runtime=main.Runtime(_FakeConfigManager()))

    assert app.test_client().get("/health").status_code == 503


def test_metrics_is_not_served(open_store):
    """`/metrics` is nothing to this app any more (ADR-0033).

    The seam is the highest one there is — the Flask app by its test client, on
    the single socket — because the 404 is the only fact about the departure
    that is visible from outside. It is the one the app gives any path it does
    not know: there is no `/metrics` branch left to produce a made-up one, and
    since #808 there is no registry left to serve either.
    """
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    app = web.create_app(runtime=runtime)

    assert app.test_client().get("/metrics").status_code == 404
    assert app.test_client().get("/metrics/").status_code == 404
    assert app.test_client().get("/health").status_code == 200


# ---------------------------------------------------------------------------
# boot.py — the sequence (issue #838, ADR-0039)
# ---------------------------------------------------------------------------
#
# Five steps and an order. It is one of the seven places this suite reaches for
# an internal double, and for the reason the rule names: **what the app decided
# not to do** leaves nothing to read. An order leaves no row and no payload
# either — only calls — and "the socket was never bound" is the whole assertion
# of two of the tests below.


@pytest.fixture
def steps(monkeypatch):
    """Record the boot's steps, in the order it takes them."""
    order = []
    runtime = main.Runtime(_FakeConfigManager())

    def _step(name, result=None, error=None):
        def _record(*args, **kwargs):
            order.append(name)
            if error is not None:
                raise error
            return result
        return _record

    def _fail(name, error):
        monkeypatch.setattr(*_TARGETS[name], _step(name, error=error))

    _TARGETS = {
        "read_environment": (boot.boot_env, "read"),
        "build_runtime": (main, "build_runtime"),
        "create_app": (web, "create_app"),
        "start_runtime": (main, "start_runtime"),
        "serve": (boot, "serve"),
    }
    monkeypatch.setattr(boot.boot_env, "read",
                        _step("read_environment", boot_env.read({})))
    monkeypatch.setattr(main, "build_runtime", _step("build_runtime", runtime))
    monkeypatch.setattr(web, "create_app", _step("create_app", "the app"))
    monkeypatch.setattr(main, "start_runtime", _step("start_runtime"))
    monkeypatch.setattr(boot, "serve", _step("serve"))
    monkeypatch.setattr(main, "shutdown_runtime", _step("shutdown_runtime"))
    return SimpleNamespace(order=order, runtime=runtime, fail=_fail)


def test_the_boot_is_one_sequence_in_one_order(steps):
    """The environment, the store, the application, the jobs, the socket.

    Linear, and that is the whole of the ticket: there is no ``fork()`` cutting
    it in two and no hook to attach the second half to. The teardown closes it.
    """
    assert boot.run({}) == 0

    assert steps.order == ["read_environment", "build_runtime", "create_app",
                           "start_runtime", "serve", "shutdown_runtime"]


@pytest.mark.parametrize("failing", ["read_environment", "build_runtime",
                                     "create_app", "start_runtime", "serve"])
def test_a_failure_at_any_step_is_one_non_zero_exit(steps, mocker, failing):
    """One exit code, decided in one place, whichever step raised.

    There is no arbiter to respawn anything, which is what lets this be the whole
    of the failure handling — and ``preload_app``, whose reason was to keep an
    unreadable store (#696) out of a respawn loop, goes with the arbiter that
    made the loop possible.
    """
    steps.fail(failing, RuntimeError("this step will not have it"))
    fatal = mocker.patch.object(main.app_logger, "fatal")

    assert boot.run({}) == 1
    assert fatal.call_count == 1


def test_the_socket_is_bound_only_if_every_step_before_it_worked(steps, mocker):
    """A process that could not arm its jobs must not answer as if it had."""
    steps.fail("start_runtime", RuntimeError("the scheduler will not start"))
    mocker.patch.object(main.app_logger, "fatal")

    assert boot.run({}) == 1
    assert "serve" not in steps.order


def test_the_teardown_runs_on_a_boot_that_never_reached_a_lifespan(
        steps, mocker):
    """The ``finally``'s own case: a socket that could not be bound at all.

    The graceful path does not come through here — see the lifespan tests below
    — and this is what covers everything that never got that far.
    """
    steps.fail("serve", RuntimeError("the port is taken"))
    mocker.patch.object(main.app_logger, "fatal")

    assert boot.run({}) == 1
    assert steps.order[-1] == "shutdown_runtime"


def test_nothing_is_torn_down_when_there_was_nothing_to_build(steps, mocker):
    """A store that will not open has already given its file back.

    The ``finally`` needs a runtime to tear down, and step two is what produces
    one — so a failure *in* step two leaves the teardown with nothing to be
    handed, and it is not called at all.
    """
    steps.fail("build_runtime", store.StoreUnavailable("disk is read-only"))
    mocker.patch.object(main.app_logger, "fatal")

    assert boot.run({}) == 1
    assert steps.order == ["read_environment", "build_runtime"]


# ---------------------------------------------------------------------------
# Nothing on the network precedes the socket (issue #851)
# ---------------------------------------------------------------------------
#
# The two tests below are the only ones in this file that run the **whole**
# sequence over a real store and a real scheduler, because that is the only way
# the claim can be made: the fifth step happening before any fetch is not an
# order between doubles, it is an order between a socket and a network.
#
# The pool sizing used to fetch one ``info`` per held symbol from
# ``start_runtime`` — step four — behind a 30-second cap that was the *only*
# bound on it. So a Yahoo that answered slowly, or not at all, was up to half a
# minute during which the container answered neither the page nor ``/health``,
# at every boot since #701 deleted the flag that gated it. The venue is read
# from ``symbol_quote`` now, so there is nothing left between the ledger and the
# socket that can wait on anybody.


def _a_ledger_holding(tmp_path, *symbols):
    """Seed the store the boot is about to open with one ``BUY`` per symbol.

    Held symbols are what make the claim non-trivial: an empty portfolio never
    fetched anything even before #851, the ``if not to_fetch: return`` being the
    capture's own first line.
    """
    seeded = store.open_store(tmp_path / "store" / store.STORE_FILENAME)
    try:
        entries.create_many(seeded, [
            Event(date(2024, 1, 15), EventType.BUY, symbol, symbol,
                  quantity=10, unit_price=100.0, fee=1.0)
            for symbol in symbols])
    finally:
        seeded.close()


@pytest.fixture
def a_market_that_never_answers(monkeypatch):
    """The edge the boot used to wait on: every gesture blocks, then fails.

    Released on the way out so the scrape threads the boot armed — which is
    where a fetch belongs, after the socket — leave cleanly rather than being
    joined at interpreter exit.
    """
    release = threading.Event()

    class _NeverAnswers:
        def __init__(self, symbol):
            self.symbol = symbol
            self.history_metadata = None

        def _wait(self):
            release.wait(timeout=30)
            raise RuntimeError(f"Yahoo never answered for {self.symbol}")

        @property
        def info(self):
            return self._wait()

        def history(self, *args, **kwargs):
            return self._wait()

    monkeypatch.setattr(market.yf, "Ticker", _NeverAnswers)
    try:
        yield
    finally:
        release.set()


def test_the_boot_serves_although_the_market_edge_raises(
        tmp_path, monkeypatch):
    """A Yahoo that refuses every call is not a boot that refuses to serve.

    The socket is the fifth step and it is reached, with two symbols held: the
    scrape jobs armed at step four fail in their own threads, on their own
    back-off, and the page is up.
    """
    _a_ledger_holding(tmp_path, "AAPL", "MSFT")

    def _refuses(symbol):
        raise RuntimeError("the network is not there")

    monkeypatch.setattr(market.yf, "Ticker", _refuses)
    answered = {}

    def _serve(app, environment, on_shutdown):
        answered["status"] = app.test_client().get("/health").status_code

    monkeypatch.setattr(boot, "serve", _serve)

    boot.sequence({})

    assert answered["status"] == 200


def test_the_health_probe_answers_within_a_second_of_a_hung_market(
        tmp_path, monkeypatch, a_market_that_never_answers):
    """The thirty seconds, measured — and they are not spent any more.

    The clock starts at the first line of the sequence and stops when the probe
    has answered, so what it bounds is the whole boot and not merely the
    request. Before #851 this could not have passed: ``start_runtime`` would
    still be inside the capture's deadline, with no socket bound and nothing to
    ask.
    """
    _a_ledger_holding(tmp_path, "AAPL", "MSFT", "ALO.PA")
    answered = {}

    def _serve(app, environment, on_shutdown):
        answered["status"] = app.test_client().get("/health").status_code
        answered["elapsed"] = time.monotonic() - started

    monkeypatch.setattr(boot, "serve", _serve)

    started = time.monotonic()
    boot.sequence({})

    assert answered["status"] == 200
    assert answered["elapsed"] < 1.0


# ---------------------------------------------------------------------------
# boot.serve — the one socket
# ---------------------------------------------------------------------------

@pytest.fixture
def served(mocker):
    """Capture the call ``boot.serve`` makes to uvicorn, without binding a port."""
    return mocker.patch.object(boot.uvicorn, "run")


def _noop():
    """A teardown that has nothing to do — :func:`boot.serve` requires one."""


def test_serve_binds_the_web_port_on_every_interface(served):
    """One socket, and the port comes from the environment (ADR-0033, #740)."""
    boot.serve("the app", boot_env.read({"SB_WEB_PORT": "9000"}), _noop)

    assert served.call_args.kwargs["host"] == "0.0.0.0"
    assert served.call_args.kwargs["port"] == 9000


def test_serve_binds_the_default_port_when_nothing_says_otherwise(served):
    boot.serve("the app", boot_env.read({}), _noop)

    assert served.call_args.kwargs["port"] == 8080


def test_serve_binds_nothing_beyond_the_web_port(served):
    """A v4 ``.env`` still carrying the metrics pair gets **one** socket.

    The names are retired rather than absent from the world (they are in
    ``boot_env.DELETED``, and the boot names them), so what is asserted is that
    they are *inert*: there is no branch left that could bind a second one.
    """
    boot.serve("the app", boot_env.read(
        {"SB_PROMETHEUS_ENABLED": "true", "SB_METRICS_PORT": "9091"}), _noop)

    assert served.call_args.kwargs["port"] == 8080


def test_serve_asks_for_no_second_process(served):
    """The ``--workers`` door, shut by there being no command line (ADR-0039).

    ``on_starting`` and ``control_socket_disable`` were two guards spent
    forbidding a second worker — *N workers are N schedulers* — and uvicorn has a
    multiprocess mode of its own, so a CLI would have reopened what they shut.
    Asserted on the call because that is where the absence is: nothing asks for a
    worker count, and there is no entrypoint anywhere that could be handed one.
    """
    boot.serve("the app", boot_env.read({}), _noop)

    assert "workers" not in served.call_args.kwargs


def test_serve_honours_the_log_level_dial(served):
    boot.serve("the app", boot_env.read({"LOG_LEVEL": "DEBUG"}), _noop)

    assert served.call_args.kwargs["log_level"] == "debug"


def test_serve_ignores_a_log_level_uvicorn_does_not_understand(served):
    """``LOG_LEVEL`` predates any server; an unknown value must not fail the boot."""
    boot.serve("the app", boot_env.read({"LOG_LEVEL": "TRACE_ALL"}), _noop)

    assert served.call_args.kwargs["log_level"] == "info"


def test_serve_hands_the_flask_app_over_unchanged(served, open_store):
    """No route is rewritten (ADR-0039): the WSGI app is wrapped, not ported.

    The adapter is the whole of the change, and ``create_app()`` stays the seam
    the rest of this suite is written against — which is why the assertion is
    that the very object built here is the one behind the ASGI wrapper.
    """
    runtime = main.Runtime(_FakeConfigManager())
    runtime.store = open_store
    flask_app = web.create_app(runtime)

    boot.serve(flask_app, boot_env.read({}), _noop)

    assert served.call_args.args[0].wsgi.app is flask_app


# ---------------------------------------------------------------------------
# The teardown — on the lifespan, and that is a decision (issue #838)
# ---------------------------------------------------------------------------
#
# uvicorn catches SIGTERM, shuts down gracefully, restores the handler it
# replaced and **re-raises the signal**: the process dies of SIGTERM the instant
# ``uvicorn.run`` returns, so nothing written after that call runs. ``docker
# stop`` is that signal. The lifespan shutdown is the last thing uvicorn drives
# while the process is still alive.


def _lifespan(app, trace):
    """Drive the ASGI lifespan protocol against ``app``, recording it into ``trace``."""
    incoming = [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]

    async def receive():
        return incoming.pop(0)

    async def send(message):
        trace.append(message["type"])

    asyncio.run(app({"type": "lifespan"}, receive, send))


def test_the_lifespan_shutdown_is_what_tears_the_runtime_down():
    """The heir of ``worker_exit``, and the only hook a SIGTERM leaves time for.

    The order is the assertion: the jobs keep running for the whole of the
    startup, the teardown lands when the shutdown is *asked for*, and uvicorn is
    told it is complete only once it has.
    """
    trace = []
    app = boot.Serving("the app", lambda: trace.append("teardown"))

    _lifespan(app, trace)

    assert trace == ["lifespan.startup.complete", "teardown",
                     "lifespan.shutdown.complete"]


def test_the_teardown_survives_being_asked_twice(mocker, tmp_path):
    """Which is what lets both the lifespan and the ``finally`` name it.

    They cover two different departures — a signal, and a boot that never bound
    a socket — and a shutdown that could only be run once would make one of the
    two a defect.
    """
    running = mocker.MagicMock()
    running.shares = []
    mocker.patch.object(main.workloads, "Workloads", return_value=running)
    mocker.patch.object(main, "BackgroundScheduler")
    runtime = main.Runtime(
        _FakeConfigManager(),
        opened_store=store.open_store(tmp_path / "twice.duckdb"))
    main.start_runtime(runtime)

    main.shutdown_runtime(runtime)
    main.shutdown_runtime(runtime)

    assert runtime.store is None
