"""The outbound notification channels under ``/api`` (§ 3.6).

A channel's secret is in no answer but as ``…last4``; a refusal names the field
and never the secret.
"""
from flask import Blueprint, jsonify

from application import notification_senders as senders
from application import notifications
from api.problem import channel_refused, not_found, unprocessable
from api.common import _json_object, _store, current_runtime

bp = Blueprint('notifications', __name__)


def _gone(identifier: str):
    return not_found(f"No notification channel is named {identifier!r}")


@bp.get('/notification-channels')
def list_channels():
    return jsonify([one.to_dict() for one in notifications.read_all(_store())])


@bp.post('/notification-channels')
def add_channel():
    """Add a channel: ``kind``, ``target``, ``scopes``; ``secret`` and ``options`` if its kind needs them."""
    try:
        with current_runtime().config_manager.writing() as opened:
            channel = notifications.create(opened, _json_object() or {})
    except notifications.InvalidChannel as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(channel.to_dict()), 201


@bp.patch('/notification-channels/<identifier>')
def change_channel(identifier: str):
    """Change any of ``target``, ``secret``, ``options``, ``scopes``, ``enabled``."""
    try:
        with current_runtime().config_manager.writing() as opened:
            channel = notifications.change(opened, identifier, _json_object() or {})
    except notifications.UnknownChannel:
        return _gone(identifier)
    except notifications.InvalidChannel as exc:
        return unprocessable(str(exc), key=exc.key)
    return jsonify(channel.to_dict())


@bp.delete('/notification-channels/<identifier>')
def delete_channel(identifier: str):
    try:
        with current_runtime().config_manager.writing() as opened:
            notifications.remove(opened, identifier)
    except notifications.UnknownChannel:
        return _gone(identifier)
    return '', 204


@bp.post('/notification-channels/<identifier>/test')
def test_channel(identifier: str):
    """Send a test notice now, scopes and ``enabled`` aside; 502 says why not."""
    try:
        channel = notifications.read_one(_store(), identifier)
    except notifications.UnknownChannel:
        return _gone(identifier)
    try:
        notifications.deliver(channel, notifications.probe_notice(channel))
    except senders.SendError as exc:
        return channel_refused(str(exc), channel.kind)
    return jsonify({'ok': True})
