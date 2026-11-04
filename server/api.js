'use strict';
const dns = require('dns').promises;
const S = require('./store');
const L = require('./ledger');
const cfg = require('./config');
const C = require('./core');
const G = require('./gateway');
const E = require('./economy');
const cf = require('./cloudflare');
const R = require('./reconciler');
const { PLANS, hourlyCost } = require('./plans');
const { TEMPLATES, RUNTIME_DEFAULTS } = require('./templates');
const U = require('./util');
const { bad, notFound, HttpError, clamp } = U;

const COUNTRY = { seoul: 'KR', busan: 'KR', incheon: 'KR', daejeon: 'KR', jeju: 'KR', tokyo: 'JP', osaka: 'JP', singapore: 'SG', 'us-west': 'US', 'us-east': 'US', 'eu-west': 'DE' };
const REGIONS = Object.keys(COUNTRY);

// ---------- 인증 ----------
const loginFails = new Map();
function sessionUser(req) {
  const sid = U.parseCookies(req).krl_sid;
  const s = sid && S.db.sessions[sid];
  if (!s || s.exp < S.now()) return null;
  return S.db.users[s.userId] || null;
}
function requireUser(req) {
  const u = sessionUser(req);
  if (!u) throw new HttpError(401, '로그인이 필요합니다');
  return u;
}
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
function newSession(req, user) {
  const sid = U.token(24);
  S.db.sessions[sid] = { userId: user.id, exp: S.now() + 30 * 86400000 };
  S.touch();
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || !!req.headers['cf-visitor'];
  return { 'set-cookie': `krl_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${https ? '; Secure' : ''}` };
}
const userView = (u) => ({ id: u.id, email: u.email, name: u.name, credits: U.round(u.credits, 2), createdAt: u.createdAt, lastDaily: u.lastDaily || 0 });

function own(collection, id, user) {
  const o = S.db[collection][id];
  if (!o || o.ownerId !== user.id) throw notFound();
  return o;
}

// ---------- 에이전트 ----------
function nodeByToken(req) {
  const t = req.headers['x-node-token'];
  if (!t) throw new HttpError(401, 'node token required');
  const n = Object.values(S.db.nodes).find((x) => x.token === t);
  if (!n) throw new HttpError(401, 'invalid node token');
  return n;
}

function instanceSpec(i) {
  const svc = S.db.services[i.serviceId], dep = S.db.deployments[i.deploymentId];
  if (!svc || !dep) return null;
  const s = dep.snap;
  return {
    id: i.id, serviceId: svc.id, deploymentId: dep.id, name: svc.name, restartNonce: i.restartNonce, kind: s.type, runtime: s.runtime,
    source: s.source, buildCommand: s.buildCommand, startCommand: s.startCommand, rootDir: s.rootDir, publishDir: s.publishDir,
    healthPath: s.healthCheckPath, cron: s.cron, files: s.files, image: (RUNTIME_DEFAULTS[s.runtime] || {}).image,
    env: Object.fromEntries(s.env.map((e) => [e.key, e.value])), cpu: i.cpu, ramMB: i.ramMB, draining: i.draining,
  };
}

function heartbeat(req, body) {
  const n = nodeByToken(req);
  const t = S.now();
  if (n.disconnected) return { disconnect: true };
  const wasOffline = n.status === 'offline';
  n.lastSeen = t;
  if (body.caps) {
    n.caps = { cores: +body.caps.cores || 1, ramMB: +body.caps.ramMB || 1024, diskGB: +body.caps.diskGB || 10, platform: String(body.caps.platform || '').slice(0, 40), docker: !!body.caps.docker, sandbox: String(body.caps.sandbox || 'none'), hostname: String(body.caps.hostname || '').slice(0, 60), version: body.caps.version };
    if (!n.limits) n.limits = C.defaultLimits(n.caps);
  }
  if (!n.limits) n.limits = C.defaultLimits(n.caps || {});
  const m = body.metrics || {};
  n.metrics = { cpuLoad: +m.cpuLoad || 0, ramPct: +m.ramPct || 0, ramUsedMB: +m.ramUsedMB || 0, temp: m.temp == null ? null : +m.temp, latencyMs: +m.latencyMs || 0, ts: t };
  n.hist = n.hist || [];
  n.hist.push([t, n.metrics.cpuLoad, n.metrics.ramPct]);
  if (n.hist.length > 120) n.hist.shift();
  if (wasOffline) {
    n.status = 'online'; n.stressSince = 0;
    if (n.offlineSince) {
      L.resolveIncident('node_offline', n.id);
      L.alert(n.ownerId, 'info', `노드 복구: ${n.name}`, `${Math.round((t - n.offlineSince) / 1000)}초 만에 다시 연결되어 자동으로 재참여했습니다.`);
    }
    n.offlineSince = 0;
  } else if (n.status === 'pending') n.status = 'online';

  // 인스턴스 상태 반영
  for (const r of body.instances || []) {
    const i = S.db.instances[r.id];
    if (!i || i.nodeId !== n.id) continue;
    if (r.status === 'running' && i.status !== 'running' && !i.startedAt) i.startedAt = t;
    if (r.status === 'running' && i.status !== 'running') i.runSince = t;
    i.status = i.desired || i.draining ? r.status : i.status;
    i.port = r.port || i.port; i.restarts = r.restarts || 0; i.usedRamMB = r.usedRamMB ?? i.usedRamMB; i.error = r.error || null;
    i.reportedAt = t;
    if (r.commit) { const d = S.db.deployments[i.deploymentId]; if (d && !d.commit) d.commit = String(r.commit).slice(0, 40); }
  }
  for (const l of (body.logs || []).slice(0, 500)) {
    const i = S.db.instances[l.instanceId];
    if (i && i.nodeId === n.id) C.pushLog(i.serviceId, { inst: i.id, node: n.name, stream: l.stream === 'stderr' ? 'stderr' : 'stdout', line: String(l.line).slice(0, 2000) });
  }
  S.touch();
  const desired = [];
  for (const i of Object.values(S.db.instances)) {
    if (i.nodeId !== n.id || !i.desired) continue;
    const sp = instanceSpec(i);
    if (sp) desired.push(sp);
  }
  return { desired, config: { paused: n.paused, limits: n.limits, schedule: n.schedule } };
}

function agentCommands(origin, token, name) {
  const q = (v) => `"${String(v).replace(/"/g, '')}"`;
  const sh = `curl -fsSL ${origin}/install.sh | sh -s -- --token ${token} --name ${q(name)}`;
  return {
    linux: sh, mac: sh, android: sh,
    windows: `iwr ${origin}/install.ps1 -OutFile $env:TEMP/krl.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP/krl.ps1 -Token ${token} -Name ${q(name)}`,
    manual: `node agent.js --server ${origin} --token ${token} --name ${q(name)}`,
  };
}

// ---------- 라우트 ----------
const routes = [];
const route = (method, pattern, fn, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, fn, ...opts });
};

// 인증
const signups = new Map();
route('POST', '/api/auth/signup', async (ctx) => {
  const b = ctx.body;
  const ip = clientIp(ctx.req), sf = signups.get(ip) || { n: 0, t: S.now() };
  if (S.now() - sf.t > 3600000) { sf.n = 0; sf.t = S.now(); }
  if (++sf.n > 10) throw new HttpError(429, '가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요');
  signups.set(ip, sf);
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('이메일 형식이 올바르지 않습니다');
  if (String(b.password || '').length < 8) throw bad('비밀번호는 8자 이상이어야 합니다');
  if (Object.values(S.db.users).some((u) => u.email === email)) throw bad('이미 가입된 이메일입니다');
  const { salt, hash } = U.hashPassword(b.password);
  const u = { id: S.id('usr'), email, name: String(b.name || email.split('@')[0]).slice(0, 40), salt, hash, credits: 0, createdAt: S.now() };
  S.db.users[u.id] = u;
  L.add(u.id, 'signup', cfg.SIGNUP_CREDITS, {}, '가입 환영 크레딧');
  L.alert(u.id, 'info', 'KRL Cloud 가입을 환영합니다', `환영 크레딧 ${cfg.SIGNUP_CREDITS}이 지급되었습니다. PC를 등록해 크레딧을 더 벌어보세요.`);
  ctx.headers = newSession(ctx.req, u);
  return userView(u);
}, { anon: true });
route('POST', '/api/auth/login', async (ctx) => {
  const ip = clientIp(ctx.req);
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 8 && S.now() - f.t < 600000) throw new HttpError(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요');
  const u = Object.values(S.db.users).find((x) => x.email === String(ctx.body.email || '').trim().toLowerCase());
  if (!u || !U.verifyPassword(String(ctx.body.password || ''), u.salt, u.hash)) {
    loginFails.set(ip, { n: f.n + 1, t: S.now() });
    throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다');
  }
  loginFails.delete(ip);
  ctx.headers = newSession(ctx.req, u);
  return userView(u);
}, { anon: true });
route('POST', '/api/auth/logout', async (ctx) => {
  const sid = U.parseCookies(ctx.req).krl_sid;
  if (sid) { delete S.db.sessions[sid]; S.touch(); }
  ctx.headers = { 'set-cookie': 'krl_sid=; Path=/; Max-Age=0' };
  return { ok: true };
}, { anon: true });
route('GET', '/api/me', async (ctx) => userView(ctx.user));
route('PATCH', '/api/me', async (ctx) => {
  const { name, password, currentPassword } = ctx.body, u = ctx.user;
  if (name) u.name = String(name).slice(0, 40);
  if (password) {
    if (!U.verifyPassword(String(currentPassword || ''), u.salt, u.hash)) throw bad('현재 비밀번호가 올바르지 않습니다');
    if (password.length < 8) throw bad('비밀번호는 8자 이상이어야 합니다');
    Object.assign(u, U.hashPassword(password));
  }
  S.touch();
  return userView(u);
});

// 공개 통계 (개인정보 없음, 실제 집계값)
route('GET', '/api/public/stats', async () => {
  const nodes = Object.values(S.db.nodes), on = nodes.filter((n) => C.nodeOnline(n));
  return { nodesOnline: on.length, nodesTotal: nodes.length, instancesRunning: Object.values(S.db.instances).filter((i) => i.status === 'running' && i.desired).length,
    services: Object.values(S.db.services).filter((s) => s.status === 'active').length, regions: new Set(on.map((n) => n.region)).size };
}, { anon: true });

// 메타
route('GET', '/api/meta', async (ctx) => ({
  baseDomain: cfg.BASE_DOMAIN, plans: PLANS, regions: REGIONS.map((r) => ({ id: r, country: COUNTRY[r] })),
  templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { label: v.label, runtime: v.runtime, type: v.type }])),
  runtimeDefaults: RUNTIME_DEFAULTS, cloudflare: cf.enabled(), subdomainSystem: true,
  install: { linux: `curl -fsSL ${ctx.origin}/install.sh | sh`, mac: `curl -fsSL ${ctx.origin}/install.sh | sh`, android: `curl -fsSL ${ctx.origin}/install.sh | sh`,
    windows: `iwr ${ctx.origin}/install.ps1 -OutFile $env:TEMP/krl.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP/krl.ps1`, manual: `node agent.js install --server ${ctx.origin}` }, tickSeconds: cfg.TICK_SECONDS,
}), { anon: true });
route('GET', '/api/slug-check', async (ctx) => {
  try { C.validateSlug(ctx.query.slug, ctx.query.except); return { available: true }; } catch (e) { return { available: false, reason: e.message }; }
});

// 서브도메인 시스템: 서비스당 1개, <name>.krl.kr
route('GET', '/api/subdomains', async (ctx) => Object.values(S.db.services).filter((x) => x.ownerId === ctx.user.id)
  .map((x) => ({ slug: x.slug, host: `${x.slug}.${cfg.BASE_DOMAIN}`, serviceId: x.id, serviceName: x.name, claimedAt: x.createdAt, public: !['worker', 'cron', 'private'].includes(x.type) })));
route('GET', '/api/subdomains/suggest', async (ctx) => {
  const base = String(ctx.query.q || 'myapp').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'myapp';
  const out = [];
  for (const c of [base, `${base}-app`, `${base}-${Math.floor(Math.random() * 900 + 100)}`, `my-${base}`]) { try { C.validateSlug(c); out.push(c); } catch {} }
  return out;
});

// 개요
route('GET', '/api/overview', async (ctx) => {
  const u = ctx.user, db = S.db;
  const nodes = Object.values(db.nodes).filter((n) => n.ownerId === u.id);
  const services = Object.values(db.services).filter((s) => s.ownerId === u.id);
  const insts = Object.values(db.instances).filter((i) => services.some((s) => s.id === i.serviceId) && i.desired);
  const avs = services.map((s) => C.availability(s)).filter((v) => v != null);
  const e = E.estimate(u.id);
  const all = Object.values(db.nodes);
  return {
    user: userView(u),
    connectedNodes: nodes.filter((n) => C.nodeOnline(n)).length, totalNodes: nodes.length,
    runningInstances: insts.filter((i) => i.status === 'running').length, totalInstances: insts.length,
    credits: U.round(u.credits, 2), availability: avs.length ? avs.reduce((a, b) => a + b, 0) / avs.length : null,
    overall: nodes.length || services.length ? (nodes.some((n) => n.status === 'degraded' || n.status === 'offline') || services.some((s) => C.serviceView(s).health === 'degraded') ? 'degraded' : 'online') : 'online',
    nodes: nodes.map((n) => C.nodeView(n)), services: services.map((s) => C.serviceView(s)), estimate: e,
    network: { nodes: all.length, online: all.filter((n) => C.nodeOnline(n)).length, instances: Object.values(db.instances).filter((i) => i.status === 'running').length,
      regions: [...new Set(all.filter((n) => C.nodeOnline(n)).map((n) => n.region))].length },
    unreadAlerts: db.alerts.filter((a) => a.userId === u.id && !a.read).length,
  };
});

// 노드
route('GET', '/api/nodes', async (ctx) => Object.values(S.db.nodes).filter((n) => n.ownerId === ctx.user.id).map((n) => C.nodeView(n)));
route('POST', '/api/nodes', async (ctx) => {
  const b = ctx.body;
  const name = String(b.name || '').trim().slice(0, 40) || `my-pc-${Object.keys(S.db.nodes).length + 1}`;
  const region = REGIONS.includes(b.region) ? b.region : 'seoul';
  const n = {
    id: S.id('node'), ownerId: ctx.user.id, name, token: 'krln_' + U.token(20), region, country: COUNTRY[region], groupId: null, status: 'pending',
    paused: false, disconnected: false, limits: null, schedule: { idleOnly: false, busyCpuThreshold: 60 }, caps: null, metrics: {}, hist: [],
    lastSeen: 0, createdAt: S.now(), stats: { earned: 0, onlineSeconds: 0, offlineSeconds: 0, failures: 0, bonusPaid: false, uptimeAccum: 0 },
  };
  S.db.nodes[n.id] = n; S.touch();
  return { ...C.nodeView(n, { secret: true }), command: `node agent/agent.js --server ${ctx.origin} --token ${n.token}`, commands: agentCommands(ctx.origin, n.token, n.name) };
});
route('GET', '/api/nodes/:id', async (ctx) => {
  const n = own('nodes', ctx.params.id, ctx.user);
  return { ...C.nodeView(n, { secret: true }), command: `node agent/agent.js --server ${ctx.origin} --token ${n.token}`, commands: agentCommands(ctx.origin, n.token, n.name),
    hist: n.hist, instances: Object.values(S.db.instances).filter((i) => i.nodeId === n.id && i.desired).map(C.instanceView) };
});
route('PATCH', '/api/nodes/:id', async (ctx) => {
  const n = own('nodes', ctx.params.id, ctx.user), b = ctx.body;
  if (b.name) n.name = String(b.name).slice(0, 40);
  if (b.region && REGIONS.includes(b.region)) { n.region = b.region; n.country = COUNTRY[b.region]; }
  if (b.limits) {
    const cap = n.caps || { cores: 64, ramMB: 262144, diskGB: 10000 }, l = b.limits;
    n.limits = {
      cpuCores: U.round(clamp(+l.cpuCores || 0.5, 0.25, cap.cores), 2), ramMB: clamp(Math.round(+l.ramMB || 512), 256, cap.ramMB),
      diskGB: clamp(Math.round(+l.diskGB || 5), 1, cap.diskGB), bandwidthMbps: clamp(Math.round(+l.bandwidthMbps || 5), 1, 10000),
    };
  }
  if (b.schedule) n.schedule = { idleOnly: !!b.schedule.idleOnly, busyCpuThreshold: clamp(+b.schedule.busyCpuThreshold || 60, 10, 95) };
  if (typeof b.paused === 'boolean') {
    n.paused = b.paused;
    L.alert(n.ownerId, 'info', b.paused ? `자원 제공 일시 중지: ${n.name}` : `자원 제공 재개: ${n.name}`, b.paused ? '실행 중인 인스턴스는 다른 노드로 무중단 이동합니다.' : '새 인스턴스를 받을 수 있습니다.');
  }
  if (b.groupId !== undefined) {
    if (b.groupId && (!S.db.groups[b.groupId] || S.db.groups[b.groupId].ownerId !== ctx.user.id)) throw bad('그룹이 올바르지 않습니다');
    n.groupId = b.groupId || null;
  }
  S.touch();
  return C.nodeView(n);
});
route('POST', '/api/nodes/:id/disconnect', async (ctx) => {
  const n = own('nodes', ctx.params.id, ctx.user);
  n.disconnected = true; n.status = 'offline';
  for (const i of Object.values(S.db.instances)) if (i.nodeId === n.id) i.desired = false;
  G.failNode(n.id); S.touch();
  return { ok: true };
});
route('POST', '/api/nodes/:id/reconnect', async (ctx) => { const n = own('nodes', ctx.params.id, ctx.user); n.disconnected = false; S.touch(); return { ok: true }; });
route('DELETE', '/api/nodes/:id', async (ctx) => {
  const n = own('nodes', ctx.params.id, ctx.user);
  for (const i of Object.values(S.db.instances)) if (i.nodeId === n.id) i.desired = false;
  n.disconnected = true; G.failNode(n.id);
  setTimeout(() => { delete S.db.nodes[n.id]; S.touch(); }, 5000);
  return { ok: true };
});
route('GET', '/api/nodes/:id/earnings', async (ctx) => {
  const n = own('nodes', ctx.params.id, ctx.user);
  return hourlySeries(ctx.user.id, 24, (e) => e.nodeId === n.id);
});

// 노드 그룹
route('GET', '/api/groups', async (ctx) => Object.values(S.db.groups).filter((g) => g.ownerId === ctx.user.id).map((g) => ({ ...g, nodes: Object.values(S.db.nodes).filter((n) => n.groupId === g.id).map((n) => n.id) })));
route('POST', '/api/groups', async (ctx) => {
  const name = String(ctx.body.name || '').trim().slice(0, 40);
  if (!name) throw bad('그룹 이름을 입력하세요');
  const g = { id: S.id('grp'), ownerId: ctx.user.id, name, private: ctx.body.private !== false };
  S.db.groups[g.id] = g; S.touch(); return g;
});
route('DELETE', '/api/groups/:id', async (ctx) => {
  const g = own('groups', ctx.params.id, ctx.user);
  for (const n of Object.values(S.db.nodes)) if (n.groupId === g.id) n.groupId = null;
  for (const s of Object.values(S.db.services)) if (s.placement.groupId === g.id) s.placement.groupId = null;
  delete S.db.groups[g.id]; S.touch(); return { ok: true };
});

// 마켓플레이스
route('GET', '/api/marketplace', async () => {
  return Object.values(S.db.nodes).filter((n) => n.limits && !n.disconnected && !(n.groupId && S.db.groups[n.groupId] && S.db.groups[n.groupId].private)).map((n) => {
    const a = C.nodeAllocation(n.id);
    return { id: n.id.slice(-6), name: n.name.slice(0, 2) + '***', region: n.region, country: n.country, status: n.paused ? 'paused' : n.status,
      reputation: C.reputation(n), uptime: (n.stats.onlineSeconds + n.stats.offlineSeconds) ? n.stats.onlineSeconds / (n.stats.onlineSeconds + n.stats.offlineSeconds) : 1,
      freeCpu: U.round(Math.max(0, n.limits.cpuCores - a.cpu), 2), freeRamMB: Math.max(0, n.limits.ramMB - a.ram), instances: a.count,
      docker: !!(n.caps && n.caps.docker), ageDays: Math.floor((S.now() - n.createdAt) / 86400000) };
  }).sort((a, b) => b.reputation - a.reputation);
});

// 서비스
route('GET', '/api/services', async (ctx) => Object.values(S.db.services).filter((s) => s.ownerId === ctx.user.id).map(C.serviceView));
route('POST', '/api/services', async (ctx) => {
  const svc = C.createService(ctx.user, ctx.body);
  C.createDeployment(svc, 'manual');
  return C.serviceView(svc);
});
route('GET', '/api/services/:id', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  const deps = Object.values(S.db.deployments).filter((d) => d.serviceId === s.id).sort((a, b) => b.version - a.version).slice(0, 30).map(depView);
  return { ...C.serviceView(s), deployments: deps, instanceList: C.serviceInstances(s.id).map(C.instanceView) };
});
route('PATCH', '/api/services/:id', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user), b = ctx.body;
  let redeploy = !!b.redeploy;
  for (const k of ['buildCommand', 'startCommand', 'publishDir', 'healthCheckPath']) if (typeof b[k] === 'string' && b[k] !== s[k]) { s[k] = b[k].slice(0, 500); redeploy = true; }
  if (typeof b.rootDir === 'string') { s.rootDir = b.rootDir.replace(/^[./\\]+/, '').replace(/\.\./g, '').slice(0, 100); redeploy = true; }
  if (b.name) s.name = String(b.name).slice(0, 60);
  if (b.env) { s.env = mergeEnv(s.env, C.normEnv(b.env)); redeploy = true; }
  if (typeof b.autoDeploy === 'boolean') s.autoDeploy = b.autoDeploy;
  if (b.source) { s.source = C.validateSource(b.source); redeploy = true; }
  if (b.cron && s.type === 'cron') { s.cron = { everyMinutes: clamp(parseInt(b.cron.everyMinutes) || 60, 1, 1440) }; redeploy = true; }
  if (b.plan && PLANS[b.plan] && b.plan !== s.plan) {
    if (b.plan === 'free' && Object.values(S.db.services).filter((x) => x.ownerId === ctx.user.id && x.plan === 'free' && x.id !== s.id).length >= 2) throw bad('Free 플랜은 2개까지입니다');
    s.plan = b.plan; redeploy = true;
    if (b.plan === 'free') { s.placement.ha = false; s.placement.priority = false; s.scaling.min = s.scaling.max = s.scaling.desired = 1; s.scaling.autoscale = false; }
  }
  if (b.placement) {
    const p = b.placement;
    if (p.groupId && (!S.db.groups[p.groupId] || S.db.groups[p.groupId].ownerId !== ctx.user.id)) throw bad('그룹이 올바르지 않습니다');
    for (const k of ['region', 'country', 'ha', 'priority', 'spot', 'groupId', 'spread']) if (p[k] !== undefined) s.placement[k] = p[k] === '' ? (k === 'region' ? 'any' : null) : p[k];
    if (s.plan === 'free') { s.placement.ha = false; s.placement.priority = false; }
    redeploy = true;
  }
  if (b.failover && ['replace', 'none'].includes(b.failover.policy)) s.failover.policy = b.failover.policy;
  if (b.scaling) applyScaling(s, b.scaling);
  if (b.slug && b.slug !== s.slug) {
    const slug = C.validateSlug(b.slug, s.id), old = s.slug;
    s.slug = slug;
    cf.createSubdomain(slug).then(() => cf.deleteSubdomain(old)).catch(() => {});
  }
  if (s.placement.ha) { s.scaling.min = Math.max(2, s.scaling.min); s.scaling.max = Math.max(s.scaling.max, s.scaling.min); s.scaling.desired = Math.max(s.scaling.desired, s.scaling.min); }
  S.touch();
  if (redeploy && s.status !== 'stopped') C.createDeployment(s, 'config');
  return C.serviceView(s);
});
function mergeEnv(old, next) { // 비밀 값이 빈 문자열로 오면 기존 값 유지
  return next.map((e) => { const o = old.find((x) => x.key === e.key); return e.secret && e.value === '' && o ? { ...e, value: o.value } : e; });
}
function applyScaling(s, b) {
  const max = PLANS[s.plan].maxReplicas, sc = s.scaling;
  if (b.min !== undefined) sc.min = clamp(parseInt(b.min) || 1, 1, max);
  if (b.max !== undefined) sc.max = clamp(parseInt(b.max) || 1, 1, max);
  if (sc.max < sc.min) sc.max = sc.min;
  if (b.autoscale !== undefined) sc.autoscale = !!b.autoscale;
  if (b.targetRps !== undefined) sc.targetRps = clamp(parseFloat(b.targetRps) || 20, 1, 1000);
  if (b.desired !== undefined) sc.desired = clamp(parseInt(b.desired) || 1, sc.min, sc.max);
  if (s.placement.ha) sc.min = Math.max(2, sc.min);
  sc.desired = clamp(sc.desired, sc.min, sc.max);
}
route('POST', '/api/services/:id/scale', async (ctx) => { const s = own('services', ctx.params.id, ctx.user); applyScaling(s, ctx.body); S.touch(); return C.serviceView(s); });
route('DELETE', '/api/services/:id', async (ctx) => { C.deleteService(own('services', ctx.params.id, ctx.user)); return { ok: true }; });
route('POST', '/api/services/:id/deploy', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  if (s.status === 'suspended' && ctx.user.credits <= 0) throw bad('크레딧이 부족합니다');
  if (s.status === 'suspended') s.status = 'active';
  return depView(C.createDeployment(s, 'manual'));
});
route('POST', '/api/services/:id/restart', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  for (const i of C.serviceInstances(s.id)) i.restartNonce++;
  C.pushLog(s.id, { inst: 'platform', node: '-', stream: 'sys', line: '전체 인스턴스 재시작 요청' });
  S.touch(); return { ok: true };
});
route('POST', '/api/services/:id/stop', async (ctx) => { const s = own('services', ctx.params.id, ctx.user); s.status = 'stopped'; C.pushLog(s.id, { inst: 'platform', node: '-', stream: 'sys', line: '전체 인스턴스 종료' }); S.touch(); return C.serviceView(s); });
route('POST', '/api/services/:id/start', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  if (ctx.user.credits <= 0 && hourlyCost(s) > 0) throw bad('크레딧이 부족합니다');
  s.status = 'active';
  if (!s.currentDeploymentId) C.createDeployment(s, 'manual');
  S.touch(); return C.serviceView(s);
});
route('POST', '/api/services/:id/rollback', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  const d = S.db.deployments[ctx.body.deploymentId];
  if (!d || d.serviceId !== s.id || d.status === 'failed') throw bad('롤백할 수 없는 배포입니다');
  const nd = C.createDeployment(s, 'rollback', JSON.parse(JSON.stringify(d.snap)), { rollbackOf: d.id, message: `v${d.version} 으로 롤백` });
  d.rolledBackTo = true;
  return depView(nd);
});
route('GET', '/api/services/:id/logs', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  return logSlice([s.id], ctx.query);
});
route('GET', '/api/services/:id/metrics', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  return serviceMetrics(s);
});
route('POST', '/api/services/:id/domains', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  const host = String(ctx.body.host || '').trim().toLowerCase();
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || host.length > 100) throw bad('도메인 형식이 올바르지 않습니다');
  if (host === cfg.BASE_DOMAIN || host.endsWith('.' + cfg.BASE_DOMAIN)) throw bad(`${cfg.BASE_DOMAIN} 하위 도메인은 서브도메인 설정에서 변경하세요`);
  if (Object.values(S.db.services).some((x) => x.domains.some((d) => d.host === host))) throw bad('이미 등록된 도메인입니다');
  s.domains.push({ host, token: 'krl-verify-' + U.token(8), verified: false, createdAt: S.now() });
  cf.addCustomHostname(host).catch((e) => L.alert(ctx.user.id, 'warn', '커스텀 도메인 SSL 등록 실패', e.message));
  S.touch(); return C.serviceView(s);
});
route('POST', '/api/services/:id/domains/verify', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  const d = s.domains.find((x) => x.host === ctx.body.host);
  if (!d) throw notFound();
  let ok = false;
  const target = `${s.slug}.${cfg.BASE_DOMAIN}`;
  try { ok = (await dns.resolveCname(d.host)).some((c) => c.replace(/\.$/, '').toLowerCase() === target); } catch {}
  if (!ok) try { ok = (await dns.resolveTxt('_krl-verify.' + d.host)).some((r) => r.join('') === d.token); } catch {}
  if (ok) { d.verified = true; S.touch(); }
  const h = ok && cf.enabled() ? await cf.getCustomHostname(d.host).catch(() => null) : null;
  if (h) d.ssl = h.ssl && h.ssl.status;
  return { verified: d.verified, expected: { cname: target, txtName: '_krl-verify.' + d.host, txt: d.token }, ssl: d.ssl || null };
});
route('DELETE', '/api/services/:id/domains/:host', async (ctx) => {
  const s = own('services', ctx.params.id, ctx.user);
  s.domains = s.domains.filter((d) => d.host !== ctx.params.host);
  cf.removeCustomHostname(ctx.params.host).catch(() => {});
  S.touch(); return C.serviceView(s);
});

// 배포 / 인스턴스
const depView = (d) => ({ id: d.id, serviceId: d.serviceId, version: d.version, status: d.status, trigger: d.trigger, commit: d.commit, createdAt: d.createdAt, finishedAt: d.finishedAt, message: d.message, rollbackOf: d.rollbackOf,
  serviceName: (S.db.services[d.serviceId] || {}).name, source: d.snap.source, current: (S.db.services[d.serviceId] || {}).currentDeploymentId === d.id });
route('GET', '/api/deployments', async (ctx) => {
  const mine = new Set(Object.values(S.db.services).filter((s) => s.ownerId === ctx.user.id).map((s) => s.id));
  return Object.values(S.db.deployments).filter((d) => mine.has(d.serviceId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(depView);
});
route('GET', '/api/instances', async (ctx) => {
  const mine = new Set(Object.values(S.db.services).filter((s) => s.ownerId === ctx.user.id).map((s) => s.id));
  return Object.values(S.db.instances).filter((i) => mine.has(i.serviceId) && i.desired).map(C.instanceView);
});
route('POST', '/api/instances/:id/restart', async (ctx) => {
  const i = S.db.instances[ctx.params.id];
  if (!i || !S.db.services[i.serviceId] || S.db.services[i.serviceId].ownerId !== ctx.user.id) throw notFound();
  i.restartNonce++; S.touch(); return { ok: true };
});
route('DELETE', '/api/instances/:id', async (ctx) => {
  const i = S.db.instances[ctx.params.id];
  if (!i || !S.db.services[i.serviceId] || S.db.services[i.serviceId].ownerId !== ctx.user.id) throw notFound();
  i.draining = true; S.touch(); return { ok: true }; // 대체 인스턴스가 준비되면 종료
});

// 크레딧
function hourlySeries(userId, hours, filter = () => true) {
  const base = Math.floor(S.now() / 3600000) * 3600000;
  const out = [];
  for (let k = hours - 1; k >= 0; k--) out.push({ t: base - k * 3600000, earn: 0, spend: 0 });
  for (const e of S.db.ledger) {
    if (e.userId !== userId || e.bucket < base - (hours - 1) * 3600000 || !filter(e)) continue;
    const b = out[(e.bucket - (base - (hours - 1) * 3600000)) / 3600000];
    if (!b) continue;
    if (e.amount >= 0) b.earn += e.amount; else b.spend -= e.amount;
  }
  return out.map((b) => ({ ...b, earn: U.round(b.earn), spend: U.round(b.spend) }));
}
route('GET', '/api/credits', async (ctx) => {
  const u = ctx.user;
  const mine = S.db.ledger.filter((e) => e.userId === u.id);
  const byKind = {}, bySvc = {}, byNode = {}, monthly = {};
  const monthAgo = S.now() - 30 * 86400000;
  for (const e of mine) {
    const m = new Date(e.ts).toISOString().slice(0, 7);
    const mo = (monthly[m] = monthly[m] || { earn: 0, spend: 0 });
    if (e.amount >= 0) mo.earn += e.amount; else mo.spend -= e.amount;
    if (e.ts < monthAgo) continue;
    byKind[e.kind] = (byKind[e.kind] || 0) + e.amount;
    if (e.serviceId && e.amount < 0) bySvc[e.serviceId] = (bySvc[e.serviceId] || 0) - e.amount;
    if (e.nodeId && e.amount > 0) byNode[e.nodeId] = (byNode[e.nodeId] || 0) + e.amount;
  }
  return {
    balance: U.round(u.credits, 2), estimate: E.estimate(u.id), hourly: hourlySeries(u.id, 24),
    monthly: Object.entries(monthly).sort().slice(-6).map(([m, v]) => ({ month: m, earn: U.round(v.earn), spend: U.round(v.spend) })),
    byKind, projects: Object.entries(bySvc).map(([id, v]) => ({ serviceId: id, name: (S.db.services[id] || {}).name || '(삭제됨)', cost: U.round(v) })),
    nodes: Object.entries(byNode).map(([id, v]) => ({ nodeId: id, name: (S.db.nodes[id] || {}).name || '(삭제됨)', earned: U.round(v) })),
    ledger: mine.slice(-200).reverse().map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, amount: U.round(e.amount, 3), note: e.note,
      node: e.nodeId && (S.db.nodes[e.nodeId] || {}).name, service: e.serviceId && (S.db.services[e.serviceId] || {}).name })),
  };
});
route('POST', '/api/credits/claim-daily', async (ctx) => {
  const u = ctx.user;
  if (S.now() - (u.lastDaily || 0) < 20 * 3600000) throw bad('오늘은 이미 받았습니다');
  u.lastDaily = S.now(); L.add(u.id, 'earn_event', 20, {}, '출석 이벤트 보상');
  return userView(u);
});

// 분석 / 로그 / 알림
function serviceMetrics(s) {
  const m = C.svcMetrics(s.id), minute = Math.floor(S.now() / 60000);
  const series = [];
  for (let k = 59; k >= 0; k--) { const b = m.buckets.get(minute - k) || { reqs: 0, errs: 0, bytes: 0, ms: 0 }; series.push({ t: (minute - k) * 60000, reqs: b.reqs, errs: b.errs, bytes: b.bytes, avgMs: b.reqs ? Math.round(b.ms / b.reqs) : 0 }); }
  return { series, rps: C.rps(s.id), availability: C.availability(s), instances: C.serviceInstances(s.id).map(C.instanceView) };
}
route('GET', '/api/analytics', async (ctx) => {
  const svcs = Object.values(S.db.services).filter((s) => s.ownerId === ctx.user.id);
  const per = svcs.map((s) => { const m = serviceMetrics(s); return { id: s.id, name: s.name, series: m.series, reqs: m.series.reduce((a, b) => a + b.reqs, 0), errs: m.series.reduce((a, b) => a + b.errs, 0), bytes: m.series.reduce((a, b) => a + b.bytes, 0), availability: m.availability }; });
  const nodes = Object.values(S.db.nodes).filter((n) => n.ownerId === ctx.user.id).map((n) => ({ id: n.id, name: n.name, hist: n.hist || [], status: n.status }));
  return { services: per, nodes, credits: hourlySeries(ctx.user.id, 24),
    incidents: S.db.incidents.filter((i) => i.userId === ctx.user.id).slice(-30).reverse() };
});
function logSlice(ids, q) {
  const since = +q.since || 0, limit = clamp(+q.limit || 300, 1, 1000), term = (q.q || '').toLowerCase(), inst = q.instance;
  let out = [];
  for (const id of ids) for (const l of C.logs.get(id) || []) {
    if (l.seq <= since) continue;
    if (term && !l.line.toLowerCase().includes(term)) continue;
    if (inst && l.inst !== inst) continue;
    out.push({ ...l, serviceId: id, service: (S.db.services[id] || {}).name });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(-limit);
}
route('GET', '/api/logs', async (ctx) => {
  const ids = Object.values(S.db.services).filter((s) => s.ownerId === ctx.user.id && (!ctx.query.serviceId || s.id === ctx.query.serviceId)).map((s) => s.id);
  return logSlice(ids, ctx.query);
});
route('GET', '/api/alerts', async (ctx) => S.db.alerts.filter((a) => a.userId === ctx.user.id).slice(-100).reverse());
route('POST', '/api/alerts/read', async (ctx) => { for (const a of S.db.alerts) if (a.userId === ctx.user.id) a.read = true; S.touch(); return { ok: true }; });

// 기기 페어링: 앱을 설치하면 코드가 표시되고, 대시보드에서 코드를 입력하면 노드가 생성되어 에이전트가 토큰을 자동으로 받는다
const pairs = new Map(); // pairId -> { code, name, expires, token?, nodeId? }
const pairStarts = new Map();
setInterval(() => { for (const [k, v] of pairs) if (v.expires < S.now()) pairs.delete(k); }, 60000).unref();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
route('POST', '/api/agent/pair/start', async (ctx) => {
  const ip = ctx.req.socket.remoteAddress, f = pairStarts.get(ip) || { n: 0, t: S.now() };
  if (S.now() - f.t > 600000) { f.n = 0; f.t = S.now(); }
  if (++f.n > 20) throw new HttpError(429, '요청이 너무 많습니다');
  pairStarts.set(ip, f);
  let code;
  do { code = Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); } while ([...pairs.values()].some((p) => p.code === code));
  const id = U.token(16);
  pairs.set(id, { code, name: String(ctx.body.name || 'my-pc').slice(0, 40), platform: String(ctx.body.platform || '').slice(0, 40), expires: S.now() + 15 * 60000 });
  return { id, code: code.slice(0, 4) + '-' + code.slice(4), expiresIn: 900, url: ctx.origin };
}, { anon: true });
route('GET', '/api/agent/pair/poll', async (ctx) => {
  const p = pairs.get(ctx.query.id);
  if (!p) return { status: 'expired' };
  if (!p.token) return { status: 'pending' };
  pairs.delete(ctx.query.id);
  return { status: 'approved', token: p.token, nodeId: p.nodeId };
}, { anon: true });
route('GET', '/api/pair/lookup', async (ctx) => {
  const code = String(ctx.query.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = [...pairs.values()].find((x) => x.code === code && !x.token);
  if (!p) throw notFound('코드를 찾을 수 없거나 만료되었습니다');
  return { name: p.name, platform: p.platform };
});
route('POST', '/api/pair/approve', async (ctx) => {
  const code = String(ctx.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = [...pairs.values()].find((x) => x.code === code && !x.token);
  if (!p) throw notFound('코드를 찾을 수 없거나 만료되었습니다');
  const region = REGIONS.includes(ctx.body.region) ? ctx.body.region : 'seoul';
  const n = {
    id: S.id('node'), ownerId: ctx.user.id, name: String(ctx.body.name || p.name).trim().slice(0, 40) || p.name, token: 'krln_' + U.token(20), region, country: COUNTRY[region], groupId: null, status: 'pending',
    paused: false, disconnected: false, limits: null, schedule: { idleOnly: false, busyCpuThreshold: 60 }, caps: null, metrics: {}, hist: [],
    lastSeen: 0, createdAt: S.now(), stats: { earned: 0, onlineSeconds: 0, offlineSeconds: 0, failures: 0, bonusPaid: false, uptimeAccum: 0 },
  };
  S.db.nodes[n.id] = n; S.touch();
  p.token = n.token; p.nodeId = n.id;
  return C.nodeView(n);
});

// 에이전트
route('POST', '/api/agent/heartbeat', async (ctx) => heartbeat(ctx.req, ctx.body), { agent: true });
route('GET', '/api/agent/poll', async (ctx) => {
  const n = nodeByToken(ctx.req);
  if (n.disconnected) return { requests: [], disconnect: true };
  G.poll(n.id, ctx.res); return undefined;
}, { agent: true, raw: true });
route('POST', '/api/agent/respond/:id', async (ctx) => { nodeByToken(ctx.req); return { ok: G.respond(ctx.params.id, ctx.body) }; }, { agent: true, body: 'large' });

module.exports = { routes, sessionUser, COUNTRY };
