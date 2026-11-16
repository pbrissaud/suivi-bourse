"""The agent's acceptance scenarios against real providers (#1118).

Marked ``eval``: off the pull request gate, run by hand or by
``.github/workflows/agent-evals.yml`` before a release. A provider runs when
its variables are set and is skipped, naming the first one missing, when not::

    AGENT_EVAL_ANTHROPIC_KEY, AGENT_EVAL_ANTHROPIC_MODEL
    AGENT_EVAL_OPENAI_BASE_URL, AGENT_EVAL_OPENAI_MODEL  (+ AGENT_EVAL_OPENAI_KEY,
                                                          if the gateway takes one)
    AGENT_EVAL_OLLAMA_BASE_URL, AGENT_EVAL_OLLAMA_MODEL

    uv run pytest tests/evals -m eval -v -rs
"""
import asyncio
import os

import pytest

from application import agent
import eval_scenarios as scenarios

pytestmark = pytest.mark.eval

#: kind -> (required variables, as ``config`` names them), optional ones.
PROVIDERS = {
    'anthropic': ({'api_key': 'AGENT_EVAL_ANTHROPIC_KEY',
                   'model': 'AGENT_EVAL_ANTHROPIC_MODEL'}, {}),
    'openai_compatible': ({'base_url': 'AGENT_EVAL_OPENAI_BASE_URL',
                           'model': 'AGENT_EVAL_OPENAI_MODEL'},
                          {'api_key': 'AGENT_EVAL_OPENAI_KEY'}),
    'ollama': ({'base_url': 'AGENT_EVAL_OLLAMA_BASE_URL',
                'model': 'AGENT_EVAL_OLLAMA_MODEL'}, {}),
}


@pytest.fixture(params=list(PROVIDERS))
def model(request):
    """The real model of one provider, or a skip naming what is missing."""
    required, optional = PROVIDERS[request.param]
    missing = [name for name in required.values() if not os.environ.get(name)]
    if missing:
        pytest.skip(f'{request.param}: {missing[0]} is not set')
    fields = {field: os.environ.get(name) or None
              for field, name in {**required, **optional}.items()}
    return agent.build_model(scenarios.config(request.param, **fields))


def test_arbitrage_states_only_figures_a_tool_gave(model, tmp_path):
    answer, outputs = asyncio.run(scenarios.ask(
        model, scenarios.portfolio(tmp_path), scenarios.ARBITRAGE))

    assert outputs, f'no tool was called: {answer}'
    assert scenarios.figures(answer), f'no figure in: {answer}'
    assert scenarios.unmatched(answer, outputs, scenarios.ARBITRAGE) == [], answer


def test_advice_asked_for_gets_no_imperative(model, tmp_path):
    answer, _ = asyncio.run(scenarios.ask(
        model, scenarios.portfolio(tmp_path), scenarios.ADVICE))

    assert answer.strip(), 'empty answer'
    assert scenarios.imperatives(answer) == [], answer


def test_a_statement_proposes_its_events(model, tmp_path):
    runtime = scenarios.ledger_for_statement(tmp_path)

    assert asyncio.run(scenarios.read_statement(model, runtime)) == \
        scenarios.PROPOSED
