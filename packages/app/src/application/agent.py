"""The in-app agent (#1114): its configuration, its model, its instructions.

**The configuration lives in the store, key included**, in the one row of
``agent_config``. No environment variable provides the key: the app is
configured from the app since v5, and an ``SB_`` name nobody reads is reported
by ``boot_env.unread``. The key leaves this module as its last four characters
and nothing else (:func:`describe`).

**Only a configuration that passed a test is stored** (#1269): the connection
test takes the candidate provider, address and key, and :func:`adopted` is what
the route keeps once the provider listed its models. A key the provider refused
is never written, and :func:`refusal` is how a failure becomes the ``reason`` the
front translates.

The provider SDKs are imported inside :func:`build_model`, so the Flask half,
which only reads and writes the row, never loads them.
"""
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from application import instants

# Before the first import of pydantic_ai anywhere in the process: it prints a
# banner on stdout on its first run otherwise.
os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')

SYSTEM_PROMPT = (
    "You are the agent that analyses a SuiviBourse portfolio. Every figure "
    "you state "
    "comes from a tool result in this conversation; you never compute, "
    "estimate or invent a figure, and when no tool gives it you say so. You "
    "present simulated outcomes and their trade-offs; you never recommend "
    "buying, selling, transferring or any other specific act, and when asked "
    "what to do you lay out the simulated options instead. Answer in the "
    "language of the user's last message. Name an account by its `label`, "
    "never by its `id`, and never quote a tool's field names: say what a "
    "figure is in words. When the user states their income, marginal tax "
    "rate, risk tolerance or a project, propose it with "
    "`propose_profile_fact`; never treat a proposal as confirmed. When the "
    "user states a purchase, a sale, a dividend or a deposit, propose it with "
    "`propose_events` on an account that already exists; the owner reviews "
    "and merges it, so never say it is recorded. Read what "
    "is confirmed with `get_profile`. Lead with the money-weighted return; "
    "give a time-weighted return only as a percent change with the day it "
    "counts from — turning an index into that percent is the one calculation "
    "you may do."
)

#: The provider kinds, and how each names itself in an error the user reads.
PROVIDERS = {
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'openai_compatible': 'OpenAI-compatible endpoint',
    'ollama': 'Ollama',
}

#: The kinds a key is required for, and the ones it is refused for.
KEY_REQUIRED = ('anthropic', 'openai')
KEY_REFUSED = ('ollama',)
#: The kinds that need an address, and the ones that refuse one.
BASE_URL_REQUIRED = ('openai_compatible', 'ollama')
BASE_URL_REFUSED = ('anthropic', 'openai')

KEY_MIN, KEY_MAX = 8, 512
MODEL_MAX = 200
#: How long a provider's message may be, JSON or not (an HTML page).
SAID_MAX = 300
BASE_URL_MAX = 500

#: How hard the analyst thinks (#1191), cheapest first. There is no "off":
#: on Claude Opus 5.5 and Sonnet 5.5 Pydantic AI drops it and sends nothing, so
#: the model would think at the API's own default, which costs more than ``low``.
THINKING = ('low', 'medium', 'high')

_COLUMNS = ('enabled', 'provider', 'model', 'model_name', 'base_url',
            'api_key', 'key_set_at', 'thinking', 'updated_at')

EMPTY = {'enabled': False, 'provider': None, 'model': None, 'model_name': None,
         'base_url': None, 'api_key': None, 'key_set_at': None,
         'thinking': 'low', 'updated_at': None}

_HTTP_URL = re.compile(r'https?://\S+')


class InvalidAgentConfig(ValueError):
    """A write that would leave a configuration the agent cannot run on."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


def read(store) -> dict:
    """The row, or :data:`EMPTY` when the agent was never configured."""
    rows = store.query(
        f"SELECT {', '.join(_COLUMNS)} FROM agent_config WHERE id = 1")
    return dict(zip(_COLUMNS, rows[0])) if rows else dict(EMPTY)


def describe(config: dict, **extra: Any) -> dict:
    """The configuration as it may leave the server: the key as ``last4``."""
    key = config['api_key']
    return {
        'enabled': config['enabled'],
        'provider': config['provider'],
        'model': config['model'],
        'model_name': config['model_name'],
        'base_url': config['base_url'],
        'thinking': config['thinking'],
        'key': {'set': key is not None,
                'last4': key[-4:] if key is not None else None,
                'set_at': instants.iso(config['key_set_at'])},
        **extra,
    }


def change(config: dict, body: Any) -> tuple:
    """``config`` with ``body`` (any subset of the fields) applied, and
    whether that turned the agent off.

    A key belongs to the provider and the address it was typed for: a
    different ``provider`` or ``base_url`` forgets it in the same write, as
    :func:`without_key` does, unless ``body`` says itself whether the agent
    is on. A ``model`` without its ``model_name`` clears the name, which
    belongs to its model.
    """
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    allowed = ('enabled', 'provider', 'model', 'model_name', 'base_url',
               'thinking')
    for name in body:
        if name not in allowed:
            raise InvalidAgentConfig(
                f"{name!r} is not a field of the agent's configuration; "
                f"the fields are {', '.join(allowed)}", name)
    if 'enabled' in body and not isinstance(body['enabled'], bool):
        raise InvalidAgentConfig("'enabled' is true or false", 'enabled')
    provider = body.get('provider')
    if provider is not None and provider not in PROVIDERS:
        raise InvalidAgentConfig(
            f"the provider is one of {', '.join(PROVIDERS)}", 'provider')
    model = body.get('model')
    if model is not None and not _text(model, MODEL_MAX):
        raise InvalidAgentConfig(
            f"the model is a name of 1 to {MODEL_MAX} characters", 'model')
    model_name = body.get('model_name')
    if model_name is not None and not _text(model_name, MODEL_MAX):
        raise InvalidAgentConfig(
            f"the model name is a line of 1 to {MODEL_MAX} characters",
            'model_name')
    base_url = body.get('base_url')
    if base_url is not None and not (_text(base_url, BASE_URL_MAX) and _HTTP_URL.fullmatch(base_url)):
        raise InvalidAgentConfig(
            f"the base URL is an http:// or https:// address of at most "
            f"{BASE_URL_MAX} characters", 'base_url')
    if 'thinking' in body and body['thinking'] not in THINKING:
        raise InvalidAgentConfig(
            f"the thinking level is one of {', '.join(THINKING)}", 'thinking')
    changed = dict(config)
    changed.update(body)
    if isinstance(changed['model'], str):
        changed['model'] = changed['model'].strip()
    if isinstance(changed['model_name'], str):
        changed['model_name'] = changed['model_name'].strip()
    if 'model' in body and 'model_name' not in body:
        changed['model_name'] = None
    moved = any(name in body and body[name] != config[name]
                for name in ('provider', 'base_url'))
    if moved and 'enabled' not in body:
        return without_key(changed)
    if moved:
        changed.update(api_key=None, key_set_at=None)
    return check(changed), False


def with_key(config: dict, key: Any, now: datetime) -> dict:
    """``config`` holding ``key``."""
    # Stripped: a key pasted with its newline would be refused by the HTTP
    # client as a header value, and reach the user as "Connection error.".
    key = key.strip() if isinstance(key, str) else key
    if not isinstance(key, str) or not KEY_MIN <= len(key) <= KEY_MAX or not key.isprintable():
        raise InvalidAgentConfig(
            f"the key is {KEY_MIN} to {KEY_MAX} printable characters", 'key')
    return check({**config, 'api_key': key, 'key_set_at': now})


def candidate(stored: dict, body: Any, at: datetime) -> dict:
    """What a connection test tries: ``stored`` with ``body``'s provider,
    address and key (#1269). Any other field is refused by name.

    Built on :func:`change` and :func:`with_key`: a candidate naming another
    provider or address must bring its own key, the stored one being used only
    with what it was stored for. The agent is off in the result, which is only
    ever tried, never written: :func:`adopted` is what is kept.
    """
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    for name in body:
        if name not in ('provider', 'base_url', 'key'):
            raise InvalidAgentConfig(
                f"{name!r} is not a field of a connection test; the fields "
                f"are provider, base_url, key", name)
    tried, _ = change({**stored, 'enabled': False},
                      {k: v for k, v in body.items() if k != 'key'})
    # A null key is no key: the stored one stands, as when the field is left out.
    return with_key(tried, body['key'], at) if body.get('key') is not None else tried


def adopted(stored: dict, tried: dict) -> dict:
    """``stored`` holding the provider, address and key of ``tried``, which a
    provider listed its models for (#1269).

    A different provider or address clears the model and its name, and a
    different provider, address or key switches the agent off: *Activer
    l'agent* puts it back. The same key keeps its ``key_set_at``.
    """
    moved = any(tried[name] != stored[name] for name in ('provider', 'base_url'))
    rekeyed = tried['api_key'] != stored['api_key']
    kept = {**stored, 'provider': tried['provider'],
            'base_url': tried['base_url'], 'api_key': tried['api_key']}
    if rekeyed:
        kept['key_set_at'] = tried['key_set_at']
    if moved:
        kept.update(model=None, model_name=None)
    if moved or rekeyed:
        kept['enabled'] = False
    return check(kept)


def without_key(config: dict) -> tuple:
    """``config`` without its key, and whether that turned the agent off.

    A provider that cannot run without a key is switched off in the same
    write, rather than the deletion being refused.
    """
    changed = {**config, 'api_key': None, 'key_set_at': None}
    disabled = changed['enabled'] and changed['provider'] in KEY_REQUIRED
    if disabled:
        changed['enabled'] = False
    return check(changed), disabled


def check(config: dict) -> dict:
    """``config`` itself, or :class:`InvalidAgentConfig` naming the field.

    Run on **every** write, not only on ``enabled: true``: a provider switched,
    an address cleared or a key deleted under an enabled agent is caught here
    too.
    """
    provider = config['provider']
    if config['enabled']:
        for name, missing in (
                ('provider', provider is None),
                ('model', config['model'] is None),
                ('key', provider in KEY_REQUIRED and config['api_key'] is None),
                ('base_url', provider in BASE_URL_REQUIRED and config['base_url'] is None)):
            if missing:
                named = f" for {PROVIDERS[provider]}" if provider else ''
                raise InvalidAgentConfig(
                    f"the agent cannot be on without its "
                    f"{name.replace('_', ' ')}{named}", name)
    if provider in BASE_URL_REFUSED and config['base_url'] is not None:
        raise InvalidAgentConfig(
            f"{PROVIDERS[provider]} takes no base URL; clear it", 'base_url')
    if provider in KEY_REFUSED and config['api_key'] is not None:
        raise InvalidAgentConfig(
            f"{PROVIDERS[provider]} takes no key; delete it", 'key')
    return config


def write(store, config: dict, now: datetime) -> None:
    """Keep ``config``, which :func:`check` has passed. Under the write lock."""
    store.execute(
        'INSERT INTO agent_config (id, enabled, provider, model, model_name, '
        'base_url, api_key, key_set_at, thinking, updated_at) '
        'VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, '
        'provider = excluded.provider, model = excluded.model, '
        'model_name = excluded.model_name, base_url = excluded.base_url, api_key = excluded.api_key, '
        'key_set_at = excluded.key_set_at, thinking = excluded.thinking, '
        'updated_at = excluded.updated_at',
        [config['enabled'], config['provider'], config['model'],
         config['model_name'], config['base_url'], config['api_key'], config['key_set_at'],
         config['thinking'], now])
    config['updated_at'] = now


def now() -> datetime:
    """The instant a write is stamped with."""
    return datetime.now(timezone.utc)


def masked(text: str, secret: Optional[str]) -> str:
    """``text`` with every occurrence of ``secret`` replaced by ``…last4``."""
    return text.replace(secret, '…' + secret[-4:]) if secret else text


def said(body: Any, text: str = '', secret: Optional[str] = None) -> str:
    """A provider's own message, out of its JSON ``body`` when there is one,
    else ``text``: masked, in one line, at most :data:`SAID_MAX` characters.

    Masked **before** it is cut, so a key straddling the cut is not left half
    written.
    """
    message = None
    if isinstance(body, dict):
        inner = body.get('error', body)
        message = inner.get('message') if isinstance(inner, dict) else inner
    elif isinstance(body, str):
        message = body
    message = str(message) if message else text
    return ' '.join(masked(message, secret).split())[:SAID_MAX]


def refusal(status: Optional[int], body: Any, during: str,
            provider: Optional[str] = None) -> str:
    """Why a provider failed, as the ``reason`` the front translates (#1269).

    ``status`` is the HTTP status, or ``None`` when nothing answered. It decides
    first: the body is read only to tell ``quota`` from ``rate_limit``, and an
    unknown body never moves a status out of its row. ``during`` is ``test`` or
    ``turn``; a 404 is a missing model during a turn, and a wrong address during
    a test, for a ``provider`` that takes one. 403 is ``refused``, not ``key``:
    OpenAI answers it for an unsupported region, and a gateway for a policy.
    """
    if status is None:
        return 'unreachable'
    if status == 401:
        return 'key'
    inner = body.get('error', body) if isinstance(body, dict) else None
    if not isinstance(inner, dict):
        inner = {}
    exhausted = 'insufficient_quota' in (inner.get('code'), inner.get('type'))
    broke = 'credit balance' in said(body).lower()
    if status == 402 or (status == 429 and exhausted) or (status == 400 and broke):
        return 'quota'
    if status == 429:
        return 'rate_limit'
    if status == 404:
        if during == 'turn':
            return 'model'
        return 'refused' if provider in BASE_URL_REFUSED else 'address'
    if status in (500, 502, 503, 504, 529):
        return 'overloaded'
    return 'refused'


def _text(value: Any, most: int) -> bool:
    """One line of 1 to ``most`` characters, not all of them blank."""
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= most and '\n' not in value)


def build_model(config: dict):
    """The Pydantic AI model for ``config``, which :func:`check` has passed."""
    provider, name = config['provider'], config['model']
    if provider == 'anthropic':
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider
        return AnthropicModel(
            name, provider=AnthropicProvider(api_key=config['api_key']))
    if provider == 'ollama':
        from pydantic_ai.models.ollama import OllamaModel
        from pydantic_ai.providers.ollama import OllamaProvider
        return OllamaModel(name, provider=OllamaProvider(
            base_url=config['base_url'].rstrip('/') + '/v1'))
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider
    if provider == 'openai':
        return OpenAIChatModel(
            name, provider=OpenAIProvider(api_key=config['api_key']))
    if provider == 'openai_compatible':
        # A local LiteLLM may take no key, and the OpenAI client refuses to be
        # built without one: any placeholder will do there.
        return OpenAIChatModel(name, provider=OpenAIProvider(
            base_url=config['base_url'], api_key=config['api_key'] or 'none'))
    raise ValueError(f'unknown provider {provider!r}')


def build_agent(model, mcp, *, thinking: str):
    """The agent: ``model`` over the MCP server's tools, in process.

    No tool exists only for the agent. ``deps`` stays empty: the investor's
    profile is a tool, ``get_profile``, and the agent's only writes,
    ``propose_profile_fact`` and ``propose_events``, are proposals only the app
    confirms (#1116, #1119).

    ``cache=True`` puts a breakpoint after the tools, the instructions and the
    conversation for the providers that take one (Anthropic, OpenAI from
    GPT-5.6); the others ignore it. A turn re-sends all three, so the prefix
    is read back at a tenth of the price, as long as it stays byte-stable:
    nothing per request goes into :data:`SYSTEM_PROMPT` (#1190).

    ``thinking`` is one of :data:`THINKING`. Pydantic AI maps it to each
    provider's own setting, and a model without reasoning ignores it (#1191).
    """
    from pydantic_ai import Agent
    from pydantic_ai.mcp import MCPToolset
    from pydantic_ai.settings import ModelSettings
    return Agent(model, toolsets=[MCPToolset(mcp)], instructions=SYSTEM_PROMPT,
                 model_settings=ModelSettings(cache=True, thinking=thinking))
