"""RFC 9457 ``application/problem+json`` responses (issue #659, design #655)."""
from typing import Any, Dict, Optional

from flask import jsonify

CONTENT_TYPE = 'application/problem+json'

TYPE_UNAVAILABLE = '/problems/storage-unavailable'
TYPE_NOT_FOUND = '/problems/not-found'
TYPE_BAD_REQUEST = '/problems/bad-request'
TYPE_INTERNAL = '/problems/internal-error'
TYPE_CONFLICT = '/problems/conflict'
TYPE_INVALID_SETTING = '/problems/invalid-setting'
TYPE_INVALID_FILE = '/problems/invalid-file'
TYPE_TOO_LARGE = '/problems/payload-too-large'
TYPE_UNREPLAYABLE = '/problems/unreplayable-ledger'
TYPE_FOREIGN_ORIGIN = '/problems/foreign-origin'


def problem(status: int, title: str, detail: Optional[str] = None,
            type_: str = TYPE_INTERNAL, **extra: Any):
    """Build a problem+json response."""
    body: Dict[str, Any] = {'type': type_, 'title': title, 'status': status}
    if detail:
        body['detail'] = detail
    body.update({k: v for k, v in extra.items() if v is not None})

    response = jsonify(body)
    response.status_code = status
    response.mimetype = CONTENT_TYPE
    return response


def storage_unavailable(detail: str):
    """503 — the query could not be answered. The distinctly *non*-empty answer."""
    return problem(
        503,
        'Portfolio storage unavailable',
        detail,
        TYPE_UNAVAILABLE)


def not_found(detail: str):
    """404 — for a resource that genuinely does not exist."""
    return problem(404, 'Not found', detail, TYPE_NOT_FOUND)


def bad_request(detail: str):
    """400 — the request itself is malformed (an unparseable window, say)."""
    return problem(400, 'Bad request', detail, TYPE_BAD_REQUEST)


def conflict(detail: str):
    """409 — the request is well formed and the store's state refuses it."""
    return problem(409, 'Conflict', detail, TYPE_CONFLICT)


GESTURE_WRITE = 'write'
GESTURE_REMOVE = 'remove'


def unreplayable(detail: str, gesture: str, symbol: Optional[str] = None,
                 wanted: Optional[float] = None,
                 owned: Optional[float] = None,
                 day: Optional[str] = None,
                 account: Optional[str] = None):
    """409 — the ledger this gesture would leave does not replay (issue #824)."""
    return problem(409, 'Ledger does not replay', detail, TYPE_UNREPLAYABLE,
                   gesture=gesture, symbol=symbol, wanted=wanted, owned=owned,
                   day=day, account=account)


def unprocessable(detail: str, key: Optional[str] = None):
    """422 — the body parsed, and a value in it is not one the registry takes."""
    return problem(422, 'Invalid setting', detail, TYPE_INVALID_SETTING, key=key or None)


def unprocessable_parameter(detail: str, key: Optional[str] = None):
    """422 — a query parameter parsed, and its value is outside a closed set."""
    return problem(422, 'Invalid parameter', detail, TYPE_BAD_REQUEST, key=key or None)


def unprocessable_entry(detail: str, key: Optional[str] = None):
    """422 — the event parsed, and the ledger's own rules refuse it (issue #764)."""
    return problem(422, 'Invalid event', detail, TYPE_BAD_REQUEST, key=key or None)


def unprocessable_file(detail: str):
    """422 — the file parsed as far as it could, and it is not a ledger."""
    return problem(422, 'Invalid file', detail, TYPE_INVALID_FILE)


def too_large(detail: str, limit: int):
    """413 — the upload is past what one may carry."""
    return problem(413, 'File too large', detail, TYPE_TOO_LARGE, limit=limit)


def foreign_origin(detail: str):
    """403 — a write arrived from a page this app does not serve."""
    return problem(403, 'Foreign origin', detail, TYPE_FOREIGN_ORIGIN)


def internal_error(detail: str):
    """500 — the last resort, for what no route anticipated."""
    return problem(500, 'Internal error', detail, TYPE_INTERNAL)


__all__ = [
    'problem', 'storage_unavailable', 'not_found', 'bad_request', 'conflict',
    'unreplayable', 'unprocessable', 'unprocessable_parameter',
    'unprocessable_entry', 'unprocessable_file', 'too_large', 'foreign_origin',
    'internal_error',
    'CONTENT_TYPE', 'GESTURE_WRITE', 'GESTURE_REMOVE',
]
