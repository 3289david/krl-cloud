'use strict';

// 인스턴스 1개당 시간당 크레딧
const PLANS = {
  free:     { label: 'Free',     cpu: 0.1,  ramMB: 256,  creditsPerHour: 0,  maxReplicas: 1 },
  starter:  { label: 'Starter',  cpu: 0.25, ramMB: 512,  creditsPerHour: 2,  maxReplicas: 5 },
  standard: { label: 'Standard', cpu: 0.5,  ramMB: 1024, creditsPerHour: 4,  maxReplicas: 10 },
  pro:      { label: 'Pro',      cpu: 1,    ramMB: 2048, creditsPerHour: 8,  maxReplicas: 20 },
  proplus:  { label: 'Pro Plus', cpu: 2,    ramMB: 4096, creditsPerHour: 16, maxReplicas: 20 },
};

// 옵션 가격 배수
const OPTION_MULT = { ha: 0.2, priority: 0.15, geo: 0.1 }; // 가산
const SPOT_MULT = 0.5;
const EGRESS_CREDITS_PER_GB = 0.5;
const DISK_CREDITS_PER_GB_HOUR = 0.01;

function hourlyCost(service) {
  const p = PLANS[service.plan] || PLANS.free;
  let m = 1;
  if (service.placement.ha) m += OPTION_MULT.ha;
  if (service.placement.priority) m += OPTION_MULT.priority;
  if (service.placement.region && service.placement.region !== 'any') m += OPTION_MULT.geo;
  if (service.placement.spot) m *= SPOT_MULT;
  return p.creditsPerHour * m;
}

// 제공자 보상 (시간당)
const REWARD = {
  cpuPerCore: 1.0,      // 제공 코어당
  ramPerGB: 0.4,
  diskPerGB: 0.01,
  netPerMbps: 0.02,
};
// 가동 시간 / 장기 유지 보너스 배수
function loyaltyMultiplier(node, nowMs) {
  const days = (nowMs - node.createdAt) / 86400000;
  return 1 + Math.min(0.25, Math.floor(days / 30) * 0.05);
}

module.exports = { PLANS, hourlyCost, REWARD, loyaltyMultiplier, EGRESS_CREDITS_PER_GB, DISK_CREDITS_PER_GB_HOUR };
