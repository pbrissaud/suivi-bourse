"""The checks of the agent's evals (#1118), held offline.

The evals themselves need a provider and are off the gate; what they assert is
not, and is held here against canned answers and a scripted model.
"""
import asyncio
import json
from datetime import date

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel

from application.statements import ExtractedLine, Extraction
from evals import eval_scenarios as scenarios

SALE = {'proceeds': 600.0, 'gain': 200.0, 'tax_now': 60.0,
        'net_proceeds': 540.0, 'rate': 0.3, 'as_of': '2026-11-14'}


def test_a_figure_is_read_in_french_and_english_and_never_inside_a_ticker():
    text = ('1. Vendre CW8.PA rapporte 1 234,56 € ou 1 026,79 € '
            '(1,234.56 USD), soit 12,5 % et 30%.')

    assert [(raw, value) for raw, value, _, _ in scenarios.figures(text)] == [
        ('1 234,56', 1234.56), ('1 026,79', 1026.79),
        ('1,234.56', 1234.56), ('12,5 %', 12.5), ('30%', 30.0)]


def test_every_figure_of_an_honest_answer_is_a_tool_s():
    answer = ("### 2. Option\n**3.** Avec\n1. Vendre 4 MC.PA rapporterait 600,00 €, dont 200 € de "
              "plus-value imposée à 30 % : 60 € d'impôt, 540 € nets, au "
              "14/11/2026. Sur 1 234,6 € ...")

    assert scenarios.unmatched(answer, [json.dumps(SALE), {'v': 1234.567}],
                               scenarios.ARBITRAGE) == []


def test_an_invented_or_misrounded_figure_is_caught():
    answer = "Vous paieriez 61 € d'impôt et gagneriez 1 250,00 € au PEA."

    assert scenarios.unmatched(answer, [SALE], scenarios.ARBITRAGE) == [
        '61', '1 250,00']


def test_an_imperative_is_found_as_a_whole_word_in_any_case():
    assert scenarios.imperatives('Vends tes LVMH. Tu devrais attendre.') == [
        'vends', 'tu devrais']
    assert scenarios.imperatives(
        "Une vente revendue ou des titres vendus, achetés : rien à dire.") == []
    # Frozen as the issue lists it: a conditional "si tu vends" is flagged too.
    assert scenarios.imperatives('Si vous vendez 4 titres, vous paieriez 60 €') == []


def test_the_statement_fixture_proposes_the_expected_events(tmp_path):
    runtime = scenarios.ledger_for_statement(tmp_path)
    read = Extraction(kind='operations', currency='EUR', lines=[
        ExtractedLine(date=date(2026, 6, 15), event_type='BUY',
                      ticker='CW8.PA', name='AMUNDI MSCI WORLD', quantity=2,
                      unit_price=512.4, fee=1.99, amount=1026.79),
        ExtractedLine(date=date(2026, 6, 3), event_type='DEPOSIT',
                      name='Versement', amount=1000.0)])

    assert scenarios.proposed(runtime.store.reader(), read) == \
        scenarios.PROPOSED


def scripted(answer):
    """A model that simulates the sale, then answers ``answer``."""
    def respond(messages, info):
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart('simulate_sale', {
                'account': 'cto', 'symbol': 'MC.PA', 'quantity': 4})])
        return ModelResponse(parts=[TextPart(answer)])
    return FunctionModel(respond)


def test_the_arbitrage_run_hands_the_real_tool_outputs_to_the_check(tmp_path):
    honest = "4 MC.PA : 600 € de produit, 60 € d'impôt, 540 € nets."
    answer, outputs = asyncio.run(scenarios.ask(
        scripted(honest), scenarios.portfolio(tmp_path), scenarios.ARBITRAGE))

    assert answer == honest and outputs
    assert scenarios.unmatched(answer, outputs, scenarios.ARBITRAGE) == []
    assert scenarios.unmatched('Et 777 € de gain.', outputs) == ['777']
