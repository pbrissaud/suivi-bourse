"""The agent's configuration under ``/api``: provider, model, key (#1197).

The key is stored by ``POST /api/agent/test`` alone, once the provider accepted
it (#1269)."""

from flask import Blueprint, jsonify

from application import agent as agent_module
from application import agent_probe
from api.problem import (
    conflict,
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
    """The agent's provider and model, and of its key only ``last4``."""
    return jsonify(agent_module.describe(agent_module.read(_store())))


@bp.put('/agent/config')
def put_agent_config():
    """Change any of ``enabled``, ``provider``, ``model``, ``base_url``.

    A different provider or address forgets the key (#1197).
    """
    return _write_agent_config(
        lambda config: agent_module.change(config, _json_object()))


@bp.delete('/agent/key')
def delete_agent_key():
    """Forget the key; a provider that needs one is switched off with it."""
    return _write_agent_config(agent_module.without_key)


@bp.post('/agent/test')
def probe_agent():
    """Test a candidate provider, address and key; keep them if it passes.

    The body names any of ``provider``, ``base_url`` and ``key``, and what it
    leaves out is the stored configuration's (an empty body tests that one);
    the stored key is used only with the provider and address it was stored
    for. The provider is asked **outside** the write lock, for up to
    ``agent_probe.TIMEOUT`` seconds. Only a pass writes, under the lock, and
    only if the stored provider, address and key are still the ones tested
    (else ``409``). A refusal answers 502 in the provider's words and writes
    nothing. The key is in no answer and no log line, but as ``…last4``.
    """
    stored = agent_module.read(_store())
    try:
        tried = agent_probe.ready(
            agent_module.candidate(stored, _json_object() or {}, agent_module.now()))
        listed = agent_probe.models(tried)
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    except agent_probe.ProviderRefused as exc:
        return provider_refused(
            str(exc), agent_module.PROVIDERS[tried['provider']], exc.reason)
    same = ('provider', 'base_url', 'api_key')
    with current_runtime().config_manager.writing() as opened:
        current = agent_module.read(opened)
        if any(current[name] != stored[name] for name in same):
            return conflict(
                "The agent's configuration changed while the connection was "
                "tested; test it again.")
        kept = agent_module.adopted(current, tried)
        if kept != current:
            agent_module.write(opened, kept, agent_module.now())
    return jsonify({
        'provider': kept['provider'],
        'models': listed,
        'preselected': agent_probe.preselected(listed, kept['model']),
        'config': agent_module.describe(kept),
    })


def _write_agent_config(changed):
    """Read, change and write the row under the writers' mutex.

    ``changed`` maps the stored configuration to the new one and whether that
    switched the agent off. A refusal names the field, and never the key.
    """
    runtime = current_runtime()
    try:
        with runtime.config_manager.writing() as opened:
            config, disabled = changed(agent_module.read(opened))
            agent_module.write(opened, config, agent_module.now())
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(agent_module.describe(
        config, **({'disabled': True} if disabled else {})))
