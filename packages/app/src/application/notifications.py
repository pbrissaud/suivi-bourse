"""The outbound notification channels, and what is pushed through them (§ 3.6).

A channel is a place the app speaks when the owner is not looking: an ntfy
topic, an address, a webhook, an Apprise URL. It carries the **scopes** it wants
(advisory kinds plus ``job_failed``) and is dispatched to when

- a ``user``-register advisory starts standing (:func:`sweep`, after every
  scrape pass, and when the update check learns of a release), or
- a job pass fails (:func:`job_failed`).

An advisory is derived on every read and stored nowhere, so "raised" needs a
memory: ``advisory_dispatch`` holds the keys already sent. A key is forgotten
when it stops standing, so the next time it stands it is sent again; a failing
job is sent at most once per :data:`JOB_COOLDOWN`.

**Secrets** (the SMTP password, the webhook or ntfy token) are stored in clear
in ``notification_channel.secret`` exactly like the agent's key, and leave the
server as ``…last4`` only. Sending is best effort: a refusal is logged with the
channel's id and kind, never its secret, and never raises into a job.
"""
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional

from logfmt_logger import getLogger

from application import advisories
from application import instants
from application import job_history
from application import notification_senders as senders

logger = getLogger("notifications")

#: The scope of a failing job; the others are advisory kinds.
JOB_FAILED = 'job_failed'
SCOPES = (advisories.LATE_PRICE, advisories.UPDATE_AVAILABLE, JOB_FAILED)
JOB_COOLDOWN = timedelta(hours=6)
LANGUAGES = ('fr', 'en')
DEFAULT_LANGUAGE = 'fr'
#: The non-secret settings a channel may carry, per kind.
OPTIONS = {
    'email': ('host', 'port', 'username', 'sender', 'starttls', 'lang'),
    'ntfy': ('lang',),
    'webhook': ('lang',),
    'apprise': ('lang',),
}

_COLUMNS = 'id, kind, target, secret, options, scopes, enabled, created_at'

_JOB_LABELS = {
    'scrape': ('Mise à jour des cours', 'Price updates'),
    'backfill': ('Reconstruction de l’historique', 'History rebuild'),
    'performance': ('Calcul de la performance', 'Performance calculation'),
    'ingestion': ('Relecture du grand livre', 'Ledger re-read'),
}


class InvalidChannel(ValueError):
    """A channel the owner described that cannot be kept; ``key`` is the field."""

    def __init__(self, message: str, key: Optional[str] = None):
        super().__init__(message)
        self.key = key


class UnknownChannel(LookupError):
    """No channel stands under this id."""


@dataclass(frozen=True)
class Channel:
    id: str
    kind: str
    target: str
    secret: Optional[str]
    options: Dict[str, Any]
    scopes: List[str]
    enabled: bool
    created_at: datetime

    @property
    def language(self) -> str:
        return self.options.get('lang') or DEFAULT_LANGUAGE

    def to_dict(self) -> Dict[str, Any]:
        """The channel as the API shows it: the secret as ``…last4`` only."""
        return {
            'id': self.id,
            'kind': self.kind,
            'target': self.target,
            'options': self.options,
            'scopes': self.scopes,
            'enabled': self.enabled,
            'has_secret': bool(self.secret),
            'secret_last4': self.secret[-4:] if self.secret else None,
            'available': self.kind != 'apprise' or senders.apprise_available(),
            'created_at': instants.iso(self.created_at),
        }


def _channel(row) -> Channel:
    identifier, kind, target, secret, options, scopes, enabled, created = row
    return Channel(identifier, kind, target, secret, json.loads(options or '{}'),
                   json.loads(scopes or '[]'), bool(enabled),
                   instants.utc(created))


def read_all(opened) -> List[Channel]:
    return [_channel(row) for row in opened.query(
        f'SELECT {_COLUMNS} FROM notification_channel ORDER BY created_at, id')]


def read_one(opened, identifier: str) -> Channel:
    rows = opened.query(
        f'SELECT {_COLUMNS} FROM notification_channel WHERE id = ?', [identifier])
    if not rows:
        raise UnknownChannel(identifier)
    return _channel(rows[0])


# -- validation ---------------------------------------------------------------

def _target(kind: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidChannel('The address is required', 'target')
    value = value.strip()
    if kind in ('ntfy', 'webhook') and not value.startswith(('http://', 'https://')):
        raise InvalidChannel('The address must start with http:// or https://',
                             'target')
    if kind == 'email' and '@' not in value:
        raise InvalidChannel('This is not an e-mail address', 'target')
    return value


def _scopes(value: Any) -> List[str]:
    listed = isinstance(value, list) and all(isinstance(one, str) for one in value)
    if not listed or any(one not in SCOPES for one in value):
        raise InvalidChannel(
            f'The scopes are a list taken from {", ".join(SCOPES)}', 'scopes')
    return [one for one in SCOPES if one in value]


def _options(kind: str, value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidChannel('The options are an object', 'options')
    unknown = sorted(set(value) - set(OPTIONS[kind]))
    if unknown:
        raise InvalidChannel(f'A {kind} channel has no option {unknown[0]!r}',
                             'options')
    kept = {name: value[name] for name in OPTIONS[kind]
            if value.get(name) not in (None, '')}
    if kept.get('lang', DEFAULT_LANGUAGE) not in LANGUAGES:
        raise InvalidChannel('The language is fr or en', 'options')
    if 'port' in kept:
        port = kept['port']
        if not isinstance(port, int) or isinstance(port, bool) \
                or not 0 < port < 65536:
            raise InvalidChannel('The port is a number between 1 and 65535',
                                 'options')
    if kind == 'email' and not (kept.get('host') and kept.get('sender')):
        raise InvalidChannel('The SMTP server and the sender are required',
                             'options')
    return kept


def _secret(value: Any) -> Optional[str]:
    if value is None or value == '':
        return None
    if not isinstance(value, str):
        raise InvalidChannel('The secret is a string', 'secret')
    return value


def _enabled(value: Any) -> bool:
    if not isinstance(value, bool):
        raise InvalidChannel('Enabled is true or false', 'enabled')
    return value


# -- the gestures -------------------------------------------------------------

def create(opened, body: Mapping[str, Any],
           now: Optional[datetime] = None) -> Channel:
    """Add a channel. ``kind``, ``target`` and ``scopes`` are required."""
    kind = body.get('kind')
    if kind not in senders.KINDS:
        raise InvalidChannel(f'The kind is one of {", ".join(senders.KINDS)}',
                             'kind')
    channel = Channel(
        id=uuid.uuid4().hex,
        kind=kind,
        target=_target(kind, body.get('target')),
        secret=_secret(body.get('secret')),
        options=_options(kind, body.get('options') or {}),
        scopes=_scopes(body.get('scopes', [])),
        enabled=_enabled(body.get('enabled', True)),
        created_at=now or datetime.now(timezone.utc))
    opened.execute(
        f'INSERT INTO notification_channel ({_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [channel.id, channel.kind, channel.target, channel.secret,
         json.dumps(channel.options), json.dumps(channel.scopes),
         channel.enabled, channel.created_at])
    return channel


def change(opened, identifier: str, body: Mapping[str, Any]) -> Channel:
    """Change any of ``target``, ``secret``, ``options``, ``scopes``, ``enabled``.

    The kind is the channel's identity and does not change. A ``secret`` left out
    is kept; ``null`` or ``''`` forgets it.
    """
    current = read_one(opened, identifier)
    if 'kind' in body and body['kind'] != current.kind:
        raise InvalidChannel('A channel cannot change kind; add another', 'kind')
    changed = Channel(
        id=current.id,
        kind=current.kind,
        target=_target(current.kind, body['target']) if 'target' in body
        else current.target,
        secret=_secret(body['secret']) if 'secret' in body else current.secret,
        options=_options(current.kind, body['options']) if 'options' in body
        else current.options,
        scopes=_scopes(body['scopes']) if 'scopes' in body else current.scopes,
        enabled=_enabled(body['enabled']) if 'enabled' in body else current.enabled,
        created_at=current.created_at)
    opened.execute(
        'UPDATE notification_channel SET target = ?, secret = ?, options = ?, '
        'scopes = ?, enabled = ? WHERE id = ?',
        [changed.target, changed.secret, json.dumps(changed.options),
         json.dumps(changed.scopes), changed.enabled, changed.id])
    return changed


def remove(opened, identifier: str) -> None:
    read_one(opened, identifier)
    opened.execute('DELETE FROM notification_channel WHERE id = ?', [identifier])


# -- sending ------------------------------------------------------------------

def deliver(channel: Channel, notice: senders.Notice) -> None:
    """Send one notice through one channel; ``SendError`` says why not."""
    senders.send(channel.kind, channel.target, channel.secret, channel.options,
                 notice)


def probe_notice(channel: Channel) -> senders.Notice:
    """What *Tester* sends."""
    if channel.language == 'en':
        return senders.Notice('Test notification', 'Suivi Bourse can reach this channel.',
                              kind='test')
    return senders.Notice('Notification de test',
                          'Suivi Bourse peut joindre ce canal.', kind='test')


def _fan_out(channels: List[Channel], scope: str, notices: Mapping[str, senders.Notice]
             ) -> None:
    """Send ``notices[language]`` to every enabled channel that wants ``scope``."""
    for channel in channels:
        if not channel.enabled or scope not in channel.scopes:
            continue
        try:
            deliver(channel, notices.get(channel.language) or notices[DEFAULT_LANGUAGE])
        except senders.SendError as exc:
            logger.warning(f"Channel {channel.id} ({channel.kind}) refused a "
                           f"{scope} notice: {exc}")
        except Exception as exc:  # a sender is third-party I/O; never reach a job
            logger.warning(f"Channel {channel.id} ({channel.kind}) failed on a "
                           f"{scope} notice: {type(exc).__name__}")


def _notices(advisory: advisories.Advisory) -> Dict[str, senders.Notice]:
    url = advisory.detail.get('url')
    return {lang: senders.Notice(text['title'], text['sub'], url, advisory.kind)
            for lang, text in (advisory.texts or {}).items()}


def sweep(manager, recorder, release: Optional[Dict[str, str]] = None,
          now: Optional[datetime] = None) -> List[advisories.Advisory]:
    """Push the ``user`` advisories that started standing since the last sweep.

    ``release`` is the update check's answer when the caller has one; without
    it, the ``update_available`` keys already sent are left alone rather than
    forgotten. Returns the advisories sent (to the channels that want them, if
    any: a key is marked sent either way, so adding a channel does not replay
    what stood before it).
    """
    now = now or datetime.now(timezone.utc)
    reader = manager.store.reader()
    standing = advisories.standing(reader, now, register=advisories.REGISTER_USER,
                                   recorder=recorder, release=release)
    keys = {one.key for one in standing}
    sent = {key for (key,) in reader.query('SELECT key FROM advisory_dispatch')}
    fresh = [one for one in standing if one.key not in sent]
    kept = (f'{JOB_FAILED}:',
            *(() if release is not None else (f'{advisories.UPDATE_AVAILABLE}:',)))
    gone = [key for key in sent - keys if not key.startswith(kept)]
    if not fresh and not gone:
        return []

    with manager.writing() as opened:
        with opened.transaction():
            for key in gone:
                opened.execute('DELETE FROM advisory_dispatch WHERE key = ?', [key])
            for one in fresh:
                opened.execute(
                    'INSERT INTO advisory_dispatch (key, sent_at) VALUES (?, ?) '
                    'ON CONFLICT (key) DO NOTHING', [one.key, now])
        channels = read_all(opened)
    for one in fresh:
        _fan_out(channels, one.kind, _notices(one))
    return fresh


def job_failed(manager, job: str, member: Optional[str], error: Optional[str],
               now: Optional[datetime] = None) -> bool:
    """Tell the channels that want ``job_failed`` about a failing pass.

    At most once per :data:`JOB_COOLDOWN` for one ``(job, member)``, or a scrape
    failing every two minutes would be a flood. Returns whether it was sent.
    """
    now = now or datetime.now(timezone.utc)
    key = f'{JOB_FAILED}:{job}:{member or ""}'
    with manager.writing() as opened:
        channels = [one for one in read_all(opened)
                    if one.enabled and JOB_FAILED in one.scopes]
        if not channels:
            return False
        rows = opened.query('SELECT sent_at FROM advisory_dispatch WHERE key = ?',
                            [key])
        if rows and now - instants.utc(rows[0][0]) < JOB_COOLDOWN:
            return False
        opened.execute(
            'INSERT INTO advisory_dispatch (key, sent_at) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET sent_at = EXCLUDED.sent_at',
            [key, now])
    fr, en = _JOB_LABELS.get(job, (job, job))
    what = f' · {member}' if member else ''
    detail = (error or '')[:200]
    _fan_out(channels, JOB_FAILED, {
        'fr': senders.Notice(f'Échec : {fr}{what}', detail, kind=JOB_FAILED),
        'en': senders.Notice(f'Failed: {en}{what}', detail, kind=JOB_FAILED),
    })
    return True


def after_pass(ctx, job: str, member: Optional[str], run) -> None:
    """Run after every job pass, **off the job's thread**; swallows everything."""
    try:
        if run is not None and run.outcome == job_history.ERROR:
            job_failed(ctx.config_manager, job, member, run.error)
        if job == 'scrape':
            sweep(ctx.config_manager, ctx.recorder)
    except Exception as exc:
        logger.debug(f"notification pass after {job} skipped: "
                     f"{type(exc).__name__}: {exc}")


__all__ = [
    'JOB_FAILED', 'SCOPES', 'Channel', 'InvalidChannel', 'UnknownChannel',
    'read_all', 'read_one', 'create', 'change', 'remove', 'deliver',
    'probe_notice', 'sweep', 'job_failed', 'after_pass',
]
