"""*Tester la connexion* (#1115): ask the stored provider which models it serves.

One ``GET`` to the provider's own model listing, with the stored address and
key, and nothing else: no prompt, no token spent. What comes back is the list
the setup's third step offers, and the model it preselects; what fails is said
in the provider's words, the key masked to ``…last4`` in the answer and in the
log alike (:func:`agent.masked`).

It runs on a Flask worker, one of four, for at most :data:`TIMEOUT` seconds:
a gesture made once, by hand, at setup, and not worth a second async route.
``httpx2`` is the provider SDKs' own client, so it is installed with them; it
honours ``HTTPS_PROXY`` like they do.
"""
import re
import time
from typing import Any, Optional

import httpx2
from logfmt_logger import getLogger

from application import agent

logger = getLogger("agent")

#: Seconds before a provider that does not answer is said not to: the whole
#: exchange, not only the silence between two chunks, so a gateway that drips
#: bytes cannot hold a Flask worker past it.
TIMEOUT = 10.0
#: A listing is a few hundred models; nothing a provider owes this is larger.
MAX_BODY = 4 * 1024 * 1024

ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models?limit=1000'
ANTHROPIC_VERSION = '2023-06-01'
OPENAI_MODELS = 'https://api.openai.com/v1/models'

#: OpenAI's listing holds every model the account may call, the ones that
#: cannot hold a conversation included: offering ``whisper-1`` as an analyst
#: is offering a model that refuses the first turn.
_NOT_A_CHAT_MODEL = re.compile(
    r'embedding|tts|whisper|dall-e|moderation|davinci|babbage|transcribe'
    r'|image|realtime|audio|search')

#: How long a provider's message may be, JSON or not (an HTML page).
_SAID_MAX = 300


class ProviderRefused(Exception):
    """The provider did not list its models; ``str()`` is the sentence, masked.

    ``reason`` is ``unreachable`` (no HTTP answer at all), ``refused`` (an
    HTTP error, in the provider's words) or ``unreadable`` (a ``200`` that is
    not a model listing).
    """

    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason


def ready(config: dict) -> dict:
    """``config`` if it holds what a test needs, or ``InvalidAgentConfig``.

    The model is not one of those things: listing them is how it is chosen.
    """
    provider = config['provider']
    if provider is None:
        raise agent.InvalidAgentConfig(
            'choose a provider before testing the connection', 'provider')
    label = agent.PROVIDERS[provider]
    if provider in agent.KEY_REQUIRED and config['api_key'] is None:
        raise agent.InvalidAgentConfig(
            f'{label} needs a key before the connection can be tested', 'key')
    if provider in agent.BASE_URL_REQUIRED and config['base_url'] is None:
        raise agent.InvalidAgentConfig(
            f'{label} needs an address before the connection can be tested',
            'base_url')
    return config


def models(config: dict, transport: Optional[httpx2.BaseTransport] = None) -> list:
    """The models ``config``'s provider serves, as ``{'id', 'name'}``, newest first.

    ``config`` has passed :func:`ready`. ``transport`` is the tests' seam.
    """
    provider, key = config['provider'], config['api_key']
    label = agent.PROVIDERS[provider]
    url, headers = _request(config)
    try:
        answer = _fetch(url, headers, transport)
    except httpx2.HTTPError as exc:
        raise _refused(label, f'cannot be reached at {_where(url)} '
                              f'({str(exc) or type(exc).__name__})',
                       'unreachable', key) from None
    if answer.is_error:
        raise _refused(label, _said(answer), 'refused', key)
    try:
        listed = _listed(provider, answer.json())
    except (ValueError, TypeError, KeyError, AttributeError):
        raise _refused(label, f'answered {_where(url)} with something that is '
                              f'not a list of models', 'unreadable', key) from None
    logger.info(f"agent test: {label} lists {len(listed)} models")
    return listed


def _fetch(url: str, headers: dict, transport) -> httpx2.Response:
    """The answer, read whole within :data:`TIMEOUT` and :data:`MAX_BODY`."""
    deadline = time.monotonic() + TIMEOUT
    with httpx2.Client(timeout=TIMEOUT, transport=transport) as client:
        with client.stream('GET', url, headers=headers) as streamed:
            body = bytearray()
            for chunk in streamed.iter_bytes():
                body.extend(chunk)
                if time.monotonic() > deadline:
                    raise httpx2.ReadTimeout(
                        f'no whole answer within {TIMEOUT:g} seconds',
                        request=streamed.request)
                if len(body) > MAX_BODY:
                    raise httpx2.ReadError(
                        f'an answer past {MAX_BODY // (1024 * 1024)} MB',
                        request=streamed.request)
            # Decoded already: only the type travels with the bytes.
            kept = {k: v for k, v in streamed.headers.items()
                    if k.lower() == 'content-type'}
            return httpx2.Response(streamed.status_code, headers=kept,
                                   content=bytes(body), request=streamed.request)


def preselected(listed: list, current: Optional[str]) -> Optional[str]:
    """The stored model when the provider still serves it, else its newest."""
    ids = [model['id'] for model in listed]
    if current in ids:
        return current
    return ids[0] if ids else None


def _request(config: dict) -> tuple:
    """The listing's URL and headers for ``config``'s provider."""
    provider, key = config['provider'], config['api_key']
    if provider == 'anthropic':
        return ANTHROPIC_MODELS, {'x-api-key': key,
                                  'anthropic-version': ANTHROPIC_VERSION}
    if provider == 'openai':
        return OPENAI_MODELS, {'Authorization': f'Bearer {key}'}
    base = config['base_url'].rstrip('/')
    if provider == 'ollama':
        # Ollama's native listing, not its /v1 one: it is the one every
        # version has served, and it names what was pulled.
        return f'{base}/api/tags', {}
    # An OpenAI-compatible gateway is addressed like build_model does: the
    # stored address already holds its /v1, and /models sits beside the
    # /chat/completions the analyst will call.
    return f'{base}/models', ({'Authorization': f'Bearer {key}'} if key else {})


def _listed(provider: str, body: Any) -> list:
    """The listing's models, newest first, as ``{'id', 'name'}``."""
    if provider == 'ollama':
        rows = [{'id': m['name'], 'name': m['name'],
                 'at': m.get('modified_at') or ''} for m in body['models']]
    else:
        rows = [{'id': m['id'], 'name': m.get('display_name') or m['id'],
                 'at': m.get('created_at') or m.get('created') or 0}
                for m in body['data']]
    if not all(isinstance(row['id'], str) and row['id'] for row in rows):
        raise ValueError('a model without an id')
    if provider == 'openai':
        rows = [row for row in rows if not _NOT_A_CHAT_MODEL.search(row['id'])]
    # A gateway may give no date at all, and then its own order stands: the
    # sort is stable.
    if len({type(row['at']) for row in rows}) == 1:
        rows.sort(key=lambda row: row['at'], reverse=True)
    return [{'id': row['id'], 'name': str(row['name'])} for row in rows]


def _said(answer: httpx2.Response) -> str:
    """The provider's own message, out of its JSON body when there is one."""
    try:
        body = answer.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        inner = body.get('error', body)
        message = inner.get('message') if isinstance(inner, dict) else inner
        if isinstance(message, str) and message:
            return message[:_SAID_MAX]
    text = ' '.join(answer.text.split())[:_SAID_MAX]
    return text or f'HTTP {answer.status_code}'


def _where(url: str) -> str:
    """The URL without its query: what the user typed, or the provider's own."""
    return url.split('?', 1)[0]


def _refused(label: str, said: str, reason: str, key: Optional[str]) -> ProviderRefused:
    """The failure, masked, logged once, ready to raise."""
    message = agent.masked(f'{label}: {said}', key)
    logger.warning(f"agent test failed: {message}")
    return ProviderRefused(message, reason)
