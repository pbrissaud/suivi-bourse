"""RFC 9457 ``application/problem+json`` responses (issue #659, design #655).

The read layer's error contract is the inverse of the scheduler's, and this
module is where that inversion becomes visible to a client. A scheduled job
ends its reads with ``except Exception: logger.error(...); return None`` —
correct for a job that must survive a flaky query, and wrong for a UI, because
it makes *the database is unreadable* and *you own nothing yet* the same value.

#655 split them into three states, and only the third is an error:

===================  ==========================================  ==============
State                Example                                     Response
===================  ==========================================  ==============
Absent by design     ``xirr`` with no external flow; a weekend    ``200`` + ``null``
Empty collection     a fresh install with no shares              ``200`` + ``[]``
Failure              the store is unreadable, a malformed query  ``503``/``500`` + problem+json
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
#: A file handed to ``POST /api/events/import`` that this app writes no row
#: from (issue #811). Its **own** identifier and not :data:`TYPE_BAD_REQUEST`,
#: because the front branches on the identifier and nothing else: *the request
#: is malformed* and *this file is not a ledger I read* are two sentences to a
#: reader holding a file, and only the second one tells them to look at the file.
TYPE_INVALID_FILE = '/problems/invalid-file'
#: The upload is past the bound (issue #811). Also its own, and for the reason
#: the bound is written down at all: *too big* is the one refusal whose repair
#: — export a narrower range — the reader can make without reading a word of
#: their file.
TYPE_TOO_LARGE = '/problems/payload-too-large'

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
    (a file being checkpointed, a mount coming back) and the front's retry
    policy should treat it as such, where a ``500`` invites a bug report.
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


def unprocessable_parameter(detail: str, key: Optional[str] = None):
    """422 — a query parameter parsed, and its value is outside a closed set.

    :func:`unprocessable`'s sibling on the read side, and a separate function
    for one reason only: its title. *Invalid setting* is the right sentence
    about a dial and the wrong one about ``?window=``, which is not a setting,
    is not stored, and is not in the registry.

    The ``type`` stays :data:`TYPE_BAD_REQUEST`, the identifier the front
    already branches on: *the request is not one I can process* is exactly what
    a reader needs to be told, and inventing a fifth identifier here would
    require a table this ticket does not touch to learn it — an unknown type
    falls back to *unexpected error*, which is a worse sentence than the true
    one. The **status** is what carries the distinction RFC 9457 cares about:
    the syntax parsed, and it is the value that has no meaning
    (issue #763).
    """
    extra = {'key': key} if key else {}
    return problem(422, 'Invalid parameter', detail, TYPE_BAD_REQUEST, **extra)


def unprocessable_entry(detail: str, key: Optional[str] = None):
    """422 — the event parsed, and the ledger's own rules refuse it (issue #764).

    The third member of the family, and a third function for the same reason
    :func:`unprocessable_parameter` is a second one: its **title**. *Invalid
    setting* is the right sentence about a dial and a lie about an event, which
    is neither stored in ``setting`` nor listed in the registry; *Invalid
    parameter* is the right sentence about ``?window=`` and wrong about a
    member of a body somebody typed into a form.

    The ``type`` stays :data:`TYPE_BAD_REQUEST` for the argument #763 wrote
    down: an unknown identifier falls back to *unexpected error* in the front's
    table, which is a worse sentence than the true one, and inventing a fifth
    here would need a table this ticket does not touch to learn it. The
    **status** carries the distinction RFC 9457 cares about — the syntax parsed,
    and it is the content that cannot be processed.

    ``key`` is the field to mark, forwarded from
    :class:`events.validator.ValidationIssue`, so a form marks the input it
    refused rather than printing a paragraph over the whole panel.
    """
    extra = {'key': key} if key else {}
    return problem(422, 'Invalid event', detail, TYPE_BAD_REQUEST, **extra)


def unprocessable_file(detail: str):
    """422 — the file parsed as far as it could, and it is not a ledger.

    The fourth member of the family, and a fourth function for the reason the
    third is one: its **title**, and here its ``type`` as well. The three above
    are refusals of a *value* somebody typed, which is why they share
    :data:`TYPE_BAD_REQUEST`; this is the refusal of a *file* somebody handed
    over, and the gesture it belongs to has a surface of its own — a drop zone,
    not a form — so the front needs to tell the two apart to say anything true.

    Every refusal an upload can earn goes through it: an unrecognised header, a
    declaration of accounts (ADR-0034), a v4 ``config.yaml``, a format this app
    does not read, and a row the ledger's own rules refuse. They are one answer
    — *nothing was written, and here is what is wrong with the file* — and a
    client branching on which of the five would be re-deciding what the sentence
    already says.
    """
    return problem(422, 'Invalid file', detail, TYPE_INVALID_FILE)


def too_large(detail: str, limit: int):
    """413 — the upload is past what one may carry.

    ``limit`` is the bound in bytes, an extension member because it is a
    **number the client can act on**: a page that knows it can refuse a file
    before spending a minute sending it, and RFC 9457 explicitly allows the
    member. The sentence is the server's, and the number is the same constant
    the route enforces — there is no second bound written anywhere.
    """
    return problem(413, 'File too large', detail, TYPE_TOO_LARGE, limit=limit)


def internal_error(detail: str):
    """500 — the last resort, for what no route anticipated."""
    return problem(500, 'Internal error', detail, TYPE_INTERNAL)


__all__ = [
    'problem', 'storage_unavailable', 'not_found', 'bad_request', 'conflict',
    'unprocessable', 'unprocessable_parameter', 'unprocessable_entry',
    'unprocessable_file', 'too_large', 'internal_error',
    'CONTENT_TYPE',
]
