'use strict';
const crypto = require('crypto');
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const notFound = (m = '찾을 수 없습니다') => new HttpError(404, m);

function readBody(req, limit = cfg.MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '요청 본문이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw bad('잘못된 JSON'); }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { 'content-length': Buffer.byteLength(data), ...headers };
  if (!h['content-type']) h['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, h);
  res.end(data);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const token = (n = 24) => crypto.randomBytes(n).toString('hex');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'dashboard', 'console', 'mail', 'ns', 'ns1', 'ns2',
  'ftp', 'smtp', 'status', 'docs', 'blog', 'help', 'support', 'root', 'krl', 'cdn', 'static', 'assets', 'login', 'signup']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

module.exports = { HttpError, bad, notFound, readBody, readJson, send, parseCookies, token, hashPassword,
  verifyPassword, RESERVED, SLUG_RE, clamp, round };
