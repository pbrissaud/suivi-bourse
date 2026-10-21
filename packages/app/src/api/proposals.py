"""The ledger events the agent proposed, under ``/api/agent/proposals`` (#1119).

Reviewed through the import's own pipeline (``api.events._run_import``) and
merged only here: the one road from a proposal to the ledger.
"""
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from application import event_proposals
from application import main
from application import profile as profile_module
from application import proposals as proposals_module
from application import uploads
from api.events import (
    IMPORT_REFUSALS, _asked, _receipt_to_dict, _run_import, _write_repeats,
    import_refusal,
)
from api.problem import (
    bad_request, conflict, not_found, proposal_stale, unprocessable_request,
)
from api.common import _store, current_runtime
from api.profile import PROPOSAL_IDS_MAX

bp = Blueprint('proposals', __name__)

_DECIDED = {'merged': 'déjà fusionnée', 'ignored': 'déjà ignorée',
            'expired': 'expirée'}


def _now() -> datetime:
    return datetime.now(timezone.utc)


@bp.get('/agent/proposals')
def get_proposals():
    """The proposals ``ids`` names; an id that names none is left out."""
    ids = list(dict.fromkeys(
        part for part in (request.args.get('ids') or '').split(',') if part))
    if not 1 <= len(ids) <= PROPOSAL_IDS_MAX or not all(
            profile_module.is_proposal_id(i) for i in ids):
        return bad_request(
            f"'ids' is 1 to {PROPOSAL_IDS_MAX} proposal ids, comma-separated")
    return jsonify({'proposals': event_proposals.read(_store(), ids, _now())})


@bp.post('/agent/proposals/<proposal_id>/preview')
def preview_proposal(proposal_id):
    """What merging would do, written nowhere: the import's dry run."""
    return _import(proposal_id, dry_run=True)


@bp.post('/agent/proposals/<proposal_id>/merge')
def merge_proposal(proposal_id):
    """Write the proposed events: the one road from a proposal to the ledger."""
    return _import(proposal_id, dry_run=False)


@bp.post('/agent/proposals/<proposal_id>/ignore')
def ignore_proposal(proposal_id):
    """Leave the ledger as it is; the proposal reads ``ignored``."""
    return _decided(proposal_id, lambda opened, now: {
        'proposal': event_proposals.ignore(opened, proposal_id, now)})


@bp.post('/agent/proposals/<proposal_id>/repropose')
def repropose_proposal(proposal_id):
    """The same events judged against the ledger as it is, as a new proposal."""
    def _again(opened, now):
        new_id = event_proposals.repropose(opened, proposal_id, now)
        return {'proposal': event_proposals.read(opened, [new_id], now)[0]}
    return _decided(proposal_id, _again)


def _decided(proposal_id, decide):
    if not profile_module.is_proposal_id(proposal_id):
        return not_found("no proposal has this id")
    try:
        with current_runtime().config_manager.writing() as opened:
            return jsonify(decide(opened, _now()))
    except event_proposals.InvalidProposal as exc:
        return unprocessable_request(str(exc), key=exc.field)
    except proposals_module.UnknownProposal:
        return not_found(f"no proposal {proposal_id!r}")
    except proposals_module.ProposalNotReady as exc:
        return _not_ready(exc)


def _not_ready(exc):
    if isinstance(exc, proposals_module.StaleProposal):
        return proposal_stale("Le grand livre a changé depuis cette proposition.")
    return conflict(f"Cette proposition est {_DECIDED[exc.status]}.")


def _import(proposal_id, *, dry_run):
    if not profile_module.is_proposal_id(proposal_id):
        return not_found("no proposal has this id")
    amounts_in = request.args.get('amounts_in')
    if amounts_in not in (None, 'base', 'quote'):
        return bad_request("amounts_in is either 'base' or 'quote'")
    now = _now()
    try:
        row = event_proposals.ready(_store(), proposal_id, now)
    except proposals_module.UnknownProposal:
        return not_found(f"no proposal {proposal_id!r}")
    except proposals_module.ProposalNotReady as exc:
        return _not_ready(exc)

    try:
        # A proposal has at most 200 lines: its answers fit the query string,
        # which the file import ignores (its groups do not).
        write_repeats = _write_repeats(request.args.getlist('write_repeat'))
    except uploads.UploadRefused as exc:
        return import_refusal(exc)
    parsed = uploads.merge([uploads.Upload(
        filename=row['title'], events=event_proposals.events_of(row),
        declared_currency=None)])
    try:
        done = _run_import(
            parsed, uploads.mapping(None), dry_run=dry_run,
            write_duplicates=_asked('write_duplicates'),
            write_repeats=write_repeats, adopt_currency=False,
            amounts_in=amounts_in,
            record=lambda opened, fresh, **how: event_proposals.merge(
                opened, proposal_id, now, fresh, **how))
    except proposals_module.ProposalNotReady as exc:
        return _not_ready(exc)
    except IMPORT_REFUSALS as exc:
        return import_refusal(exc)

    answer = _receipt_to_dict(
        uploads.receipt(parsed, done.rows, written=done.written,
                        duplicates=len(done.duplicates),
                        file_accounts=done.census),
        duplicates=done.duplicates, origin=parsed.origin,
        declared_currency=done.stated, foreign=done.foreign,
        unverified=done.unverified)
    answer['proposal'] = {'id': proposal_id, 'title': row['title'],
                          'status': 'ready' if dry_run else 'merged'}
    if dry_run:
        return jsonify(answer), 200
    main.replay_after_write(current_runtime())
    answer['written_ids'] = [str(event.id) for event in done.created]
    return jsonify(answer), 201
