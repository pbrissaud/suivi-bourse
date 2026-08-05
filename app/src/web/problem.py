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

# The write path's own vocabulary (issue #662). Each one is a *different* thing
# for the ledger to say, which is the whole reason they are separate types
# rather than one 400 with a message: the front branches on them — a stale
# fingerprint refetches and reopens the row, a read-only source badges the file,
# an unwritable directory is a deployment problem no retry will fix.
TYPE_STALE = '/problems/stale-fingerprint'
TYPE_READ_ONLY = '/problems/read-only-source'
TYPE_UNWRITABLE = '/problems/source-unwritable'
TYPE_WRONG_MODE = '/problems/wrong-mode'
TYPE_CONFLICT = '/problems/conflict'
TYPE_INVALID_CONFIG = '/problems/invalid-configuration'
TYPE_PRECONDITION_REQUIRED = '/problems/precondition-required'


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


def internal_error(detail: str):
    """500 — the last resort, for what no route anticipated."""
    return problem(500, 'Internal error', detail, TYPE_INTERNAL)


# --------------------------------------------------------------------------- #
# The write path (issue #662)
# --------------------------------------------------------------------------- #

def conflict(detail: str, type_: str = TYPE_CONFLICT):
    """409 — the request cannot be applied to the resource as it stands now."""
    return problem(409, 'Conflict', detail, type_)


def stale_fingerprint(detail: str):
    """409 — the addressed row is no longer the row the client read.

    ``409`` rather than the ``412`` an ``If-Match`` failure usually earns, and
    the difference is not pedantry. ``412`` says *this representation is not the
    one you have*; here the representation is fine and the **address** has
    moved — reorder a CSV by hand and the token now names a different event, so
    what failed is a conflict with the current state of the collection, which is
    409's own definition. #655 fixed this reading when it chose the fingerprint,
    and the front's handling follows from it: refetch the ledger, do not retry.
    """
    return conflict(detail, TYPE_STALE)


def read_only_source(detail: str):
    """403 — the server understood, and will not write this file.

    Not a 405: the method is right for the collection, and it is the *member*
    that refuses. RFC 9110 keeps 403 for a refusal unrelated to authentication,
    which is exactly a workbook whose formulas a save would overwrite.
    """
    return problem(403, 'Read-only source', detail, TYPE_READ_ONLY)


def source_unwritable(detail: str):
    """403 — the config directory itself cannot be written.

    A deployment condition, not a request error, and worth its own type: no
    retry and no correction of the payload will change it. This is the visible
    end of the map's PaaS fog — a platform that never ran ``make init`` runs the
    container as ``1000:1000`` over someone else's files.
    """
    return problem(403, 'Configuration directory not writable', detail,
                   TYPE_UNWRITABLE)


def wrong_mode(detail: str):
    """409 — this installation has no event ledger to write to."""
    return conflict(detail, TYPE_WRONG_MODE)


def precondition_required(detail: str):
    """428 — the guard is missing, so the write was not attempted.

    Distinct from the 409 a *failed* guard earns: one says the client forgot
    ``If-Match``, the other says it sent one that no longer holds. Collapsing
    them would make a front bug and a concurrent edit read the same.
    """
    return problem(428, 'Precondition required', detail,
                   TYPE_PRECONDITION_REQUIRED)


def invalid_configuration(errors, detail: Optional[str] = None):
    """422 — the candidate would produce a configuration the app refuses.

    The validator's messages travel **verbatim**, in an ``errors`` member: #653
    is explicit that a rejected save changes nothing *and* that the response
    carries what the validator objected to, because the alternative is a user
    staring at "invalid" with no way to learn which row.

    ``422`` and not ``400``: the request is perfectly well-formed — it is the
    configuration it would produce that is not.
    """
    messages = list(errors or [])
    return problem(
        422,
        'Invalid configuration',
        detail or (messages[0] if messages else None),
        TYPE_INVALID_CONFIG,
        errors=messages)


__all__ = [
    'problem', 'storage_unavailable', 'not_found', 'bad_request',
    'internal_error', 'conflict', 'stale_fingerprint', 'read_only_source',
    'source_unwritable', 'wrong_mode', 'precondition_required',
    'invalid_configuration', 'CONTENT_TYPE',
]
