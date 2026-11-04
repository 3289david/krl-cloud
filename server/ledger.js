'use strict';
const S = require('./store');

const HOUR = 3600000;
const MAX_LEDGER = 30000;

/**
 * 크레딧 증감. 같은 (사용자, 종류, 참조, 시간 단위)는 하나의 항목으로 합산해서 장부가 비대해지지 않게 한다.
 */
function add(userId, kind, amount, ref = {}, note = '') {
  const db = S.db;
  const u = db.users[userId];
  if (!u || !amount) return;
  u.credits += amount;
  const bucket = Math.floor(S.now() / HOUR) * HOUR;
  const key = `${userId}|${kind}|${ref.nodeId || ''}|${ref.serviceId || ''}|${bucket}`;
  const last = findRecent(key);
  if (last) { last.amount += amount; last.ts = S.now(); }
  else {
    const e = { id: S.id('tx'), key, ts: S.now(), bucket, userId, kind, amount, nodeId: ref.nodeId, serviceId: ref.serviceId, note };
    db.ledger.push(e);
    recent.set(key, e);
    if (db.ledger.length > MAX_LEDGER) db.ledger.splice(0, db.ledger.length - MAX_LEDGER);
  }
  S.touch();
}

const recent = new Map();
function findRecent(key) {
  const e = recent.get(key);
  if (e) return e;
  const l = S.db.ledger;
  for (let i = l.length - 1; i >= 0 && i > l.length - 400; i--) if (l[i].key === key) { recent.set(key, l[i]); return l[i]; }
  return null;
}
setInterval(() => { // 지난 시간 버킷 정리
  const cutoff = Math.floor(S.now() / HOUR) * HOUR;
  for (const [k, e] of recent) if (e.bucket < cutoff) recent.delete(k);
}, 60000).unref();

const isEarn = (k) => k.startsWith('earn_') || k === 'signup' || k === 'daily';

function alert(userId, level, title, msg) {
  const db = S.db;
  db.alerts.push({ id: S.id('al'), userId, ts: S.now(), level, title, msg, read: false });
  if (db.alerts.length > 5000) db.alerts.splice(0, db.alerts.length - 5000);
  S.touch();
}

function openIncident(userId, type, ref, detail) {
  const db = S.db;
  const dup = db.incidents.find((i) => !i.resolvedAt && i.type === type && i.ref === ref);
  if (dup) return dup;
  const inc = { id: S.id('inc'), userId, type, ref, detail, startedAt: S.now(), resolvedAt: null };
  db.incidents.push(inc);
  if (db.incidents.length > 3000) db.incidents.splice(0, db.incidents.length - 3000);
  S.touch();
  return inc;
}
function resolveIncident(type, ref) {
  for (const i of S.db.incidents) if (!i.resolvedAt && i.type === type && i.ref === ref) { i.resolvedAt = S.now(); S.touch(); }
}

module.exports = { add, alert, openIncident, resolveIncident, isEarn };
