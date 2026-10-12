"""The analyst's conversations on disk (#1114)."""
import os

import pytest
from pydantic_ai.messages import (
    ModelRequest, ModelResponse, TextPart, UserPromptPart,
)

from application import agent_threads


def asked(text):
    return ModelRequest(parts=[UserPromptPart(content=text)])


def answer(text):
    return ModelResponse(parts=[TextPart(content=text)])


def thread(thread_id, history, title='t'):
    return agent_threads.saved(None, thread_id, title, history, 'anthropic', 'm')


def test_a_thread_reads_back_as_written(tmp_path):
    agent_threads.write(tmp_path, thread('k1', [asked('Q'), answer('A')]))

    stored = agent_threads.read(tmp_path, 'k1')

    assert stored['version'] == 1 and stored['title'] == 't'
    assert [type(m) for m in agent_threads.messages(stored)] == \
        [ModelRequest, ModelResponse]
    assert agent_threads.read(tmp_path, 'absent') is None


def test_an_interrupted_write_leaves_the_old_file_whole(tmp_path, monkeypatch):
    agent_threads.write(tmp_path, thread('k1', [asked('old')]))

    def interrupted(source, target):
        raise KeyboardInterrupt
    monkeypatch.setattr(os, 'replace', interrupted)
    with pytest.raises(KeyboardInterrupt):
        agent_threads.write(tmp_path, thread('k1', [asked('new')]))

    kept = agent_threads.messages(agent_threads.read(tmp_path, 'k1'))
    assert kept[0].parts[0].content == 'old'
    assert sorted(os.listdir(tmp_path)) == ['k1.json']


def test_a_read_only_directory_raises_an_os_error(tmp_path):
    tmp_path.chmod(0o500)
    try:
        with pytest.raises(OSError):
            agent_threads.write(tmp_path, thread('k1', [asked('Q')]))
    finally:
        tmp_path.chmod(0o700)


def test_unanswered_requests_are_dropped_from_the_history():
    history = [asked('Q'), answer('A'), asked('B')]

    assert agent_threads.answered(history) == history[:2]
    assert agent_threads.answered(history[:2]) == history[:2]


def test_the_listing_is_most_recent_first(tmp_path):
    first = thread('old', [asked('Q')])
    first['updated_at'] = '2026-01-01T00:00:00Z'
    agent_threads.write(tmp_path, first)
    agent_threads.write(tmp_path, thread('new', [asked('Q')]))

    assert [t['id'] for t in agent_threads.listing(tmp_path)] == ['new', 'old']
    assert agent_threads.listing(tmp_path / 'none') == []


@pytest.mark.parametrize('thread_id', ['a/b', '..', 'x' * 65, '', None, 'a.b'])
def test_an_id_that_could_leave_the_directory_is_not_one(thread_id):
    assert not agent_threads.valid_id(thread_id)


def test_a_title_is_the_first_eighty_characters_on_one_line():
    assert agent_threads.title_of('a\n b  ' + 'c' * 100) == ('a b ' + 'c' * 76)
