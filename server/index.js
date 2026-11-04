'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./store');
const cfg = require('./config');
const C = require('./core');
const G = require('./gateway');
const U = require('./util');
const api = require('./api');
const R = require('./reconciler');
const E = require('./economy');

S.load();

const WEB = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// 공개 사이트 페이지 (확장자 없는 경로 -> html)
const PAGES = { '/': '/landing.html', '/app': '/index.html', '/terms': '/terms.html', '/privacy': '/privacy.html', '/status': '/status.html' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]).replace(/\/+$/, '') || '/';
  if (PAGES[p]) p = PAGES[p];
  else if (!path.extname(p)) return U.send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) return U.send(res, 403, 'forbidden', { 'content-type': 'text/plain' });
  fs.readFile(file, (err, data) => {
    if (err) return U.send(res, 404, 'not found', { 'content-type': 'text/plain' });
    U.send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
  });
}

// 에이전트 배포: 원라이너 설치 스크립트에 이 서버 주소를 주입해서 내려준다
function serveInstaller(req, res, url) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const file = url.pathname === '/agent/agent.js' ? path.join(__dirname, '..', 'agent', 'agent.js') : path.join(__dirname, '..', 'packaging', url.pathname.slice(1));
  fs.readFile(file, 'utf8', (err, txt) => {
    if (err) return U.send(res, 404, 'not found', { 'content-type': 'text/plain' });
    U.send(res, 200, txt.replace(/__SERVER__/g, origin), { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  });
}

async function handleApi(req, res, url) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  for (const r of api.routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), origin, headers: {} };
    if (!r.agent && req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) throw new U.HttpError(415, 'application/json 이 필요합니다');
    if (!r.anon && !r.agent) ctx.user = api.sessionUser(req) || (() => { throw new U.HttpError(401, '로그인이 필요합니다'); })();
    if (req.method !== 'GET') {
      if (r.body === 'large') { const b = await U.readBody(req, 16 * 1024 * 1024); try { ctx.body = JSON.parse(b.toString() || '{}'); } catch { throw U.bad('잘못된 JSON'); } }
      else ctx.body = await U.readJson(req);
    } else ctx.body = {};
    const out = await r.fn(ctx);
    if (r.raw) return;
    return U.send(res, 200, out === undefined ? { ok: true } : out, ctx.headers);
  }
  throw U.notFound('API 경로를 찾을 수 없습니다');
}

async function githubHook(req, res, url) {
  const m = /^\/hooks\/github\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const svc = m && S.db.services[m[1]];
  if (!svc || svc.webhookSecret !== m[2]) return U.send(res, 404, { error: 'not found' });
  const body = await U.readJson(req);
  if (req.headers['x-github-event'] === 'ping') return U.send(res, 200, { ok: 'pong' });
  const branch = String(body.ref || '').replace('refs/heads/', '');
  if (!svc.autoDeploy || svc.source.kind !== 'github' || (branch && branch !== svc.source.branch)) return U.send(res, 200, { skipped: true });
  const d = C.createDeployment(svc, 'github', null, { message: (body.head_commit && body.head_commit.message || '').slice(0, 120) });
  U.send(res, 200, { deployment: d.id });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = G.hostOf(req);
    const url = new URL(req.url, 'http://x');
    // Cloudflare/프록시에서 커스텀 도메인 인증서 발급 허용 여부 확인용
    if (url.pathname === '/internal/tls-ask') {
      if (cfg.ASK_TOKEN && url.searchParams.get('token') !== cfg.ASK_TOKEN) return U.send(res, 403, 'no', { 'content-type': 'text/plain' });
      const d = String(url.searchParams.get('domain') || '').toLowerCase();
      return U.send(res, G.resolveService(d) ? 200 : 404, 'ok', { 'content-type': 'text/plain' });
    }
    const svc = G.resolveService(host);
    if (svc !== null) return await G.handle(req, res, svc || null); // false => 존재하지 않는 서브도메인
    if (url.pathname === '/agent/agent.js' || url.pathname === '/install.sh' || url.pathname === '/install.ps1') return serveInstaller(req, res, url);
    if (url.pathname.startsWith('/api/')) { res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store'); return await handleApi(req, res, url); }
    if (url.pathname.startsWith('/hooks/github/')) return await githubHook(req, res, url);
    if (url.pathname === '/healthz') return U.send(res, 200, 'ok', { 'content-type': 'text/plain' });
    serveStatic(req, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof U.HttpError) return U.send(res, e.status, { error: e.message });
    console.error('[server]', e);
    U.send(res, 500, { error: '서버 오류' });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 30000;

R.start();
E.start();
require('./cloudflare').ensureWildcard().then((id) => id && console.log(`Cloudflare 와일드카드 *.${cfg.BASE_DOMAIN} 준비 완료`)).catch((e) => console.error('[cloudflare]', e.message));
server.listen(cfg.PORT, () => {
  console.log(`KRL Cloud 컨트롤 플레인: http://localhost:${cfg.PORT}`);
  console.log(`무료 서브도메인: <name>.${cfg.BASE_DOMAIN}  (개발: <name>.localhost:${cfg.PORT})`);
});
process.on('SIGINT', () => { S.save(); process.exit(0); });
process.on('SIGTERM', () => { S.save(); process.exit(0); });
