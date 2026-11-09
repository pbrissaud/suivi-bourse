"""What the agent's model responses cost in tokens, indexed from the threads.

The thread files stay the truth: every response of ``ModelResponse`` already
carries Pydantic AI's usage in its JSON. ``agent_usage`` is the index that lets
``GET /api/agent/stats`` add them up without opening every file: a thread's rows
are **replaced** from its messages each time it is saved (:func:`record`),
dropped with the thread (:func:`forget`), and filled once for the threads that
existed before by a schema step (:func:`backfill`). No price is kept: a token
count is a fact of the response, a price is a table that changes.

Pydantic AI's ``input_tokens`` already holds the cached tokens, so what the
provider read from its cache is ``cache_read_tokens`` and the rest of the input
is new (:func:`stats`).
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from logfmt_logger import getLogger

from application import agent_threads
from pydantic_ai.messages import ModelResponse, ToolCallPart

logger = getLogger("agent")

_INSERT = ('INSERT INTO agent_usage (thread_id, seq, responded_at, model, provider, '
           'input_tokens, output_tokens, cache_read_tokens, '
           'cache_write_tokens, requests, tool_calls) '
           'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')

#: How many threads the per-thread table lists, the most expensive first.
THREADS_LISTED = 10

RANGES = ('1M', 'YTD', '1Y', 'MAX')


def rows(thread_id: str, history: list) -> list:
    """One row per response a model gave. The app's own (``propose_events``
    made by the statement route) names no model and counts for nothing."""
    found = []
    for seq, message in enumerate(history):
        if not isinstance(message, ModelResponse) or not message.model_name:
            continue
        usage = message.usage
        found.append((
            thread_id, seq, message.timestamp, message.model_name,
            message.provider_name, usage.input_tokens, usage.output_tokens,
            usage.cache_read_tokens, usage.cache_write_tokens, 1,
            sum(isinstance(part, ToolCallPart) for part in message.parts)))
    return found


def record(store, thread_id: str, history: list) -> None:
    """Replace the thread's rows by those of ``history``. Under the write lock."""
    store.execute('DELETE FROM agent_usage WHERE thread_id = ?', [thread_id])
    found = rows(thread_id, history)
    if found:
        store.executemany(_INSERT, found)


def forget(store, thread_id: str) -> None:
    """Drop the thread's rows with the thread. Under the write lock."""
    store.execute('DELETE FROM agent_usage WHERE thread_id = ?', [thread_id])


def backfill(connection) -> None:
    """Index the threads that were saved before the table existed.

    A schema step: ``connection`` is the store's own, in the step's
    transaction. The threads are found beside the store file; an in-memory
    store has none. A thread the version cannot read is skipped, said.
    """
    path = connection.execute(
        'SELECT path FROM duckdb_databases() WHERE database_name = current_database()'
    ).fetchone()[0]
    if not path:
        return
    root = agent_threads.directory(path)
    if not root.is_dir():
        return
    for file in sorted(root.glob('*.json')):
        try:
            thread = agent_threads.read(root, file.stem)
            found = rows(file.stem, agent_threads.messages(thread))
        except (OSError, ValueError) as exc:
            logger.warning(f"agent usage: {file} not indexed: {exc}")
            continue
        connection.execute(
            'DELETE FROM agent_usage WHERE thread_id = ?', [file.stem])
        if found:
            connection.executemany(_INSERT, found)


def since(range_: str, today: datetime) -> Optional[datetime]:
    """The instant a range starts at, ``None`` for all of it."""
    if range_ == '1M':
        return today - timedelta(days=30)
    if range_ == '1Y':
        return today - timedelta(days=365)
    if range_ == 'YTD':
        return datetime(today.year, 1, 1, tzinfo=timezone.utc)
    return None


def _monday(day):
    return day - timedelta(days=day.weekday())


def stats(reader, root: Path, start: Optional[datetime], today: datetime) -> dict:
    """The totals from ``start``, how the input splits, the weeks, the models
    and the threads that used the most.

    ``fresh`` is the input the provider did not read from its cache (what was
    written to the cache counts as fresh, it was paid for as input).
    """
    where, args = ('WHERE responded_at >= ?', [start]) if start else ('', [])
    [(threads, requests, tool_calls, inputs, outputs, cached)] = reader.query(
        'SELECT count(DISTINCT thread_id), coalesce(sum(requests), 0), '
        'coalesce(sum(tool_calls), 0), coalesce(sum(input_tokens), 0), '
        'coalesce(sum(output_tokens), 0), coalesce(sum(cache_read_tokens), 0) '
        f'FROM agent_usage {where}', args)

    # The week of the response in UTC, Monday first: explicit, so it does not
    # depend on the connection's time zone.
    by_week = {
        week: (cache, inputs_ - cache, out) for week, cache, inputs_, out in
        reader.query(
            "SELECT CAST(date_trunc('week', responded_at AT TIME ZONE 'UTC') AS DATE), "
            'sum(cache_read_tokens), sum(input_tokens), sum(output_tokens) '
            f'FROM agent_usage {where} GROUP BY 1', args)}
    first = _monday(start.date()) if start else min(by_week, default=None)
    weeks = []
    if first is not None:
        week = first
        while week <= _monday(today.date()):
            cache, fresh, out = by_week.get(week, (0, 0, 0))
            weeks.append({'week': week.isoformat(), 'cache_read': int(cache),
                          'fresh': int(fresh), 'output': int(out)})
            week += timedelta(days=7)

    models = [
        {'model': model, 'provider': provider, 'requests': int(n),
         'tokens': int(i + o), 'cache_read': int(c),
         'cache_ratio': c / i if i else None}
        for model, provider, n, i, o, c in reader.query(
            'SELECT model, any_value(provider), sum(requests), '
            'sum(input_tokens), sum(output_tokens), sum(cache_read_tokens) '
            f'FROM agent_usage {where} GROUP BY model '
            'ORDER BY sum(input_tokens + output_tokens) DESC, model', args)]

    listed = []
    for thread_id, n, i, o, at in reader.query(
            'SELECT thread_id, sum(requests), sum(input_tokens), '
            'sum(output_tokens), max(responded_at) '
            f'FROM agent_usage {where} GROUP BY thread_id '
            'ORDER BY sum(input_tokens + output_tokens) DESC, thread_id '
            f'LIMIT {THREADS_LISTED}', args):
        try:
            title = (agent_threads.read(root, thread_id) or {}).get('title')
        except (OSError, ValueError):
            title = None
        listed.append({'id': thread_id, 'title': title, 'last_at': at.isoformat(),
                       'requests': int(n), 'tokens': int(i + o)})

    return {
        'since': start.date().isoformat() if start else None,
        'totals': {
            'tokens': int(inputs + outputs), 'input': int(inputs),
            'output': int(outputs), 'cache_read': int(cached),
            'fresh': int(inputs - cached), 'threads': threads,
            'requests': int(requests), 'tool_calls': int(tool_calls)},
        'weeks': weeks, 'models': models, 'threads': listed,
    }
