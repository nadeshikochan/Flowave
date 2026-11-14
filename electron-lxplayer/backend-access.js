const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function backendToken(dataDir) {
  const target = path.join(dataDir, 'electron', 'backend-access-token');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (descriptor !== undefined) {
    try {
      fs.writeFileSync(descriptor, crypto.randomBytes(32).toString('hex'));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }
  let value = fs.readFileSync(target, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    value = crypto.randomBytes(32).toString('hex');
    const temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const replacement = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(replacement, value); fs.fsyncSync(replacement); }
    finally { fs.closeSync(replacement); }
    fs.renameSync(temporary, target);
  }
  const location = path.resolve(dataDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHmac('sha256', Buffer.from(value, 'hex')).update('flowave-local-api-v1\n' + location).digest('hex');
}

function authenticatedLocalRequest(headers, token) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(headers.host || '')) return false;
  if (headers.origin && headers.origin !== 'kumiko-app://renderer') return false;
  const supplied = Buffer.from(headers['x-flowave-token'] || '');
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {backendToken, authenticatedLocalRequest};
