"""The in-app analyst (#1114): its configuration, its model, its instructions.

**The configuration lives in the store, key included**, in the one row of
``agent_config``. No environment variable provides the key: the app is
configured from the app since v5, and an ``SB_`` name nobody reads is reported
by ``boot_env.unread``. The key leaves this module as its last four characters
and nothing else (:func:`describe`).

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
    "You are the analyst of a SuiviBourse portfolio. Every figure you state "
    "comes from a tool result in this conversation; you never compute, "
    "estimate or invent a figure, and when no tool gives it you say so. You "
    "present simulated outcomes and their trade-offs; you never recommend "
    "buying, selling, transferring or any other specific act, and when asked "
    "what to do you lay out the simulated options instead. Answer in the "
    "language of the user's last message."
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
BASE_URL_MAX = 500
PAGE_ROUTE_MAX = 200
PAGE_IDS_MAX = 20
PAGE_ID_MAX = 64

_COLUMNS = ('enabled', 'provider', 'model', 'base_url', 'api_key',
            'key_set_at', 'updated_at')

EMPTY = {'enabled': False, 'provider': None, 'model': None, 'base_url': None,
         'api_key': None, 'key_set_at': None, 'updated_at': None}

_HTTP_URL = re.compile(r'https?://\S+')

#: What a page's route and ids may hold: the line lands in the instructions,
#: so it carries a path and identifiers, never a sentence.
_ROUTE = re.compile(r'/[A-Za-z0-9/_.~%-]*')
_PAGE_ID = re.compile(r'[A-Za-z0-9._:^=-]+')


class InvalidAgentConfig(ValueError):
    """A write that would leave a configuration the analyst cannot run on."""

    def __init__(self, message: str, key: str):
        super().__init__(message)
        self.key = key


def read(store) -> dict:
    """The row, or :data:`EMPTY` when the analyst was never configured."""
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
        'base_url': config['base_url'],
        'key': {'set': key is not None,
                'last4': key[-4:] if key is not None else None,
                'set_at': instants.iso(config['key_set_at'])},
        **extra,
    }


def change(config: dict, body: Any) -> dict:
    """``config`` with ``body`` (any subset of the four fields) applied."""
    if not isinstance(body, dict):
        raise InvalidAgentConfig('a JSON object is required', 'body')
    allowed = ('enabled', 'provider', 'model', 'base_url')
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
    base_url = body.get('base_url')
    if base_url is not None and not (_text(base_url, BASE_URL_MAX) and _HTTP_URL.fullmatch(base_url)):
        raise InvalidAgentConfig(
            f"the base URL is an http:// or https:// address of at most "
            f"{BASE_URL_MAX} characters", 'base_url')
    changed = dict(config)
    changed.update(body)
    if isinstance(changed['model'], str):
        changed['model'] = changed['model'].strip()
    return check(changed)


def with_key(config: dict, key: Any, now: datetime) -> dict:
    """``config`` holding ``key``."""
    # Stripped: a key pasted with its newline would be refused by the HTTP
    # client as a header value, and reach the user as "Connection error.".
    key = key.strip() if isinstance(key, str) else key
    if not isinstance(key, str) or not KEY_MIN <= len(key) <= KEY_MAX or not key.isprintable():
        raise InvalidAgentConfig(
            f"the key is {KEY_MIN} to {KEY_MAX} printable characters", 'key')
    return check({**config, 'api_key': key, 'key_set_at': now})


def without_key(config: dict) -> tuple:
    """``config`` without its key, and whether that turned the analyst off.

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
    an address cleared or a key deleted under an enabled analyst is caught here
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
                    f"the analyst cannot be on without its "
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
        'INSERT INTO agent_config (id, enabled, provider, model, base_url, '
        'api_key, key_set_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?) '
        'ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, '
        'provider = excluded.provider, model = excluded.model, '
        'base_url = excluded.base_url, api_key = excluded.api_key, '
        'key_set_at = excluded.key_set_at, updated_at = excluded.updated_at',
        [config['enabled'], config['provider'], config['model'],
         config['base_url'], config['api_key'], config['key_set_at'], now])
    config['updated_at'] = now


def now() -> datetime:
    """The instant a write is stamped with."""
    return datetime.now(timezone.utc)


def page_line(page: Any) -> Optional[str]:
    """The page the user is on, as one line of instructions, or ``ValueError``."""
    if page is None:
        return None
    if not isinstance(page, dict) or set(page) - {'route', 'ids'}:
        raise ValueError("'page' holds a 'route' and its 'ids', nothing else")
    route = page.get('route')
    if not (isinstance(route, str) and len(route) <= PAGE_ROUTE_MAX and _ROUTE.fullmatch(route)):
        raise ValueError(
            f"'page.route' is a path starting with '/', of at most "
            f"{PAGE_ROUTE_MAX} characters")
    ids = page.get('ids', [])
    if not isinstance(ids, list) or len(ids) > PAGE_IDS_MAX or not all(isinstance(i, str) and len(i) <= PAGE_ID_MAX and _PAGE_ID.fullmatch(i) for i in ids):
        raise ValueError(
            f"'page.ids' is a list of at most {PAGE_IDS_MAX} ids of 1 to "
            f"{PAGE_ID_MAX} characters")
    shown = f", showing {', '.join(ids)}" if ids else ''
    return f"The user is on the page {route}{shown}."


def masked(text: str, secret: Optional[str]) -> str:
    """``text`` with every occurrence of ``secret`` replaced by ``…last4``."""
    return text.replace(secret, '…' + secret[-4:]) if secret else text


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


def build_agent(model, mcp):
    """The analyst: ``model`` over the MCP server's tools, in process.

    No tool exists only for the agent. ``deps`` stays empty: the investor's
    profile facts are #1116's.
    """
    from pydantic_ai import Agent
    from pydantic_ai.mcp import MCPToolset
    return Agent(model, toolsets=[MCPToolset(mcp)], instructions=SYSTEM_PROMPT)
