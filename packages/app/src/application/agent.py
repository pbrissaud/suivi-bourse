"""The in-app agent (#1114): its providers, its model, its instructions.

**The providers live in the store, keys included**, in ``agent_provider``: one
row each, one of them the default. ``enabled`` and the reasoning level stay on
the one row of ``agent_config``. No environment variable provides a key: the app
is configured from the app since v5, and an ``SB_`` name nobody reads is
reported by ``boot_env.unread``. A key leaves this module as its last four
characters and nothing else (:func:`describe`).

Inside the app a provider keeps the names the model builder and the probe read:
``provider`` is the API's ``kind``, ``model`` its ``default_model``. A turn runs
on what :func:`choose` picks: the provider and model the request names, else the
thread's, else the default's.

A connection test (:func:`candidate`) tries a provider that need not be saved
yet; :func:`refusal` is how a failure becomes the ``reason`` the front
translates.

The provider SDKs are imported inside :func:`build_model`, so the Flask half,
which only reads and writes the rows, never loads them.
"""
import ipaddress
import os
import re
import secrets
import socket
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

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

PROVIDER_COLUMNS = (
    'id', 'label', 'kind AS provider', 'base_url', 'api_key', 'key_set_at',
    'default_model AS model', 'is_default', 'last_test_at', 'created_at')
_PROVIDER_NAMES = ('id', 'label', 'provider', 'base_url', 'api_key',
                   'key_set_at', 'model', 'is_default', 'last_test_at',
                   'created_at')

LABEL_MAX = 60

#: The provider fields a body may name, as the API spells them.
PROVIDER_FIELDS = ('label', 'kind', 'base_url', 'key', 'default_model')

#: What a provider is before anything is said about it. Inside the app it keeps
#: the names the model builder and the probe read: ``provider`` is the API's
#: ``kind``, ``model`` its ``default_model``.
BLANK = {'id': None, 'label': None, 'provider': None, 'base_url': None,
         'api_key': None, 'key_set_at': None, 'model': None,
         'is_default': False, 'last_test_at': None, 'created_at': None}

#: ``enabled`` and ``thinking`` are all the ``agent_config`` row holds now.
EMPTY = {'enabled': False, 'thinking': 'low', 'updated_at': None}

_HTTP_URL = re.compile(r'https?://\S+')


class InvalidAgentConfig(ValueError):
    """A write that would leave a configuration the agent cannot run on."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


def read(store) -> dict:
    """``enabled`` and ``thinking``, or :data:`EMPTY` when never written."""
    rows = store.query(
        'SELECT enabled, thinking, updated_at FROM agent_config WHERE id = 1')
    return dict(zip(EMPTY, rows[0])) if rows else dict(EMPTY)


def providers(store) -> list:
    """Every provider, the default first, then the oldest."""
    rows = store.query(
        f"SELECT {', '.join(PROVIDER_COLUMNS)} FROM agent_provider "
        'ORDER BY is_default DESC, created_at, id')
    return [dict(zip(_PROVIDER_NAMES, row)) for row in rows]


def provider(store, provider_id: str) -> Optional[dict]:
    """The provider by that id, or ``None``."""
    return next((p for p in providers(store) if p['id'] == provider_id), None)


def default_of(listed: list) -> Optional[dict]:
    """The default provider among ``listed``, or ``None`` when there is none."""
    return next((p for p in listed if p['is_default']), None)


def runnable(config: Optional[dict]) -> bool:
    """Can a turn run on this provider? It holds a model; :func:`check` made
    sure of the key and the address."""
    return config is not None and config['model'] is not None


def describe_settings(config: dict, **extra: Any) -> dict:
    """``GET /api/agent/config``: ``enabled`` and ``reasoning``, and nothing else."""
    return {'enabled': config['enabled'], 'reasoning': config['thinking'],
            **extra}


def describe(config: dict, **extra: Any) -> dict:
    """A provider as it may leave the server: the key as ``last4``."""
    key = config['api_key']
    return {
        'id': config['id'],
        'label': config['label'],
        'kind': config['provider'],
        'base_url': config['base_url'],
        'default_model': config['model'],
        'is_default': config['is_default'],
        'last_test_at': instants.iso(config['last_test_at']),
        'key': {'set': key is not None,
                'last4': key[-4:] if key is not None else None,
                'set_at': instants.iso(config['key_set_at'])},
        'privacy': privacy(config),
        **extra,
    }


def is_private(base_url: Optional[str]) -> bool:
    """Does ``base_url`` name this machine or a private network?

    A host name is resolved, and **every** address it gives must be loopback or
    private: a name that does not resolve is not known to be private.
    """
    host = urlsplit(base_url or '').hostname
    if not host:
        return False
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            found = socket.getaddrinfo(host, None)
        except OSError:
            return False
        addresses = [ipaddress.ip_address(info[4][0].split('%')[0])
                     for info in found]
    return bool(addresses) and all(
        a.is_loopback or a.is_private for a in addresses)


def privacy(config: dict) -> dict:
    """Where the figures go when the agent answers, in both languages.

    ``local`` only when the address resolves to this machine or a private
    network; a hosted provider (no address) never is.
    """
    local = is_private(config['base_url'])
    name = label_of(config)
    return {
        'local': local,
        'fr': ('Vos chiffres restent sur ce serveur.' if local
               else f'Vos chiffres sont envoyés à {name}.'),
        'en': ('Your figures stay on this server.' if local
               else f'Your figures are sent to {name}.'),
    }


def _clean(value: Any) -> Any:
    """A text field as stored: stripped, and blank is none."""
    if isinstance(value, str):
        return value.strip() or None
    return value


def create(body: Any, now: datetime, first: bool) -> dict:
    """A new provider from ``body``, the default when it is the ``first``."""
    body = _fields(body)
    key = _clean(body.get('key'))
    return check({
        **BLANK, 'id': secrets.token_hex(6), 'label': _clean(body.get('label')),
        'provider': body.get('kind'), 'base_url': _clean(body.get('base_url')),
        'api_key': key, 'key_set_at': now if key else None,
        'model': _clean(body.get('default_model')), 'is_default': first,
        'created_at': now})


def change(stored: dict, body: Any, now: datetime) -> dict:
    """``stored`` with ``body`` (any subset of the fields) applied.

    A key belongs to the kind and the address it was typed for: moving either
    forgets it (and the default model, which belongs to its provider) unless
    ``body`` brings its own. ``key: null`` forgets the key.
    """
    body = _fields(body)
    changed = dict(stored)
    for name, own in (('label', 'label'), ('kind', 'provider'),
                      ('base_url', 'base_url'), ('default_model', 'model')):
        if name in body:
            changed[own] = _clean(body[name])
    moved = any(changed[name] != stored[name] for name in ('provider', 'base_url'))
    if 'key' in body:
        changed['api_key'] = _clean(body['key'])
    elif moved:
        changed['api_key'] = None
    if changed['api_key'] != stored['api_key']:
        changed['key_set_at'] = now if changed['api_key'] else None
    if moved and 'default_model' not in body:
        changed['model'] = None
    return check(changed)


def _fields(body: Any) -> dict:
    """``body`` itself if it is an object naming only provider fields."""
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    for name in body:
        if name not in PROVIDER_FIELDS:
            raise InvalidAgentConfig(
                f"{name!r} is not a field of a provider; the fields are "
                f"{', '.join(PROVIDER_FIELDS)}", name)
    return body


def candidate(stored: Optional[dict], body: Any, at: datetime) -> dict:
    """What a connection test tries: ``stored`` (none for a provider not yet
    saved) with ``body``'s kind, address and key. Any other field is refused.

    The stored key is used only with the kind and address it was stored for: a
    candidate moving either must bring its own.
    """
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    for name in body:
        if name not in ('kind', 'base_url', 'key'):
            raise InvalidAgentConfig(
                f"{name!r} is not a field of a connection test; the fields "
                f"are kind, base_url, key", name)
    tried = dict(stored or BLANK)
    if 'kind' in body:
        tried['provider'] = body['kind']
    if 'base_url' in body:
        tried['base_url'] = _clean(body['base_url'])
    if stored is not None and any(
            tried[name] != stored[name] for name in ('provider', 'base_url')):
        tried.update(api_key=None, key_set_at=None)
    if body.get('key') is not None:
        tried.update(api_key=_clean(body['key']), key_set_at=at)
    return check(tried, require=False)


def change_settings(current: dict, body: Any, default: Optional[dict]) -> dict:
    """``current`` with ``body``'s ``enabled`` and ``reasoning`` applied.

    The agent is on only over a default provider that holds a model.
    """
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    for name in body:
        if name not in ('enabled', 'reasoning'):
            raise InvalidAgentConfig(
                f"{name!r} is not a field of the agent's configuration; "
                f"the fields are enabled, reasoning", name)
    if 'enabled' in body and not isinstance(body['enabled'], bool):
        raise InvalidAgentConfig("'enabled' is true or false", 'enabled')
    if 'reasoning' in body and body['reasoning'] not in THINKING:
        raise InvalidAgentConfig(
            f"the reasoning level is one of {', '.join(THINKING)}", 'reasoning')
    changed = dict(current)
    if 'enabled' in body:
        changed['enabled'] = body['enabled']
    if 'reasoning' in body:
        changed['thinking'] = body['reasoning']
    if 'enabled' in body and changed['enabled'] and not runnable(default):
        raise InvalidAgentConfig(
            'the agent cannot be on without a default provider and its model',
            'enabled')
    return changed


def choose(listed: list, asked_id: Any, asked_model: Any,
           thread: Optional[dict]) -> dict:
    """The provider and model a turn runs on, as a config :func:`build_model` reads.

    What the request names wins; else what the thread ran on last; else the
    default provider and its model. A thread stored before providers had ids
    names its kind: the default of that kind carries on.
    """
    thread = thread or {}
    # A thread stored before providers had ids names its kind only.
    stored_id, stored_kind = thread.get('provider_id'), thread.get('provider')
    if asked_id is not None:
        chosen = next((p for p in listed if p['id'] == asked_id), None)
        if chosen is None:
            raise InvalidAgentConfig('no provider has this id', 'provider_id')
    else:
        chosen = next((p for p in listed if p['id'] == stored_id), None)
        if chosen is None and stored_id is None:
            chosen = next((p for p in listed if p['provider'] == stored_kind), None)
        chosen = chosen or default_of(listed)
    if chosen is None:
        raise InvalidAgentConfig('no provider is configured', 'provider_id')
    continuing = chosen['id'] == stored_id or (
        stored_id is None and chosen['provider'] == stored_kind)
    if asked_model is not None and not _text(asked_model, MODEL_MAX):
        raise InvalidAgentConfig(
            f"the model is a name of 1 to {MODEL_MAX} characters", 'model')
    model = asked_model.strip() if asked_model is not None else None
    model = model or (thread.get('model') if continuing else None) or chosen['model']
    if model is None:
        raise InvalidAgentConfig('this provider has no model chosen', 'model')
    return {**chosen, 'model': model}


def label_of(config: dict) -> str:
    """How an error names the provider: its label, else its kind."""
    return config['label'] or PROVIDERS[config['provider']]


def check(config: dict, require: bool = True) -> dict:
    """``config`` itself, or :class:`InvalidAgentConfig` naming the field.

    ``require``: also that a kind which cannot run without a key or an address
    holds one. A connection test checks that itself, in its own words.
    """
    kind = config['provider']
    if kind not in PROVIDERS:
        raise InvalidAgentConfig(
            f"the kind is one of {', '.join(PROVIDERS)}", 'kind')
    for name, own, most in (('label', 'label', LABEL_MAX),
                            ('default_model', 'model', MODEL_MAX)):
        if config[own] is not None and not _text(config[own], most):
            raise InvalidAgentConfig(
                f"the {name.replace('_', ' ')} is a line of 1 to {most} "
                f"characters", name)
    url = config['base_url']
    if url is not None and not (_text(url, BASE_URL_MAX) and _HTTP_URL.fullmatch(url)):
        raise InvalidAgentConfig(
            f"the base URL is an http:// or https:// address of at most "
            f"{BASE_URL_MAX} characters", 'base_url')
    key = config['api_key']
    # Stripped by _clean already: a key pasted with its newline would be
    # refused by the HTTP client as a header value, and reach the user as
    # "Connection error.".
    if key is not None and not (isinstance(key, str) and KEY_MIN <= len(key) <= KEY_MAX and key.isprintable()):
        raise InvalidAgentConfig(
            f"the key is {KEY_MIN} to {KEY_MAX} printable characters", 'key')
    if kind in BASE_URL_REFUSED and url is not None:
        raise InvalidAgentConfig(
            f"{PROVIDERS[kind]} takes no base URL; clear it", 'base_url')
    if kind in KEY_REFUSED and key is not None:
        raise InvalidAgentConfig(
            f"{PROVIDERS[kind]} takes no key; delete it", 'key')
    if require:
        for name, missing in (
                ('key', kind in KEY_REQUIRED and key is None),
                ('base_url', kind in BASE_URL_REQUIRED and url is None)):
            if missing:
                raise InvalidAgentConfig(
                    f"{PROVIDERS[kind]} needs its {name.replace('_', ' ')}",
                    name)
    return config


def write_provider(store, config: dict) -> None:
    """Keep ``config``, which :func:`check` has passed. Under the write lock."""
    store.execute(
        'INSERT INTO agent_provider (id, label, kind, base_url, api_key, '
        'key_set_at, default_model, is_default, last_test_at, created_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT (id) DO UPDATE SET label = excluded.label, '
        'kind = excluded.kind, base_url = excluded.base_url, '
        'api_key = excluded.api_key, key_set_at = excluded.key_set_at, '
        'default_model = excluded.default_model, '
        'is_default = excluded.is_default, last_test_at = excluded.last_test_at',
        [config['id'], config['label'], config['provider'], config['base_url'],
         config['api_key'], config['key_set_at'], config['model'],
         config['is_default'], config['last_test_at'], config['created_at']])


def make_default(store, provider_id: str) -> None:
    """Make ``provider_id`` the one default. Under the write lock."""
    store.execute('UPDATE agent_provider SET is_default = (id = ?)', [provider_id])


def remove_provider(store, provider_id: str) -> None:
    """Delete the provider; the oldest left becomes the default if it was.

    Under the write lock. The threads that ran on it keep their id, and carry
    on on the default.
    """
    store.execute('DELETE FROM agent_provider WHERE id = ?', [provider_id])
    left = providers(store)
    if left and default_of(left) is None:
        make_default(store, left[0]['id'])


def settle(store, now: datetime) -> bool:
    """Switch the agent off if a provider write left it nothing to run on.

    Under the write lock; whether it did.
    """
    current = read(store)
    if current['enabled'] and not runnable(default_of(providers(store))):
        write(store, {**current, 'enabled': False}, now)
        return True
    return False


def write(store, config: dict, now: datetime) -> None:
    """Keep ``enabled`` and ``thinking``. Under the write lock."""
    store.execute(
        'INSERT INTO agent_config (id, enabled, thinking, updated_at) '
        'VALUES (1, ?, ?, ?) '
        'ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, '
        'thinking = excluded.thinking, updated_at = excluded.updated_at',
        [config['enabled'], config['thinking'], now])
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


def build_extractor(model, output_type, instructions: str):
    """An agent that reads a text and answers ``output_type``, **with no tool**.

    The statement of #1120 goes to this one and to no other: whatever the text
    asks for, nothing here can act on it. ``thinking='low'``: it copies, it
    does not reason.
    """
    from pydantic_ai import Agent
    from pydantic_ai.settings import ModelSettings
    return Agent(model, output_type=output_type, instructions=instructions,
                 model_settings=ModelSettings(thinking='low'))
