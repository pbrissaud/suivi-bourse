"""A bug report drafted for a public repository (#1630): what a text the agent
wrote is refused for, what is scrubbed out of a text nobody chose, and the
link that carries both.
"""
from urllib.parse import parse_qs, urlsplit

import pytest

from application import bug_report
from application import build_info
from application.bug_report import MASK, Refused, refusal, scrub

LABELS = ['PEA Boursorama', None, '  ']
SYMBOLS = ['CW8.PA', 'AAPL']
#: The reporting currency the store holds, beside the codes the module knows.
STORED = ['RSD']
NO_HISTORY = ('yfinance returned no history for CW8.PA over '
              '2020-03-02..2020-06-02')
BUILD = build_info.Build(
    version='5.4.0', revision='0123456789abcdef', source=build_info.RELEASE)


def found(text):
    return refusal(text, LABELS, SYMBOLS, STORED)


def sent(url):
    """The title and the body a link carries, as GitHub's form reads them."""
    asked = parse_qs(urlsplit(url).query)
    return asked['title'][0], asked['body'][0]


@pytest.mark.parametrize('text', [
    'The page of PEA Boursorama stays empty',
    'the pea  boursorama page stays empty',
    'Empty page (PEA\u00a0Boursorama).',
    # Whatever stands between the label's words.
    'The PEA-Boursorama page stays empty',
    'The pea_boursorama page stays empty',
    'PEABoursorama stays empty',
])
def test_a_text_that_names_an_account_is_refused(text):
    assert found(text).startswith("names one of the owner's accounts")


@pytest.mark.parametrize('text, quoted', [
    ('The total reads 12\u202f000\u00a0€ and should not', '12\u202f000'),
    ('The total reads 1,200.50 USD', '1,200.50'),
    ('The total reads USD 500', '500'),
    ('The total reads €12', '€12'),
    ('It shows $5 of fees', '$5'),
    ('A gain of 3 k€ is missing', '3'),
    ('A gain of 1.2M EUR is missing', '1.2M'),
    ('It lost 500 euros overnight', '500'),
    ('It lost 250 RSD overnight', '250'),
    # The currency a few words away, as a model rephrases a refused amount.
    ('The portfolio is worth 52340 in EUR', '52340'),
    ('Portfolio value (EUR): 52340', '52340'),
    ('The value in EUR is about 52 340', '52 340'),
    ('It is worth 52340 US dollars', '52340'),
    ('It is worth 12 chf', '12'),
    # Grouped thousands are no version, and a date exempts only itself.
    ('The portfolio value is 1.234.567 EUR', '1.234.567'),
    ('{"date":"2026-11-20","value":52340,"currency":"EUR"}',
     '{"date":"2026-11-20","value":52340,"currency":"EUR"}'),
    ('Il vaut 1,2 million d’euros', '1,2'),
    ('La valeur est de 52\u202f340 en euros', '52\u202f340'),
])
def test_a_number_beside_a_currency_is_refused(text, quoted):
    assert found(text) == (
        f'gives an amount of money, a number beside a currency ("{quoted}")')


@pytest.mark.parametrize('text, quoted', [
    ('The line of 12 shares of AAPL is missing', '12'),
    ('The line of 12 shares of Apple (AAPL) is missing', '12'),
    ('The first line, AAPL, shows its quantity as 12', '12'),
    ('AAPL closed at 180.50 and the page says otherwise', '180.50'),
    ('The line CW8.PA x12 is drawn twice', 'x12'),
    ('12x AAPL is drawn twice', '12x'),
    ('AAPL: 12', '12'),
    ('AAPL=12 is drawn twice', 'AAPL=12'),
])
def test_a_number_beside_a_held_security_is_refused(text, quoted):
    assert found(text) == (
        'gives a number beside a security the owner holds, a quantity or a '
        f'price ("{quoted}")')


@pytest.mark.parametrize('text', [
    # A ticker's own digits and the dates beside it are no quantity.
    NO_HISTORY,
    'The backfill of CW8.PA has failed since 2026-11-20 09:00',
    'CW8.PA and AAPL have no price',
    'Since 5.4.0 the page of AAPL stays empty',
    'AAPL failed at 2026-11-20T09:00:00.123456+00:00 on v5.4.0',
    # A number with no currency beside it and no security near it is a count.
    'HTTP 404 on GET /api/positions, 3 passes in a row since 5.4.0',
    # A currency with no number is only its name, and a code is capitals.
    'The EUR rate is missing since 2026-11-20',
    'I will try 3 more passes',
    # A ticker is read in the market's case.
    'Only 3 jobs ran, and aapl is not one of their words',
])
def test_what_says_nothing_of_the_owner_s_money_is_kept(text):
    assert found(text) is None
    assert scrub(text, LABELS, SYMBOLS, STORED) == text


def test_a_text_nobody_chose_is_scrubbed_and_stays_readable():
    line = ('ingestion: the deposit of 1 000,00 EUR on PEA Boursorama was '
            'rejected after sold 12 AAPL at 180.50')

    assert scrub(line, LABELS, SYMBOLS, STORED) == (
        f'ingestion: the deposit of {MASK} EUR on {MASK} was rejected after '
        f'sold {MASK} AAPL at {MASK}')


def test_a_quantity_a_few_words_after_its_security_is_scrubbed_too():
    line = 'Insufficient quantity for CW8.PA: have 10.5, need 12'

    assert scrub(line, LABELS, SYMBOLS, STORED) == (
        f'Insufficient quantity for CW8.PA: have {MASK} need {MASK}')


def test_nothing_to_look_for_finds_nothing():
    assert refusal('12 shares of AAPL on PEA Boursorama') is None
    assert refusal('12 EUR') == (
        'gives an amount of money, a number beside a currency ("12")')


@pytest.mark.parametrize('title, description', [
    ('', 'The page stays empty.'),
    ('Two\nlines', 'The page stays empty.'),
    ('x' * (bug_report.TITLE_MAX + 1), 'The page stays empty.'),
    ('The page stays empty', ' '),
    ('The page stays empty', 'x' * (bug_report.DESCRIPTION_MAX + 1)),
    ('PEA Boursorama stays empty', 'The page stays empty.'),
    ('The page stays empty', 'It should read 12 000 €.'),
    ('The page stays empty', 'It should read 12 AAPL.'),
])
def test_a_report_is_checked_whole_before_anything_is_built(title, description):
    with pytest.raises(Refused):
        bug_report.check(title, description, LABELS, SYMBOLS, STORED)


def test_the_refusal_says_which_text_and_what_to_take_out():
    with pytest.raises(Refused) as refused:
        bug_report.check('The page stays empty', 'It should read 12 000 €.',
                         LABELS, SYMBOLS, STORED)

    assert str(refused.value).startswith(
        'the description gives an amount of money, a number beside a '
        'currency ("12 000"). ')


def test_the_body_holds_the_version_the_jobs_and_their_errors():
    url = bug_report.draft(
        '  The benchmark\tstays empty ', 'Nothing is drawn.\n\nSee /benchmark.',
        BUILD,
        [{'id': 'backfill', 'state': 'error', 'last_error': NO_HISTORY}],
        [{'source': 'backfill:backward', 'key': 'CW8.PA',
          'message': NO_HISTORY}],
        [{'time': '2026-11-21T09:00:00+00:00', 'level': 'error',
          'job': 'backfill', 'message': 'the pass failed',
          'detail': 'Traceback\n```\nValueError: no closes'}])

    title, body = sent(url)
    assert url.startswith(bug_report.NEW_ISSUE + '?title=The%20benchmark%20')
    assert title == 'The benchmark stays empty'
    assert body.startswith('Nothing is drawn.\n\nSee /benchmark.\n\n---\n')
    # What the app adds sits in one block, so none of it reads as Markdown.
    assert body.count('```') == 2
    assert '\n```text\nVersion: 5.4.0 (0123456789ab) (release)\n' in body
    assert f'- backfill (error): {NO_HISTORY}' in body
    assert f'- backfill:backward CW8.PA: {NO_HISTORY}' in body
    # A fence in a traceback does not close that block.
    assert body.endswith(
        "2026-11-21T09:00:00+00:00 error backfill: the pass failed\n"
        "Traceback\n'''\nValueError: no closes\n```")


def test_a_quiet_installation_still_drafts_a_report():
    _, body = sent(bug_report.draft(
        'A wrong figure', 'The return reads twice.',
        build_info.UNSTAMPED, [], [], []))

    assert body.endswith('```text\nVersion: unknown (unknown)\n\n'
                         'Failing jobs:\n- none\n```')


def test_the_link_is_capped_by_dropping_log_lines_never_the_agent_s_text():
    description = 'é' * 600
    lines = [{'time': f'2026-11-21T09:{n:02d}:00+00:00', 'level': 'error',
              'job': 'scrape', 'message': f'line {n} ' + 'x' * 300,
              'detail': None} for n in range(29, -1, -1)]

    url = bug_report.draft('The scrape fails', description, BUILD,
                           [{'id': 'scrape', 'state': 'error',
                             'last_error': 'HTTP 500'}], [], lines)

    title, body = sent(url)
    assert len(url) <= bug_report.URL_MAX
    assert title == 'The scrape fails'
    assert body.startswith(description + '\n\n---\n')
    assert '- scrape (error): HTTP 500' in body
    # The newest lines stay, the oldest went first.
    assert 'line 29 ' in body and 'line 0 ' not in body
    kept = body.count(' error scrape: line ')
    assert 0 < kept < len(lines)


def test_the_job_errors_go_after_the_lines_and_then_the_report_is_refused():
    errors = [{'source': 'scrape', 'key': f'S{n}', 'message': 'x' * 300}
              for n in range(40)]

    _, body = sent(bug_report.draft(
        'The scrape fails', 'é' * 500, BUILD, [], errors, []))

    assert 0 < body.count('- scrape S') < bug_report.ERRORS_MAX
    with pytest.raises(Refused, match='shorten the description'):
        bug_report.draft('The scrape fails', 'é' * bug_report.DESCRIPTION_MAX,
                         BUILD, [], errors, [])


def test_a_label_with_no_word_in_it_is_matched_as_written():
    assert refusal('The page of my\U0001f3e6 fails', ['\U0001f3e6'])
    assert scrub('on \U0001f3e6: failed', ['\U0001f3e6']) == f'on {MASK}: failed'
