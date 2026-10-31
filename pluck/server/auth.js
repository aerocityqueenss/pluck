'use strict';

/**
 * Optional single-password gate. Off by default: on your own machine you are the only
 * client, and a login screen would just be ceremony. The moment Pluck listens on a public
 * address it is a browser-as-a-service for whoever finds the URL, so setting PLUCK_PASSWORD
 * is the difference between a tool and an open proxy.
 */

const crypto = require('node:crypto');

let password = '';

function init(fromEnv) {
  password = String(fromEnv || '');
  return password.length > 0;
}

function enabled() {
  return password.length > 0;
}

function token() {
  return crypto.createHash('sha256').update(`pluck|${password}`).digest('hex');
}

function cookieName() {
  return 'pluck_key';
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function basicPassword(req) {
  const header = req.headers.authorization || '';
  if (!/^basic /i.test(header)) return '';
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); } catch { return ''; }
  const i = decoded.indexOf(':');
  return i === -1 ? '' : decoded.slice(i + 1);
}

function check(req) {
  if (!enabled()) return true;
  if (safeEqual(basicPassword(req), password)) return true;
  return safeEqual(readCookie(req, cookieName()), token());
}

function isSecure(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'https') return true;
  return Boolean(req.socket && req.socket.encrypted);
}

/** Answers an unauthenticated request. Browsers show their own credentials dialog. */
function challenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Pluck", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('Pluck needs the password set in PLUCK_PASSWORD.\n');
}

/** Remembers a successful Basic login so the WebSocket handshake (which cannot prompt) passes. */
function grant(req, res) {
  if (req.headers.authorization) {
    const parts = [
      `${cookieName()}=${token()}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=2592000',
    ];
    if (isSecure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}

function rejectUpgrade(socket) {
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\n' +
    'WWW-Authenticate: Basic realm="Pluck", charset="UTF-8"\r\n' +
    'Connection: close\r\n\r\n'
  );
  socket.destroy();
}

module.exports = { init, enabled, check, challenge, grant, rejectUpgrade };
