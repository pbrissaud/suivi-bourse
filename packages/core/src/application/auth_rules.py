"""The PIN's rules, with no I/O: hashing, the attempt throttle, the revoked-list purge (#1203).

The gate that applies them is ``auth_gate`` in the app member; this module
imports the standard library only, so the clock is injected and every rule is
testable without a socket or a store.
"""
import hashlib
import hmac
import re
import secrets
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Deque, Dict, Mapping, Optional

PIN_PATTERN = re.compile(r'[0-9]{6}')

#: ``hashlib.scrypt``'s cost: n=2^14, r=8, p=1, 16 MiB of memory a check.
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16

#: How long a session lives without being seen, and how long a revoked id is kept.
SESSION_DAYS = 30

FREE_ATTEMPTS = 5
FIRST_WAIT = 30
LONGEST_WAIT = 15 * 60
GLOBAL_FAILURES = 60
GLOBAL_WINDOW = 60 * 60
GLOBAL_PACE = 60


def is_pin(value) -> bool:
    """Six ASCII digits, nothing around them."""
    return isinstance(value, str) and PIN_PATTERN.fullmatch(value) is not None


def hash_pin(pin: str, salt: Optional[bytes] = None) -> str:
    """``scrypt$<salt hex>$<hash hex>``. Slow on purpose: run it off the event loop."""
    salt = secrets.token_bytes(SALT_BYTES) if salt is None else salt
    digest = hashlib.scrypt(pin.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                            p=SCRYPT_P)
    return f'scrypt${salt.hex()}${digest.hex()}'


def verify_pin(pin: str, stored: Optional[str]) -> bool:
    """Whether ``pin`` is the one ``stored`` was made from. ``False`` on a malformed row."""
    if not stored or not isinstance(pin, str):
        return False
    try:
        scheme, salt, expected = stored.split('$')
        if scheme != 'scrypt':
            return False
        return hmac.compare_digest(hash_pin(pin, bytes.fromhex(salt)), stored)
    except ValueError:
        return False


def new_token() -> str:
    """The ``/mcp`` bearer token, shown once."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """What is stored of the token: SHA-256, a lookup and not a password."""
    return hashlib.sha256(token.encode()).hexdigest()


def token_matches(token: Optional[str], stored: Optional[str]) -> bool:
    """Constant-time comparison of a presented token against the stored hash."""
    if not token or not stored:
        return False
    return hmac.compare_digest(hash_token(token), stored)


def purge_revoked(revoked: Mapping[str, str], now: datetime) -> Dict[str, str]:
    """Drop the revoked session ids older than a session can live.

    ``revoked`` maps an id to the ISO instant it was revoked at. A cookie for an
    id revoked more than :data:`SESSION_DAYS` ago has expired anyway.
    """
    horizon = now - timedelta(days=SESSION_DAYS)
    return {sid: at for sid, at in revoked.items()
            if datetime.fromisoformat(at) > horizon}


@dataclass(frozen=True)
class Admission:
    """The throttle's answer to one attempt."""

    admitted: bool
    #: Seconds to wait before the next attempt is admitted; 0 when admitted freely.
    retry_after: int = 0
    #: Free attempts this IP has left after this one.
    remaining: int = 0


@dataclass
class _Address:
    attempts: int = 0
    open_at: float = 0.0


@dataclass
class Throttle:
    """Per IP: 5 free attempts, then a wait doubling from 30 s up to 15 min.

    Globally: past 60 failures in an hour, one attempt a minute. An attempt is
    counted **on entry**, before the PIN is checked, so parallel requests cannot
    slip past the count; :meth:`succeeded` gives the IP back its slate. Memory
    only: a restart forgets it, which costs an attacker a restart they cannot
    cause from the network.
    """

    clock: Callable[[], float]
    _addresses: Dict[str, _Address] = field(default_factory=dict)
    _failures: Deque[float] = field(default_factory=deque)
    _global_open_at: float = 0.0

    def enter(self, ip: str) -> Admission:
        """Count one attempt from ``ip``, or refuse it with how long to wait."""
        now = self.clock()
        address = self._addresses.setdefault(ip, _Address())
        if now < address.open_at:
            return Admission(False, _seconds(address.open_at - now))

        while self._failures and self._failures[0] <= now - GLOBAL_WINDOW:
            self._failures.popleft()
        busy = len(self._failures) >= GLOBAL_FAILURES
        if busy and now < self._global_open_at:
            return Admission(False, _seconds(self._global_open_at - now))

        address.attempts += 1
        self._failures.append(now)
        if busy:
            self._global_open_at = now + GLOBAL_PACE
        beyond = address.attempts - FREE_ATTEMPTS
        if beyond >= 0:
            address.open_at = now + min(FIRST_WAIT * 2 ** beyond, LONGEST_WAIT)
        return Admission(True, 0, max(0, FREE_ATTEMPTS - address.attempts))

    def wait(self, ip: str) -> int:
        """Seconds before ``ip`` may try again; 0 when it may now."""
        address = self._addresses.get(ip)
        return 0 if address is None else _seconds(address.open_at - self.clock())

    def succeeded(self, ip: str) -> None:
        """A right PIN: the IP starts over, and its attempt was no failure."""
        self._addresses.pop(ip, None)
        if self._failures:
            self._failures.pop()


def _seconds(delta: float) -> int:
    """A wait as ``Retry-After`` states it: whole seconds, rounded up, never negative."""
    whole = int(delta)
    return max(0, whole + (1 if delta > whole else 0))


__all__ = [
    'Admission', 'Throttle', 'SESSION_DAYS', 'FREE_ATTEMPTS',
    'is_pin', 'hash_pin', 'verify_pin', 'new_token', 'hash_token',
    'token_matches', 'purge_revoked',
]
