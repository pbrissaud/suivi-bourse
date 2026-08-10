"""RFC 9457 ``application/problem+json`` responses (issue #659, design #655).

The read layer's error contract is the inverse of the writer's, and this module
is where that inversion becomes visible to a client. ``influxdb_writer.py`` ends
every read with ``except Exception: logger.error(...); return None`` — correct
for a scheduler that must survive a flaky query, and wrong for a UI, because it
makes *the database is unreachable* and *you own nothing yet* the same value.

#655 split them into three states, and only the third is an error:

===================  ==========================================  ==============
State                Example                                     Response
===================  ==========================================  ==============
Absent by design     ``xirr`` with no external flow; a weekend    ``200`` + ``null``
Empty collection     a fresh install with no shares              ``200`` + ``[]``
Failure              InfluxDB unreachable, malformed query        ``503``/``500`` + problem+json
===================  ==========================================  ==============

Rendering the first two as errors is what a generic dashboard does, and #652
déc. 6 ("empty states that mean something") is half the argument for building a
first-party UI at all — so the distinction is enforced here rather than left to
each route's judgement.
"""
from typing import Any, Dict, Optional

from flask import jsonify

#: The media type. Flask will not set it for us — ``jsonify`` hardcodes
#: ``application/json`` — so every response below overrides it explicitly.
CONTENT_TYPE = 'application/problem+json'

#: ``type`` is a URI *reference*; RFC 9457 explicitly allows a relative one, and
#: a relative one is right here: the app is self-hosted at an address it does not
#: know, so an absolute URL would be a guess. These are stable identifiers a
#: client may branch on.
TYPE_UNAVAILABLE = '/problems/storage-unavailable'
TYPE_NOT_FOUND = '/problems/not-found'
TYPE_BAD_REQUEST = '/problems/bad-request'
TYPE_INTERNAL = '/problems/internal-error'
TYPE_CONFLICT = '/problems/conflict'
TYPE_INVALID_SETTING = '/problems/invalid-setting'

# #662's write-path vocabulary — a stale fingerprint, a read-only source, an
# unwritable directory, a wrong mode — left with the apparatus that raised it
# (#711). Each of those types existed because **the file was the address**; in a
# store a row has a primary key, which does not go stale, so none of them has a
# successor to be renamed into.


def problem(status: int, title: str, detail: Optional[str] = None,
            type_: str = TYPE_INTERNAL, **extra: Any):
    """Build a problem+json response.

    Args:
        status: the HTTP status, repeated in the body as RFC 9457 requires.
        title: a short, stable, human-readable summary — the same string for
            every occurrence of this problem type, so it is safe to match on.
        detail: what went wrong *this* time. Free-form and specific.
        type_: the problem type identifier.
        extra: additional members, merged into the object.
    """
    body: Dict[str, Any] = {'type': type_, 'title': title, 'status': status}
    if detail:
        body['detail'] = detail
    body.update(extra)

    response = jsonify(body)
    response.status_code = status
    response.mimetype = CONTENT_TYPE
    return response


def storage_unavailable(detail: str):
    """503 — the query could not be answered. The distinctly *non*-empty answer.

    Deliberately ``503`` and not ``500``: the condition is transient by nature
    (InfluxDB restarting, a network blip) and the front's retry policy should
    treat it as such, where a ``500`` invites a bug report.
    """
    return problem(
        503,
        'Portfolio storage unavailable',
        detail,
        TYPE_UNAVAILABLE)


def not_found(detail: str):
    """404 — for a resource that genuinely does not exist.

    Never for an empty collection: an install with no shares yet returns
    ``200`` and ``[]``. This is for an unknown route or an unknown symbol.
    """
    return problem(404, 'Not found', detail, TYPE_NOT_FOUND)


def bad_request(detail: str):
    """400 — the request itself is malformed (an unparseable window, say)."""
    return problem(400, 'Bad request', detail, TYPE_BAD_REQUEST)


def conflict(detail: str):
    """409 — the request is well formed and the store's state refuses it.

    The status of every refusal issue #698 introduced: an account an event
    names, an account a file provisioned, an id already taken, an accounts
    import something still rests on. None of them is a malformed request (the
    client did nothing wrong) and none is a missing resource (it is there —
    that is the problem), so ``409`` is the one that carries *"try this again
    after removing what it rests on"* rather than *"fix your syntax"*.
    """
    return problem(409, 'Conflict', detail, TYPE_CONFLICT)


def unprocessable(detail: str, key: Optional[str] = None):
    """422 — the body parsed, and a value in it is not one the registry takes.

    Distinct from ``400`` on the axis RFC 9457 cares about: the request is well
    formed, the syntax is fine, and it is the *content* that cannot be
    processed. A cadence of ``0`` is not a typo in the JSON, it is an answer the
    app refuses — and a client that retried it because it read ``400`` as "fix
    your encoding" would retry forever.

    ``key`` names the field, so a form can mark the input that was refused
    rather than show a sentence above the whole page. It is an extension member
    of the problem object, which RFC 9457 explicitly allows.
    """
    extra = {'key': key} if key else {}
    return problem(
        422, 'Invalid setting', detail, TYPE_INVALID_SETTING, **extra)


def internal_error(detail: str):
    """500 — the last resort, for what no route anticipated."""
    return problem(500, 'Internal error', detail, TYPE_INTERNAL)


__all__ = [
    'problem', 'storage_unavailable', 'not_found', 'bad_request', 'conflict',
    'unprocessable', 'internal_error', 'CONTENT_TYPE',
]
