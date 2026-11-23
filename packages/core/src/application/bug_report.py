"""A bug report drafted for a public repository, with no I/O (#1630).

The agent writes a title and a description; the app adds what it knows of the
failure and builds a link to GitHub's prefilled new-issue form, which the owner
reviews and files themself. The repository is public, so the report never
carries the owner's money, and that is enforced here rather than asked of a
model:

- :func:`refusal` says why a text the agent wrote may not go out: it names an
  account, gives an amount of money, or gives a number beside a held security.
  The agent rewrites it; nothing of it is ever cut or changed here.
- :func:`scrub` replaces the same spans with :data:`MASK` in a text nobody
  chose (a job's error, a log line), which is kept for what else it says.
- :func:`draft` composes the body and the link, and drops the oldest log lines
  until the link fits :data:`URL_MAX`.

Like the masker it reads shapes: a figure with no currency and no held
security within a few words of it is a count like any other, and is left
alone. A security is known by its ticker, not by its name.
"""
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import quote, urlencode

from application import build_info
from application.log_masking import MASK

NEW_ISSUE = 'https://github.com/pbrissaud/suivi-bourse/issues/new'
#: The whole link, encoded: under what a browser and GitHub take in a URL.
URL_MAX = 6000
TITLE_MAX = 120
DESCRIPTION_MAX = 1500
#: The job errors a report lists at most; the newest come first.
ERRORS_MAX = 10

#: A report may say a currency; it may not say one beside a number. Read in
#: any case (*12 chf*), so no code here is also a word: the lira's is left to
#: the store, which adds its own reporting currency in capitals.
CODES = ('EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK',
         'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'CNY', 'HKD', 'SGD', 'INR', 'KRW',
         'BRL', 'MXN', 'ZAR', 'ILS', 'AED')
_SIGNS = '€$£¥₹₩₽₣'
_WORDS = r'euros?|dollars?|pounds?|francs?|yens?|cents?|centimes?'

#: A word, or a number with its thousands spaced as a locale writes them
#: (``12 000,50``): one figure is one word.
_TOKEN = re.compile(
    r'\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?(?!\d)|\S+')
_DIGIT = re.compile(r'\d')
#: A day, an hour or a version: a number that is no quantity and no amount.
_DATED = re.compile(r'\d{4}-\d{2}-\d{2}'
                    r'|^\W*(?:\d{1,2}:\d{2}(?::\d{2})?|v?\d+\.\d+\.\d+)\W*$')
#: How many words away a number still reads as the quantity or the price of
#: a security, or as an amount in a currency: *12 shares of Apple (X)*, *X
#: closed at 180.50*, *a value in EUR of about 52 340*. Wide on purpose: a
#: status code beside a ticker is refused or masked with the quantities,
#: because nothing here can tell them apart.
NEAR = 5

Span = Tuple[int, int]


class Refused(ValueError):
    """The report may not be drafted as written; the message says why."""


def _alternation(words: Iterable[str]) -> str:
    """The longest first: a name that starts another must not win over it."""
    return '|'.join(sorted(words, key=len, reverse=True))


def _accounts(text: str, labels: Iterable[Optional[str]]) -> List[Span]:
    """Where ``text`` names an account, whatever the case and whatever
    stands between the label's words (*PEA-Boursorama*, *pea boursorama*).

    The label is read whole: one of its words alone, or its words in another
    order, is not found.
    """
    worded = [[word for word in re.split(r'[\W_]+', label or '') if word]
              for label in labels]
    named = [r'[\W_]*'.join(map(re.escape, words))
             for words in worded if words]
    if not named:
        return []
    pattern = re.compile(rf'(?<!\w)(?:{_alternation(named)})(?!\w)',
                         re.IGNORECASE)
    return [found.span() for found in pattern.finditer(text)]


def _beside(text: str, marker: 're.Pattern[str]') -> List[Span]:
    """The numbers within :data:`NEAR` words of what ``marker`` finds.

    Read word by word, ``marker`` taken out of each first: a ticker holds
    digits of its own (``CW8.PA``), a sign sticks to its figure (``€12``),
    and both stand beside dates (*no history for CW8.PA over 2020-03-02*).
    """
    tokens = list(_TOKEN.finditer(text))
    rest = [marker.sub('', token.group()) for token in tokens]
    named = [at for at, token in enumerate(tokens)
             if rest[at] != token.group()]
    counted = [at for at, left in enumerate(rest)
               if _DIGIT.search(left) and not _DATED.search(left)]
    return [tokens[at].span() for at in counted
            if any(abs(at - one) <= NEAR for one in named)]


def _amounts(text: str, currencies: Iterable[Optional[str]]) -> List[Span]:
    """The numbers beside a currency: its sign, its code, its name.

    ``currencies`` adds the codes the store knows (the reporting currency) to
    :data:`CODES`, in capitals only: any of them may be a word.
    """
    named = [rf'(?i:{_alternation([*CODES, _WORDS])})',
             *(re.escape(code.upper()) for code in currencies if code)]
    return _beside(text, re.compile(
        rf'[{_SIGNS}]|(?<![A-Za-z])(?:{"|".join(named)})(?![A-Za-z])'))


def _quantities(text: str, symbols: Iterable[Optional[str]]) -> List[Span]:
    """The numbers beside a held security: a quantity or a price.

    A ticker is read in the case the market writes it: a held ``NOW`` or
    ``A`` must not turn every sentence into one about a security.
    """
    held = [re.escape(symbol.strip()) for symbol in symbols
            if symbol and symbol.strip()]
    if not held:
        return []
    return _beside(text, re.compile(
        rf'(?<![\w.])(?:{_alternation(held)})(?!\w)'))


def _private(text: str, labels: Iterable[Optional[str]],
             symbols: Iterable[Optional[str]],
             currencies: Iterable[Optional[str]]) -> List[Tuple[str, List[Span]]]:
    """What ``text`` shows of the owner's portfolio, each kind under the words
    a refusal says it in."""
    return [
        ('names one of the owner\'s accounts', _accounts(text, labels)),
        ('gives an amount of money, a number beside a currency',
         _amounts(text, currencies)),
        ('gives a number beside a security the owner holds, a quantity or a '
         'price', _quantities(text, symbols)),
    ]


def refusal(text: str, labels: Iterable[Optional[str]] = (),
            symbols: Iterable[Optional[str]] = (),
            currencies: Iterable[Optional[str]] = ()) -> Optional[str]:
    """Why ``text`` may not go into a public report, or ``None``.

    The reason quotes what was found, so the agent knows what to take out.
    """
    for reason, spans in _private(text, labels, symbols, currencies):
        if spans:
            start, end = spans[0]
            return f'{reason} ("{text[start:end]}")'
    return None


def scrub(text: str, labels: Iterable[Optional[str]] = (),
          symbols: Iterable[Optional[str]] = (),
          currencies: Iterable[Optional[str]] = ()) -> str:
    """``text`` with every span :func:`refusal` would name replaced by
    :data:`MASK`, and the rest as it was written.

    Scrub **before** cutting a text: an amount straddling the cut would be
    left half shown, and no longer read as one.
    """
    spans = sorted(span for _, found
                   in _private(text, labels, symbols, currencies)
                   for span in found)
    kept, at = [], 0
    for start, end in spans:
        if start >= at:
            kept += [text[at:start], MASK]
        at = max(at, end)
    return ''.join(kept) + text[at:]


def check(title: str, description: str,
          labels: Iterable[Optional[str]] = (),
          symbols: Iterable[Optional[str]] = (),
          currencies: Iterable[Optional[str]] = ()) -> None:
    """Raise :class:`Refused` unless the agent's two texts may go out."""
    if not title.strip() or '\n' in title.strip() or len(title) > TITLE_MAX:
        raise Refused(
            f'the title is one line of at most {TITLE_MAX} characters')
    if not description.strip() or len(description) > DESCRIPTION_MAX:
        raise Refused(
            f'the description is {len(description)} characters long, and it '
            f'takes 1 to {DESCRIPTION_MAX}')
    labels, symbols, currencies = list(labels), list(symbols), list(currencies)
    for name, text in (('title', title), ('description', description)):
        found = refusal(text, labels, symbols, currencies)
        if found:
            raise Refused(
                f'the {name} {found}. The report is public and never carries '
                f'the owner\'s money: rewrite the {name} without any account '
                f'name, amount, quantity or price')


def _job(job: Dict[str, Any]) -> str:
    state = f" ({job['state']})" if job.get('state') else ''
    return (f"- {job['id']}{state}: "
            f"{job.get('last_error') or 'no error message'}")


def _error(error: Dict[str, Any]) -> str:
    key = f" {error['key']}" if error.get('key') else ''
    return f"- {error['source']}{key}: {error['message']}"


def _line(line: Dict[str, Any]) -> str:
    said = f"{line['time']} {line['level']} {line['job']}: {line['message']}"
    return said + ('\n' + line['detail'] if line.get('detail') else '')


def compose(description: str, build: build_info.Build,
            jobs: Sequence[Dict[str, Any]], errors: Sequence[Dict[str, Any]],
            lines: Sequence[Dict[str, Any]]) -> str:
    """The report's body: the agent's words, then what the app knows.

    ``jobs`` are the failing ones, ``errors`` what the jobs still carry and
    ``lines`` the journal's error lines, newest first. All three arrive masked
    and scrubbed: this only lays them out, in one fenced block that nothing in
    them may close, so an error's own words are never read as Markdown (a
    ``@name`` in a traceback notifies nobody).
    """
    known = [f'Version: {build_info.said(build)} ({build.source})', '',
             'Failing jobs:', *(map(_job, jobs) if jobs else ['- none'])]
    if errors:
        known += ['', 'Errors the jobs carry:', *map(_error, errors)]
    if lines:
        known += ['', 'Recent error lines of the journal:', *map(_line, lines)]
    return '\n'.join([
        description.strip(), '', '---',
        f'_Added by SuiviBourse. Secrets, amounts, quantities and account '
        f'names are replaced by `{MASK}`._', '',
        '```text', '\n'.join(known).replace('```', "'''"), '```'])


def link(title: str, body: str) -> str:
    """GitHub's new-issue form, prefilled. ``%20`` and not ``+``: the form
    reads a query string as a URL does."""
    return NEW_ISSUE + '?' + urlencode(
        {'title': title, 'body': body}, quote_via=quote)


def draft(title: str, description: str, build: build_info.Build,
          jobs: Sequence[Dict[str, Any]], errors: Sequence[Dict[str, Any]],
          lines: Sequence[Dict[str, Any]]) -> str:
    """The link to the prefilled report, at most :data:`URL_MAX` characters.

    The oldest log lines go first, then the oldest job errors; the agent's
    title and description are never cut. A link still too long with neither
    left is :class:`Refused`: the description is what to shorten.
    """
    title = ' '.join(title.split())
    errors, lines = list(errors[:ERRORS_MAX]), list(lines)
    while True:
        url = link(title, compose(description, build, jobs, errors, lines))
        if len(url) <= URL_MAX:
            return url
        if lines:
            lines.pop()
        elif errors:
            errors.pop()
        else:
            raise Refused(
                f'the report does not fit a link of {URL_MAX} characters '
                f'once encoded: shorten the description')


__all__ = [
    'NEW_ISSUE', 'URL_MAX', 'TITLE_MAX', 'DESCRIPTION_MAX', 'ERRORS_MAX',
    'CODES', 'NEAR', 'MASK', 'Refused',
    'refusal', 'scrub', 'check', 'compose', 'link', 'draft',
]
