#!/usr/bin/env node
'use strict';
/**
 * KRL Cloud 노드 에이전트
 *   node agent/agent.js --server http://localhost:8080 --token krln_xxx [--sandbox docker|process] [--allow-unsandboxed]
 *
 * - 컨트롤 플레인에 아웃바운드로만 연결합니다 (포트포워딩/공인 IP 불필요).
 * - 배정된 인스턴스를 실행하고, 게이트웨이가 릴레이한 HTTP 요청을 로컬 인스턴스에 전달합니다.
 * - 정적 사이트는 에이전트 내부의 파일 서버로 제공됩니다 (사용자 코드 실행 없음).
 * - 사용자 코드(Node/Python/커스텀)는 기본적으로 Docker 컨테이너 안에서만 실행됩니다.
 *   Docker 가 없으면 --allow-unsandboxed 를 명시해야 호스트에서 직접 실행합니다 (신뢰할 수 있는 개발용).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

// ---------- 설정 ----------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const CMD = ['install', 'uninstall', 'status', 'run'].includes(argv[0]) ? argv[0] : 'run';
const HOME_DIR = path.join(os.homedir(), '.krl-agent');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } };
const writeConfig = (c) => { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 }); };
let CONFIG = readConfig();
const DEFAULT_SERVER = '__DEFAULT_SERVER__'; // 빌드 시 scripts/build.js 가 KRL_SERVER 값으로 치환
const SERVER = String(arg('server', process.env.KRL_SERVER || CONFIG.server || (DEFAULT_SERVER.startsWith('__') ? 'http://localhost:8080' : DEFAULT_SERVER))).replace(/\/$/, '');
let TOKEN = arg('token', process.env.KRL_TOKEN || CONFIG.token);
if (TOKEN === true) TOKEN = null;
const WORK = arg('workdir', path.join(HOME_DIR, 'work'));
const ALLOW_UNSANDBOXED = !!arg('allow-unsandboxed', CONFIG.allowUnsandboxed || false);
const VERSION = '0.2.0';
const IS_SEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

// Docker 는 나중에 켜질 수 있으므로 주기적으로 다시 감지한다
const probeDocker = () => new Promise((res) => execFile('docker', ['info'], { timeout: 8000, windowsHide: true }, (e) => res(!e)));
let hasDocker = false;
let SANDBOX = 'none';
let canRunCode = false;
async function detectSandbox() {
  hasDocker = await probeDocker();
  const want = arg('sandbox', hasDocker ? 'docker' : 'none');
  SANDBOX = want === 'docker' && hasDocker ? 'docker' : want === 'process' && ALLOW_UNSANDBOXED ? 'process' : 'none';
  canRunCode = SANDBOX === 'docker' || SANDBOX === 'process';
}

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
fs.mkdirSync(WORK, { recursive: true });

// ---------- HTTP 헬퍼 ----------
async function api(method, p, body, timeout = 15000) {
  const r = await fetch(SERVER + p, {
    method, headers: { 'content-type': 'application/json', 'x-node-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ---------- 시스템 메트릭 ----------
let lastCpu = os.cpus();
function cpuLoad() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = lastCpu[i] || c;
    for (const k of Object.keys(c.times)) { const d = c.times[k] - p.times[k]; total += d; if (k === 'idle') idle += d; }
  });
  lastCpu = cur;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}
function temperature() {
  try { return Math.round(+fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8') / 1000); } catch { return null; }
}
function diskGB() {
  try { const s = fs.statfsSync(WORK); return Math.floor(s.bavail * s.bsize / 1e9); } catch { return 20; }
}
const caps = () => ({
  cores: os.cpus().length, ramMB: Math.floor(os.totalmem() / 1048576), diskGB: diskGB(), platform: `${os.platform()}-${os.arch()}`,
  docker: SANDBOX === 'docker', sandbox: SANDBOX, hostname: os.hostname(), version: VERSION,
});

// ---------- 인스턴스 런타임 ----------
const instances = new Map(); // id -> state
const logBuf = [];
let limits = { bandwidthMbps: 20 };

function ilog(st, stream, line) {
  for (const l of String(line).split(/\r?\n/)) if (l.trim()) { logBuf.push({ instanceId: st.id, stream, line: l, ts: Date.now() }); }
  if (logBuf.length > 3000) logBuf.splice(0, logBuf.length - 3000);
}

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
const sh = (cmd, opts) => spawn(cmd, { shell: true, windowsHide: true, ...opts });

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.xml': 'application/xml', '.pdf': 'application/pdf' };

function staticServer(root, port) {
  const srv = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    let file = path.normalize(path.join(root, p));
    if (!file.startsWith(path.normalize(root))) { res.writeHead(403); return res.end('forbidden'); }
    const tryFile = (f, cb) => fs.stat(f, (e, s) => (!e && s.isDirectory() ? tryFile(path.join(f, 'index.html'), cb) : !e ? cb(f) : cb(null)));
    tryFile(file, (f) => {
      if (f) { res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=60' }); return fs.createReadStream(f).pipe(res); }
      if (!path.extname(p)) return tryFile(path.join(root, 'index.html'), (idx) => { // SPA 폴백
        if (!idx) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'content-type': MIME['.html'] }); fs.createReadStream(idx).pipe(res);
      });
      tryFile(path.join(root, '404.html'), (nf) => { res.writeHead(404, { 'content-type': MIME['.html'] }); nf ? fs.createReadStream(nf).pipe(res) : res.end('Not found'); });
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

function run(st, cmd, { cwd, env, image, network = true }) {
  // 한 번 실행하고 종료되는 명령 (빌드). 종료 코드를 반환
  return new Promise((resolve) => {
    let child;
    if (SANDBOX === 'docker') {
      child = spawn('docker', ['run', '--rm', '--cpus', String(Math.max(0.25, st.spec.cpu)), '--memory', `${st.spec.ramMB}m`, '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${cwd}:/app`, '-w', '/app', ...envArgs(env), image, 'sh', '-c', cmd], { windowsHide: true });
    } else child = sh(cmd, { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32' });
    st.child = child;
    child.stdout.on('data', (d) => ilog(st, 'stdout', d));
    child.stderr.on('data', (d) => ilog(st, 'stderr', d));
    child.on('close', (code) => { if (st.child === child) st.child = null; resolve(code); });
    child.on('error', (e) => { ilog(st, 'stderr', e.message); resolve(1); });
  });
}
const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

function gitClone(st, spec, dir) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', ['clone', '--depth', '1', '--branch', spec.source.branch, '--', spec.source.repo, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    c.stdout.on('data', (d) => ilog(st, 'stdout', d)); c.stderr.on('data', (d) => ilog(st, 'stderr', d));
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('git clone 실패 (저장소/브랜치 확인)'))));
    c.on('error', reject);
  });
}

async function prepare(st) {
  const spec = st.spec;
  fs.rmSync(st.dir, { recursive: true, force: true });
  fs.mkdirSync(st.dir, { recursive: true });
  if (spec.source.kind === 'template') {
    for (const [f, content] of Object.entries(spec.files || {})) {
      const target = path.join(st.dir, f);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  } else if (spec.source.kind === 'github') {
    ilog(st, 'stdout', `==> ${spec.source.repo} (${spec.source.branch}) 클론`);
    fs.rmSync(st.dir, { recursive: true, force: true });
    await gitClone(st, spec, st.dir);
    try { st.commit = execFileSync('git', ['-C', st.dir, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch {}
  }
  st.root = path.join(st.dir, spec.rootDir || '');
  if (!path.normalize(st.root).startsWith(path.normalize(st.dir))) throw new Error('잘못된 rootDir');
}

function baseEnv(st, port) {
  return { ...st.spec.env, PORT: String(port), KRL: '1', KRL_INSTANCE_ID: st.id, KRL_SERVICE_ID: st.spec.serviceId, KRL_NODE_NAME: nodeName, NODE_ENV: st.spec.env.NODE_ENV || 'production' };
}

async function launch(st) {
  const spec = st.spec;
  st.status = 'starting'; st.error = null;
  try {
    if (spec.kind !== 'static' && !canRunCode) throw new Error('이 노드는 샌드박스(Docker)가 없어 사용자 코드를 실행하지 않습니다');
    if (spec.source.kind === 'docker' && SANDBOX !== 'docker') throw new Error('이 노드는 Docker 이미지를 실행할 수 없습니다');
    if (!st.prepared) { ilog(st, 'stdout', `==> 인스턴스 ${st.id} 준비 (${spec.runtime})`); await prepare(st); st.prepared = true; }
    if (st.stopped) return;
    st.port = st.port || await freePort();
    const env = baseEnv(st, SANDBOX === 'docker' && spec.kind !== 'static' ? 10000 : st.port);

    if (spec.buildCommand && !st.built) {
      ilog(st, 'stdout', `==> 빌드: ${spec.buildCommand}`);
      const code = await run(st, spec.buildCommand, { cwd: st.root, env, image: spec.image || 'node:20-alpine' });
      if (st.stopped) return;
      if (code !== 0) throw new Error(`빌드 실패 (종료 코드 ${code})`);
      st.built = true;
    }

    if (spec.kind === 'static') {
      const pub = path.join(st.root, spec.publishDir || '.');
      if (!path.normalize(pub).startsWith(path.normalize(st.dir))) throw new Error('잘못된 publishDir');
      if (st.server) st.server.close();
      st.server = await staticServer(pub, st.port);
      ilog(st, 'stdout', `==> 정적 사이트 제공: ${spec.publishDir || '.'} (포트 ${st.port})`);
      return startHealth(st);
    }

    if (spec.kind === 'cron') { st.status = 'running'; return scheduleCron(st, env); }

    ilog(st, 'stdout', `==> 시작: ${spec.startCommand || '(이미지 기본 명령)'}`);
    let child;
    if (SANDBOX === 'docker') {
      const image = spec.source.kind === 'docker' ? spec.source.image : spec.image;
      const name = `krl-${st.id}`;
      st.containerName = name;
      const args = ['run', '--rm', '--name', name, '--cpus', String(Math.max(0.1, spec.cpu)), '--memory', `${spec.ramMB}m`, '--pids-limit', '512', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', ...(spec.kind === 'worker' ? [] : ['-p', `127.0.0.1:${st.port}:10000`]), ...envArgs(env)];
      if (spec.source.kind !== 'docker') args.push('-v', `${st.root}:/app`, '-w', '/app');
      args.push(image);
      if (spec.startCommand) args.push('sh', '-c', spec.startCommand);
      child = spawn('docker', args, { windowsHide: true });
    } else child = sh(spec.startCommand, { cwd: st.root, env: { ...process.env, ...env }, detached: process.platform !== 'win32' });
    st.child = child; st.startedAt = Date.now();
    child.stdout.on('data', (d) => ilog(st, 'stdout', d));
    child.stderr.on('data', (d) => ilog(st, 'stderr', d));
    child.on('error', (e) => ilog(st, 'stderr', e.message));
    child.on('close', (code) => onExit(st, child, code));
    startHealth(st);
  } catch (e) {
    ilog(st, 'stderr', `오류: ${e.message}`);
    st.status = 'failed'; st.error = e.message;
  }
}

function onExit(st, child, code) {
  if (st.child !== child) return;
  st.child = null;
  if (st.stopped) return;
  ilog(st, 'stderr', `==> 프로세스 종료 (코드 ${code})`);
  const now = Date.now();
  st.crashes = (st.crashes || []).filter((t) => now - t < 5 * 60000); st.crashes.push(now);
  if (st.crashes.length > 5) { st.status = 'failed'; st.error = `반복 충돌 (종료 코드 ${code})`; return; }
  st.restarts++; st.status = 'starting';
  const delay = Math.min(15000, 1000 * 2 ** (st.crashes.length - 1));
  ilog(st, 'stdout', `==> ${delay / 1000}초 후 자동 재실행 (${st.restarts}회)`);
  st.restartTimer = setTimeout(() => launch(st), delay);
}

function startHealth(st) {
  clearInterval(st.healthTimer);
  st.fails = 0; st.bootAt = Date.now();
  if (st.spec.kind === 'worker') { setTimeout(() => { if (st.child && !st.stopped) st.status = 'running'; }, 2500); return; }
  const check = () => {
    if (st.stopped || !st.port) return;
    const req = http.request({ host: '127.0.0.1', port: st.port, path: st.spec.healthPath || '/', timeout: 3000 }, (r) => {
      r.resume();
      if (r.statusCode < 500) { st.fails = 0; if (st.status !== 'running') { st.status = 'running'; ilog(st, 'stdout', '==> 헬스체크 통과, 서비스 준비 완료'); } }
      else fail();
    });
    req.on('timeout', () => { req.destroy(); fail(); });
    req.on('error', fail);
    req.end();
  };
  const fail = () => {
    if (st.stopped) return;
    st.fails++;
    if (st.status === 'running' && st.fails >= 3) { st.status = 'unhealthy'; ilog(st, 'stderr', '==> 헬스체크 실패: unhealthy'); }
    if (st.status === 'unhealthy' && st.fails >= 8) { ilog(st, 'stderr', '==> 응답 없음: 자동 재시작'); restart(st); }
    if (st.status === 'starting' && st.spec.kind !== 'static' && Date.now() - st.bootAt > 120000) {
      st.status = 'failed'; st.error = '시작 후 120초 내에 포트가 응답하지 않았습니다 (PORT 환경변수로 리슨하세요)';
      killProc(st);
    }
  };
  st.healthTimer = setInterval(check, 3000);
  check();
}

function scheduleCron(st, env) {
  const run1 = async () => {
    if (st.stopped || st.cronRunning) return;
    st.cronRunning = true;
    ilog(st, 'stdout', `==> 크론 실행: ${st.spec.startCommand}`);
    const t = setTimeout(() => killProc(st), 10 * 60000);
    const code = await run(st, st.spec.startCommand, { cwd: st.root, env, image: st.spec.image || 'node:20-alpine' });
    clearTimeout(t); st.cronRunning = false;
    ilog(st, 'stdout', `==> 크론 종료 (코드 ${code})`);
  };
  run1();
  st.cronTimer = setInterval(run1, Math.max(1, (st.spec.cron && st.spec.cron.everyMinutes) || 60) * 60000);
}

function killProc(st) {
  if (st.containerName) execFile('docker', ['rm', '-f', st.containerName], () => {});
  killTree(st.child);
}

function restart(st) {
  clearInterval(st.healthTimer); clearTimeout(st.restartTimer); clearInterval(st.cronTimer);
  killProc(st);
  st.status = 'starting'; st.built = st.built;
  setTimeout(() => { if (!st.stopped) launch(st); }, 800);
}

function stopInstance(st) {
  st.stopped = true;
  clearInterval(st.healthTimer); clearTimeout(st.restartTimer); clearInterval(st.cronTimer);
  killProc(st);
  if (st.server) st.server.close();
  st.status = 'stopped';
  setTimeout(() => fs.rm(st.dir, { recursive: true, force: true }, () => {}), 2000);
  instances.delete(st.id);
  log(`인스턴스 ${st.id} 종료`);
}

function sampleRam(st) {
  const pid = st.child && st.child.pid;
  if (!pid) return;
  if (process.platform === 'win32') execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], (e, out) => { const m = /"([\d,]+) K"\s*$/m.exec(out || ''); if (m) st.usedRamMB = Math.round(+m[1].replace(/,/g, '') / 1024); });
  else execFile('ps', ['-o', 'rss=', '-p', String(pid)], (e, out) => { if (!e && +out) st.usedRamMB = Math.round(+out / 1024); });
}

let nodeName = os.hostname();

function reconcile(desired) {
  const want = new Map(desired.map((d) => [d.id, d]));
  for (const [id, st] of instances) if (!want.has(id)) stopInstance(st);
  for (const spec of desired) {
    let st = instances.get(spec.id);
    if (!st) {
      st = { id: spec.id, spec, status: 'starting', restarts: 0, dir: path.join(WORK, spec.id), nonce: spec.restartNonce };
      instances.set(spec.id, st);
      log(`인스턴스 ${st.id} 시작 (${spec.name})`);
      launch(st);
    } else {
      st.spec = spec;
      if (spec.restartNonce !== st.nonce) { st.nonce = spec.restartNonce; ilog(st, 'stdout', '==> 재시작 요청'); restart(st); }
    }
  }
}

// ---------- 하트비트 ----------
let latency = 0, hbBusy = false, firstOk = false;
async function heartbeat() {
  if (hbBusy) return;
  hbBusy = true;
  const t0 = Date.now();
  try {
    const mem = os.totalmem(), free = os.freemem();
    const body = {
      caps: caps(),
      metrics: { cpuLoad: cpuLoad(), ramPct: Math.round((1 - free / mem) * 100), ramUsedMB: Math.round((mem - free) / 1048576), temp: temperature(), latencyMs: latency },
      instances: [...instances.values()].map((s) => { sampleRam(s); return { id: s.id, status: s.status, port: s.port, restarts: s.restarts, usedRamMB: s.usedRamMB, error: s.error, commit: s.commit }; }),
      logs: logBuf.splice(0, 500),
    };
    const r = await api('POST', '/api/agent/heartbeat', body);
    latency = Date.now() - t0;
    if (!firstOk) { firstOk = true; log(`서버 연결 완료 (${SERVER}) - 샌드박스: ${SANDBOX}`); if (!canRunCode) log('⚠ 정적 사이트만 호스팅합니다. 코드 실행을 허용하려면 Docker 를 설치하거나 --allow-unsandboxed 를 사용하세요.'); }
    if (r.disconnect) { log('원격으로 연결 해제되었습니다. 종료합니다.'); for (const st of [...instances.values()]) stopInstance(st); setTimeout(() => process.exit(0), 1500); return; }
    if (r.config) limits = r.config.limits || limits;
    reconcile(r.desired || []);
  } catch (e) {
    if (firstOk) log('서버 연결 오류:', e.message);
    else log('서버 연결 대기:', e.message);
    if (/401/.test(e.message)) { console.error('이 노드는 계정에서 삭제되었거나 토큰이 올바르지 않습니다. 설정을 지우고 종료합니다.'); try { fs.rmSync(CONFIG_FILE, { force: true }); } catch {} process.exit(1); }
  } finally { hbBusy = false; }
}

// ---------- 릴레이 (게이트웨이 -> 로컬 인스턴스) ----------
async function throttle(bytes) {
  const mbps = (limits && limits.bandwidthMbps) || 20;
  const ms = (bytes * 8) / (mbps * 1e6) * 1000;
  if (ms > 5) await new Promise((r) => setTimeout(r, Math.min(ms, 20000)));
}

function handleRelay(rq) {
  const st = instances.get(rq.instanceId);
  const reply = (data) => api('POST', `/api/agent/respond/${rq.id}`, data, 30000).catch(() => {});
  if (!st || !st.port || st.status !== 'running' && st.status !== 'unhealthy') return reply({ status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('instance unavailable').toString('base64') });
  const body = Buffer.from(rq.body || '', 'base64');
  const headers = { ...rq.headers, host: `127.0.0.1:${st.port}`, 'content-length': body.length };
  const req = http.request({ host: '127.0.0.1', port: st.port, method: rq.method, path: rq.path, headers, timeout: 25000 }, (res) => {
    const chunks = []; let size = 0;
    res.on('data', (c) => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
    res.on('end', async () => {
      const out = Buffer.concat(chunks);
      await throttle(out.length);
      reply({ status: res.statusCode, headers: res.headers, body: out.toString('base64') });
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => reply({ status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('bad gateway').toString('base64') }));
  req.end(body);
}

async function pollLoop() {
  for (;;) {
    try {
      const r = await api('GET', '/api/agent/poll', null, 30000);
      if (r.disconnect) return;
      for (const rq of r.requests || []) handleRelay(rq);
    } catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
}

// ---------- 페어링 / 설치 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureToken() {
  if (TOKEN) return;
  const name = arg('name', os.hostname());
  const start = await fetch(SERVER + '/api/agent/pair/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, platform: `${os.platform()}-${os.arch()}` }) }).then((r) => r.json());
  if (!start.code) throw new Error('페어링을 시작할 수 없습니다: ' + JSON.stringify(start));
  console.log(`\n  이 PC를 내 계정에 연결하세요\n\n    1) ${SERVER} 에 로그인\n    2) My Nodes → "내 PC 연결" 에서 아래 코드를 입력\n\n        코드:  ${start.code}\n\n  (15분 이내 입력 / 대기 중…)\n`);
  const until = Date.now() + 15 * 60000;
  while (Date.now() < until) {
    await sleep(3000);
    const r = await fetch(`${SERVER}/api/agent/pair/poll?id=${start.id}`).then((x) => x.json()).catch(() => ({}));
    if (r.status === 'approved') {
      TOKEN = r.token; CONFIG = { ...CONFIG, server: SERVER, token: TOKEN, name };
      writeConfig(CONFIG);
      console.log('  ✓ 연결 완료! 이제 이 PC가 자동으로 호스팅에 참여합니다.\n');
      return;
    }
    if (r.status === 'expired') break;
  }
  throw new Error('페어링 시간이 초과되었습니다. 다시 실행하세요.');
}

function selfCommand() {
  // SEA 단일 실행 파일이면 자기 자신, 아니면 node + 설치된 agent.js
  return IS_SEA ? { exe: path.join(HOME_DIR, 'bin', path.basename(process.execPath)), args: ['run'] }
    : { exe: process.execPath, args: [path.join(HOME_DIR, 'agent.js'), 'run'] };
}
function installFiles() {
  fs.mkdirSync(path.join(HOME_DIR, 'bin'), { recursive: true });
  if (IS_SEA) { const dst = selfCommand().exe; if (path.resolve(dst) !== path.resolve(process.execPath)) { fs.copyFileSync(process.execPath, dst); fs.chmodSync(dst, 0o755); } }
  else { const dst = path.join(HOME_DIR, 'agent.js'); if (path.resolve(dst) !== path.resolve(__filename)) fs.copyFileSync(__filename, dst); }
}
const q = (x) => `"${x}"`;
function registerAutostart() {
  const { exe, args } = selfCommand();
  if (process.platform === 'win32') {
    const cmd = [q(exe), ...args.map((a) => (a.includes(path.sep) ? q(a) : a))].join(' ');
    execFileSync('schtasks', ['/Create', '/TN', 'KRLCloudAgent', '/TR', cmd, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'], { stdio: 'ignore' });
    spawn('schtasks', ['/Run', '/TN', 'KRLCloudAgent'], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    return '작업 스케줄러(로그온 시 자동 실행)';
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'kr.krl.agent.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>kr.krl.agent</string><key>ProgramArguments</key><array>${[exe, ...args].map((a) => `<string>${a}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${HOME_DIR}/agent.log</string><key>StandardErrorPath</key><string>${HOME_DIR}/agent.log</string></dict></plist>\n`);
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', plist]);
    return 'launchd (로그인 시 자동 실행)';
  }
  if (process.env.TERMUX_VERSION || fs.existsSync('/data/data/com.termux')) {
    const boot = path.join(os.homedir(), '.termux', 'boot'); fs.mkdirSync(boot, { recursive: true });
    fs.writeFileSync(path.join(boot, 'krl-agent.sh'), `#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\nexec ${[exe, ...args].join(' ')} >> ${HOME_DIR}/agent.log 2>&1\n`, { mode: 0o755 });
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    return 'Termux:Boot (앱 설치 시 부팅 자동 실행)';
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'krl-agent.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, `[Unit]\nDescription=KRL Cloud node agent\nAfter=network-online.target\n[Service]\nExecStart=${[exe, ...args].map((a) => (/\s/.test(a) ? q(a) : a)).join(' ')}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=default.target\n`);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'krl-agent']);
  try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); } catch {}
  return 'systemd --user 서비스';
}
function unregisterAutostart() {
  try {
    if (process.platform === 'win32') { try { execFileSync('schtasks', ['/End', '/TN', 'KRLCloudAgent'], { stdio: 'ignore' }); } catch {} execFileSync('schtasks', ['/Delete', '/TN', 'KRLCloudAgent', '/F'], { stdio: 'ignore' }); }
    else if (process.platform === 'darwin') { const p = path.join(os.homedir(), 'Library', 'LaunchAgents', 'kr.krl.agent.plist'); try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch {} fs.rmSync(p, { force: true }); }
    else { try { execFileSync('systemctl', ['--user', 'disable', '--now', 'krl-agent'], { stdio: 'ignore' }); } catch {} fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'krl-agent.service'), { force: true }); fs.rmSync(path.join(os.homedir(), '.termux', 'boot', 'krl-agent.sh'), { force: true }); }
  } catch {}
}

// ---------- 시작 ----------
async function startAgent() {
  nodeName = arg('name', CONFIG.name || os.hostname());
  await detectSandbox();
  setInterval(detectSandbox, 30000).unref();
  log(`KRL Cloud 에이전트 v${VERSION} - ${nodeName} (${os.platform()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1073741824)}GB)`);
  setInterval(heartbeat, 3000);
  heartbeat();
  pollLoop();
  const bye = () => { for (const st of [...instances.values()]) { st.stopped = true; killProc(st); if (st.server) st.server.close(); } setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

(async () => {
  if (CMD === 'uninstall') { unregisterAutostart(); fs.rmSync(HOME_DIR, { recursive: true, force: true }); console.log('KRL 에이전트를 제거했습니다.'); return; }
  if (CMD === 'status') { console.log(JSON.stringify({ server: SERVER, paired: !!TOKEN, name: CONFIG.name, config: CONFIG_FILE }, null, 2)); return; }
  await ensureToken();
  if (CMD === 'install') {
    CONFIG = { ...CONFIG, server: SERVER, token: TOKEN, name: arg('name', CONFIG.name || os.hostname()), allowUnsandboxed: ALLOW_UNSANDBOXED }; writeConfig(CONFIG);
    installFiles();
    const how = registerAutostart();
    await detectSandbox();
    console.log(`✓ 설치 완료 — ${how}\n  이 PC는 이제 자동으로 호스팅에 참여합니다 (서버: ${SERVER}).`);
    if (!canRunCode) console.log('  참고: Docker 가 실행 중이 아니라 현재는 정적 사이트만 호스팅합니다. Docker Desktop 을 켜면 자동으로 앱 실행도 시작됩니다.');
    return;
  }
  await startAgent();
})().catch((e) => { console.error(e.message); process.exit(1); });
