'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const empty = () => ({
  users: {}, sessions: {}, nodes: {}, groups: {}, services: {}, deployments: {},
  instances: {}, ledger: [], alerts: [], incidents: [], seq: 0,
});

let db = empty();
let dirty = false;

function load() {
  try {
    db = Object.assign(empty(), JSON.parse(fs.readFileSync(cfg.DATA_FILE, 'utf8')));
  } catch { db = empty(); }
  // 재시작 시 모든 인스턴스는 에이전트가 다시 보고할 때까지 대기 상태
  for (const n of Object.values(db.nodes)) { n.status = 'offline'; }
  return db;
}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(cfg.DATA_FILE), { recursive: true });
    const tmp = cfg.DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, cfg.DATA_FILE);
  } catch (e) { console.error('[store] save failed', e.message); }
}

const touch = () => { dirty = true; };
setInterval(save, 2000).unref();
process.on('exit', save);

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => Date.now();

module.exports = { load, save, touch, id, now, get db() { return db; } };
