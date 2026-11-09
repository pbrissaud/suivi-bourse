"""The agent under ``/api``: its settings, its providers and its usage.

``GET/PUT /api/agent/config`` keep ``enabled`` and ``reasoning`` alone. The
providers are ``/api/agent/providers``: a provider holds a kind, an address, a
key, a default model and the privacy sentence computed from them. A provider
need not pass a test to be saved; ``POST /api/agent/providers/<id>/test`` lists
its models (``new`` for one not yet saved, the body naming the candidate).
``GET /api/agent/stats`` adds up the tokens the models exchanged.
"""
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from application import agent as agent_module
from application import agent_probe
from application import agent_threads
from application import agent_usage
from api.problem import (
    bad_request,
    not_found,
    provider_refused,
    unprocessable,
)
from api.common import (
    _store,
    current_runtime,
    _json_object,
)

bp = Blueprint('agent', __name__)


@bp.get('/agent/config')
def get_agent_config():
    """Whether the agent is on, and how hard it reasons."""
    return jsonify(agent_module.describe_settings(agent_module.read(_store())))


@bp.put('/agent/config')
def put_agent_config():
    """Change ``enabled`` and ``reasoning``. On needs a default provider that
    holds a model."""
    body = request.get_json(silent=True)
    try:
        with current_runtime().config_manager.writing() as opened:
            config = agent_module.change_settings(
                agent_module.read(opened), body,
                agent_module.default_of(agent_module.providers(opened)))
            agent_module.write(opened, config, agent_module.now())
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(agent_module.describe_settings(config))


@bp.get('/agent/providers')
def list_providers():
    """Every provider, the default first; of a key only ``last4``."""
    return jsonify([agent_module.describe(p)
                    for p in agent_module.providers(_store())])


@bp.post('/agent/providers')
def create_provider():
    """Add a provider: ``kind``, and as the kind needs ``base_url`` and
    ``key``; ``label`` and ``default_model`` are optional. The first one is
    the default."""
    try:
        with current_runtime().config_manager.writing() as opened:
            created = agent_module.create(
                _json_object(), agent_module.now(),
                not agent_module.providers(opened))
            agent_module.write_provider(opened, created)
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(agent_module.describe(created)), 201


@bp.patch('/agent/providers/<provider_id>')
def patch_provider(provider_id: str):
    """Change any of ``label``, ``kind``, ``base_url``, ``key``, ``default_model``.

    Moving the kind or the address forgets the key and the default model
    unless the body brings its own. A default provider left without a model
    switches the agent off (``disabled: true``).
    """
    now = agent_module.now()
    try:
        with current_runtime().config_manager.writing() as opened:
            stored = agent_module.provider(opened, provider_id)
            if stored is None:
                return not_found(f'No provider has the id {provider_id!r}.')
            changed = agent_module.change(stored, _json_object(), now)
            agent_module.write_provider(opened, changed)
            disabled = agent_module.settle(opened, now)
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(agent_module.describe(
        changed, **({'disabled': True} if disabled else {})))


@bp.delete('/agent/providers/<provider_id>')
def delete_provider(provider_id: str):
    """Forget a provider. The oldest left becomes the default if it was; with
    none left, the agent is off."""
    now = agent_module.now()
    with current_runtime().config_manager.writing() as opened:
        if agent_module.provider(opened, provider_id) is None:
            return not_found(f'No provider has the id {provider_id!r}.')
        agent_module.remove_provider(opened, provider_id)
        disabled = agent_module.settle(opened, now)
    return jsonify({'id': provider_id, 'removed': True, 'disabled': disabled})


@bp.put('/agent/providers/<provider_id>/default')
def default_provider(provider_id: str):
    """Make this provider the default."""
    with current_runtime().config_manager.writing() as opened:
        if agent_module.provider(opened, provider_id) is None:
            return not_found(f'No provider has the id {provider_id!r}.')
        agent_module.make_default(opened, provider_id)
        chosen = agent_module.provider(opened, provider_id)
        disabled = agent_module.settle(opened, agent_module.now())
    return jsonify(agent_module.describe(
        chosen, **({'disabled': True} if disabled else {})))


@bp.post('/agent/providers/<provider_id>/test')
def test_provider(provider_id: str):
    """List the models a provider serves; nothing is spent, nothing is saved
    but the instant of a pass on a saved provider.

    ``provider_id`` is ``new`` for a provider not saved yet. The body may name
    ``kind``, ``base_url`` and ``key`` to try something other than what is
    stored; the stored key is used only with the kind and address it was stored
    for. The provider is asked **outside** the write lock, for up to
    ``agent_probe.TIMEOUT`` seconds. A refusal answers 502 in the provider's
    words; the key is in no answer and no log line, but as ``…last4``.
    """
    stored = None
    if provider_id != 'new':
        stored = agent_module.provider(_store(), provider_id)
        if stored is None:
            return not_found(f'No provider has the id {provider_id!r}.')
    body = request.get_json(silent=True) if request.data else {}
    try:
        tried = agent_probe.ready(
            agent_module.candidate(stored, body, agent_module.now()))
        began = time.monotonic()
        listed = agent_probe.models(tried)
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    except agent_probe.ProviderRefused as exc:
        return provider_refused(
            str(exc), agent_module.PROVIDERS[tried['provider']], exc.reason)
    elapsed = time.monotonic() - began
    # Stamped only when what passed is what is saved, not unsaved edits.
    if stored is not None and all(
            tried[name] == stored[name]
            for name in ('provider', 'base_url', 'api_key')):
        with current_runtime().config_manager.writing() as opened:
            # Deleted meanwhile: nothing to stamp.
            if agent_module.provider(opened, provider_id) is not None:
                opened.execute(
                    'UPDATE agent_provider SET last_test_at = ? WHERE id = ?',
                    [agent_module.now(), provider_id])
    return jsonify({
        'models': listed,
        'preselected': agent_probe.preselected(
            listed, tried['model'] or (stored or {}).get('model')),
        'elapsed_ms': round(elapsed * 1000),
    })


@bp.get('/agent/stats')
def get_agent_stats():
    """The tokens the models exchanged since 1 January (``?range=`` ``1M``,
    ``YTD``, ``1Y`` or ``MAX``): totals, how the input splits between the cache
    and what is new, the weeks, the models and the threads that used the most.
    No price."""
    range_ = request.args.get('range', 'YTD')
    if range_ not in agent_usage.RANGES:
        return bad_request(
            f"'range' is one of {', '.join(agent_usage.RANGES)}.")
    today = datetime.now(timezone.utc)
    return jsonify({
        'range': range_,
        **agent_usage.stats(
            _store(), agent_threads.directory(current_runtime().store.path),
            agent_usage.since(range_, today), today)})
