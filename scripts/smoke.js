'use strict';
/**
 * 종단간 테스트 — 전부 실제 프로세스를 사용합니다 (모의 객체 없음).
 *  서버(임시 DB) 실행 → 회원가입 → 에이전트 3개를 실제로 실행하고 페어링 코드로 연결 →
 *  서비스 배포 → 로드밸런싱 → 노드 연결 해제(장애) → 자동 복구 → 롤백 → 실제 GitHub 저장소 배포
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18080, BASE = `http://localhost:${PORT}`;
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krl-e2e-'));
const procs = [];
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; return c; };
async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error || r.status}`);
  return j;
}
async function waitFor(fn, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(1000); } return null; }
const hit = (slug, p = '/') => new Promise((resolve, reject) => {
  http.get({ host: 'localhost', port: PORT, path: p, headers: { host: `${slug}.localhost:${PORT}` } }, (r) => {
    let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => resolve({ status: r.statusCode, text: t, inst: r.headers['x-krl-instance'], node: r.headers['x-krl-node'] }));
  }).on('error', reject);
});

function startAgent(name, region) {
  const home = path.join(tmp, 'home-' + name);
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const p = spawn(process.execPath, [path.join(root, 'agent', 'agent.js'), 'run', '--server', BASE, '--name', name, '--sandbox', 'process', '--allow-unsandboxed'], { env });
  procs.push(p);
  let out = '';
  return new Promise((resolve) => {
    p.stdout.on('data', async (d) => {
      out += d;
      const m = /코드:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out);
      if (m && !p.paired) { p.paired = true; const n = await call('POST', '/api/pair/approve', { code: m[1], region }); resolve(n); }
    });
    p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(tmp, 'db.json'), TICK_SECONDS: '5' }, stdio: 'ignore' });
  procs.push(srv);
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/healthz'); break; } catch { await sleep(250); } }
  await call('POST', '/api/auth/signup', { email: 'e2e@test.local', password: 'e2e-password-1' });

  const nodes = await Promise.all([['pc-a', 'seoul'], ['pc-b', 'busan'], ['pc-c', 'tokyo']].map(([n, r]) => startAgent(n, r)));
  ok(nodes.length === 3, '페어링 코드로 실제 에이전트 3개 연결');
  await waitFor(async () => (await call('GET', '/api/nodes')).every((n) => n.status === 'online'));
  const caps = (await call('GET', '/api/nodes'))[0];
  ok(caps.caps && caps.caps.cores === os.cpus().length, `실제 하드웨어 정보 보고 (${caps.caps && caps.caps.cores} cores)`);

  const slug = 'e2e' + Math.floor(Math.random() * 9999);
  const svc = await call('POST', '/api/services', { name: slug, slug, plan: 'starter', source: { kind: 'template', template: 'node-hello' }, scaling: { min: 3, max: 3 }, env: [{ key: 'GREETING', value: 'hi-krl' }] });
  const live = await waitFor(async () => { const s = await call('GET', `/api/services/${svc.id}`); return s.instances.running >= 3 && s.currentDeploymentId ? s : null; });
  if (!ok(!!live, '3개 인스턴스 실행')) return;
  ok(new Set(live.instanceList.map((i) => i.nodeName)).size === 3, '서로 다른 3개 노드에 분산');
  const seen = new Set();
  for (let i = 0; i < 12; i++) { const r = await hit(slug); if (r.status === 200) { seen.add(r.inst); if (i === 0) ok(r.text.includes('hi-krl'), '환경변수 전달'); } }
  ok(seen.size >= 2, `로드밸런싱 (${seen.size}개 인스턴스 응답)`);
  ok((await hit('nonexistent-xyz')).status === 404, '없는 서브도메인 404');

  const victim = live.instanceList[0];
  await call('POST', `/api/nodes/${victim.nodeId}/disconnect`);
  const healed = await waitFor(async () => { const s = await call('GET', `/api/services/${svc.id}`); return s.instances.running >= 2 && s.instanceList.every((i) => i.nodeId !== victim.nodeId) ? s : null; }, 40000);
  ok(!!healed, '장애 노드 제외 후 서비스 유지');
  ok((await hit(slug)).status === 200, '장애 중에도 응답');

  await call('POST', `/api/services/${svc.id}/deploy`);
  const full = await call('GET', `/api/services/${svc.id}`);
  const rb = await call('POST', `/api/services/${svc.id}/rollback`, { deploymentId: full.deployments[full.deployments.length - 1].id });
  ok(rb.trigger === 'rollback', '롤백 배포');
  ok((await call('GET', `/api/services/${svc.id}/logs`)).length > 0, '로그 수집');
  await call('DELETE', `/api/services/${svc.id}`);

  // 실제 GitHub 저장소: git clone → npm install → npm start (신뢰하는 저장소를 E2E_REPO 로 직접 지정했을 때만 실행)
  const repo = process.env.E2E_REPO;
  if (repo) {
  const g = await call('POST', '/api/services', { name: 'gh', slug: 'gh' + slug, plan: 'starter', source: { kind: 'github', repo, branch: 'main' }, runtime: 'node', buildCommand: 'npm install', startCommand: 'npm start', healthCheckPath: '/' });
  const gl = await waitFor(async () => { const s = await call('GET', `/api/services/${g.id}`); return s.instances.running >= 1 && s.currentDeploymentId ? s : null; }, 240000);
  if (ok(!!gl, `GitHub 저장소 clone/빌드/실행 (${repo})`)) {
    const r = await hit('gh' + slug);
    ok(r.status === 200 && r.text.length > 100, `GitHub 앱 응답 HTTP ${r.status} (${r.text.length}B)`);
    const dep = (await call('GET', `/api/services/${g.id}`)).deployments[0];
    ok(/^[0-9a-f]{7,}$/.test(dep.commit || ''), `실제 커밋 해시 기록: ${dep.commit}`);
  }
  }
  ok((await call('GET', '/api/credits')).ledger.length > 0, '크레딧 장부 기록');
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; }).finally(() => {
  procs.forEach((p) => { try { p.kill(); } catch {} });
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(); }, 1500);
});
