'use strict';
const S = require('./store');
const L = require('./ledger');
const cfg = require('./config');
const cf = require('./cloudflare');
const { PLANS, hourlyCost } = require('./plans');
const { TEMPLATES, RUNTIME_DEFAULTS } = require('./templates');
const { bad, notFound, token, RESERVED, SLUG_RE, clamp } = require('./util');

const logs = new Map();      // serviceId -> [{ts, inst, node, line, stream}]
const metrics = new Map();   // serviceId -> { buckets: Map(minute -> {reqs, errs, bytes, ms}), win: [] , inflight: Map(instId -> n)}
let logSeq = 0;

function pushLog(serviceId, entry) {
  let a = logs.get(serviceId);
  if (!a) logs.set(serviceId, (a = []));
  a.push({ seq: ++logSeq, ts: S.now(), ...entry });
  if (a.length > 3000) a.splice(0, a.length - 3000);
}

function svcMetrics(id) {
  let m = metrics.get(id);
  if (!m) metrics.set(id, (m = { buckets: new Map(), recent: [], inflight: new Map(), egress: new Map() }));
  return m;
}
function recordRequest(svc, inst, { bytes, ms, err }) {
  const m = svcMetrics(svc.id);
  const minute = Math.floor(S.now() / 60000);
  let b = m.buckets.get(minute);
  if (!b) { b = { reqs: 0, errs: 0, bytes: 0, ms: 0 }; m.buckets.set(minute, b); if (m.buckets.size > 180) m.buckets.delete(m.buckets.keys().next().value); }
  b.reqs++; b.bytes += bytes; b.ms += ms; if (err) b.errs++;
  m.recent.push(S.now());
  if (inst) m.egress.set(inst.id, (m.egress.get(inst.id) || 0) + bytes);
}
function rps(svcId, windowSec = 10) {
  const m = metrics.get(svcId);
  if (!m) return 0;
  const cut = S.now() - windowSec * 1000;
  while (m.recent.length && m.recent[0] < cut - 60000) m.recent.shift();
  let n = 0;
  for (let i = m.recent.length - 1; i >= 0 && m.recent[i] >= cut; i--) n++;
  return n / windowSec;
}

// ---------- 노드 ----------
const nodeOnline = (n) => n.status === 'online' || n.status === 'degraded' || n.status === 'busy';

function defaultLimits(caps) {
  const cores = caps.cores || 2;
  return {
    cpuCores: Math.max(1, Math.floor(cores / 2)),
    ramMB: Math.max(512, Math.floor((caps.ramMB || 4096) / 2)),
    diskGB: 20,
    bandwidthMbps: 20,
  };
}

function nodeAllocation(nodeId) {
  let cpu = 0, ram = 0, count = 0;
  for (const i of Object.values(S.db.instances)) {
    if (i.nodeId !== nodeId || !i.desired) continue;
    cpu += i.cpu; ram += i.ramMB; count++;
  }
  return { cpu, ram, count };
}

function reputation(n) {
  const st = n.stats;
  const total = st.onlineSeconds + st.offlineSeconds;
  const ratio = total > 0 ? st.onlineSeconds / total : 1;
  const conf = clamp(st.onlineSeconds / 86400, 0, 1);
  const ageDays = (S.now() - n.createdAt) / 86400000;
  const score = 40 + 40 * ratio * (0.4 + 0.6 * conf) + Math.min(15, ageDays) - Math.min(30, st.failures * 3) + (conf >= 1 ? 5 : 0);
  return Math.round(clamp(score, 0, 100));
}

function nodeView(n, { secret = false } = {}) {
  const a = nodeAllocation(n.id);
  const v = {
    id: n.id, name: n.name, status: n.paused && nodeOnline(n) ? 'paused' : n.status, region: n.region, country: n.country,
    groupId: n.groupId || null, paused: n.paused, limits: n.limits, schedule: n.schedule, caps: n.caps,
    metrics: n.metrics, lastSeen: n.lastSeen, createdAt: n.createdAt, stats: { ...n.stats, reputation: reputation(n) },
    allocated: { cpu: S.db && a.cpu, ramMB: a.ram, instances: a.count },
    uptimeRatio: (n.stats.onlineSeconds + n.stats.offlineSeconds) ? n.stats.onlineSeconds / (n.stats.onlineSeconds + n.stats.offlineSeconds) : 1,
  };
  if (secret) v.token = n.token;
  return v;
}

// ---------- 서비스 ----------
function validateSlug(slug, exceptServiceId) {
  slug = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) throw bad('서브도메인은 영문 소문자/숫자/하이픈 3~32자여야 합니다');
  if (RESERVED.has(slug)) throw bad('예약된 이름입니다');
  for (const s of Object.values(S.db.services)) if (s.slug === slug && s.id !== exceptServiceId) throw bad('이미 사용 중인 서브도메인입니다');
  return slug;
}

const TYPES = ['web', 'static', 'worker', 'cron', 'private'];
const RUNTIMES = ['node', 'python', 'static', 'docker', 'custom'];

function normEnv(env) {
  if (!Array.isArray(env)) return [];
  return env.filter((e) => e && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key || ''))
    .slice(0, 100).map((e) => ({ key: e.key, value: String(e.value ?? ''), secret: !!e.secret }));
}

function validateSource(src) {
  src = src || {};
  if (src.kind === 'github') {
    if (!/^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(src.repo || '')) throw bad('GitHub 저장소 주소(https://github.com/user/repo) 형식이 필요합니다');
    return { kind: 'github', repo: src.repo.replace(/\/$/, ''), branch: /^[\w./-]{1,100}$/.test(src.branch || '') ? src.branch : 'main' };
  }
  if (src.kind === 'docker') {
    if (!/^[a-z0-9][\w./:@-]{0,200}$/i.test(src.image || '')) throw bad('Docker 이미지 이름이 올바르지 않습니다');
    return { kind: 'docker', image: src.image };
  }
  if (src.kind === 'template') {
    if (!TEMPLATES[src.template]) throw bad('알 수 없는 템플릿');
    return { kind: 'template', template: src.template };
  }
  throw bad('소스(github / docker / template)를 선택하세요');
}

function createService(user, b) {
  const db = S.db;
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw bad('이름을 입력하세요');
  const slug = validateSlug(b.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  const source = validateSource(b.source);
  const tpl = source.kind === 'template' ? TEMPLATES[source.template] : null;
  let type = TYPES.includes(b.type) ? b.type : (tpl ? tpl.type : 'web');
  let runtime = RUNTIMES.includes(b.runtime) ? b.runtime : (tpl ? tpl.runtime : (source.kind === 'docker' ? 'docker' : 'node'));
  if (source.kind === 'docker') runtime = 'docker';
  if (type === 'static') runtime = 'static';
  const plan = PLANS[b.plan] ? b.plan : 'free';
  if (plan === 'free' && Object.values(db.services).filter((s) => s.ownerId === user.id && s.plan === 'free').length >= 2) throw bad('Free 플랜 서비스는 계정당 2개까지입니다');
  const rd = RUNTIME_DEFAULTS[runtime];
  const placement = {
    region: b.placement && b.placement.region || 'any', country: b.placement && b.placement.country || '',
    ha: !!(b.placement && b.placement.ha), priority: !!(b.placement && b.placement.priority),
    spot: !!(b.placement && b.placement.spot), groupId: (b.placement && b.placement.groupId) || null,
    spread: (b.placement && b.placement.spread) !== false,
  };
  if (placement.groupId && (!db.groups[placement.groupId] || db.groups[placement.groupId].ownerId !== user.id)) throw bad('노드 그룹이 올바르지 않습니다');
  if (plan === 'free') { placement.ha = false; placement.priority = false; }
  const maxRep = PLANS[plan].maxReplicas;
  let min = clamp(parseInt(b.scaling && b.scaling.min) || 1, 1, maxRep);
  if (placement.ha) min = Math.max(2, min);
  const max = clamp(parseInt(b.scaling && b.scaling.max) || min, min, maxRep);
  const svc = {
    id: S.id('svc'), ownerId: user.id, name, slug, type, runtime, source, plan, placement,
    buildCommand: b.buildCommand ?? (tpl ? tpl.buildCommand : rd.buildCommand),
    startCommand: b.startCommand ?? (tpl ? tpl.startCommand : rd.startCommand),
    rootDir: String(b.rootDir || '').replace(/^[./\\]+/, '').replace(/\.\./g, '').slice(0, 100),
    publishDir: b.publishDir || (tpl && tpl.publishDir) || (runtime === 'static' ? 'dist' : ''),
    healthCheckPath: b.healthCheckPath || (type === 'static' ? '/' : '/healthz'),
    cron: type === 'cron' ? { everyMinutes: clamp(parseInt(b.cron && b.cron.everyMinutes) || 60, 1, 1440) } : null,
    env: normEnv(b.env), autoDeploy: b.autoDeploy !== false, webhookSecret: token(10),
    scaling: { min, max, desired: min, autoscale: !!(b.scaling && b.scaling.autoscale), targetRps: clamp(parseFloat(b.scaling && b.scaling.targetRps) || 20, 1, 1000), lastScaleAt: 0, lowSince: 0 },
    failover: { policy: (b.failover && b.failover.policy) === 'none' ? 'none' : 'replace', minHealthy: 1 },
    domains: [], status: 'active', currentDeploymentId: null, createdAt: S.now(), avail: {}, deployCount: 0,
  };
  if (type === 'private') svc.noPublic = true;
  db.services[svc.id] = svc;
  S.touch();
  cf.createSubdomain(slug).catch((e) => L.alert(user.id, 'warn', 'DNS 발급 실패', `${slug}.${cfg.BASE_DOMAIN}: ${e.message}`));
  return svc;
}

function deleteService(svc) {
  const db = S.db;
  for (const i of Object.values(db.instances)) if (i.serviceId === svc.id) i.desired = false;
  delete db.services[svc.id];
  for (const d of Object.values(db.deployments)) if (d.serviceId === svc.id) delete db.deployments[d.id];
  logs.delete(svc.id); metrics.delete(svc.id);
  cf.deleteSubdomain(svc.slug).catch(() => {});
  for (const d of svc.domains) cf.removeCustomHostname(d.host).catch(() => {});
  S.touch();
}

function snapshot(svc) {
  const tpl = svc.source.kind === 'template' ? TEMPLATES[svc.source.template] : null;
  return {
    source: svc.source, runtime: svc.runtime, type: svc.type, buildCommand: svc.buildCommand, startCommand: svc.startCommand,
    rootDir: svc.rootDir, publishDir: svc.publishDir, healthCheckPath: svc.healthCheckPath, cron: svc.cron,
    env: svc.env, files: tpl ? tpl.files : null,
  };
}

function createDeployment(svc, trigger = 'manual', fromSnapshot = null, meta = {}) {
  const db = S.db;
  // 진행 중인 이전 배포는 취소
  for (const d of Object.values(db.deployments)) {
    if (d.serviceId === svc.id && d.status === 'building') cancelDeployment(d, 'superseded');
  }
  svc.deployCount++;
  const d = {
    id: S.id('dep'), serviceId: svc.id, version: svc.deployCount, status: 'building', trigger,
    createdAt: S.now(), finishedAt: null, commit: null, snap: fromSnapshot || snapshot(svc), message: meta.message || '', rollbackOf: meta.rollbackOf || null,
  };
  db.deployments[d.id] = d;
  svc.status = 'active';
  pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `배포 v${d.version} 시작 (${trigger})` });
  S.touch();
  return d;
}

function cancelDeployment(d, status) {
  d.status = status; d.finishedAt = S.now();
  for (const i of Object.values(S.db.instances)) if (i.deploymentId === d.id) i.desired = false;
  S.touch();
}

function serviceInstances(svcId, onlyDesired = true) {
  return Object.values(S.db.instances).filter((i) => i.serviceId === svcId && (!onlyDesired || i.desired));
}

function availability(svc, hours = 24) {
  let up = 0, tot = 0;
  const cut = Math.floor(S.now() / 3600000) - hours;
  for (const [h, v] of Object.entries(svc.avail || {})) if (+h > cut) { up += v[0]; tot += v[1]; }
  return tot ? up / tot : null;
}

function serviceView(svc) {
  const insts = serviceInstances(svc.id);
  const running = insts.filter((i) => i.status === 'running');
  return {
    id: svc.id, name: svc.name, slug: svc.slug, url: `https://${svc.slug}.${cfg.BASE_DOMAIN}`, type: svc.type, runtime: svc.runtime,
    source: svc.source, plan: svc.plan, placement: svc.placement, buildCommand: svc.buildCommand, startCommand: svc.startCommand,
    rootDir: svc.rootDir, publishDir: svc.publishDir, healthCheckPath: svc.healthCheckPath, cron: svc.cron,
    env: svc.env.map((e) => (e.secret ? { ...e, value: '' , hasValue: !!e.value } : e)), autoDeploy: svc.autoDeploy,
    scaling: svc.scaling, failover: svc.failover, domains: svc.domains.map((d) => ({ host: d.host, verified: d.verified, token: d.token, ssl: d.ssl || null })),
    status: svc.status, currentDeploymentId: svc.currentDeploymentId, createdAt: svc.createdAt,
    instances: { total: insts.length, running: running.length }, costPerHour: hourlyCost(svc) * Math.max(insts.length, 0),
    unitCostPerHour: hourlyCost(svc), availability: availability(svc), rps: +rps(svc.id).toFixed(2),
    webhook: `/hooks/github/${svc.id}/${svc.webhookSecret}`,
    health: svc.status === 'suspended' ? 'suspended' : svc.status === 'stopped' ? 'stopped'
      : running.length === 0 ? (insts.length ? 'starting' : 'down') : running.length < Math.min(svc.scaling.desired, insts.length || 1) ? 'degraded' : 'healthy',
  };
}

function instanceView(i) {
  const n = S.db.nodes[i.nodeId];
  const svc = S.db.services[i.serviceId];
  return {
    id: i.id, serviceId: i.serviceId, serviceName: svc && svc.name, deploymentId: i.deploymentId, nodeId: i.nodeId,
    nodeName: n && n.name, region: n && n.region, status: i.draining ? 'draining' : i.status, startedAt: i.startedAt, restarts: i.restarts,
    cpu: i.cpu, ramMB: i.ramMB, usedRamMB: i.usedRamMB, createdAt: i.createdAt, port: i.port, error: i.error || null,
  };
}

module.exports = { logs, pushLog, svcMetrics, recordRequest, rps, nodeOnline, defaultLimits, nodeAllocation, reputation, nodeView,
  validateSlug, createService, deleteService, createDeployment, cancelDeployment, serviceInstances, availability, serviceView,
  instanceView, snapshot, normEnv, validateSource, TYPES, RUNTIMES };
