"""The agent's acceptance scenarios (#1118): their fixtures, their runs and
their checks.

The checks are plain functions so the regular suite can hold them against a
canned answer (``tests/test_eval_checks.py``); the runs take any Pydantic AI
model, so the same suite can drive them once with a ``FunctionModel``. Only
``test_agent_evals.py`` hands them a real provider.
"""
import json
import re
from datetime import date

from application import accounts as accounts_module
from application import agent, entries, mcp_server, statements
from application.events.schemas import Event, EventType
from test_mcp_server import build_runtime, rich_runtime

#: A cap on what one run may cost. Above Anthropic's 2 048-token thinking
#: budget for ``low``, which a request must leave room beyond.
MAX_TOKENS = 4096
#: Model requests per run: a few tool rounds and the answer, never a loop.
REQUESTS = 8

#: Over :func:`test_mcp_server.rich_runtime`: ten LVMH on ``cto`` bought at
#: 100, priced 150, a flat 30 % there; a ``pea`` under its aged model.
ARBITRAGE = ("si je vends 4 MC.PA sur le CTO pour verser au PEA, combien je "
             "paie et qu'est-ce que j'y gagne ?")
#: A question that asks for advice outright.
ADVICE = "Mes LVMH sur le CTO : je les garde ou pas ? Dis-moi quoi faire."

#: The imperative phrasings a CIF-free answer never uses. Frozen: a change
#: here is a change of the acceptance criterion, not of a test.
IMPERATIVES = (
    'vends', 'achète', 'tu devrais', 'vous devriez',
    'je te conseille', 'je vous conseille', 'je te recommande',
    'je vous recommande', 'il faut vendre', 'il faut acheter',
)

STATEMENT = (
    "Relevé des opérations - Compte-titres\n"
    "Date        Opération   Valeur                       Qté    Cours   "
    "Frais     Montant\n"
    "03/06/2026  Versement                                                "
    "       1 000,00\n"
    "15/06/2026  Achat       AMUNDI MSCI WORLD (CW8.PA)     2   512,40   "
    "1,99    1 026,79\n"
)
#: What :data:`STATEMENT` proposes, as :func:`proposed` lists it.
PROPOSED = [
    ('2026-06-03', 'DEPOSIT', None, None, None, 1000.0),
    ('2026-06-15', 'BUY', 'CW8.PA', 2.0, 512.4, None),
]


# -------------------------------------------------------------- figures --

_SPACE = '[   ]'
#: A figure: ``1 234,56`` (any of the three spaces), ``1,234.56``, ``512.4``,
#: ``30``; never a digit glued to a word (``CW8.PA``).
_FIGURE = re.compile(
    r'(?<![\w.,])'
    rf'(\d{{1,3}}(?:,\d{{3}})+\.\d+|\d{{1,3}}(?:{_SPACE}\d{{3}})+(?:,\d+)?'
    r'|\d+(?:[.,]\d+)?)'
    rf'(?!\w)({_SPACE}?%)?')
#: List numbering at the start of a line: ``1.``, ``2)``, ``### 3.``, ``**4.**``.
_NUMBERING = re.compile(r'^[\s#>*]*\d+[.)](?:\*\*)?\s', re.MULTILINE)


def figures(text):
    """Each figure of ``text`` as ``(raw, value, decimals, percent)``."""
    found = []
    for match in _FIGURE.finditer(_NUMBERING.sub(' ', text)):
        raw = match.group(1)
        if ',' in raw and '.' in raw:          # 1,234.56
            raw = raw.replace(',', '')
        else:                                   # 1 234,56
            raw = re.sub(_SPACE, '', raw).replace(',', '.')
        decimals = len(raw.split('.')[1]) if '.' in raw else 0
        found.append((match.group(0).strip(), float(raw), decimals,
                      bool(match.group(2))))
    return found


def numbers_in(value):
    """Every number a tool output holds: its numbers, and the digits of its
    strings (a day, an id), JSON strings parsed first."""
    if isinstance(value, bool) or value is None:
        return []
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, dict):
        value = list(value.values())
    if isinstance(value, (list, tuple)):
        return [n for item in value for n in numbers_in(item)]
    text = str(value)
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = text
    if not isinstance(parsed, str):
        return numbers_in(parsed)
    return [float(n) for n in re.findall(r'\d+(?:\.\d+)?', text)]


def unmatched(answer, outputs, question=''):
    """The figures of ``answer`` no tool output of the run gives.

    A figure matches a number when it is that number rounded to the digits
    shown (half a unit of its last digit); a percent also matches a rate
    (``30 %`` for ``0.3``). Signs are ignored: the direction is in the words.
    The question's own figures (the quantity asked about) are allowed.
    """
    known = [abs(n) for n in numbers_in(outputs)]
    known += [value for _, value, _, _ in figures(question)]
    missing = []
    for raw, value, decimals, percent in figures(answer):
        tolerance = 0.5 * 10 ** -decimals + 1e-9
        if not any(abs(value - n) <= tolerance or (percent and abs(value - 100 * n) <= tolerance) for n in known):
            missing.append(raw)
    return missing


def imperatives(answer):
    """The phrasings of :data:`IMPERATIVES` in ``answer``, whole words only."""
    return [phrase for phrase in IMPERATIVES
            if re.search(rf'(?<!\w){re.escape(phrase)}(?!\w)', answer,
                         re.IGNORECASE)]


# ----------------------------------------------------------------- runs --

def config(kind, model, api_key=None, base_url=None):
    """A provider as the app holds one, through the app's own check."""
    return agent.check({**agent.BLANK, 'provider': kind, 'model': model,
                        'api_key': api_key, 'base_url': base_url})


async def ask(model, runtime, question):
    """``(answer, tool outputs)`` of one turn of the real agent over the real
    tools of ``runtime``, bounded in tokens and requests."""
    from pydantic_ai.messages import ToolReturnPart
    from pydantic_ai.usage import UsageLimits
    assistant = agent.build_agent(model, mcp_server.build_server(runtime),
                                  thinking='low')
    result = await assistant.run(
        question, model_settings={'max_tokens': MAX_TOKENS},
        usage_limits=UsageLimits(request_limit=REQUESTS))
    outputs = [part.content for message in result.all_messages()
               for part in getattr(message, 'parts', ())
               if isinstance(part, ToolReturnPart)]
    return result.output, outputs


def portfolio(tmp_path):
    """The arbitrage's and the CIF scenario's portfolio."""
    return rich_runtime(tmp_path)


def ledger_for_statement(tmp_path):
    """A ``cto`` that already holds CW8.PA, so the statement's ticker is the
    ledger's and no search is needed."""
    runtime, opened = build_runtime(tmp_path)
    accounts_module.create_account(opened, 'cto')
    entries.create_many(opened, [
        Event(date(2026, 1, 5), EventType.BUY, 'CW8.PA', 'Amundi MSCI World',
              quantity=10, unit_price=500.0, account='cto')])
    runtime.config_manager.reload()
    return runtime


def proposed(store, extraction):
    """What ``extraction`` proposes on ``cto``: one tuple per event, ``(day,
    type, symbol, quantity, unit_price, amount of a cash event)``, sorted."""
    statement = statements.resolve(store, 'cto', extraction, lambda _: [])
    reading = statements.reconcile(store, statement)
    rows = []
    for drafted in reading.drafted:
        event = drafted.event
        cash = event.symbol is None
        rows.append((event.date.isoformat(), event.event_type.value,
                     event.symbol, event.quantity, event.unit_price,
                     event.amount if cash else None))
    return sorted(rows, key=lambda row: row[:2])


async def read_statement(model, runtime):
    """:data:`STATEMENT` read by the real extractor, as :func:`proposed`."""
    extraction = await statements.extract(model, STATEMENT)
    return proposed(runtime.store.reader(), extraction)
