"""The investor's profile under ``/api`` (#1116): the owner's own facts, and
the agent's proposals they confirm or ignore. The only place one is confirmed.
"""
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from application import profile as profile_module
from api.problem import (
    bad_request, conflict, not_found, unprocessable_request,
)
from api.common import _store, _json_object, current_runtime

bp = Blueprint('profile', __name__)

PROPOSAL_IDS_MAX = 50

_DECIDED = {'merged': 'déjà notée', 'ignored': 'déjà ignorée',
            'expired': 'expirée'}


def _now() -> datetime:
    return datetime.now(timezone.utc)


@bp.get('/profile')
def get_profile():
    """Every confirmed fact, the income amount included."""
    return jsonify(profile_module.read(_store()))


@bp.put('/profile/<key>')
def put_profile_fact(key):
    """Change one fact, or a project that exists. Answers the whole profile."""
    if not profile_module.is_key(key):
        return not_found(f"{key!r} is not a fact of the profile")
    body = _json_object()
    if body is None or 'value' not in body:
        return bad_request('a JSON object {"value": ...} is required')
    try:
        with current_runtime().config_manager.writing() as opened:
            profile_module.put(opened, key, body['value'], _now())
    except profile_module.InvalidProfileFact as exc:
        return unprocessable_request(str(exc), key=exc.key)
    except profile_module.UnknownFact:
        return not_found(f"no project {key!r} in the profile")
    return jsonify(profile_module.read(_store()))


@bp.delete('/profile/<key>')
def delete_profile_fact(key):
    """Forget one fact, at once."""
    if not profile_module.is_key(key):
        return not_found(f"{key!r} is not a fact of the profile")
    try:
        with current_runtime().config_manager.writing() as opened:
            profile_module.forget(opened, key)
    except profile_module.UnknownFact:
        return not_found(f"{key!r} is not declared")
    return '', 204


@bp.get('/profile/proposals')
def get_proposals():
    """The proposals ``ids`` names; an id that names none is left out."""
    ids = list(dict.fromkeys(
        part for part in (request.args.get('ids') or '').split(',') if part))
    if not 1 <= len(ids) <= PROPOSAL_IDS_MAX or not all(
            profile_module.is_proposal_id(i) for i in ids):
        return bad_request(
            f"'ids' is 1 to {PROPOSAL_IDS_MAX} proposal ids, comma-separated")
    return jsonify({'proposals': profile_module.read_proposals(
        _store(), ids, _now())})


@bp.post('/profile/proposals/<proposal_id>/confirm')
def confirm_proposal(proposal_id):
    """Write the proposed fact: the one road from a proposal to the profile."""
    return _decide(proposal_id, profile_module.confirm, with_profile=True)


@bp.post('/profile/proposals/<proposal_id>/ignore')
def ignore_proposal(proposal_id):
    """Leave the profile as it is; the proposal reads ``ignored``."""
    return _decide(proposal_id, profile_module.ignore, with_profile=False)


def _decide(proposal_id, decide, with_profile):
    if not profile_module.is_proposal_id(proposal_id):
        return not_found("no proposal has this id")
    try:
        with current_runtime().config_manager.writing() as opened:
            proposal = decide(opened, proposal_id, _now())
    except profile_module.UnknownProposal:
        return not_found(f"no proposal {proposal_id!r}")
    except profile_module.ProposalNotReady as exc:
        return conflict(f"Cette proposition est {_DECIDED[exc.status]}.")
    except profile_module.InvalidProfileFact as exc:
        return unprocessable_request(str(exc), key=exc.key)
    except profile_module.UnknownFact:
        return not_found("the project this proposal changes is gone")
    if with_profile:
        return jsonify({'proposal': proposal,
                        'profile': profile_module.read(_store())})
    return jsonify({'proposal': proposal})
