'use strict';
const path = require('path');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  PORT: num(process.env.PORT, 8080),
  // 무료 서브도메인: <name>.<BASE_DOMAIN>
  BASE_DOMAIN: (process.env.BASE_DOMAIN || 'krl.kr').toLowerCase(),
  // 로컬 개발용 추가 도메인 (name.localhost 로 접속 가능)
  DEV_DOMAINS: (process.env.DEV_DOMAINS || 'localhost').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  DATA_FILE: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  // 크레딧 정산 주기(초). 데모에서는 짧게, 운영에서는 60 권장
  TICK_SECONDS: num(process.env.TICK_SECONDS, 60),
  // 하트비트가 이 시간(초) 동안 없으면 노드 오프라인
  NODE_TIMEOUT: num(process.env.NODE_TIMEOUT, 15),
  SIGNUP_CREDITS: num(process.env.SIGNUP_CREDITS, 1000),
  NEW_NODE_BONUS: num(process.env.NEW_NODE_BONUS, 200),
  // 소비자가 지불한 크레딧 중 노드 제공자에게 돌아가는 비율
  PROVIDER_SHARE: num(process.env.PROVIDER_SHARE, 0.85),
  MAX_BODY: 10 * 1024 * 1024,
  ASK_TOKEN: process.env.ASK_TOKEN || '', // Caddy on_demand_tls ask 보호용(선택)
};
