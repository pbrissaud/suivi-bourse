"""The log masker (#1627): one case per shape, and what it must leave alone.

Every secret here is built by concatenation: a literal credentialed URL or a
provider-shaped key in a test file stops the push.
"""
import time

import pytest

from application import log_masking
from application.log_masking import MASK, mask

SECRET = 'hunter2' + 'Zq9' * 6
AT = '@'
SCHEME = 'https' + '://'
SK = 'sk' + '-'


@pytest.mark.parametrize('line, masked', [
    # Credentials in a URL: the host stays.
    (f'proxy {SCHEME}paul:{SECRET}{AT}proxy.example:8080/path refused',
     f'proxy {SCHEME}{MASK}{AT}proxy.example:8080/path refused'),
    (f'clone {SCHEME}{SECRET}{AT}git.example/repo.git',
     f'clone {SCHEME}{MASK}{AT}git.example/repo.git'),
    ('redis' + f'://:{SECRET}{AT}cache:6379/0',
     'redis' + f'://{MASK}{AT}cache:6379/0'),
    # Authorization and Bearer values: the scheme stays.
    (f'Authorization: Bearer {SECRET}', f'Authorization: Bearer {MASK}'),
    (f"{{'Authorization': 'Basic {SECRET}', 'Accept': '*/*'}}",
     f"{{'Authorization': 'Basic {MASK}', 'Accept': '*/*'}}"),
    (f'authorization={SECRET}', f'authorization={MASK}'),
    (f'sent with bearer {SECRET}.', f'sent with bearer {MASK}'),
    # Named query parameters.
    (f'GET /v8/chart?symbol=AI.PA&token={SECRET}&range=1d',
     f'GET /v8/chart?symbol=AI.PA&token={MASK}&range=1d'),
    (f'GET /search?key={SECRET}&q=AI.PA', f'GET /search?key={MASK}&q=AI.PA'),
    (f'GET /x?api_key={SECRET}', f'GET /x?api_key={MASK}'),
    (f'GET /x?password={SECRET}', f'GET /x?password={MASK}'),
    (f'GET /x?client_secret={SECRET}', f'GET /x?client_secret={MASK}'),
    (f'GET /x?access_token={SECRET}', f'GET /x?access_token={MASK}'),
    (f'GET /x?crumb={SECRET}', f'GET /x?crumb={MASK}'),
    # The same names in a header and in a dict's repr.
    (f'X-Api-Key: {SECRET}', f'X-Api-Key: {MASK}'),
    (f'{{"refresh_token": "{SECRET}", "expires_in": 3600}}',
     f'{{"refresh_token": "{MASK}", "expires_in": 3600}}'),
    # Provider keys, by their prefix.
    (f'invalid x-api-key {SK}ant-api03-{SECRET}',
     f'invalid x-api-key {MASK}'),
    (f'Incorrect API key provided: {SK}proj-{SECRET}.',
     f'Incorrect API key provided: {MASK}.'),
    ('remote: gh' + f'p_{SECRET}AbCd rejected', f'remote: {MASK} rejected'),
    # The app's own access token: its public prefix names it.
    ('token sb' + f'_0a1b2c3d_{SECRET} is expired',
     f'token sb_0a1b2c3d_{MASK} is expired'),
    # PIN and session values.
    (f"body={{'pin': '{SECRET}'}}", f"body={{'pin': '{MASK}'}}"),
    (f'PIN={SECRET}', f'PIN={MASK}'),
    (f'Cookie: sb_session={SECRET}; theme=dark', f'Cookie: {MASK}'),
    (f'sb_session={SECRET}', f'sb_session={MASK}'),
    # A quoted value holding spaces, or an escaped quote.
    (f'password = "my pass {SECRET}" refused',
     f'password = "{MASK}" refused'),
    (f"{{'api_key': 'a b {SECRET}', 'model': 'x'}}",
     f"{{'api_key': '{MASK}', 'model': 'x'}}"),
    (f'{{"secret": "a\\"{SECRET}", "n": 1}}', f'{{"secret": "{MASK}", "n": 1}}'),
    (f'body {{\\"token\\": \\"{SECRET}\\", \\"n\\": 1}}',
     f'body {{\\"token\\": \\"{MASK}\\", \\"n\\": 1}}'),
    # The other names of a key.
    (f'SECRET_KEY={SECRET}', f'SECRET_KEY={MASK}'),
    (f'AWS_SECRET_ACCESS_KEY={SECRET}', f'AWS_SECRET_ACCESS_KEY={MASK}'),
    (f'private_key: {SECRET}', f'private_key: {MASK}'),
    (f'api key: {SECRET}', f'api key: {MASK}'),
    (f'passphrase={SECRET}', f'passphrase={MASK}'),
    ('sk' + f'_live_{SECRET}', MASK),
    # A raw slash or question mark in a URL's password.
    (f'{SCHEME}paul:a/b?{SECRET}{AT}proxy.example/v8',
     f'{SCHEME}{MASK}{AT}proxy.example/v8'),
    (f'session_id: {SECRET}', f'session_id: {MASK}'),
])
def test_a_secret_is_masked_and_the_line_around_it_kept(line, masked):
    assert SECRET in line
    assert mask(line) == masked
    assert SECRET not in mask(line)


@pytest.mark.parametrize('line', [
    'HTTP 429 for AI.PA',
    'yfinance returned no history for CW8.PA over 2020-03-02..2020-06-02',
    'backfill:backward key=AI.PA failed 3 times',
    "error {'source': 'perf', 'key': 'CW8.PA', 'message': 'no closes'}",
    'GET https://query1.finance.yahoo.com/v8/finance/chart/AI.PA?range=1d',
    'turn done: input_tokens=1200 output_tokens=340',
    'GET https://host.example:8080/users/paul@example.test',
    'sk-learn-model-registry loaded',
    'session_seconds=900, spinning=3',
    'The PIN was removed, and the access tokens with it',
    'mail the owner at paul@example.test about /system',
    'ValueError: could not convert string to float: "12,5"',
])
def test_a_line_with_no_secret_is_left_as_written(line):
    assert mask(line) == line


def test_a_traceback_keeps_its_frames_and_loses_its_secret():
    detail = (
        'Traceback (most recent call last):\n'
        '  File "/app/application/market.py", line 12, in fetch\n'
        '    raise ConnectionError(url)\n'
        f'ConnectionError: {SCHEME}paul:{SECRET}{AT}proxy.example/v8\n')

    masked = mask(detail)

    assert SECRET not in masked
    assert masked.splitlines()[:3] == detail.splitlines()[:3]
    assert masked.endswith(f'ConnectionError: {SCHEME}{MASK}{AT}proxy.example/v8\n')


def test_masking_twice_changes_nothing_more():
    line = f'Authorization: Bearer {SECRET} then ?token={SECRET}'
    assert mask(mask(line)) == mask(line)


@pytest.mark.parametrize('text', [
    'a' * 50_000, 'a-' * 25_000, 'token' * 10_000, 'http' + '://' + 'a:' * 25_000,
    'a' + '://b:c' * 10_000, 'sk' + '-sk' * 15_000, 'token="' * 8_000,
    'token' + ' ' * 50_000, 'key' + '\\' * 50_000,
])
def test_a_long_line_is_masked_in_linear_time(text):
    """A quadratic pattern takes minutes here, on the agent's own thread."""
    started = time.perf_counter()
    mask(text)
    assert time.perf_counter() - started < 5


def test_the_module_reads_no_one():
    """Standard library only: the masker is pure (``packages/core``)."""
    import ast
    from pathlib import Path
    tree = ast.parse(Path(log_masking.__file__).read_text(encoding='utf-8'))
    imported = [alias.name for node in ast.walk(tree)
                if isinstance(node, ast.Import) for alias in node.names]
    assert imported == ['re']
    assert not [node for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom)]
