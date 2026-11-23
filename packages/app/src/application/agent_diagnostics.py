"""The built-in agent's own tools: the System page, read (#1625), and a
setting proposed for the owner to confirm (#1628, #1629).

Served to the owner's built-in agent only, through :func:`agent.build_agent`.
Nothing here is registered on the ``/mcp`` server: a client the owner connects
there never sees these tools (decided on 2026-11-20).
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, TypedDict

import duckdb
from pydantic import TypeAdapter, ValidationError

from application import advisories
from application import installation_facts
from application import instants
from application import proposals
from application import runtime_view
from application import setting_proposals
from application import settings
from application import settings_registry
from application import store as store_module
from application.jobs import registry
from application.jobs.scrape import scrape_next_runs

GET_SYSTEM_STATUS_DESCRIPTION = """\
What the app's System page shows about this installation right now: whether \
anything is wrong, and why a price, a history or a figure is empty or late. \
Takes no argument, reads only, changes nothing.

- `jobs`: the four background jobs (`scrape` fetches the current prices, \
`backfill` downloads the price histories, `ingestion` reads the ledger, \
`performance` recomputes the figures). `state` is what the last pass said: \
`ok`, `attention` (it ran and something needs a look), `error`, `idle` \
(nothing to do), `never` (not run since the app started); `null` when the \
jobs do not run in this process. `last_error` is that pass's error, `null` \
when it had none.
- `errors`: every error the jobs still carry, newest first. `source` is \
`scrape`, `backfill:backward`, `backfill:forward`, `backfill:lateral`, \
`ingest` or `perf`; `key` is the symbol it is about, `null` for the whole \
job. An empty list means no job reports an error.
- `symbols`: one row per security the ledger names, plus the comparison \
funds the owner follows. `price` is the state of its current price: `open` \
(fresh, market open), `closed` (market closed, so the last close is the \
normal price), `frozen` (the market has answered the same price since \
`stale_since`), `failing` then `backoff` (`failure_count` passes failed in a \
row, and in backoff the next try is spaced out), `write_failed` (fetched and \
not stored), `unknown` (no pass yet), `not_held` (not held, so no current \
price is fetched). `history` is the state of its price history in each \
direction: `complete`, `running`, `failing`, `unreachable` (the market has \
no history under that name), `unconvertible` (no exchange rate to the \
reporting currency), `unknown` (not started), or the reason the last pass \
was skipped: `no_series`, `too_recent`, `window_too_small`, \
`no_base_currency` (the reporting currency is not chosen yet), \
`no_quote_currency`, `nothing_to_repair`, `unit_learnt`.
- `rebuilding` with `reconstruction`: histories are still being downloaded, \
so figures over the past are incomplete until `complete` reaches `total`.
- `advisories`: what the portfolio and the installation flag and the owner \
has not put to sleep; `message` says it in words. `installation_facts`: \
what the installation was told and has not acknowledged.
- `settings`: each setting's `value`, and whether the owner `stored` it or \
it is the `default`. `log_level` and `unread_environment` (environment \
variables that are set and no longer read) complete the configuration.

`advisories`, `installation_facts` and `settings` are read from the store. \
When the store cannot answer they are `null` and `store_fault` says why: \
that is unknown, never "none". An empty list is a real "none".\
"""


def _stored_setting(key: str) -> str:
    """One stored setting as the tool's description lists it."""
    spec = settings_registry.spec_for(key)
    bounds = (f', {spec.minimum} to {spec.maximum}'
              if spec.minimum is not None else '')
    return f'- `{key}` ({spec.kind}{bounds}): {spec.doc}'


PROPOSE_SETTING_DESCRIPTION = f"""\
Propose a change to one setting of this installation, for the owner to \
confirm or ignore on a card under your answer. **This records a proposal and \
never changes the setting**: nothing changes until the owner confirms, so \
never say the setting is changed, and no tool confirms a proposal.

`key` is one of these, and `value` is what the setting would become:
- `log_level`: `DEBUG`, `INFO`, `WARNING`, `ERROR` or `CRITICAL`. It applies \
until the app restarts; it is not stored.
{chr(10).join(_stored_setting(key) for key in setting_proposals.STORED)}

Any other key is refused, the reporting currency among them: the owner \
changes those themself, in the app's Settings. A value out of range is \
refused too, and so is the value the setting already has. Tell the owner the \
reason the refusal gives, and propose nothing in its place unless they ask.

The comparison fund (the benchmark) is set up here, from a closed list. \
{setting_proposals.OFFERED}. When the owner wants a comparison and follows \
none, say so and ask which index they want before proposing anything. Then \
propose `benchmark_symbols` with the **whole list** to follow, as a list of \
symbols: the ones already followed plus the new one, because `value` \
replaces the list. Once confirmed, the fund's history downloads in the \
background. Propose `benchmark_symbol`, the one the Benchmark page displays, \
only once that fund's history reads `complete` in `get_system_status`: \
before that, the confirmation is refused. An index no offered reference \
tracks cannot be followed: name the offered ones instead.

`previous` is the setting's value when the proposal was made.\
"""


class Build(TypedDict):
    version: Optional[str]
    revision: Optional[str]
    source: str


class Reconstruction(TypedDict):
    complete: int
    total: int


class JobState(TypedDict):
    id: str
    state: Optional[str]
    last_run_at: Optional[str]
    next_run_at: Optional[str]
    cadence: Optional[Dict[str, Any]]
    last_error: Optional[str]


class JobError(TypedDict):
    source: str
    key: Optional[str]
    at: Optional[str]
    message: str


class SymbolState(TypedDict):
    symbol: str
    name: Optional[str]
    held: bool
    price: str
    last_pass: Optional[str]
    next_run: Optional[str]
    failure_count: int
    stale_since: Optional[str]
    history: Dict[str, str]


class Advisory(TypedDict):
    kind: str
    message: str
    detail: Dict[str, Any]


class Fact(TypedDict):
    key: str
    message: str
    first_seen_at: Optional[str]


class Setting(TypedDict):
    key: str
    value: Any
    default: Any
    stored: bool


class SystemStatus(TypedDict):
    now: str
    build: Build
    scheduler_running: bool
    rebuilding: bool
    reconstruction: Optional[Reconstruction]
    jobs: List[JobState]
    errors: List[JobError]
    symbols: List[SymbolState]
    log_level: str
    unread_environment: List[str]
    advisories: Optional[List[Advisory]]
    installation_facts: Optional[List[Fact]]
    settings: Optional[List[Setting]]
    store_fault: Optional[str]


class ProposedSetting(TypedDict):
    proposal_id: str
    key: str
    value: Any
    previous: Any
    status: str
    created_at: str
    expires_at: str
    note: str


_SHAPE = TypeAdapter(SystemStatus)

#: The store's half, when the store could not answer: unknown, not empty.
_UNREAD = {'references': [], 'advisories': None, 'installation_facts': None,
           'settings': None}


def system_status(runtime, checker=None,
                  now: Optional[datetime] = None) -> Dict[str, Any]:
    """What ``/system`` shows, folded for a model: the routes' own functions.

    Two halves. The jobs, their errors and the symbols come from process
    memory and are always answered. The advisories, the installation facts
    and the settings come from the store: a storage fault leaves them
    ``None`` under a sentence, so the half that explains the fault still
    reaches the model.

    The whole ``SymbolRuntime`` row, an advisory's ``texts`` and a setting's
    form fields are left out: the answer is kept in the thread and sent again
    on every turn.
    """
    from application import main

    now = now or datetime.now(timezone.utc)
    recorder = runtime.recorder
    ingestion = runtime.jobs['ingestion'] if runtime.jobs is not None else None
    reconstruction = (ingestion.reconstruction_state()
                      if ingestion is not None else None)
    rebuilding = runtime_view.is_rebuilding(reconstruction)

    try:
        stored, fault = _stored(runtime, checker, ingestion, rebuilding, now), None
    except (store_module.StoreUnavailable, duckdb.Error, ValueError) as exc:
        stored, fault = _UNREAD, (
            f"the store could not answer, so the advisories, the "
            f"installation facts and the settings are unknown here, not "
            f"empty: {exc}")

    # A followed comparison fund nobody holds is in no share, and the page's
    # rows stop at the shares: named here, or its backfill error has no row.
    shares = list(runtime.config_manager.current().shares)
    named = {share.get('symbol') for share in shares}
    shares += [{'symbol': symbol} for symbol in stored['references']
               if symbol not in named]
    scrape, backfill = recorder.records_for(shares)
    scheduler_running = runtime.scheduler is not None
    symbols = runtime_view.build_symbols(
        shares, scrape, backfill, scrape_next_runs(runtime.scheduler), now,
        scheduler_running)

    return {
        'now': instants.iso(now),
        'build': runtime.build.to_dict(),
        'scheduler_running': scheduler_running,
        'rebuilding': rebuilding,
        'reconstruction': (
            None if reconstruction is None
            else {'complete': reconstruction[0], 'total': reconstruction[1]}),
        'jobs': [{
            'id': row['id'],
            'state': row.get('state'),
            'last_run_at': row.get('last_run_at'),
            'next_run_at': row.get('next_run_at'),
            'cadence': row.get('cadence'),
            'last_error': getattr(
                recorder.history.last_pass(row['id']), 'error', None),
        } for row in registry.describe(
            runtime.jobs, recorder.history, runtime.scheduler)],
        'errors': runtime_view.build_errors(
            symbols, recorder.ingest(), recorder.perf()),
        'symbols': [_symbol(symbol.to_dict()) for symbol in symbols],
        'log_level': main.current_log_level(),
        'unread_environment': installation_facts.unread_environment(),
        'advisories': stored['advisories'],
        'installation_facts': stored['installation_facts'],
        'settings': stored['settings'],
        'store_fault': fault,
    }


def _stored(runtime, checker, ingestion, rebuilding: bool,
            now: datetime) -> Dict[str, Any]:
    """The store's half, as ``/api/advisories``, ``/api/installation-facts``
    and ``/api/config`` read it."""
    if runtime.store is None:
        raise store_module.StoreUnavailable(
            'the store is not open in this process')
    opened = runtime.store.reader()
    return {
        'references': list(opened.setting('benchmark_symbols')),
        'advisories': [
            {'kind': one.kind, 'message': one.message, 'detail': one.detail}
            for one in advisories.listing(
                opened, now, rebuilding=rebuilding, recorder=runtime.recorder,
                release=advisories.known_release(
                    opened, runtime.build, checker))],
        'installation_facts': [
            {key: fact.to_dict()[key]
             for key in ('key', 'message', 'first_seen_at')}
            for fact in installation_facts.listing(
                opened, installation_facts.observe(ingestion))],
        'settings': [
            {key: dial[key] for key in ('key', 'value', 'default', 'stored')}
            for dial in settings.describe(opened)],
    }


def _symbol(row: Dict[str, Any]) -> Dict[str, Any]:
    """One symbol's row, down to what answers *why is it empty or late*."""
    return {
        'symbol': row['symbol'],
        'name': row['name'],
        'held': row['held'],
        'price': row['pill'],
        'last_pass': row['last_pass'],
        'next_run': row['next_run'],
        'failure_count': row['failure_count'],
        'stale_since': row['stale_since'],
        'history': {direction: row[direction]['state']
                    for direction in ('backward', 'forward', 'lateral')},
    }


def build_toolset(runtime, checker=None):
    """The toolset only the built-in agent gets, closed over ``runtime``.

    ``checker`` is the process's update check (``update_check.Checker``): the
    ``update_available`` advisory reads what it has already learnt and asks no
    one. Left out, no update is ever announced.
    """
    from pydantic_ai import ModelRetry
    from pydantic_ai.exceptions import ToolFailed
    from pydantic_ai.toolsets import FunctionToolset

    def get_system_status() -> SystemStatus:
        """The System page, held to its published shape before it goes out."""
        answer = system_status(runtime, checker)
        try:
            _SHAPE.validate_python(answer)
        except ValidationError as exc:
            raise ModelRetry(
                f"this answer does not match the shape the tool publishes, "
                f"so it is withheld rather than served wrong: {exc}") from exc
        return answer

    def propose_setting(key: str, value: Any) -> ProposedSetting:
        """**This toolset's only write**: a ``proposal`` row, ``ready``.

        No tool confirms or ignores it; only the app's
        ``/api/config/proposals/<id>/confirm`` applies the setting. A refusal
        is a :class:`ToolFailed`: the model reads the reason and relays it,
        and is not asked to try again.
        """
        from application import main

        now = datetime.now(timezone.utc)
        try:
            # One transaction: a read-back that fails takes the row with it,
            # so the model is never told *nothing is proposed* about a card.
            with runtime.config_manager.writing() as opened, \
                    opened.transaction():
                proposal_id = setting_proposals.propose(
                    opened, key, value, main.current_log_level(), now)
                proposal, = setting_proposals.read(opened, [proposal_id], now)
        except setting_proposals.InvalidSettingProposal as exc:
            raise ToolFailed(f"this setting is refused: {exc}") from exc
        except (store_module.StoreUnavailable, duckdb.Error) as exc:
            raise ToolFailed(
                f"the store could not record this proposal, so nothing is "
                f"proposed: {exc}") from exc
        return {'proposal_id': proposal_id, 'key': proposal['key'],
                'value': proposal['value'], 'previous': proposal['previous'],
                'status': proposal['status'],
                'created_at': proposal['created_at'],
                'expires_at': instants.iso(now + proposals.EXPIRY),
                'note': "Le propriétaire doit confirmer dans SuiviBourse ; "
                        "rien n'est changé avant."}

    toolset = FunctionToolset()
    toolset.add_function(
        get_system_status, description=GET_SYSTEM_STATUS_DESCRIPTION)
    toolset.add_function(
        propose_setting, description=PROPOSE_SETTING_DESCRIPTION)
    return toolset
