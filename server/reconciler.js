'use strict';
const S = require('./store');
const L = require('./ledger');
const cfg = require('./config');
const C = require('./core');
const { PLANS } = require('./plans');
const { clamp } = require('./util');

const BUILD_TIMEOUT = 15 * 60000;

// ---------- 노드 상태 감시 ----------
function monitorNodes() {
  const db = S.db, t = S.now();
  for (const n of Object.values(db.nodes)) {
    const age = (t - (n.lastSeen || 0)) / 1000;
    const wasOnline = C.nodeOnline(n);
    if (!n.disconnected && age > cfg.NODE_TIMEOUT && wasOnline) {
      n.status = 'offline'; n.stats.failures++; n.offlineSince = t;
      L.alert(n.ownerId, 'critical', `노드 연결 끊김: ${n.name}`, '하트비트가 끊겨 노드를 제외하고 다른 노드로 인스턴스를 옮깁니다.');
      L.openIncident(n.ownerId, 'node_offline', n.id, `${n.name} 연결 끊김`);
      for (const i of Object.values(db.instances)) if (i.nodeId === n.id && i.desired) { i.desired = false; i.lost = true; }
      S.touch();
      continue;
    }
    if (n.status === 'offline' || n.status === 'pending') continue; // 첫 하트비트 전에는 온라인으로 취급하지 않는다
    // 과부하/불안정 감지
    const m = n.metrics || {};
    const stress = m.cpuLoad > 92 || m.ramPct > 92 || (m.temp != null && m.temp > 85) || m.latencyMs > 1500;
    if (stress) { n.stressSince = n.stressSince || t; } else n.stressSince = 0;
    const prev = n.status;
    if (n.paused) n.status = 'online';
    else if (stress) n.status = 'degraded';
    else if (n.schedule.idleOnly && m.cpuLoad > n.schedule.busyCpuThreshold) { n.busySince = n.busySince || t; n.status = 'busy'; }
    else { n.busySince = 0; n.status = 'online'; }
    if (!n.schedule.idleOnly || m.cpuLoad <= n.schedule.busyCpuThreshold) n.busySince = 0;
    if (prev !== n.status && (n.status === 'degraded')) {
      L.alert(n.ownerId, 'warn', `노드 불안정: ${n.name}`, `CPU ${Math.round(m.cpuLoad)}% / RAM ${Math.round(m.ramPct)}% / 지연 ${Math.round(m.latencyMs || 0)}ms`);
      L.openIncident(n.ownerId, 'node_degraded', n.id, `${n.name} 과부하/지연`);
    }
    if (prev === 'degraded' && n.status !== 'degraded') L.resolveIncident('node_degraded', n.id);
    // 불안정 30초 지속 / 사용 중(idle-only) 60초 지속 / 일시중지 -> 무중단으로 인스턴스 이동(draining)
    const evict = n.paused || (n.stressSince && t - n.stressSince > 30000) || (n.busySince && t - n.busySince > 60000);
    if (evict) for (const i of Object.values(db.instances)) if (i.nodeId === n.id && i.desired && !i.draining) i.draining = true;
    S.touch();
  }
}

// ---------- 스케줄링 ----------
function pickNode(svc, exclude = new Set()) {
  const db = S.db, plan = PLANS[svc.plan];
  const pl = svc.placement;
  const mine = C.serviceInstances(svc.id);
  const usedNodes = new Set(mine.map((i) => i.nodeId));
  const usedOwners = new Set(mine.map((i) => db.nodes[i.nodeId] && db.nodes[i.nodeId].ownerId));
  let best = null, bestScore = -1e9;
  for (const n of Object.values(db.nodes)) {
    if (n.status !== 'online' || n.paused || n.disconnected || exclude.has(n.id)) continue;
    if (!n.caps || (svc.runtime === 'docker' && !n.caps.docker)) continue;
    if (svc.runtime !== 'static' && !['docker', 'process'].includes(n.caps.sandbox)) continue; // 코드 실행 불가 노드 제외
    if (pl.groupId && n.groupId !== pl.groupId) continue;
    if (!pl.groupId && n.groupId && db.groups[n.groupId] && db.groups[n.groupId].private && db.groups[n.groupId].ownerId !== svc.ownerId) continue;
    if (pl.region && pl.region !== 'any' && n.region !== pl.region) continue;
    if (pl.country && n.country !== pl.country) continue;
    const a = C.nodeAllocation(n.id);
    const freeCpu = n.limits.cpuCores - a.cpu, freeRam = n.limits.ramMB - a.ram;
    if (freeCpu < plan.cpu - 1e-9 || freeRam < plan.ramMB) continue;
    const rep = C.reputation(n);
    if (pl.priority && rep < 70) continue;
    let score = rep * 0.5 + (freeCpu / n.limits.cpuCores) * 25 + (freeRam / n.limits.ramMB) * 15 - ((n.metrics && n.metrics.cpuLoad) || 0) * 0.2;
    if (usedNodes.has(n.id)) { if (pl.spread) continue; score -= 40; }
    if (pl.spread && (pl.ha || mine.length) && !usedOwners.has(n.ownerId)) score += 25; // 서로 다른 제공자 우선
    if (pl.spot) score -= rep * 0.3;                                                      // 스팟: 신뢰도 낮은 노드 선호
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

function spawn(svc, dep, node) {
  const plan = PLANS[svc.plan];
  const i = {
    id: S.id('ins'), serviceId: svc.id, deploymentId: dep.id, nodeId: node.id, desired: true, draining: false, status: 'pending',
    cpu: plan.cpu, ramMB: plan.ramMB, createdAt: S.now(), restarts: 0, restartNonce: 0, startedAt: null, port: null, usedRamMB: null,
  };
  S.db.instances[i.id] = i;
  C.pushLog(svc.id, { inst: 'platform', node: node.name, stream: 'sys', line: `인스턴스 ${i.id} 배치 -> 노드 ${node.name} (${node.region})` });
  S.touch();
  return i;
}

// ---------- 서비스 조정 루프 ----------
function reconcileService(svc) {
  const db = S.db, t = S.now();
  const all = C.serviceInstances(svc.id, false);

  // 정리: 중단 대상이고 에이전트가 더 이상 실행하지 않는 인스턴스 삭제
  for (const i of all) {
    const n = db.nodes[i.nodeId];
    if (!i.desired && (!n || n.status === 'offline' || !i.reportedAt || t - i.reportedAt > 6000 || i.status === 'stopped' || i.stopRequestedAt && t - i.stopRequestedAt > 30000)) {
      delete db.instances[i.id]; S.touch();
    }
  }
  if (svc.status === 'stopped' || svc.status === 'suspended') {
    for (const i of C.serviceInstances(svc.id)) { i.desired = false; i.stopRequestedAt = i.stopRequestedAt || t; }
    return;
  }

  const live = svc.currentDeploymentId && db.deployments[svc.currentDeploymentId];
  const building = Object.values(db.deployments).find((d) => d.serviceId === svc.id && d.status === 'building');
  const target = building || live;
  if (!target) return;

  const desired = svc.type === 'worker' || svc.type === 'cron' ? 1 : svc.scaling.desired;
  // 실패한 인스턴스는 제외하고 다른 노드에 대체 (배포 중이면 실패 횟수 누적)
  for (const i of C.serviceInstances(svc.id)) {
    if (i.status !== 'failed') continue;
    i.desired = false; i.stopRequestedAt = t;
    const d = db.deployments[i.deploymentId];
    if (d && d.status === 'building') { d.failCount = (d.failCount || 0) + 1; d.lastError = i.error; }
    else L.alert(svc.ownerId, 'warn', `인스턴스 실패: ${svc.name}`, `${i.error || '비정상 종료'} - 다른 노드에 대체 인스턴스를 배치합니다.`);
  }
  const inst = C.serviceInstances(svc.id);

  // 빌드 실패 / 타임아웃
  if (building) {
    const bi = inst.filter((i) => i.deploymentId === building.id);
    if (building.failCount >= 3) {
      C.cancelDeployment(building, 'failed');
      C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `배포 v${building.version} 실패: ${building.lastError || '실행 오류'} (이전 버전 유지)` });
      L.alert(svc.ownerId, 'critical', `배포 실패: ${svc.name}`, building.lastError || '빌드/실행 중 오류가 발생했습니다.');
      return;
    }
    if (t - building.createdAt > BUILD_TIMEOUT) {
      C.cancelDeployment(building, 'failed');
      C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `배포 v${building.version} 시간 초과` });
      return;
    }
    const ok = bi.filter((i) => i.status === 'running').length;
    const need = svc.type === 'cron' || svc.type === 'worker' ? 1 : Math.max(1, Math.ceil(desired / 2));
    const isReady = svc.type === 'cron' ? bi.some((i) => ['running', 'idle'].includes(i.status)) : ok >= need;
    if (isReady) {
      if (live && live.id !== building.id) { live.status = 'superseded'; live.finishedAt = t; }
      building.status = 'live'; building.finishedAt = t; svc.currentDeploymentId = building.id;
      for (const i of inst) if (i.deploymentId !== building.id) i.draining = true; // 이전 버전: 새 버전이 desired 를 채우면 종료
      C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `배포 v${building.version} 라이브` });
      S.touch();
    }
  }

  const cur = svc.currentDeploymentId === target.id || building ? target : live;
  const curInsts = inst.filter((i) => i.deploymentId === cur.id && !i.draining);
  const missing = desired - curInsts.length;

  // 부족분 배치 (장애 대체 포함). failover.policy === 'none' 이면 장애 시 대체하지 않음
  if (missing > 0) {
    for (let k = 0; k < missing; k++) {
      const wasLost = all.some((i) => i.lost && i.deploymentId === cur.id);
      if (live && !building && svc.failover.policy === 'none' && wasLost) break;
      const n = pickNode(svc);
      if (!n) {
        if (!svc._noCapacityAt || t - svc._noCapacityAt > 30000) {
          svc._noCapacityAt = t;
          C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: '배치 가능한 노드가 없습니다 (용량/지역/그룹 조건 확인)' });
        }
        break;
      }
      spawn(svc, cur, n);
    }
  } else if (missing < 0) { // 축소: 부하 낮은 순서가 아닌 최신 인스턴스부터 종료
    const extra = curInsts.sort((a, b) => b.createdAt - a.createdAt).slice(0, -missing);
    for (const i of extra) { i.desired = false; i.stopRequestedAt = t; }
  }

  // draining: 대체 인스턴스가 충분히 실행 중이면 종료
  const healthy = inst.filter((i) => i.deploymentId === cur.id && !i.draining && i.status === 'running' && i.desired).length;
  const drainNeed = svc.type === 'cron' || svc.type === 'worker' ? 1 : Math.max(1, Math.min(desired, curInsts.length));
  if (healthy >= drainNeed || (!building && healthy >= desired)) {
    for (const i of inst) if (i.draining) { i.desired = false; i.stopRequestedAt = t; }
  }
  // 이전 배포 인스턴스가 라이브 후에도 남아있으면 draining 보장
  if (!building) for (const i of inst) if (i.deploymentId !== svc.currentDeploymentId && !i.draining) i.draining = true;
}

// ---------- 오토스케일 (10초 주기) ----------
function autoscale() {
  const t = S.now();
  for (const svc of Object.values(S.db.services)) {
    const sc = svc.scaling;
    if (svc.status !== 'active' || svc.type === 'worker' || svc.type === 'cron') continue;
    const plan = PLANS[svc.plan];
    sc.max = Math.min(sc.max, plan.maxReplicas);
    if (svc.placement.ha) sc.min = Math.max(2, sc.min);
    if (!sc.autoscale) { sc.desired = clamp(sc.desired, sc.min, sc.max); continue; }
    const running = Math.max(1, C.serviceInstances(svc.id).filter((i) => i.status === 'running').length);
    const per = C.rps(svc.id, 10) / running;
    if (per > sc.targetRps && sc.desired < sc.max && t - sc.lastScaleAt > 20000) {
      sc.desired++; sc.lastScaleAt = t; sc.lowSince = 0;
      C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `오토스케일 확장 -> ${sc.desired} (인스턴스당 ${per.toFixed(1)} rps)` });
    } else if (per < sc.targetRps * 0.3 && sc.desired > sc.min) {
      sc.lowSince = sc.lowSince || t;
      if (t - sc.lowSince > 120000 && t - sc.lastScaleAt > 20000) {
        sc.desired--; sc.lastScaleAt = t; sc.lowSince = 0;
        C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: `오토스케일 축소 -> ${sc.desired}` });
      }
    } else sc.lowSince = 0;
    sc.desired = clamp(sc.desired, sc.min, sc.max);
  }
}

// ---------- 가동률 샘플링 ----------
let lastSample = 0;
function sampleAvailability() {
  const t = S.now();
  if (t - lastSample < 10000) return;
  lastSample = t;
  const hour = Math.floor(t / 3600000);
  for (const svc of Object.values(S.db.services)) {
    if (svc.status !== 'active' || !svc.currentDeploymentId || svc.type === 'worker' || svc.type === 'cron') continue;
    const up = C.serviceInstances(svc.id).some((i) => i.status === 'running' && i.deploymentId === svc.currentDeploymentId) ? 1 : 0;
    const v = (svc.avail[hour] = svc.avail[hour] || [0, 0]);
    v[0] += up; v[1] += 1;
    const k = Object.keys(svc.avail);
    if (k.length > 200) delete svc.avail[k[0]];
    if (!up) L.openIncident(svc.ownerId, 'service_down', svc.id, `${svc.name} 서비스 중단`);
    else if (S.db.incidents.some((i) => !i.resolvedAt && i.type === 'service_down' && i.ref === svc.id)) {
      L.resolveIncident('service_down', svc.id);
      L.alert(svc.ownerId, 'info', `서비스 복구: ${svc.name}`, '새 인스턴스가 실행되어 트래픽이 재분배되었습니다.');
    }
  }
}

function run() {
  monitorNodes();
  for (const svc of Object.values(S.db.services)) {
    try { reconcileService(svc); } catch (e) { console.error('[reconcile]', svc.id, e); }
  }
  sampleAvailability();
}

function start() {
  setInterval(run, 2000).unref();
  setInterval(autoscale, 10000).unref();
}

module.exports = { start, run, pickNode };
