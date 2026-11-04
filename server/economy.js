'use strict';
const S = require('./store');
const L = require('./ledger');
const cfg = require('./config');
const C = require('./core');
const { hourlyCost, REWARD, loyaltyMultiplier, EGRESS_CREDITS_PER_GB } = require('./plans');

let last = S.now();

function tick() {
  const db = S.db, t = S.now();
  const dt = Math.min((t - last) / 1000, 600);
  last = t;
  if (dt <= 0) return;

  // 1) 노드 가동 통계 + 제공 보상
  for (const n of Object.values(db.nodes)) {
    if (n.status === 'offline' || n.disconnected) { n.stats.offlineSeconds += dt; continue; }
    n.stats.onlineSeconds += dt;
    if (n.paused || n.status === 'busy') continue; // 일시 중지/사용 중에는 보상 없음
    const lim = n.limits;
    const perHour = lim.cpuCores * REWARD.cpuPerCore + (lim.ramMB / 1024) * REWARD.ramPerGB
      + lim.diskGB * REWARD.diskPerGB + lim.bandwidthMbps * REWARD.netPerMbps;
    const rep = C.reputation(n);
    const mult = (0.5 + rep / 200) * loyaltyMultiplier(n, t) * (n.status === 'degraded' ? 0.5 : 1);
    const amt = perHour * mult * dt / 3600;
    L.add(n.ownerId, 'earn_capacity', amt, { nodeId: n.id });
    n.stats.earned += amt;
    // 신규 노드 보너스: 10분 이상 안정적으로 온라인
    if (!n.stats.bonusPaid && n.stats.onlineSeconds >= 600) {
      n.stats.bonusPaid = true;
      L.add(n.ownerId, 'earn_bonus_new', cfg.NEW_NODE_BONUS, { nodeId: n.id }, '신규 노드 참여 보너스');
      n.stats.earned += cfg.NEW_NODE_BONUS;
      L.alert(n.ownerId, 'info', '신규 노드 보너스', `${n.name} 노드 참여 보너스 ${cfg.NEW_NODE_BONUS} 크레딧이 지급되었습니다.`);
    }
    // 안정 가동 보너스: 24시간 연속 온라인마다 하루치 보상의 10%
    n.stats.uptimeAccum = (n.stats.uptimeAccum || 0) + dt;
    if (n.stats.uptimeAccum >= 86400) {
      n.stats.uptimeAccum = 0;
      const b = perHour * 24 * 0.1;
      L.add(n.ownerId, 'earn_uptime', b, { nodeId: n.id }, '24시간 안정 가동 보너스');
      n.stats.earned += b;
    }
  }

  // 2) 호스팅 사용료 차감 및 노드 제공자 정산
  for (const svc of Object.values(db.services)) {
    if (svc.status !== 'active') continue;
    const owner = db.users[svc.ownerId];
    const unit = hourlyCost(svc);
    const running = C.serviceInstances(svc.id).filter((i) => ['running', 'starting', 'idle'].includes(i.status));
    let cost = 0;
    const paid = [];
    for (const i of running) {
      const c = unit * dt / 3600;
      cost += c;
      paid.push([i, c]);
    }
    // 데이터 전송료
    const m = C.svcMetrics(svc.id);
    for (const [instId, bytes] of m.egress) {
      const c = bytes / 1e9 * EGRESS_CREDITS_PER_GB;
      m.egress.delete(instId);
      const inst = db.instances[instId];
      if (c > 0 && inst) paid.push([inst, c, 'transfer']);
      cost += c;
    }
    if (cost <= 0) continue;
    if (owner.credits < cost) {
      svc.status = 'suspended';
      L.alert(owner.id, 'critical', `크레딧 부족으로 중지: ${svc.name}`, '크레딧을 충전(노드 제공)한 뒤 서비스를 다시 시작하세요.');
      C.pushLog(svc.id, { inst: 'platform', node: '-', stream: 'sys', line: '크레딧 부족 - 서비스 일시 중지' });
      continue;
    }
    L.add(owner.id, 'spend_compute', -cost, { serviceId: svc.id });
    for (const [inst, c] of paid) {
      const node = db.nodes[inst.nodeId];
      if (!node) continue;
      const pay = c * cfg.PROVIDER_SHARE;
      L.add(node.ownerId, 'earn_usage', pay, { nodeId: node.id });
      node.stats.earned += pay;
    }
    if (owner.credits < unit * 2 && !owner._lowWarned) {
      owner._lowWarned = true;
      L.alert(owner.id, 'warn', '크레딧 잔액 부족 임박', '현재 소모 속도로는 곧 서비스가 중지됩니다.');
    }
    if (owner.credits > unit * 10) owner._lowWarned = false;
  }
  S.touch();
}

function estimate(userId) {
  const db = S.db;
  let perHour = 0;
  const bySvc = [];
  for (const s of Object.values(db.services)) {
    if (s.ownerId !== userId || s.status !== 'active') continue;
    const n = C.serviceInstances(s.id).length;
    const c = hourlyCost(s) * n;
    perHour += c; bySvc.push({ serviceId: s.id, name: s.name, perHour: c, instances: n });
  }
  let earnPerHour = 0;
  for (const n of Object.values(db.nodes)) {
    if (n.ownerId !== userId || n.status === 'offline' || n.paused) continue;
    const lim = n.limits;
    earnPerHour += (lim.cpuCores * REWARD.cpuPerCore + (lim.ramMB / 1024) * REWARD.ramPerGB + lim.diskGB * REWARD.diskPerGB + lim.bandwidthMbps * REWARD.netPerMbps) * (0.5 + C.reputation(n) / 200);
  }
  return { burnPerHour: perHour, burnPerDay: perHour * 24, burnPerMonth: perHour * 720, earnPerHour, bySvc,
    runwayHours: perHour > earnPerHour ? db.users[userId].credits / (perHour - earnPerHour) : null };
}

function start() {
  setInterval(tick, cfg.TICK_SECONDS * 1000).unref();
}

module.exports = { start, tick, estimate };
