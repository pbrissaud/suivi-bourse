"""The agent's configuration under ``/api``: provider, model, key (#1197)."""

from flask import Blueprint, jsonify

from application import agent as agent_module
from application import agent_probe
from api.problem import (
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


@bp.put('/agent/key')
def put_agent_key():
    """Keep the provider's key. It is never served back, only its ``last4``."""
    body = _json_object() or {}
    return _write_agent_config(lambda config: (
        agent_module.with_key(config, body.get('key'), agent_module.now()),
        False))


@bp.delete('/agent/key')
def delete_agent_key():
    """Forget the key; a provider that needs one is switched off with it."""
    return _write_agent_config(agent_module.without_key)


@bp.post('/agent/test')
def probe_agent():
    """List the stored provider's models, with the stored address and key.

    The answer names the models and the one to preselect; a provider that
    refuses answers 502 in its own words. The key is in neither, nor in the
    log, but as ``…last4``. Nothing is written: choosing a model and switching
    the agent on are ``PUT /api/agent/config``'s.
    """
    config = agent_module.read(_store())
    try:
        agent_probe.ready(config)
        listed = agent_probe.models(config)
    except agent_module.InvalidAgentConfig as exc:
        return unprocessable(str(exc), key=exc.key)
    except agent_probe.ProviderRefused as exc:
        return provider_refused(
            str(exc), agent_module.PROVIDERS[config['provider']], exc.reason)
    return jsonify({
        'provider': config['provider'],
        'models': listed,
        'preselected': agent_probe.preselected(listed, config['model']),
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
