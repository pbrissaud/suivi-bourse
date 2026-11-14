"""One sender per outbound channel kind (§ 3.6).

A sender takes what the channel stores (``target``, ``secret``, ``options``) and
one :class:`Notice`, and either returns or raises :class:`SendError` with a
sentence the owner can read in the Réglages panel next to *Tester*. Nothing here
reads the store: the caller hands everything over, which is what keeps this
module in ``core`` and testable with an injected transport.

The transports are the stdlib's (``urllib`` for ntfy and webhooks, ``smtplib``
for e-mail), like :mod:`update_check` and :mod:`bounded_get`. Apprise is used
only if the library is installed; it is not a dependency of this project, so the
kind is accepted and answers *not available* until someone installs it.
"""
import json
import smtplib
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Callable, Dict, Mapping, Optional
from urllib.parse import urlsplit

KINDS = ('ntfy', 'email', 'webhook', 'apprise')
TIMEOUT = 8
USER_AGENT = 'suivi-bourse'


class SendError(Exception):
    """The channel did not take the notice; the message says why, never the secret."""


@dataclass(frozen=True)
class Notice:
    """What is said: a title, a line under it, and where it leads."""

    title: str
    body: str = ''
    url: Optional[str] = None
    #: The advisory kind (or ``job_failed``) it comes from.
    kind: str = ''


def apprise_available() -> bool:
    try:
        import apprise  # noqa: F401
    except ImportError:
        return False
    return True


def _post(url: str, data: bytes, headers: Mapping[str, str]) -> None:
    if urlsplit(url).scheme not in ('http', 'https'):
        raise SendError('The address must start with http:// or https://')
    request = urllib.request.Request(
        url, data=data, method='POST',
        headers={'User-Agent': USER_AGENT, **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            if not 200 <= response.status < 300:
                raise SendError(f'HTTP {response.status}')
    except urllib.error.HTTPError as exc:
        raise SendError(f'HTTP {exc.code}') from None
    except (urllib.error.URLError, OSError) as exc:
        raise SendError(f'Unreachable: {getattr(exc, "reason", exc)}') from None


def _bearer(secret: Optional[str]) -> Dict[str, str]:
    return {'Authorization': f'Bearer {secret}'} if secret else {}


def send_ntfy(target: str, secret: Optional[str], options: Mapping[str, Any],
              notice: Notice) -> None:
    """POST the body to the topic URL; title and click target ride in headers."""
    headers = {'Title': notice.title.encode('utf-8').decode('latin-1'),
               **_bearer(secret)}
    if notice.url:
        headers['Click'] = notice.url
    _post(target, (notice.body or notice.title).encode('utf-8'), headers)


def send_webhook(target: str, secret: Optional[str], options: Mapping[str, Any],
                 notice: Notice) -> None:
    """POST a small JSON object: ``{title, body, url, kind}``."""
    payload = json.dumps({'title': notice.title, 'body': notice.body,
                          'url': notice.url, 'kind': notice.kind}).encode('utf-8')
    _post(target, payload, {'Content-Type': 'application/json', **_bearer(secret)})


def send_email(target: str, secret: Optional[str], options: Mapping[str, Any],
               notice: Notice) -> None:
    """Mail ``target`` through the SMTP server ``options`` names."""
    host, sender = options.get('host'), options.get('sender')
    if not host or not sender:
        raise SendError('The SMTP server and the sender address are required')
    message = EmailMessage()
    message['Subject'] = notice.title
    message['From'] = sender
    message['To'] = target
    message.set_content('\n\n'.join(
        part for part in (notice.body, notice.url) if part) or notice.title)
    port = int(options.get('port') or 587)
    try:
        if port == 465:
            smtp = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT,
                                    context=ssl.create_default_context())
        else:
            smtp = smtplib.SMTP(host, port, timeout=TIMEOUT)
        with smtp:
            if port != 465 and options.get('starttls', True):
                smtp.starttls(context=ssl.create_default_context())
            if options.get('username'):
                smtp.login(options['username'], secret or '')
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise SendError('The SMTP server refused the login') from None
    except (smtplib.SMTPException, OSError) as exc:
        raise SendError(f'SMTP: {type(exc).__name__}') from None


def send_apprise(target: str, secret: Optional[str], options: Mapping[str, Any],
                 notice: Notice) -> None:
    """Hand the notice to Apprise, if it is installed."""
    try:
        import apprise
    except ImportError:
        raise SendError('Apprise is not available in this installation') from None
    hub = apprise.Apprise()
    if not hub.add(target):
        raise SendError('Apprise does not understand this address')
    if not hub.notify(title=notice.title, body=notice.body or notice.title):
        raise SendError('Apprise could not deliver the notice')


SENDERS: Dict[str, Callable[..., None]] = {
    'ntfy': send_ntfy,
    'email': send_email,
    'webhook': send_webhook,
    'apprise': send_apprise,
}


def send(kind: str, target: str, secret: Optional[str],
         options: Mapping[str, Any], notice: Notice) -> None:
    """Send through the sender of ``kind`` (looked up late, so a test can swap it)."""
    try:
        sender = SENDERS[kind]
    except KeyError:
        raise SendError(f'Unknown channel kind {kind!r}') from None
    sender(target, secret, options, notice)


__all__ = ['KINDS', 'Notice', 'SendError', 'SENDERS', 'apprise_available', 'send']
