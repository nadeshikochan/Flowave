"""Admission for the local desktop API, before any business operation."""
import os
import hashlib
import hmac
from pathlib import Path
import re
import secrets
import time

from starlette.responses import JSONResponse

TRUSTED_ORIGIN = 'kumiko-app://renderer'
TOKEN_HEADER = 'x-flowave-token'


def _bound_token(value, data_dir):
    location = str(Path(data_dir).resolve()).replace('\\', '/').rstrip('/').lower()
    return hmac.new(bytes.fromhex(value), ('flowave-local-api-v1\n' + location).encode('utf-8'), hashlib.sha256).hexdigest()


def backend_token(data_dir):
    target = Path(data_dir) / 'electron' / 'backend-access-token'
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, 'w', encoding='ascii') as stream:
            stream.write(secrets.token_hex(32))
            stream.flush()
            os.fsync(stream.fileno())
    for _ in range(5):
        try:
            value = target.read_text(encoding='ascii').strip()
        except UnicodeError:
            value = ''
        if re.fullmatch(r'[0-9a-f]{64}', value):
            return _bound_token(value, data_dir)
        time.sleep(.02)
    value = secrets.token_hex(32)
    temporary = target.with_name(target.name + '.' + secrets.token_hex(8) + '.tmp')
    with temporary.open('x', encoding='ascii') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    return _bound_token(value, data_dir)


class DesktopAPIAccess:
    def __init__(self, app, token):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {}
        for key, value in scope['headers']:
            name = key.decode('latin-1').lower()
            if name in headers:
                headers[name] += ',' + value.decode('latin-1')
            else:
                headers[name] = value.decode('latin-1')
        origin = headers.get('origin', '')
        host = headers.get('host', '')
        allowed = re.fullmatch(r'(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?', host, re.IGNORECASE) is not None and origin in {'', TRUSTED_ORIGIN}
        preflight = scope['method'] == 'OPTIONS' and origin == TRUSTED_ORIGIN
        authenticated = secrets.compare_digest(headers.get(TOKEN_HEADER, '').encode('latin-1'), self.token.encode('ascii'))
        if not allowed or not (authenticated or preflight):
            response = JSONResponse({'detail': '本机服务请求未获授权'}, status_code=403,
                headers={'Access-Control-Allow-Origin': TRUSTED_ORIGIN} if origin == TRUSTED_ORIGIN else {})
            return await response(scope, receive, send)
        return await self.app(scope, receive, send)
