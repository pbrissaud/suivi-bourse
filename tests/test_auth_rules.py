"""The PIN's rules, on an injected clock (#1203)."""
from datetime import datetime, timedelta, timezone

from application import auth_rules
from application.auth_rules import Throttle


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_a_pin_is_six_digits_and_nothing_else():
    assert auth_rules.is_pin('012345')
    for wrong in ('12345', '1234567', '12345a', ' 123456', '١٢٣٤٥٦', 123456, None):
        assert not auth_rules.is_pin(wrong), wrong


def test_the_hash_verifies_its_own_pin_only():
    stored = auth_rules.hash_pin('123456')
    assert stored.startswith('scrypt$')
    assert auth_rules.verify_pin('123456', stored)
    assert not auth_rules.verify_pin('654321', stored)
    assert not auth_rules.verify_pin('123456', 'garbage')
    assert not auth_rules.verify_pin('123456', None)
    assert auth_rules.hash_pin('123456') != stored, 'a fresh salt each time'


def test_the_token_is_stored_as_its_hash():
    token = auth_rules.new_token()
    stored = auth_rules.hash_token(token)
    assert token not in stored
    assert auth_rules.token_matches(token, stored)
    assert not auth_rules.token_matches(token + 'x', stored)
    assert not auth_rules.token_matches(None, stored)
    assert not auth_rules.token_matches(token, None)


def test_five_free_attempts_then_a_wait_that_doubles_up_to_fifteen_minutes():
    clock = Clock()
    throttle = Throttle(clock)

    said = [throttle.enter('a') for _ in range(5)]
    assert [s.admitted for s in said] == [True] * 5
    assert [s.remaining for s in said] == [4, 3, 2, 1, 0]

    refused = throttle.enter('a')
    assert not refused.admitted and refused.retry_after == 30

    waits = []
    for _ in range(8):
        clock.now += throttle.wait('a')
        assert throttle.enter('a').admitted
        waits.append(throttle.wait('a'))
    assert waits == [60, 120, 240, 480, 900, 900, 900, 900]


def test_another_address_is_not_held_by_the_first():
    throttle = Throttle(Clock())
    for _ in range(6):
        throttle.enter('a')
    assert throttle.enter('b').admitted


def test_a_success_gives_the_address_its_slate_back():
    throttle = Throttle(Clock())
    for _ in range(4):
        throttle.enter('a')
    throttle.succeeded('a')
    assert throttle.enter('a').remaining == 4


def test_past_sixty_failures_an_hour_one_attempt_a_minute():
    clock = Clock()
    throttle = Throttle(clock)
    for n in range(60):
        assert throttle.enter(f'10.0.0.{n}').admitted

    assert throttle.enter('fresh-1').admitted
    paced = throttle.enter('fresh-2')
    assert not paced.admitted and paced.retry_after == 60

    clock.now += 60
    assert throttle.enter('fresh-2').admitted

    clock.now += 3600
    assert throttle.enter('fresh-3').admitted
    assert throttle.enter('fresh-4').admitted


def test_revoked_ids_are_dropped_once_no_cookie_could_carry_them():
    now = datetime(2026, 10, 16, tzinfo=timezone.utc)
    revoked = {'old': (now - timedelta(days=31)).isoformat(),
               'new': (now - timedelta(days=2)).isoformat()}
    assert auth_rules.purge_revoked(revoked, now) == {'new': revoked['new']}
