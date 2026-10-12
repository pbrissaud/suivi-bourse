"""The analyst's routes, async on the event loop beside ``/mcp`` (#1114).

``POST /agent`` streams one turn in the Vercel AI SDK's UI protocol;
``GET /agent/threads[/<id>]`` reads the conversations back. Not Flask: a turn
waits on a provider for seconds, and a WSGI worker held that long is one of
four (``boot.WSGI_THREADS``). Nothing here blocks the loop: the config read and
the thread files go through ``anyio.to_thread``, and the MCP SDK runs the tools'
store reads in worker threads of its own.
"""
import json
from dataclasses import dataclass
from typing import Optional

import anyio
from logfmt_logger import getLogger
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from application import agent
from application import agent_threads
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import ErrorChunk

logger = getLogger("agent")

#: The Vercel AI SDK major the stream speaks. #1117 installs the matching
#: ``ai@6`` in the front: changing one means changing the other.
AI_SDK_VERSION = 6

OFF = 'The agent is off.'
BUSY = 'A turn is already running in this conversation.'
NOT_SAVED = 'The conversation could not be saved: {}'
UNREADABLE = 'This conversation cannot be read: {}'

#: A turn is one typed question; nothing a person types comes near this.
MAX_BODY = 256 * 1024


@dataclass
class _EventStream(VercelAIEventStream):
    """The stock stream, with a provider failure told in the provider's words."""

    provider_label: str = ''
    secret: Optional[str] = None

    async def on_error(self, error: Exception):
        """``Anthropic: invalid x-api-key``, the key masked as ``…last4``.

        Only a provider's failure is put in the provider's mouth; anything
        else (a bug of ours, a usage limit) is said as the analyst's.
        """
        said = masked(_said(error), self.secret)
        speaker = (self.provider_label if isinstance(error, ModelAPIError)
                   else 'The analyst')
        logger.warning(f"agent turn failed: {speaker}: {said}")
        async for chunk in super().on_error(error):
            if isinstance(chunk, ErrorChunk):
                chunk = ErrorChunk(error_text=f'{speaker}: {said}')
            yield chunk


@dataclass
class _Adapter(VercelAIAdapter):
    """The stock adapter, building :class:`_EventStream`."""

    provider_label: str = ''
    secret: Optional[str] = None

    def build_event_stream(self):
        """The stream that says which provider failed, and never the key."""
        return _EventStream(
            self.run_input, accept=self.accept, sdk_version=self.sdk_version,
            server_message_id=self.server_message_id,
            provider_label=self.provider_label, secret=self.secret)


def _said(error: Exception) -> str:
    """The provider's own message, out of the HTTP body when there is one."""
    body = error.body if isinstance(error, ModelHTTPError) else None
    if isinstance(body, dict):
        inner = body.get('error', body)
        message = inner.get('message') if isinstance(inner, dict) else inner
        if message:
            return str(message)
    return str(error)


def masked(text: str, secret: Optional[str]) -> str:
    """``text`` with every occurrence of ``secret`` replaced by ``…last4``."""
    return text.replace(secret, '…' + secret[-4:]) if secret else text


def _error(status: int, message: str) -> JSONResponse:
    """The one shape every refusal here takes."""
    return JSONResponse({'error': message}, status_code=status)


def build_app(runtime, mcp) -> Starlette:
    """The analyst's Starlette app, over ``runtime``'s store and ``mcp``'s tools."""
    #: The threads with a turn in flight. One process, one loop: a set checked
    #: and filled between two awaits is as good as a lock per thread.
    running = set()

    def root():
        """The threads' directory, beside the store this process opened."""
        return agent_threads.directory(runtime.store.path)

    def config():
        """The row, read on a worker thread's own cursor."""
        return agent.read(runtime.store.reader())

    async def turn(request):
        """One turn: the user's last message, the thread's history, a stream."""
        settings = await anyio.to_thread.run_sync(config)
        if not settings['enabled']:
            return _error(404, OFF)
        if request.headers.get('content-type', '').split(';')[0].strip() \
                != 'application/json':
            return _error(415, 'A turn is a JSON body.')
        body = bytearray()
        async for piece in request.stream():
            body.extend(piece)
            if len(body) > MAX_BODY:
                return _error(413, f'A turn is at most {MAX_BODY} bytes.')
        body = bytes(body)
        try:
            raw = json.loads(body)
        except ValueError:
            return _error(400, 'A turn is a JSON object.')
        if not isinstance(raw, dict):
            return _error(400, 'A turn is a JSON object.')
        thread_id = raw.get('id')
        if not agent_threads.valid_id(thread_id):
            return _error(400, "'id' is 1 to 64 letters, digits, '_' or '-'.")
        try:
            page = agent.page_line(raw.get('page'))
            run_input = VercelAIAdapter.build_run_input(body)
        except (ValueError, ValidationError) as exc:
            return _error(400, str(exc))
        # Regenerating an answer would need the thread rewound first; until
        # the panel asks for it, a turn is a new question and nothing else.
        if run_input.trigger != 'submit-message':
            return _error(400, "A turn is a 'submit-message'.")
        asked = [m for m in run_input.messages if m.role == 'user']
        if not asked:
            return _error(400, 'A turn carries a user message.')
        if not all(part.type == 'text' for part in asked[-1].parts):
            return _error(400, 'A question is text, and text only.')
        # Only the user's last message: the history is the file's, so a client
        # cannot put words, or tool results, in the analyst's mouth.
        run_input.messages = [asked[-1]]

        if thread_id in running:
            return _error(409, BUSY)
        running.add(thread_id)
        try:
            return await _start(request, settings, thread_id, page, run_input)
        except BaseException:
            running.discard(thread_id)
            raise

    async def _start(request, settings, thread_id, page, run_input):
        """Keep the question, then hand the turn to the adapter."""
        directory = root()
        # Off the loop: the first build imports a provider SDK (half a second),
        # and the history is validated whole.
        analyst = await anyio.to_thread.run_sync(
            lambda: agent.build_agent(agent.build_model(settings), mcp))
        adapter = _Adapter(
            agent=analyst,
            run_input=run_input, accept=request.headers.get('accept'),
            sdk_version=AI_SDK_VERSION,
            provider_label=agent.PROVIDERS[settings['provider']],
            secret=settings['api_key'])

        def stored_history():
            """The file, and its history without a question left unanswered."""
            stored = agent_threads.read(directory, thread_id)
            return stored, agent_threads.answered(
                agent_threads.messages(stored))

        try:
            stored, history = await anyio.to_thread.run_sync(stored_history)
        except ValueError as exc:
            # A hand edit, or messages an upgraded Pydantic AI no longer reads:
            # said, and nothing written over the file.
            logger.error(f"agent thread {directory / thread_id}.json: {exc}")
            running.discard(thread_id)
            return _error(409, UNREADABLE.format(exc))
        title = agent_threads.title_of(' '.join(
            getattr(part, 'text', '') for part in run_input.messages[0].parts))

        def save(messages, thread):
            """The thread holding ``messages``, written whole."""
            kept = agent_threads.saved(
                thread, thread_id, title, messages,
                settings['provider'], settings['model'])
            agent_threads.write(directory, kept)
            return kept

        # Before the provider is called: a failed turn leaves the question.
        try:
            first = await anyio.to_thread.run_sync(
                save, history + adapter.messages, stored)
        except OSError as exc:
            message = NOT_SAVED.format(_reason(exc))
            logger.error(f"agent thread {directory / thread_id}.json: {exc}")
            running.discard(thread_id)
            return _error(500, message)

        async def on_complete(result):
            """Rewrite the thread with the whole run, or say it was not kept."""
            try:
                await anyio.to_thread.run_sync(
                    save, result.all_messages(), first)
            except OSError as exc:
                logger.error(
                    f"agent thread {directory / thread_id}.json: {exc}")
                yield ErrorChunk(error_text=NOT_SAVED.format(_reason(exc)))

        async def released():
            """The stream, giving the thread back however it ends."""
            try:
                async for chunk in adapter.run_stream(
                        message_history=history, instructions=page,
                        on_complete=on_complete):
                    yield chunk
            finally:
                running.discard(thread_id)

        return adapter.streaming_response(released())

    async def threads(request):
        """Every conversation, the most recent first."""
        settings = await anyio.to_thread.run_sync(config)
        if not settings['enabled']:
            return _error(404, OFF)
        return JSONResponse(
            await anyio.to_thread.run_sync(agent_threads.listing, root()))

    async def thread(request):
        """One conversation, as the front's ``useChat`` holds messages."""
        settings = await anyio.to_thread.run_sync(config)
        if not settings['enabled']:
            return _error(404, OFF)
        thread_id = request.path_params['thread_id']
        if not agent_threads.valid_id(thread_id):
            return _error(400, "'id' is 1 to 64 letters, digits, '_' or '-'.")

        def shown():
            """The thread as UI messages, or ``None``. Off the loop."""
            stored = agent_threads.read(root(), thread_id)
            if stored is None:
                return None
            messages = VercelAIAdapter.dump_messages(
                agent_threads.messages(stored), sdk_version=AI_SDK_VERSION)
            return {'id': thread_id, 'title': stored.get('title'),
                    'messages': [m.model_dump(mode='json', by_alias=True,
                                              exclude_none=True)
                                 for m in messages]}
        try:
            answer = await anyio.to_thread.run_sync(shown)
        except ValueError as exc:
            logger.error(f"agent thread {root() / thread_id}.json: {exc}")
            return _error(409, UNREADABLE.format(exc))
        if answer is None:
            return _error(404, 'No conversation has this id.')
        return JSONResponse(answer)

    return Starlette(routes=[
        Route('/agent', turn, methods=['POST']),
        Route('/agent/threads', threads, methods=['GET']),
        # `:path` so an id holding a '/' reaches the check and is refused by
        # name, rather than matching no route at all.
        Route('/agent/threads/{thread_id:path}', thread, methods=['GET']),
    ])


def _reason(exc: OSError) -> str:
    """The OS's own words for a failed write."""
    return exc.strerror or str(exc)
