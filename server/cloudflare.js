'use strict';
// Cloudflare DNS 연동: name.krl.kr 서브도메인 발급/회수, 커스텀 도메인(Cloudflare for SaaS)
// 환경변수: CF_API_TOKEN, CF_ZONE_ID, CF_ORIGIN (원본 서버 IP 또는 호스트명)
// 설정이 없으면 비활성화되며, 이 경우 *.krl.kr 와일드카드 레코드를 직접 만들어 둔 것으로 간주한다.
const cfg = require('./config');

const API = 'https://api.cloudflare.com/client/v4';
const enabled = () => !!(process.env.CF_API_TOKEN && process.env.CF_ZONE_ID && process.env.CF_ORIGIN);

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare HTTP ${r.status}`);
  return j.result;
}

const zone = () => process.env.CF_ZONE_ID;
const isIp = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s);

/** *.krl.kr 와일드카드(프록시) 레코드를 한 번만 만든다. 이후 모든 서브도메인은 DNS 변경 없이 플랫폼이 발급/회수한다. */
async function ensureWildcard() {
  if (!enabled()) return null;
  const name = `*.${cfg.BASE_DOMAIN}`;
  const existing = await call('GET', `/zones/${zone()}/dns_records?name=${encodeURIComponent(name)}`);
  if (existing.length) return existing[0].id;
  const rec = await call('POST', `/zones/${zone()}/dns_records`, {
    type: isIp(process.env.CF_ORIGIN) ? 'A' : 'CNAME', name, content: process.env.CF_ORIGIN, proxied: true, ttl: 1, comment: 'krl-cloud wildcard',
  });
  return rec.id;
}

// 서비스별 DNS 레코드는 기본적으로 만들지 않는다 (CF_PER_RECORD=1 일 때만)
const perRecord = () => enabled() && process.env.CF_PER_RECORD === '1';

/** slug.krl.kr 을 프록시(주황 구름) 레코드로 생성 -> Cloudflare 가 SSL 자동 발급/종단 */
async function createSubdomain(slug) {
  if (!perRecord()) return null;
  const name = `${slug}.${cfg.BASE_DOMAIN}`;
  const existing = await call('GET', `/zones/${zone()}/dns_records?name=${encodeURIComponent(name)}`);
  if (existing.length) return existing[0].id;
  const rec = await call('POST', `/zones/${zone()}/dns_records`, {
    type: isIp(process.env.CF_ORIGIN) ? 'A' : 'CNAME', name, content: process.env.CF_ORIGIN, proxied: true, ttl: 1,
    comment: 'krl-cloud managed',
  });
  return rec.id;
}

async function deleteSubdomain(slug) {
  if (!perRecord()) return;
  const name = `${slug}.${cfg.BASE_DOMAIN}`;
  const recs = await call('GET', `/zones/${zone()}/dns_records?name=${encodeURIComponent(name)}`);
  for (const r of recs) await call('DELETE', `/zones/${zone()}/dns_records/${r.id}`);
}

/** Cloudflare for SaaS 커스텀 호스트네임 등록 (SSL 은 HTTP 검증으로 자동 발급) */
async function addCustomHostname(host) {
  if (!enabled()) return null;
  return call('POST', `/zones/${zone()}/custom_hostnames`, {
    hostname: host, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
  });
}
async function getCustomHostname(host) {
  if (!enabled()) return null;
  const r = await call('GET', `/zones/${zone()}/custom_hostnames?hostname=${encodeURIComponent(host)}`);
  return r[0] || null;
}
async function removeCustomHostname(host) {
  if (!enabled()) return;
  const h = await getCustomHostname(host);
  if (h) await call('DELETE', `/zones/${zone()}/custom_hostnames/${h.id}`);
}

module.exports = { enabled, ensureWildcard, createSubdomain, deleteSubdomain, addCustomHostname, getCustomHostname, removeCustomHostname };
