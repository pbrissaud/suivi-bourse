"""Secrets masked out of a log text, with no I/O (#1627).

A log line is written for the owner's terminal, and what reaches it was never
meant to travel: the address of a proxy with its credentials, the header a
library dumps beside its error, a provider key in an exception's words.
:func:`mask` replaces each of those with :data:`MASK` and leaves the rest of
the line as it was written, so a line still says what failed and where.

It reads shapes, not values: a secret that looks like nothing (a bare word
after no name) is not found. What the app knows to be a secret is masked where
it is known (:func:`agent.masked`); this is the net under a text nobody chose.
"""
import re

MASK = '***'

#: A name whose value is a secret, wherever it ends a longer one (``api_key``,
#: ``access_token``, ``X-Api-Key``, ``sb_session``). It **ends** the name, so a
#: count is left alone (``input_tokens=1200``, ``session_seconds=900``). What
#: stands before it is not matched: scanning it would be quadratic.
_NAMED = (r'(?:token|secret|passw(?:or)?d|pwd|pass(?:phrase|code)'
          r'|(?:api|secret|private|access|auth)[_\- ]?key|credentials?|signature'
          r'|session(?:[_\-]?id)?|crumb|(?<![a-z])pin)')

_RULES = tuple((re.compile(pattern, re.IGNORECASE), kept) for pattern, kept in (
    # A URL's credentials, to the last ``@`` of the run: a password may hold a
    # raw ``/``, ``?`` or ``@``. A port is no password: a number behind a
    # dotted host or ``localhost``, with one ``@`` at most after it.
    (r'(\b[a-z][a-z0-9+.\-]{0,20}://)'
     r'(?!(?:localhost|[^\s/?#@:]{0,200}\.[^\s/?#@:]{0,200}):\d{1,5}[/?#]'
     r'[^\s@]{0,200}@?[^\s@]{0,200}(?:\s|$))'
     r'[^\s/?#@:]{0,200}:[^\s]{1,200}@',
     r'\1' + MASK + '@'),
    # The same with no password, or a numeric one: the host stays, it says where.
    (r'(\b[a-z][a-z0-9+.\-]{0,20}://)[^\s/?#]+@', r'\1' + MASK + '@'),
    # A cookie header, every pair in it: to its closing quote, or to the end of
    # the line when it has no opening one.
    (r"""(\b(?:set-)?cookie\\*["']?\s*[=:]\s*)(\\*["'])"""
     r"""(?:(?!\2)(?:\\.|[^\r\n]))*""", r'\1\2' + MASK),
    (r"""(\b(?:set-)?cookie\\*["']?\s*[=:]\s*)(?!\s|\\*["'])[^\r\n]+""",
     r'\1' + MASK),
    # ``Authorization: Bearer …``, its scheme kept; then a bearer on its own.
    (r'''(\b(?:proxy-)?authorization["']?\s*[=:]\s*["']?'''
     r'''(?:(?:bearer|basic|digest|token)\s+)?)[^\s,;'"]+''', r'\1' + MASK),
    (r'(\bbearer\s+)[a-z0-9._~+/=\-]{8,}', r'\1' + MASK),
    # A quoted value, to its closing quote: a passphrase holds spaces.
    (r'(' + _NAMED + r'''\\*["']?\s*[=:]\s*b?)(\\*["'])'''
     r'''(?:(?!\2)(?:\\.|[^\r\n]))*''', r'\1\2' + MASK),
    # ``name=value`` and ``"name": "value"``, in a query string, a header, a
    # dict's repr.
    (r'''(''' + _NAMED + r'''["']?\s*[=:]\s*["']?)[^\s&;,'")\]}]+''',
     r'\1' + MASK),
    # A bare ``key`` is a secret in a query string alone: everywhere else in
    # this app it is the symbol a job's error is about.
    (r'([?&]key=)[^\s&#;]+', r'\1' + MASK),
    # The app's own access tokens: the prefix names the token, and is public.
    (r'\b(sb_[0-9a-f]{8}_)[\w\-]{16,}', r'\1' + MASK),
    # Provider keys, known by their prefix.
    (r'\b(?:(?:sk|pk|rk)[\-_](?=[\w\-]{0,200}\d)[\w\-]{12,}|gh[pousr]_\w{20,}|github_pat_\w{20,}'
     r'|xox[abprs]-[\w\-]{10,}|AIza[\w\-]{30,}|AKIA[0-9A-Z]{16}'
     r'|eyJ[\w\-]{8,}\.[\w\-]{8,}\.[\w\-]{8,})', MASK),
))


def mask(text: str) -> str:
    """``text`` with every secret it shows replaced by :data:`MASK`.

    Mask **before** cutting a text: a secret straddling the cut would be left
    half shown.
    """
    for pattern, kept in _RULES:
        text = pattern.sub(kept, text)
    return text


__all__ = ['MASK', 'mask']
