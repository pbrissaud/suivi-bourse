"""The agent's routes, async on the event loop beside ``/mcp`` (#1114).

``POST /api/agent/chat`` streams one turn in the Vercel AI SDK's UI protocol;
``GET /api/agent/threads[/<id>]`` reads the conversations back, and
``DELETE /api/agent/threads/<id>`` forgets one (*Supprimer ce fil*, #1117).
Under ``/api`` since #1196, so ``/agent`` is the front's page; ``boot`` sends
these two prefixes here and nothing else of ``/api/agent``. Not Flask: a turn
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
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from application import agent
from application import agent_threads
from pydantic_ai import capture_run_messages
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.ui.vercel_ai import VercelAIAdapter, VercelAIEventStream
from pydantic_ai.ui.vercel_ai.response_types import ErrorChunk

logger = getLogger("agent")

#: The Vercel AI SDK major the stream speaks. The front (#1117) installs the
#: matching ``ai@7``: changing one means changing the other. Pydantic AI writes
#: v7 as the same wire as v6, so the move from 6 changed no chunk.
AI_SDK_VERSION = 7

OFF = 'The agent is off.'
BUSY = 'A turn is already running in this conversation.'
NOT_SAVED = 'The conversation could not be saved: {}'
UNREADABLE = 'This conversation cannot be read: {}'
NOT_REMOVED = 'The conversation could not be deleted: {}'

#: A turn is one typed question; nothing a person types comes near this.
MAX_BODY = 256 * 1024


@dataclass
class _EventStream(VercelAIEventStream):
    """The stock stream, with a provider failure told in the provider's words."""

    provider_label: str = ''
    secret: Optional[str] = None

    async def on_error(self, error: Exception):
        """``Anthropic: invalid x-api-key``, the key masked as ``…last4``.

        Only a provider's failure is put in the provider's mouth, and carries
        the ``reason`` the page translates (#1269); anything else (a bug of
        ours, a usage limit) is said as the agent's, as plain text.
        """
        http = error if isinstance(error, ModelHTTPError) else None
        said = agent.said(http.body if http else None, str(error), self.secret)
        provider = isinstance(error, ModelAPIError)
        speaker = self.provider_label if provider else 'The agent'
        logger.warning(f"agent turn failed: {speaker}: {said}")
        text = f'{speaker}: {said}'
        if provider:
            text = json.dumps({
                'error': text, 'provider': speaker,
                'reason': agent.refusal(
                    http.status_code if http else None,
                    http.body if http else None, 'turn')})
        async for chunk in super().on_error(error):
            if isinstance(chunk, ErrorChunk):
                chunk = ErrorChunk(error_text=text)
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


def _error(status: int, message: str) -> JSONResponse:
    """The one shape every refusal here takes."""
    return JSONResponse({'error': message}, status_code=status)


def build_app(runtime, mcp) -> Starlette:
    """The agent's Starlette app, over ``runtime``'s store and ``mcp``'s tools."""
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
            run_input = VercelAIAdapter.build_run_input(body)
        except (ValueError, ValidationError) as exc:
            return _error(400, str(exc))
        # Regenerating an answer would need the thread rewound first; until
        # the page asks for it, a turn is a new question and nothing else.
        if run_input.trigger != 'submit-message':
            return _error(400, "A turn is a 'submit-message'.")
        asked = [m for m in run_input.messages if m.role == 'user']
        if not asked:
            return _error(400, 'A turn carries a user message.')
        if not all(part.type == 'text' for part in asked[-1].parts):
            return _error(400, 'A question is text, and text only.')
        # Only the user's last message: the history is the file's, so a client
        # cannot put words, or tool results, in the agent's mouth.
        run_input.messages = [asked[-1]]

        if thread_id in running:
            return _error(409, BUSY)
        running.add(thread_id)
        try:
            return await _start(request, settings, thread_id, run_input)
        except BaseException:
            running.discard(thread_id)
            raise

    async def _start(request, settings, thread_id, run_input):
        """Keep the question, then hand the turn to the adapter."""
        directory = root()
        # Off the loop: the first build imports a provider SDK (half a second),
        # and the history is validated whole.
        assistant = await anyio.to_thread.run_sync(
            lambda: agent.build_agent(
                agent.build_model(settings), mcp, thinking=settings['thinking']))
        adapter = _Adapter(
            agent=assistant,
            run_input=run_input, accept=request.headers.get('accept'),
            sdk_version=AI_SDK_VERSION,
            provider_label=agent.PROVIDERS[settings['provider']],
            secret=settings['api_key'])

        def stored_history():
            """The file, and its history without a turn that has no answer."""
            stored = agent_threads.read(directory, thread_id)
            return stored, agent_threads.answered(
                agent_threads.messages(stored),
                bool((stored or {}).get('failed')))

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

        def save(messages, thread, failed=False):
            """The thread holding ``messages``, written whole."""
            kept = agent_threads.saved(
                thread, thread_id, title, messages,
                settings['provider'], settings['model'], failed)
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

        #: The run was written by ``on_complete``, saved or not: ``released``
        #: writes what a run that ended otherwise held, and only then.
        kept = False

        async def on_complete(result):
            """Rewrite the thread with the whole run, or say it was not kept."""
            nonlocal kept
            kept = True  # before the await: a save that fails here is not retried
            # The counts alone: what the cache saved, never the key or a word.
            usage = result.usage
            logger.info(
                f"agent turn: {settings['provider']} {settings['model']} "
                f"thinking={settings['thinking']} input={usage.input_tokens} output={usage.output_tokens} "
                f"cache_read={usage.cache_read_tokens} "
                f"cache_write={usage.cache_write_tokens}")
            try:
                await anyio.to_thread.run_sync(
                    save, result.all_messages(), first)
            except OSError as exc:
                logger.error(
                    f"agent thread {directory / thread_id}.json: {exc}")
                yield ErrorChunk(error_text=NOT_SAVED.format(_reason(exc)))

        async def keep_partial(captured, failed):
            """A turn that did not complete: what it held, as far as it got.

            A stop (the client left: the cancellation reaches the stream
            wherever it waits) and a provider error end here with the partial
            answer and the tool calls that returned, which Pydantic AI holds
            in ``captured``. Shielded, or the cancellation that brought us here
            cancels the write too.
            """
            if len(captured) <= len(history):  # not even the question: it is kept
                return
            try:
                with anyio.CancelScope(shield=True):
                    await anyio.to_thread.run_sync(
                        save, agent_threads.closed(captured), first, failed)
            except OSError as exc:
                logger.error(
                    f"agent thread {directory / thread_id}.json: {exc}")

        async def released():
            """The stream, giving the thread back however it ends."""
            failed = False
            try:
                with capture_run_messages() as captured:
                    try:
                        async for chunk in adapter.run_stream(
                                message_history=history,
                                on_complete=on_complete):
                            failed = failed or (
                                not kept and isinstance(chunk, ErrorChunk))
                            yield chunk
                    finally:
                        if not kept:
                            await keep_partial(captured, failed)
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
                    'failed': bool(stored.get('failed')),
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

    async def forget(request):
        """Delete one conversation's file; a turn in flight keeps it."""
        settings = await anyio.to_thread.run_sync(config)
        if not settings['enabled']:
            return _error(404, OFF)
        thread_id = request.path_params['thread_id']
        if not agent_threads.valid_id(thread_id):
            return _error(400, "'id' is 1 to 64 letters, digits, '_' or '-'.")
        # The turn would write the file back on completion: refused rather
        # than deleted under it. And held while the file goes, so a turn that
        # starts meanwhile is refused too rather than writing back what it read.
        if thread_id in running:
            return _error(409, BUSY)
        running.add(thread_id)
        try:
            removed = await anyio.to_thread.run_sync(
                agent_threads.remove, root(), thread_id)
        except OSError as exc:
            logger.error(f"agent thread {root() / thread_id}.json: {exc}")
            return _error(500, NOT_REMOVED.format(_reason(exc)))
        finally:
            running.discard(thread_id)
        if not removed:
            return _error(404, 'No conversation has this id.')
        return Response(status_code=204)

    return Starlette(routes=[
        Route('/api/agent/chat', turn, methods=['POST']),
        Route('/api/agent/threads', threads, methods=['GET']),
        # `:path` so an id holding a '/' reaches the check and is refused by
        # name, rather than matching no route at all.
        Route('/api/agent/threads/{thread_id:path}', thread, methods=['GET']),
        Route('/api/agent/threads/{thread_id:path}', forget, methods=['DELETE']),
    ])


def _reason(exc: OSError) -> str:
    """The OS's own words for a failed write."""
    return exc.strerror or str(exc)
