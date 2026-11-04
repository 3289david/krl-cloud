'use strict';
// name.krl.kr 로 들어온 요청을 해당 서비스의 인스턴스로 로드밸런싱하여 전달한다.
// 가정용 PC 는 NAT 뒤에 있으므로, 에이전트가 아웃바운드로 롱폴링하고 요청을 릴레이받는 방식을 쓴다.
const S = require('./store');
const cfg = require('./config');
const C = require('./core');
const { readBody, send, token } = require('./util');

const queues = new Map();   // nodeId -> { items: [], waiter: fn|null }
const pending = new Map();  // reqId -> { resolve, reject, timer, nodeId }
const REQ_TIMEOUT = 30000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

function queueOf(nodeId) {
  let q = queues.get(nodeId);
  if (!q) queues.set(nodeId, (q = { items: [], waiter: null }));
  return q;
}

function relay(inst, payload) {
  return new Promise((resolve, reject) => {
    const id = token(8);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, REQ_TIMEOUT);
    pending.set(id, { resolve, reject, timer, nodeId: inst.nodeId });
    const q = queueOf(inst.nodeId);
    q.items.push({ id, instanceId: inst.id, ...payload });
    if (q.waiter) { const w = q.waiter; q.waiter = null; w(); }
  });
}

/** 에이전트의 롱폴링: 대기 중인 요청이 생기면 즉시 반환 */
function poll(nodeId, res) {
  const q = queueOf(nodeId);
  const flush = () => {
    const items = q.items.splice(0, 20);
    send(res, 200, { requests: items });
  };
  if (q.items.length) return flush();
  if (q.waiter) q.waiter(); // 이전 폴링 해제
  const timer = setTimeout(() => { q.waiter = null; send(res, 200, { requests: [] }); }, 20000);
  q.waiter = () => { clearTimeout(timer); flush(); };
  res.on('close', () => { if (q.waiter) { clearTimeout(timer); q.waiter = null; } });
}

function respond(id, data) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer); pending.delete(id);
  p.resolve(data);
  return true;
}

function failNode(nodeId) {
  for (const [id, p] of pending) if (p.nodeId === nodeId) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error('node lost')); }
}

// ---------- 라우팅 ----------
function hostOf(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].split(':')[0].toLowerCase();
}

/** 호스트 -> 서비스. 대시보드 호스트면 null */
function resolveService(host) {
  const db = S.db;
  for (const base of [cfg.BASE_DOMAIN, ...cfg.DEV_DOMAINS]) {
    if (host.endsWith('.' + base)) {
      const sub = host.slice(0, -base.length - 1);
      if (['app', 'www', 'dashboard'].includes(sub)) return null;
      return Object.values(db.services).find((s) => s.slug === sub) || false;
    }
  }
  for (const s of Object.values(db.services)) if (s.domains.some((d) => d.verified && d.host === host)) return s;
  return null;
}

function pickInstance(svc, tried) {
  const m = C.svcMetrics(svc.id);
  let best = null, bestLoad = Infinity;
  for (const i of Object.values(S.db.instances)) {
    if (i.serviceId !== svc.id || i.status !== 'running' || !i.desired && !i.draining || tried.has(i.id)) continue;
    if (i.deploymentId !== svc.currentDeploymentId && !i.draining) continue;
    const n = S.db.nodes[i.nodeId];
    if (!n || !C.nodeOnline(n)) continue;
    const load = (m.inflight.get(i.id) || 0) + ((n.metrics && n.metrics.cpuLoad) || 0) / 200 + Math.random() * 0.01;
    if (load < bestLoad) { bestLoad = load; best = i; }
  }
  return best;
}

const page = (title, msg) => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b1020;color:#e8ecff;font-family:system-ui,sans-serif">
<div style="text-align:center;padding:24px"><div style="font-size:48px">☁️</div><h1 style="margin:8px 0">${title}</h1><p style="opacity:.7">${msg}</p><p style="opacity:.4;font-size:13px">KRL Cloud</p></div></body></html>`;

async function handle(req, res, svc) {
  const t0 = Date.now();
  if (!svc) return send(res, 404, page('404 - 서비스를 찾을 수 없습니다', '이 주소에 연결된 서비스가 없습니다.'), { 'content-type': 'text/html; charset=utf-8' });
  if (svc.type === 'worker' || svc.type === 'cron' || svc.type === 'private') return send(res, 404, page('404', '이 서비스는 공개 HTTP 엔드포인트가 없습니다.'), { 'content-type': 'text/html; charset=utf-8' });
  if (svc.status === 'suspended') return send(res, 503, page('서비스 일시 중지', '크레딧이 부족하여 서비스가 중지되었습니다.'), { 'content-type': 'text/html; charset=utf-8' });
  let body;
  try { body = await readBody(req); } catch { return send(res, 413, 'Payload too large', { 'content-type': 'text/plain' }); }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers['x-forwarded-for'] = [req.headers['cf-connecting-ip'] || req.socket.remoteAddress].join(',');
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  headers['x-forwarded-host'] = hostOf(req);
  const payload = { method: req.method, path: req.url, headers, body: body.toString('base64') };

  const idem = req.method === 'GET' || req.method === 'HEAD';
  const tried = new Set();
  const m = C.svcMetrics(svc.id);
  for (let attempt = 0; attempt < (idem ? 3 : 1); attempt++) {
    const inst = pickInstance(svc, tried);
    if (!inst) break;
    tried.add(inst.id);
    m.inflight.set(inst.id, (m.inflight.get(inst.id) || 0) + 1);
    try {
      const r = await relay(inst, payload);
      const out = Buffer.from(r.body || '', 'base64');
      const rh = {};
      for (const [k, v] of Object.entries(r.headers || {})) if (!HOP.has(k.toLowerCase())) rh[k] = v;
      rh['x-krl-instance'] = inst.id;
      rh['x-krl-node'] = (S.db.nodes[inst.nodeId] || {}).name || '';
      res.writeHead(r.status || 502, rh);
      res.end(req.method === 'HEAD' ? undefined : out);
      C.recordRequest(svc, inst, { bytes: out.length, ms: Date.now() - t0, err: (r.status || 502) >= 500 });
      return;
    } catch (e) {
      // 다음 인스턴스로 재시도 (장애 노드 자동 우회)
    } finally {
      m.inflight.set(inst.id, Math.max(0, (m.inflight.get(inst.id) || 1) - 1));
    }
  }
  C.recordRequest(svc, null, { bytes: 0, ms: Date.now() - t0, err: true });
  const starting = C.serviceInstances(svc.id).length > 0;
  send(res, 503, page(starting ? '서비스를 시작하는 중입니다' : '서비스를 사용할 수 없습니다',
    starting ? '잠시 후 다시 시도해 주세요. 인스턴스가 준비되면 자동으로 연결됩니다.' : '실행 중인 인스턴스가 없습니다.'), { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
}

module.exports = { handle, resolveService, hostOf, poll, respond, failNode, queues };
