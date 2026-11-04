'use strict';
/* KRL Cloud 대시보드 - 의존성 없는 SPA */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, meta: null, sig: '', dirty: false, tab: {}, cleanup: [], seq: 0 };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) { S.me = null; renderAuth(); }
  if (!r.ok) throw new Error(j.error || `오류 ${r.status}`);
  return j;
}
const GET = (p) => api('GET', p), POST = (p, b) => api('POST', p, b || {}), PATCH = (p, b) => api('PATCH', p, b), DEL = (p) => api('DELETE', p);

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'err'); return undefined; }
}

// ---------- 포맷 ----------
const num = (n, d = 0) => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const cr = (n) => num(n, Math.abs(n) < 100 ? 2 : 0);
const pct = (v, d = 2) => (v == null ? '-' : (v * 100).toFixed(d).replace(/\.?0+$/, '') + '%');
const bytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB' : (b || 0) + ' B');
const ago = (t) => {
  if (!t) return '-';
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.floor(s)}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`;
};
const clock = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour12: false });
const dt = (t) => new Date(t).toLocaleString('ko-KR', { hour12: false });
const BADGE = { online: 'ok', running: 'ok', live: 'ok', healthy: 'ok', active: 'ok', verified: 'ok', degraded: 'warn', busy: 'warn', unhealthy: 'warn', draining: 'warn', paused: '', pending: 'info', starting: 'info', building: 'info',
  offline: 'bad', failed: 'bad', suspended: 'bad', down: 'bad', stopped: '', superseded: '', stopping: '' };
const LABEL = { online: 'Online', degraded: 'Degraded', offline: 'Offline', busy: '사용 중', paused: '일시 중지', pending: '연결 대기', running: 'Running', starting: 'Starting', unhealthy: 'Unhealthy',
  failed: 'Failed', draining: 'Draining', live: 'Live', building: 'Building', superseded: '이전 버전', stopped: 'Stopped', suspended: '크레딧 부족', healthy: 'Healthy', down: 'Down', active: 'Active' };
const badge = (s) => `<span class="badge b-${BADGE[s] ?? ''}">${esc(LABEL[s] || s)}</span>`;
const KIND = { earn_capacity: '자원 제공 보상 (CPU·RAM·디스크·네트워크)', earn_usage: '호스팅 사용 보상', earn_bonus_new: '신규 노드 참여 보너스', earn_uptime: '안정 가동 보너스', earn_event: '이벤트 보상', signup: '가입 환영 크레딧', spend_compute: '호스팅 사용 (인스턴스·전송)' };
const TYPE = { web: 'Web Service', static: 'Static Site', worker: 'Background Worker', cron: 'Cron Job', private: 'Private Service' };
const REGION = { seoul: '서울', busan: '부산', incheon: '인천', daejeon: '대전', jeju: '제주', tokyo: '도쿄', osaka: '오사카', singapore: '싱가포르', 'us-west': '미국 서부', 'us-east': '미국 동부', 'eu-west': '유럽 서부' };
const reg = (r) => REGION[r] || r;
const cls = (v) => (v > 90 ? 'bad' : v > 70 ? 'warn' : '');
const meter = (v) => `<div class="bar ${cls(v)}"><i style="width:${Math.min(100, Math.max(0, v || 0))}%"></i></div>`;
function cmdTabs(c) {
  const os = [['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux'], ['android', 'Android (Termux)'], ['manual', '수동 실행']];
  const guess = /Win/.test(navigator.platform) ? 'windows' : /Mac/.test(navigator.platform) ? 'mac' : /Android/.test(navigator.userAgent) ? 'android' : 'linux';
  return `<div class="cmdtabs" data-cmds="${esc(JSON.stringify(c))}"><div class="tabs" style="margin-bottom:10px">${os.map(([k, l]) => `<button type="button" class="${k === guess ? 'active' : ''}" data-a="ostab" data-os="${k}">${l}</button>`).join('')}</div>
    <div class="cmd"><code class="grow cmdtext" style="background:none">${esc(c[guess])}</code><button type="button" class="btn sm" data-a="copycmd">복사</button></div></div>`;
}
const copyBtn = (text) => `<button class="btn sm" data-a="copy" data-t="${esc(text)}">복사</button>`;

// ---------- 차트 ----------
function chart(series, { h = 90, max, fill = true } = {}) {
  const W = 600, n = Math.max(...series.map((s) => s.vals.length), 2);
  const m = max || Math.max(1e-9, ...series.flatMap((s) => s.vals));
  const paths = series.map((s) => {
    const pts = s.vals.map((v, i) => [(i / (n - 1)) * W, h - 4 - (v / m) * (h - 10)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `${fill ? `<path d="${d} L${W} ${h} L0 ${h} Z" fill="${s.color}" opacity=".12"/>` : ''}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block"><line x1="0" x2="${W}" y1="${h - 1}" y2="${h - 1}" stroke="var(--line)"/>${paths}</svg>`;
}
function bars(vals, { h = 90, color = 'var(--brand)' } = {}) {
  const W = 600, m = Math.max(1e-9, ...vals), bw = W / vals.length;
  return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block">${vals.map((v, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - (v / m) * (h - 4)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((v / m) * (h - 4)).toFixed(1)}" rx="2" fill="${color}" opacity=".85"/>`).join('')}</svg>`;
}

// ---------- 모달 ----------
function modal(html) {
  closeModal();
  const o = document.createElement('div');
  o.className = 'overlay'; o.id = 'modal';
  o.innerHTML = `<div class="modal">${html}</div>`;
  o.addEventListener('mousedown', (e) => { if (e.target === o) closeModal(); });
  document.body.appendChild(o);
  return o;
}
const closeModal = () => { const m = $('#modal'); if (m) m.remove(); };
const confirmBox = (title, msg, okLabel = '확인') => new Promise((res) => {
  const m = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p><div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn" id="c-no">취소</button><button class="btn danger" id="c-ok">${esc(okLabel)}</button></div>`);
  $('#c-no', m).onclick = () => { closeModal(); res(false); };
  $('#c-ok', m).onclick = () => { closeModal(); res(true); };
});

// ---------- 인증 ----------
function renderAuth(mode = 'login') {
  $('#root').innerHTML = `<div class="authwrap"><div class="authcard card">
    <div class="hero"><div class="logo" style="margin:0 auto 10px;width:46px;height:46px;font-size:24px">☁</div><h1>KRL Cloud</h1>
    <div class="muted">내 PC를 제공하고, 모두의 PC에 호스팅하세요.<br>무료 서브도메인 <b>name.${esc(S.meta.baseDomain)}</b> 제공</div></div>
    <form id="authf" class="stack">
      ${mode === 'signup' ? '<label class="f"><span>이름</span><input name="name" placeholder="홍길동"></label>' : ''}
      <label class="f"><span>이메일</span><input name="email" type="email" required autocomplete="email"></label>
      <label class="f"><span>비밀번호</span><input name="password" type="password" required minlength="8" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"><span class="hint">${mode === 'signup' ? '8자 이상' : ''}</span></label>
      <button class="btn primary" style="justify-content:center">${mode === 'signup' ? '가입하고 시작하기' : '로그인'}</button>
      <div class="muted small right" style="text-align:center">${mode === 'signup' ? '이미 계정이 있나요? <a href="#" id="sw">로그인</a>' : '처음이신가요? <a href="#" id="sw">회원가입 (시작 크레딧 지급)</a>'}</div>
    </form></div></div>`;
  $('#sw').onclick = (e) => { e.preventDefault(); renderAuth(mode === 'login' ? 'signup' : 'login'); };
  $('#authf').onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    const u = await run(() => POST('/api/auth/' + mode, b));
    if (u) { S.me = u; boot(); }
  };
}

// ---------- 셸 ----------
const NAV = [
  ['overview', '◉', 'Overview'],
  ['__', 'Contribute'], ['nodes', '🖥', 'My Nodes'], ['marketplace', '🛒', 'Node Marketplace'],
  ['__', 'Hosting'], ['services', '🚀', 'Hosting Projects'], ['subdomains', '🌐', 'Subdomains'], ['deployments', '📦', 'Deployments'], ['instances', '🧩', 'Instances'], ['logs', '📜', 'Logs'],
  ['__', 'Network'], ['analytics', '📈', 'Analytics'], ['alerts', '🔔', 'Alerts'],
  ['__', 'Economy'], ['credits', '💰', 'Credits'],
  ['__', ''], ['settings', '⚙', 'Settings'],
];
function renderShell() {
  $('#root').innerHTML = `<div class="app"><aside class="side" id="side">
    <div class="brand"><div class="logo">☁</div>KRL Cloud</div>
    <nav class="nav">${NAV.map((n) => (n[0] === '__' ? (n[1] ? `<div class="nav-group">${n[1]}</div>` : '<div style="height:8px"></div>') : `<a href="#/${n[0]}" data-nav="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}${n[0] === 'alerts' ? '<span class="cnt" id="alertcnt" hidden></span>' : ''}</a>`)).join('')}</nav>
  </aside><div class="main"><div class="top">
    <button class="btn sm menu-btn" data-a="menu">☰</button><div class="grow"></div>
    <span class="pill-status" id="topstat"></span>
    <a class="pill-status" href="#/credits" style="text-decoration:none;color:inherit">💰 <b id="topcr">${cr(S.me.credits)}</b> 크레딧</a>
    <button class="btn sm ghost" data-a="theme" title="테마">◐</button>
    <span class="muted small">${esc(S.me.name)}</span><button class="btn sm" data-a="logout">로그아웃</button>
  </div><main class="content" id="page"></main></div></div>`;
}

// ---------- 페이지 ----------
const P = {};
const route = () => {
  const h = location.hash.replace(/^#\/?/, '') || 'overview';
  const [name, ...rest] = h.split('/');
  return { name, params: rest.map(decodeURIComponent), key: h };
};

// Overview
P.overview = {
  load: () => GET('/api/overview'),
  render(d) {
    const first = !d.totalNodes && !d.services.length;
    return `<div class="page-h"><div><h1>Overview</h1><div class="muted">내 노드와 호스팅 프로젝트의 한눈에 보기</div></div>
      <div class="row"><a class="btn" href="#/nodes">+ PC 등록</a><a class="btn primary" href="#/services/new">+ 새 프로젝트 배포</a></div></div>
    <div class="grid g4">
      <div class="card stat"><div class="l">Connected Nodes</div><div class="v">${d.connectedNodes}<span class="muted" style="font-size:16px"> / ${d.totalNodes}</span></div><div class="s muted">네트워크 전체 ${d.network.online}대 온라인</div></div>
      <div class="card stat"><div class="l">Running Instances</div><div class="v">${d.runningInstances}<span class="muted" style="font-size:16px"> / ${d.totalInstances}</span></div><div class="s muted">네트워크 전체 ${d.network.instances}개 실행 중</div></div>
      <div class="card stat"><div class="l">Credit Balance</div><div class="v">${cr(d.credits)}</div><div class="s ${d.estimate.earnPerHour >= d.estimate.burnPerHour ? '' : 'muted'}" style="color:${d.estimate.earnPerHour >= d.estimate.burnPerHour ? 'var(--ok)' : 'var(--muted)'}">시간당 +${cr(d.estimate.earnPerHour)} / −${cr(d.estimate.burnPerHour)}</div></div>
      <div class="card stat"><div class="l">Availability (24h)</div><div class="v">${d.availability == null ? '-' : pct(d.availability, 2)}</div><div class="s muted">${d.services.length}개 프로젝트 평균</div></div>
    </div>
    ${first ? `<div class="card" style="margin-top:16px"><h2>시작하기</h2><div class="grid g3">
      <div><b>1. PC 등록</b><p class="muted">My Nodes 에서 PC를 등록하고 에이전트를 실행하면 유휴 자원이 크레딧이 됩니다.</p></div>
      <div><b>2. 프로젝트 배포</b><p class="muted">GitHub / Docker / 템플릿으로 배포하면 즉시 <code>name.${esc(S.meta.baseDomain)}</code> 주소가 생깁니다.</p></div>
      <div><b>3. 복제 & 자동 복구</b><p class="muted">여러 사람의 PC에 인스턴스를 분산하고, 장애 노드는 자동으로 제외됩니다.</p></div></div></div>` : ''}
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2 style="margin:0">Node Status</h2><a href="#/nodes" class="small">전체 보기</a></div>
        ${d.nodes.length ? `<div class="stack gap-s">${d.nodes.map((n) => `<a href="#/nodes/${n.id}" style="color:inherit;text-decoration:none" class="row card" style="padding:12px">
          <div class="grow"><b>${esc(n.name)}</b> <span class="muted small">${reg(n.region)}</span>
          <div class="small muted">CPU ${Math.round(n.metrics.cpuLoad || 0)}% · RAM ${Math.round(n.metrics.ramPct || 0)}% · 인스턴스 ${n.allocated.instances}</div></div>${badge(n.status)}</a>`).join('')}</div>`
          : '<div class="empty"><div class="big">🖥</div>등록된 노드가 없습니다</div>'}</div>
      <div class="card"><div class="card-h"><h2 style="margin:0">Hosting Projects</h2><a href="#/services" class="small">전체 보기</a></div>
        ${d.services.length ? `<div class="stack gap-s">${d.services.map((s) => `<a href="#/services/${s.id}" style="color:inherit;text-decoration:none" class="row card">
          <div class="grow"><b>${esc(s.name)}</b><div class="small muted">${esc(s.slug)}.${esc(S.meta.baseDomain)} · ${s.instances.running}/${s.scaling.desired} Instances</div></div>${badge(s.health)}</a>`).join('')}</div>`
          : '<div class="empty"><div class="big">🚀</div>배포한 프로젝트가 없습니다</div>'}</div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Network</h2><div class="grid g4">
      <div><div class="muted small">전체 노드</div><b style="font-size:20px">${d.network.nodes}</b></div><div><div class="muted small">온라인 노드</div><b style="font-size:20px">${d.network.online}</b></div>
      <div><div class="muted small">활성 지역</div><b style="font-size:20px">${d.network.regions}</b></div><div><div class="muted small">월 예상 소모</div><b style="font-size:20px">${cr(d.estimate.burnPerMonth)}</b></div></div></div>`;
  },
};

// My Nodes
P.nodes = {
  load: async () => ({ nodes: await GET('/api/nodes'), groups: await GET('/api/groups') }),
  render({ nodes, groups }) {
    const tot = nodes.reduce((a, n) => a + n.stats.earned, 0);
    return `<div class="page-h"><div><h1>My Nodes</h1><div class="muted">내 PC 자원을 제공하고 크레딧을 획득합니다 · 누적 획득 <b>${cr(tot)}</b> 크레딧</div></div>
      <div class="row"><button class="btn primary" data-a="pairNode">🔗 내 PC 연결</button><button class="btn" data-a="addNode">+ 토큰으로 등록</button></div></div>
    ${nodes.length ? `<div class="grid g3">${nodes.map((n) => `<a class="card" href="#/nodes/${n.id}" style="color:inherit;text-decoration:none">
      <div class="row between"><b>${esc(n.name)}</b>${badge(n.status)}</div>
      <div class="muted small" style="margin:2px 0 12px">${reg(n.region)} · 신뢰도 ${n.stats.reputation}/100</div>
      <div class="small row between"><span>CPU</span><span>${Math.round(n.metrics.cpuLoad || 0)}%</span></div>${meter(n.metrics.cpuLoad)}
      <div class="small row between" style="margin-top:8px"><span>RAM</span><span>${Math.round(n.metrics.ramPct || 0)}%</span></div>${meter(n.metrics.ramPct)}
      <div class="small row between" style="margin-top:8px"><span>제공 할당</span><span>${n.allocated.cpu.toFixed(2)} / ${n.limits ? n.limits.cpuCores : '-'} core</span></div>${meter(n.limits ? (n.allocated.cpu / n.limits.cpuCores) * 100 : 0)}
      <div class="row between small" style="margin-top:12px"><span class="muted">획득 <b style="color:var(--ok)">+${cr(n.stats.earned)}</b></span><span class="muted">인스턴스 ${n.allocated.instances}</span></div></a>`).join('')}</div>`
      : `<div class="card empty"><div class="big">🖥</div><p>아직 등록된 PC가 없습니다.</p><button class="btn primary" data-a="addNode">첫 PC 등록하기</button></div>`}
    <div class="card" style="margin-top:20px"><div class="card-h"><div><h2 style="margin:0">Node Groups</h2><div class="muted small">여러 노드를 묶어서 관리하고, Private Hosting 으로 이 그룹에서만 서비스를 실행할 수 있습니다.</div></div>
      <button class="btn sm" data-a="addGroup">+ 그룹</button></div>
      ${groups.length ? groups.map((g) => `<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><b>${esc(g.name)}</b><span class="tag">노드 ${g.nodes.length}</span><span class="tag">${g.private ? 'Private' : 'Public'}</span><div class="grow"></div><button class="btn sm danger" data-a="delGroup" data-id="${g.id}">삭제</button></div>`).join('') : '<div class="muted">그룹이 없습니다.</div>'}</div>`;
  },
};

P['nodes/:id'] = {
  load: async ([id]) => {
    const [n, e, groups] = await Promise.all([GET('/api/nodes/' + id), GET(`/api/nodes/${id}/earnings`), GET('/api/groups')]);
    return { n, e, groups };
  },
  render({ n, e, groups }) {
    const m = n.metrics || {}, L = n.limits || { cpuCores: 1, ramMB: 1024, diskGB: 10, bandwidthMbps: 10 }, caps = n.caps || { cores: 4, ramMB: 8192, diskGB: 100 };
    const hist = n.hist || [];
    return `<div class="page-h"><div><a href="#/nodes" class="small">← My Nodes</a><h1>${esc(n.name)} ${badge(n.status)}</h1>
      <div class="muted">${reg(n.region)} · ${esc(caps.platform || '연결 대기')} · 마지막 응답 ${ago(n.lastSeen)}</div></div>
      <div class="row"><button class="btn" data-a="pauseNode" data-id="${n.id}" data-p="${n.paused ? 0 : 1}">${n.paused ? '▶ 제공 재개' : '⏸ 제공 일시 중지'}</button>
      <button class="btn danger" data-a="discNode" data-id="${n.id}">연결 해제</button><button class="btn danger" data-a="delNode" data-id="${n.id}">삭제</button></div></div>
    <div class="grid g4">
      <div class="card stat"><div class="l">신뢰도 (Reputation)</div><div class="v">${n.stats.reputation}</div><div class="s muted">가동률 ${pct(n.uptimeRatio, 2)} · 장애 ${n.stats.failures}회</div></div>
      <div class="card stat"><div class="l">CPU / RAM</div><div class="v" style="font-size:22px">${Math.round(m.cpuLoad || 0)}% / ${Math.round(m.ramPct || 0)}%</div><div class="s muted">온도 ${m.temp == null ? 'N/A' : m.temp + '℃'} · 지연 ${Math.round(m.latencyMs || 0)}ms</div></div>
      <div class="card stat"><div class="l">누적 획득 크레딧</div><div class="v" style="color:var(--ok)">+${cr(n.stats.earned)}</div><div class="s muted">온라인 ${num(n.stats.onlineSeconds / 3600, 1)}시간</div></div>
      <div class="card stat"><div class="l">실행 중 인스턴스</div><div class="v">${n.instances.length}</div><div class="s muted">${n.allocated.cpu.toFixed(2)} core · ${num(n.allocated.ramMB)}MB 사용</div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2 style="margin:0">CPU / RAM 모니터링</h2><div class="legend"><span><i style="background:var(--brand)"></i>CPU</span><span><i style="background:var(--ok)"></i>RAM</span></div></div>
        ${hist.length > 2 ? chart([{ vals: hist.map((x) => x[1]), color: 'var(--brand)' }, { vals: hist.map((x) => x[2]), color: 'var(--ok)' }], { h: 110, max: 100 }) : '<div class="empty">수집 중…</div>'}</div>
      <div class="card"><div class="card-h"><h2 style="margin:0">시간별 크레딧 획득 (24h)</h2></div>${bars(e.map((x) => x.earn), { h: 110, color: 'var(--ok)' })}</div>
    </div>
    <div class="card" style="margin-top:16px"><h2>자원 제공 설정</h2>
      <form id="nodeform" data-id="${n.id}" class="stack">
        <div class="grid g2">
          <label class="f"><span>노드 이름</span><input name="name" value="${esc(n.name)}"></label>
          <label class="f"><span>지역</span><select name="region">${S.meta.regions.map((r) => `<option value="${r.id}" ${r.id === n.region ? 'selected' : ''}>${reg(r.id)} (${r.country})</option>`).join('')}</select></label>
          <label class="f"><span>CPU 제공량: <b data-out="cpuCores">${L.cpuCores}</b> core <i class="hint">(최대 ${caps.cores})</i></span><input type="range" name="cpuCores" min="0.25" max="${caps.cores}" step="0.25" value="${L.cpuCores}"></label>
          <label class="f"><span>RAM 제공량: <b data-out="ramMB">${L.ramMB}</b> MB <i class="hint">(최대 ${caps.ramMB})</i></span><input type="range" name="ramMB" min="256" max="${caps.ramMB}" step="256" value="${L.ramMB}"></label>
          <label class="f"><span>디스크 제공량: <b data-out="diskGB">${L.diskGB}</b> GB <i class="hint">(여유 ${caps.diskGB}GB)</i></span><input type="range" name="diskGB" min="1" max="${Math.max(2, caps.diskGB)}" step="1" value="${L.diskGB}"></label>
          <label class="f"><span>네트워크 대역폭 제한: <b data-out="bandwidthMbps">${L.bandwidthMbps}</b> Mbps</span><input type="range" name="bandwidthMbps" min="1" max="1000" step="1" value="${L.bandwidthMbps}"></label>
          <label class="f"><span>노드 그룹</span><select name="groupId"><option value="">(없음)</option>${groups.map((g) => `<option value="${g.id}" ${g.id === n.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
          <div class="stack gap-s"><label class="chk"><input type="checkbox" name="idleOnly" ${n.schedule.idleOnly ? 'checked' : ''}> PC 사용 중에는 자원 제공 제한 (유휴 시에만 제공)</label>
            <label class="f"><span>사용 중 판단 CPU 기준: <b data-out="busyCpuThreshold">${n.schedule.busyCpuThreshold}</b>%</span><input type="range" name="busyCpuThreshold" min="10" max="95" value="${n.schedule.busyCpuThreshold}"></label></div>
        </div>
        <div><button class="btn primary">설정 저장</button></div>
      </form></div>
    <div class="card" style="margin-top:16px"><h2>에이전트 연결</h2>
      <p class="muted">PC에서 아래 명령을 실행하세요 (Node.js 20+). 아웃바운드 연결만 사용하므로 포트포워딩이 필요 없습니다.</p>
      ${cmdTabs(n.commands)}
      <p class="muted small">Windows/macOS/Linux 는 로그인 시 자동 실행되도록 등록됩니다. Android 는 Termux 에서 실행합니다. 사용자 코드 실행은 Docker 샌드박스에서만 허용됩니다. Docker 가 없는 PC는 정적 사이트만 호스팅합니다.</p></div>
    <div class="card flat" style="margin-top:16px"><div style="padding:16px 18px 0"><h2>이 노드의 인스턴스</h2></div>${instTable(n.instances, false)}</div>`;
  },
  after() {
    const f = $('#nodeform');
    if (!f) return;
    f.addEventListener('input', (e) => { const o = $(`[data-out="${e.target.name}"]`, f); if (o) o.textContent = e.target.value; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const r = await run(() => PATCH('/api/nodes/' + f.dataset.id, {
        name: v.name, region: v.region, groupId: v.groupId, limits: { cpuCores: +v.cpuCores, ramMB: +v.ramMB, diskGB: +v.diskGB, bandwidthMbps: +v.bandwidthMbps },
        schedule: { idleOnly: !!v.idleOnly, busyCpuThreshold: +v.busyCpuThreshold },
      }), '저장했습니다');
      if (r) refresh(true);
    };
  },
};

// Marketplace
P.marketplace = {
  load: () => GET('/api/marketplace'),
  render(list) {
    const regs = [...new Set(list.map((n) => n.region))];
    return `<div class="page-h"><div><h1>Node Marketplace</h1><div class="muted">네트워크에서 제공 가능한 노드를 탐색합니다. 이름은 익명 처리됩니다.</div></div></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card stat"><div class="l">전체 노드</div><div class="v">${list.length}</div></div>
      <div class="card stat"><div class="l">온라인</div><div class="v">${list.filter((n) => n.status === 'online').length}</div></div>
      <div class="card stat"><div class="l">지역</div><div class="v">${regs.length}</div></div>
      <div class="card stat"><div class="l">여유 CPU 합계</div><div class="v">${num(list.reduce((a, n) => a + n.freeCpu, 0), 1)}</div></div></div>
    <div class="card flat"><div class="table-wrap"><table><thead><tr><th>노드</th><th>지역</th><th>상태</th><th>신뢰도</th><th>가동률</th><th>여유 CPU</th><th>여유 RAM</th><th>인스턴스</th><th>Docker</th><th>운영</th></tr></thead><tbody>
      ${list.map((n) => `<tr><td class="mono">${esc(n.name)}·${esc(n.id)}</td><td>${reg(n.region)}</td><td>${badge(n.status)}</td>
      <td><b>${n.reputation}</b> <span class="tag">${n.reputation >= 70 ? '우수' : n.reputation >= 50 ? '보통' : '신규'}</span></td><td>${pct(n.uptime, 1)}</td><td>${n.freeCpu}</td><td>${num(n.freeRamMB)} MB</td><td>${n.instances}</td><td>${n.docker ? '✓' : '-'}</td><td>${n.ageDays}일</td></tr>`).join('') || '<tr><td colspan="10" class="empty">노드가 없습니다</td></tr>'}
    </tbody></table></div></div>`;
  },
};

// Services
P.services = {
  load: () => GET('/api/services'),
  render(list) {
    return `<div class="page-h"><div><h1>Hosting Projects</h1><div class="muted">웹 서비스, 정적 사이트, 워커, 크론 잡을 배포하고 관리합니다.</div></div><a class="btn primary" href="#/services/new">+ New</a></div>
    ${list.length ? `<div class="card flat"><div class="table-wrap"><table><thead><tr><th>이름</th><th>유형</th><th>주소</th><th>플랜</th><th>인스턴스</th><th>상태</th><th>가동률</th><th class="right">크레딧/h</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td><a href="#/services/${s.id}"><b>${esc(s.name)}</b></a></td><td><span class="tag">${TYPE[s.type]}</span> <span class="tag">${esc(s.runtime)}</span></td>
      <td>${s.type === 'worker' || s.type === 'cron' || s.type === 'private' ? '<span class="muted">비공개</span>' : `<a href="${esc(devUrl(s))}" target="_blank" rel="noopener">${esc(s.slug)}.${esc(S.meta.baseDomain)}</a>`}</td>
      <td>${esc(S.meta.plans[s.plan].label)}</td><td>${s.instances.running}/${s.scaling.desired}</td><td>${badge(s.health)}</td><td>${pct(s.availability, 2)}</td><td class="right">${cr(s.costPerHour)}</td></tr>`).join('')}</tbody></table></div></div>`
      : `<div class="card empty"><div class="big">🚀</div><p>배포한 프로젝트가 없습니다.</p><a class="btn primary" href="#/services/new">첫 프로젝트 배포하기</a></div>`}`;
  },
};
// 로컬(localhost) 접속 시에는 name.localhost 로 열어서 테스트할 수 있게 한다
const devUrl = (s) => (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? `http://${s.slug}.localhost:${location.port || 80}` : s.url);

P['services/new'] = {
  load: async () => ({ groups: await GET('/api/groups') }),
  render({ groups }) {
    const M = S.meta, plans = Object.entries(M.plans);
    return `<div class="page-h"><div><a href="#/services" class="small">← Hosting Projects</a><h1>새 프로젝트 배포</h1></div></div>
    <form id="newsvc" class="stack">
      <div class="card stack"><h2 style="margin:0">1. 소스</h2>
        <div class="choice" id="srckind"><label><input type="radio" name="kind" value="template" checked><b>시작 템플릿</b><span>바로 배포해 보기</span></label>
          <label><input type="radio" name="kind" value="github"><b>GitHub</b><span>저장소에서 빌드 & 배포</span></label>
          <label><input type="radio" name="kind" value="docker"><b>Docker 이미지</b><span>이미지 그대로 실행</span></label></div>
        <div data-src="template"><label class="f"><span>템플릿</span><select name="template">${Object.entries(M.templates).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label></div>
        <div data-src="github" hidden class="grid g2"><label class="f"><span>저장소 URL</span><input name="repo" placeholder="https://github.com/user/repo"></label><label class="f"><span>브랜치</span><input name="branch" value="main"></label></div>
        <div data-src="docker" hidden><label class="f"><span>이미지</span><input name="image" placeholder="nginx:alpine 또는 user/app:latest"><span class="hint">컨테이너는 PORT=10000 으로 리슨해야 합니다.</span></label></div>
      </div>
      <div class="card stack"><h2 style="margin:0">2. 이름과 무료 서브도메인</h2>
        <div class="grid g2"><label class="f"><span>프로젝트 이름</span><input name="name" required placeholder="my-website"></label>
        <label class="f"><span>서브도메인</span><div class="sub-input"><input name="slug" required placeholder="my-website" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]"><span>.${esc(M.baseDomain)}</span></div><span class="hint" id="slughint">영문 소문자·숫자·하이픈 3~32자</span></label></div></div>
      <div class="card stack"><h2 style="margin:0">3. 유형과 런타임</h2>
        <div class="choice" id="typechoice">${Object.entries(TYPE).map(([k, v]) => `<label><input type="radio" name="type" value="${k}" ${k === 'web' ? 'checked' : ''}><b>${v}</b><span>${{ web: 'HTTP 공개 서비스', static: 'HTML/JS 정적 호스팅', worker: '백그라운드 프로세스', cron: '주기적 실행', private: '내부 전용' }[k]}</span></label>`).join('')}</div>
        <div class="grid g2" id="rtopts"><label class="f"><span>런타임</span><select name="runtime">${['node', 'python', 'static', 'docker', 'custom'].map((r) => `<option>${r}</option>`).join('')}</select></label>
        <label class="f"><span>헬스체크 경로</span><input name="healthCheckPath" value="/healthz"></label>
        <label class="f"><span>빌드 명령</span><input name="buildCommand" placeholder="npm install"></label><label class="f"><span>시작 명령 / 크론 명령</span><input name="startCommand" placeholder="npm start"></label>
        <label class="f" id="pubdir" hidden><span>배포 디렉터리 (정적)</span><input name="publishDir" value="dist"></label>
        <label class="f" id="cronopt" hidden><span>크론 주기(분)</span><input name="cronMin" type="number" min="1" value="60"></label></div>
        <label class="f"><span>환경변수 (한 줄에 KEY=VALUE)</span><textarea name="env" rows="3" placeholder="NODE_ENV=production&#10;GREETING=안녕"></textarea></label></div>
      <div class="card stack"><h2 style="margin:0">4. 플랜</h2>
        <div class="choice">${plans.map(([k, p]) => `<label><input type="radio" name="plan" value="${k}" ${k === 'free' ? 'checked' : ''}><b>${p.label}</b><span>${p.cpu} CPU · ${p.ramMB}MB</span><span><b style="color:var(--text)">${p.creditsPerHour ? p.creditsPerHour + ' 크레딧/h' : '무료'}</b></span></label>`).join('')}</div>
        <div class="hint">Free 는 계정당 2개까지 · 1 인스턴스 · 고가용성/우선 배치 불가. 인스턴스 개수만큼 비용이 곱해집니다.</div></div>
      <div class="card stack"><h2 style="margin:0">5. 다중 노드 & 배치 옵션</h2>
        <div class="grid g3"><label class="f"><span>최소 인스턴스</span><input name="min" type="number" min="1" max="20" value="1"></label><label class="f"><span>최대 인스턴스</span><input name="max" type="number" min="1" max="20" value="1"></label>
        <label class="f"><span>오토스케일 목표 (인스턴스당 rps)</span><input name="targetRps" type="number" min="1" value="20"></label></div>
        <div class="grid g3"><label class="f"><span>지역 (Geographic Hosting)</span><select name="region"><option value="any">전체 (자동)</option>${M.regions.map((r) => `<option value="${r.id}">${reg(r.id)}</option>`).join('')}</select></label>
        <label class="f"><span>Private Hosting 노드 그룹</span><select name="groupId"><option value="">(공용 네트워크)</option>${groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
        <label class="f"><span>장애 대응 (Failover Policy)</span><select name="failover"><option value="replace">대체 노드 자동 투입</option><option value="none">대체 없음</option></select></label></div>
        <div class="row wrap"><label class="chk"><input type="checkbox" name="autoscale"> 자동 확장/축소</label><label class="chk"><input type="checkbox" name="ha"> 고가용성 (+20%, 최소 2개·서로 다른 제공자)</label>
        <label class="chk"><input type="checkbox" name="priority"> 우선 배치 (+15%, 신뢰도 70+ 노드)</label><label class="chk"><input type="checkbox" name="spot"> Spot (−50%, 중단 가능)</label></div></div>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/services">취소</a><button class="btn primary" id="deploybtn">배포하기</button></div>
    </form>`;
  },
  after() {
    const f = $('#newsvc'), M = S.meta;
    const sync = () => {
      const v = Object.fromEntries(new FormData(f));
      $$('[data-src]', f).forEach((e) => (e.hidden = e.dataset.src !== v.kind));
      const tpl = v.kind === 'template' ? M.templates[v.template] : null;
      if (tpl && !f.dataset.typeTouched) { f.querySelector(`[name=type][value=${tpl.type}]`).checked = true; }
      const type = f.querySelector('[name=type]:checked').value;
      let rt = v.runtime;
      if (v.kind === 'docker') rt = 'docker'; else if (type === 'static') rt = 'static'; else if (tpl && !f.dataset.rtTouched) rt = tpl.runtime;
      f.runtime.value = rt;
      $('#rtopts').hidden = v.kind === 'docker' && !['worker', 'cron'].includes(type) && false;
      $('#pubdir').hidden = rt !== 'static'; $('#cronopt').hidden = type !== 'cron';
      f.buildCommand.disabled = rt === 'docker' || rt === 'static' && v.kind === 'template';
      const d = M.runtimeDefaults[rt] || {};
      if (!f.dataset.cmdTouched) {
        f.buildCommand.value = tpl ? '' : d.buildCommand || ''; f.startCommand.value = tpl ? (rt === 'static' ? '' : rt === 'python' ? 'python app.py' : 'node server.js') : d.startCommand || '';
        if (tpl && rt === 'static') f.publishDir.value = '.';
      }
      f.healthCheckPath.value = f.healthCheckPath.dataset.t ? f.healthCheckPath.value : (type === 'static' ? '/' : '/healthz');
    };
    f.addEventListener('change', (e) => {
      if (e.target.name === 'type') f.dataset.typeTouched = 1;
      if (e.target.name === 'runtime') f.dataset.rtTouched = 1;
      if (e.target.name === 'template' || e.target.name === 'kind') { delete f.dataset.cmdTouched; delete f.dataset.rtTouched; delete f.dataset.typeTouched; }
      sync();
    });
    f.addEventListener('input', (e) => {
      if (e.target.name === 'buildCommand' || e.target.name === 'startCommand') f.dataset.cmdTouched = 1;
      if (e.target.name === 'healthCheckPath') e.target.dataset.t = 1;
      if (e.target.name === 'name' && !f.slug.dataset.t) f.slug.value = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
      if (e.target.name === 'slug') f.slug.dataset.t = 1;
      if (e.target.name === 'name' || e.target.name === 'slug') checkSlug();
    });
    let tm;
    const checkSlug = () => {
      clearTimeout(tm);
      tm = setTimeout(async () => {
        const r = await GET('/api/slug-check?slug=' + encodeURIComponent(f.slug.value)).catch(() => null);
        const h = $('#slughint');
        if (!r || !h) return;
        h.innerHTML = r.available ? `<span style="color:var(--ok)">✓ ${esc(f.slug.value)}.${esc(M.baseDomain)} 사용 가능</span>` : `<span style="color:var(--bad)">✗ ${esc(r.reason)}</span>`;
      }, 300);
    };
    sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const source = v.kind === 'template' ? { kind: 'template', template: v.template } : v.kind === 'github' ? { kind: 'github', repo: v.repo, branch: v.branch } : { kind: 'docker', image: v.image };
      const env = v.env.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return { key: l.slice(0, i).trim(), value: l.slice(i + 1) }; }).filter((x) => x.key);
      const body = {
        name: v.name, slug: v.slug, source, type: v.type, runtime: v.runtime, plan: v.plan, healthCheckPath: v.healthCheckPath, buildCommand: v.buildCommand, startCommand: v.startCommand,
        publishDir: v.publishDir, env, cron: { everyMinutes: +v.cronMin }, failover: { policy: v.failover },
        scaling: { min: +v.min, max: +v.max, autoscale: !!v.autoscale, targetRps: +v.targetRps },
        placement: { region: v.region, groupId: v.groupId || null, ha: !!v.ha, priority: !!v.priority, spot: !!v.spot },
      };
      $('#deploybtn').disabled = true;
      const s = await run(() => POST('/api/services', body), '배포를 시작했습니다');
      if (s) location.hash = '#/services/' + s.id; else $('#deploybtn').disabled = false;
    };
  },
};

// Service detail
const TABS = [['overview', '개요'], ['deploys', '배포'], ['logs', '로그'], ['env', '환경변수'], ['scale', '확장·배치'], ['domains', '도메인'], ['settings', '설정']];
P['services/:id'] = {
  live: () => ['overview', 'deploys'].includes(tabOf()),
  load: async ([id]) => {
    const s = await GET('/api/services/' + id);
    const t = tabOf();
    const extra = {};
    if (t === 'overview') extra.m = await GET(`/api/services/${id}/metrics`);
    if (t === 'scale') extra.groups = await GET('/api/groups');
    return { s, ...extra };
  },
  render({ s, m, groups }) {
    const t = tabOf();
    const pub = !['worker', 'cron', 'private'].includes(s.type);
    return `<div class="page-h"><div><a href="#/services" class="small">← Hosting Projects</a><h1>${esc(s.name)} ${badge(s.health)}</h1>
      <div class="muted">${TYPE[s.type]} · ${esc(s.runtime)} · ${esc(S.meta.plans[s.plan].label)} ${pub ? `· <a href="${esc(devUrl(s))}" target="_blank" rel="noopener">${esc(s.slug)}.${esc(S.meta.baseDomain)} ↗</a>` : ''}</div></div>
      <div class="row wrap"><button class="btn primary" data-a="deploy" data-id="${s.id}">🚀 재배포</button><button class="btn" data-a="restartAll" data-id="${s.id}">↻ 전체 재시작</button>
      ${s.status === 'active' ? `<button class="btn danger" data-a="stopAll" data-id="${s.id}">■ 전체 종료</button>` : `<button class="btn" data-a="startSvc" data-id="${s.id}">▶ 시작</button>`}</div></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="${t === k ? 'active' : ''}" data-a="tab" data-t="${k}">${l}</button>`).join('')}</div>
    ${TAB[t](s, { m, groups })}`;
  },
  after([id], { s }) { TAB_AFTER[tabOf()] && TAB_AFTER[tabOf()](s); },
};
const tabOf = () => S.tab[route().params[0]] || 'overview';

const instTable = (list, withSvc = true) => `<div class="table-wrap"><table><thead><tr><th>인스턴스</th>${withSvc ? '<th>서비스</th>' : ''}<th>노드</th><th>지역</th><th>상태</th><th>재시작</th><th>메모리</th><th>생성</th><th></th></tr></thead><tbody>
  ${list.map((i) => `<tr><td class="mono">${esc(i.id)}</td>${withSvc ? `<td><a href="#/services/${i.serviceId}">${esc(i.serviceName)}</a></td>` : ''}<td>${esc(i.nodeName)}</td><td>${reg(i.region)}</td>
  <td>${badge(i.status)}${i.error ? `<div class="small" style="color:var(--bad)">${esc(i.error)}</div>` : ''}</td><td>${i.restarts}</td><td>${i.usedRamMB ? i.usedRamMB + ' MB' : '-'} <span class="muted small">/ ${i.ramMB}</span></td><td class="muted">${ago(i.createdAt)}</td>
  <td class="nowrap"><button class="btn sm" data-a="restartInst" data-id="${i.id}">재시작</button> <button class="btn sm danger" data-a="drainInst" data-id="${i.id}">교체</button></td></tr>`).join('') || `<tr><td colspan="9" class="empty">인스턴스가 없습니다</td></tr>`}</tbody></table></div>`;

const TAB = {
  overview(s, { m }) {
    const vals = m ? m.series.map((x) => x.reqs) : [];
    const tot = vals.reduce((a, b) => a + b, 0);
    return `<div class="grid g4">
      <div class="card stat"><div class="l">인스턴스</div><div class="v">${s.instances.running}<span class="muted" style="font-size:16px"> / ${s.scaling.desired}</span></div><div class="s muted">min ${s.scaling.min} · max ${s.scaling.max}${s.scaling.autoscale ? ' · auto' : ''}</div></div>
      <div class="card stat"><div class="l">가동률 (24h)</div><div class="v">${pct(s.availability, 2)}</div></div>
      <div class="card stat"><div class="l">트래픽</div><div class="v">${s.rps}<span class="muted" style="font-size:14px"> rps</span></div><div class="s muted">최근 1시간 ${num(tot)}건</div></div>
      <div class="card stat"><div class="l">크레딧 사용</div><div class="v">${cr(s.costPerHour)}<span class="muted" style="font-size:14px"> /h</span></div><div class="s muted">인스턴스당 ${cr(s.unitCostPerHour)}/h · 월 ${cr(s.costPerHour * 720)}</div></div></div>
    <div class="card" style="margin:16px 0"><div class="card-h"><h2 style="margin:0">분당 요청 수 (최근 60분)</h2><div class="legend"><span>오류 ${num(m ? m.series.reduce((a, b) => a + b.errs, 0) : 0)}건 · 평균 응답 ${m ? Math.round(m.series.filter((x) => x.reqs).reduce((a, b, _, r) => a + b.avgMs / r.length, 0)) : 0}ms</span></div></div>${bars(vals, { h: 100 })}</div>
    <div class="card flat"><div style="padding:16px 18px 0" class="row between"><h2>노드별 실행 상태</h2><span class="muted small">${s.placement.ha ? 'HA · ' : ''}${s.placement.spot ? 'Spot · ' : ''}${s.placement.priority ? 'Priority · ' : ''}${s.placement.region !== 'any' ? reg(s.placement.region) : '전 지역'}</span></div>${instTable(s.instanceList || [], false)}</div>`;
  },
  deploys(s) {
    return `<div class="card flat"><div class="table-wrap"><table><thead><tr><th>버전</th><th>상태</th><th>트리거</th><th>커밋</th><th>시작</th><th></th></tr></thead><tbody>
      ${s.deployments.map((d) => `<tr><td><b>v${d.version}</b>${d.current ? ' <span class="tag">현재</span>' : ''}</td><td>${badge(d.status)}</td><td>${esc(d.trigger)}${d.message ? `<div class="muted small">${esc(d.message)}</div>` : ''}</td><td class="mono">${esc(d.commit || '-')}</td><td class="muted">${ago(d.createdAt)}</td>
      <td class="right">${d.status === 'superseded' || (d.status === 'live' && !d.current) ? `<button class="btn sm" data-a="rollback" data-id="${s.id}" data-d="${d.id}">이 버전으로 롤백</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  },
  logs(s) { return `<div id="logbox" data-sid="${s.id}"></div>`; },
  env(s) {
    return `<div class="card"><h2>환경변수</h2><p class="muted">저장하면 새 버전으로 무중단 재배포됩니다. Secret 값은 저장 후 다시 표시되지 않습니다.</p>
      <form id="envform" class="stack"><div id="envrows" class="stack gap-s">${s.env.map((e) => envRow(e)).join('')}</div>
      <div class="row"><button type="button" class="btn sm" data-a="addEnv">+ 변수 추가</button><div class="grow"></div><button class="btn primary">저장 후 재배포</button></div></form></div>`;
  },
  scale(s, { groups }) {
    const sc = s.scaling, p = s.placement;
    return `<form id="scaleform" class="stack"><div class="card stack"><h2 style="margin:0">플랜</h2>
        <div class="choice">${Object.entries(S.meta.plans).map(([k, v]) => `<label><input type="radio" name="plan" value="${k}" ${k === s.plan ? 'checked' : ''}><b>${v.label}</b><span>${v.cpu} CPU · ${v.ramMB}MB</span><span><b style="color:var(--text)">${v.creditsPerHour || 0} 크레딧/h</b></span></label>`).join('')}</div></div>
      <div class="card stack"><h2 style="margin:0">다중 노드 실행 (Replication Policy)</h2>
        <div class="grid g4"><label class="f"><span>최소</span><input name="min" type="number" min="1" max="20" value="${sc.min}"></label><label class="f"><span>최대</span><input name="max" type="number" min="1" max="20" value="${sc.max}"></label>
        <label class="f"><span>현재 목표 개수</span><input name="desired" type="number" min="1" max="20" value="${sc.desired}"></label><label class="f"><span>목표 rps/인스턴스</span><input name="targetRps" type="number" min="1" value="${sc.targetRps}"></label></div>
        <label class="chk"><input type="checkbox" name="autoscale" ${sc.autoscale ? 'checked' : ''}> 트래픽에 따라 자동 확장/축소 (Auto Scaling)</label></div>
      <div class="card stack"><h2 style="margin:0">배치 정책</h2>
        <div class="grid g3"><label class="f"><span>지역</span><select name="region"><option value="any">전체 (자동)</option>${S.meta.regions.map((r) => `<option value="${r.id}" ${p.region === r.id ? 'selected' : ''}>${reg(r.id)}</option>`).join('')}</select></label>
        <label class="f"><span>노드 그룹 (Private Hosting)</span><select name="groupId"><option value="">(공용 네트워크)</option>${groups.map((g) => `<option value="${g.id}" ${p.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
        <label class="f"><span>Failover Policy</span><select name="failover"><option value="replace" ${s.failover.policy === 'replace' ? 'selected' : ''}>대체 노드 자동 투입</option><option value="none" ${s.failover.policy === 'none' ? 'selected' : ''}>대체 없음</option></select></label></div>
        <div class="row wrap"><label class="chk"><input type="checkbox" name="ha" ${p.ha ? 'checked' : ''}> 고가용성 (+20%)</label><label class="chk"><input type="checkbox" name="priority" ${p.priority ? 'checked' : ''}> 우선 배치 (+15%)</label>
        <label class="chk"><input type="checkbox" name="spot" ${p.spot ? 'checked' : ''}> Spot (−50%)</label><label class="chk"><input type="checkbox" name="spread" ${p.spread !== false ? 'checked' : ''}> 서로 다른 노드/제공자에 분산</label></div>
        <div class="hint">현재 인스턴스당 ${cr(s.unitCostPerHour)} 크레딧/h. 플랜·배치 변경은 무중단 재배포로 적용됩니다.</div></div>
      <div><button class="btn primary">저장</button></div></form>`;
  },
  domains(s) {
    const pub = !['worker', 'cron', 'private'].includes(s.type);
    return `<div class="card stack"><h2 style="margin:0">무료 서브도메인</h2>
      <form id="slugform" class="row"><div class="sub-input grow"><input name="slug" value="${esc(s.slug)}"><span>.${esc(S.meta.baseDomain)}</span></div><button class="btn">변경</button></form>
      <div class="muted small">서비스당 서브도메인 1개가 발급됩니다. 이름을 바꾸면 이전 이름은 즉시 반납됩니다. (*.${esc(S.meta.baseDomain)} 와일드카드 + Cloudflare HTTPS)</div></div>
      <div class="card stack" style="margin-top:16px"><h2 style="margin:0">커스텀 도메인</h2>
        ${pub ? `<form id="domform" class="row"><input name="host" placeholder="www.example.com" class="grow"><button class="btn primary">추가</button></form>` : '<div class="muted">공개 서비스에서만 사용할 수 있습니다.</div>'}
        ${s.domains.map((d) => `<div class="card" style="background:var(--bg)"><div class="row between"><b>${esc(d.host)}</b><div class="row">${badge(d.verified ? 'verified' : 'pending')}${d.ssl ? `<span class="tag">SSL ${esc(d.ssl)}</span>` : ''}<button class="btn sm" data-a="verifyDom" data-id="${s.id}" data-h="${esc(d.host)}">확인</button><button class="btn sm danger" data-a="delDom" data-id="${s.id}" data-h="${esc(d.host)}">삭제</button></div></div>
        ${d.verified ? '' : `<div class="small muted" style="margin-top:8px">DNS 에 아래 중 하나를 추가한 뒤 “확인”을 누르세요.<br>① <code>CNAME</code> ${esc(d.host)} → <code>${esc(s.slug)}.${esc(S.meta.baseDomain)}</code><br>② <code>TXT</code> _krl-verify.${esc(d.host)} → <code>${esc(d.token)}</code></div>`}</div>`).join('')}</div>`;
  },
  settings(s) {
    return `<form id="setform" class="stack"><div class="card stack"><h2 style="margin:0">빌드 & 실행</h2>
        <div class="grid g2"><label class="f"><span>이름</span><input name="name" value="${esc(s.name)}"></label>
        <label class="f"><span>소스</span><input disabled value="${esc(s.source.kind === 'github' ? s.source.repo + ' @ ' + s.source.branch : s.source.kind === 'docker' ? s.source.image : '템플릿: ' + s.source.template)}"></label>
        <label class="f"><span>빌드 명령</span><input name="buildCommand" value="${esc(s.buildCommand)}"></label><label class="f"><span>시작 명령</span><input name="startCommand" value="${esc(s.startCommand)}"></label>
        <label class="f"><span>루트 디렉터리</span><input name="rootDir" value="${esc(s.rootDir)}"></label><label class="f"><span>${s.runtime === 'static' ? '배포 디렉터리' : '헬스체크 경로'}</span><input name="${s.runtime === 'static' ? 'publishDir' : 'healthCheckPath'}" value="${esc(s.runtime === 'static' ? s.publishDir : s.healthCheckPath)}"></label>
        ${s.type === 'cron' ? `<label class="f"><span>크론 주기(분)</span><input name="cronMin" type="number" value="${s.cron.everyMinutes}"></label>` : ''}</div>
        <label class="chk"><input type="checkbox" name="autoDeploy" ${s.autoDeploy ? 'checked' : ''}> GitHub push 시 자동 배포</label>
        <div><button class="btn primary">저장 후 재배포</button></div></div></form>
      ${s.source.kind === 'github' ? `<div class="card stack" style="margin-top:16px"><h2 style="margin:0">GitHub Webhook</h2><div class="muted small">저장소 Settings → Webhooks 에 아래 URL 을 Content type: application/json, push 이벤트로 추가하세요.</div>
        <div class="cmd"><code class="grow" style="background:none">${esc(location.origin + s.webhook)}</code>${copyBtn(location.origin + s.webhook)}</div></div>` : ''}
      <div class="card" style="margin-top:16px;border-color:var(--bad)"><h2 style="color:var(--bad)">Danger Zone</h2><p class="muted">프로젝트와 모든 배포, 서브도메인을 삭제합니다.</p><button class="btn danger" data-a="delSvc" data-id="${s.id}">프로젝트 삭제</button></div>`;
  },
};
const envRow = (e = {}) => `<div class="row envrow"><input class="k" placeholder="KEY" value="${esc(e.key || '')}" style="max-width:240px"><input class="v" placeholder="${e.secret && e.hasValue ? '(저장됨 - 비워두면 유지)' : 'value'}" value="${esc(e.secret ? '' : e.value || '')}" ${e.secret ? 'type="password"' : ''}>
  <label class="chk small nowrap"><input type="checkbox" class="s" ${e.secret ? 'checked' : ''}> Secret</label><button type="button" class="btn sm danger" data-a="rmEnv">✕</button></div>`;

const TAB_AFTER = {
  logs(s) { mountLogs($('#logbox'), s.id); },
  env(s) {
    $('#envform').onsubmit = async (e) => {
      e.preventDefault();
      const env = $$('.envrow').map((r) => ({ key: $('.k', r).value.trim(), value: $('.v', r).value, secret: $('.s', r).checked })).filter((x) => x.key);
      if (await run(() => PATCH('/api/services/' + s.id, { env }), '저장했습니다. 새 버전을 배포합니다.')) refresh(true);
    };
  },
  scale(s) {
    $('#scaleform').onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      const body = { plan: v.plan, scaling: { min: +v.min, max: +v.max, desired: +v.desired, autoscale: !!v.autoscale, targetRps: +v.targetRps },
        placement: { region: v.region, groupId: v.groupId, ha: !!v.ha, priority: !!v.priority, spot: !!v.spot, spread: !!v.spread }, failover: { policy: v.failover } };
      if (await run(() => PATCH('/api/services/' + s.id, body), '적용했습니다')) refresh(true);
    };
  },
  domains(s) {
    $('#slugform').onsubmit = async (e) => { e.preventDefault(); if (await run(() => PATCH('/api/services/' + s.id, { slug: e.target.slug.value }), '서브도메인을 변경했습니다')) refresh(true); };
    const df = $('#domform');
    if (df) df.onsubmit = async (e) => { e.preventDefault(); if (await run(() => POST(`/api/services/${s.id}/domains`, { host: e.target.host.value }), '도메인을 추가했습니다')) refresh(true); };
  },
  settings(s) {
    $('#setform').onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      const body = { name: v.name, buildCommand: v.buildCommand, startCommand: v.startCommand, rootDir: v.rootDir, autoDeploy: !!v.autoDeploy };
      if (v.publishDir !== undefined) body.publishDir = v.publishDir; if (v.healthCheckPath !== undefined) body.healthCheckPath = v.healthCheckPath;
      if (v.cronMin) body.cron = { everyMinutes: +v.cronMin };
      if (await run(() => PATCH('/api/services/' + s.id, body), '저장했습니다')) refresh(true);
    };
  },
};

// Subdomains
P.subdomains = {
  load: async () => ({ list: await GET('/api/subdomains') }),
  render({ list }) {
    return `<div class="page-h"><div><h1>Subdomains</h1><div class="muted">무료 서브도메인 <b>name.${esc(S.meta.baseDomain)}</b> · 서비스당 1개 · 먼저 가져가는 사람이 임자입니다.</div></div></div>
    <div class="card stack"><h2 style="margin:0">이름 조회</h2><form id="subq" class="row"><div class="sub-input grow"><input name="q" placeholder="myapp" autocomplete="off"><span>.${esc(S.meta.baseDomain)}</span></div><button class="btn">사용 가능 여부 확인</button></form><div id="subres" class="muted small"></div></div>
    <div class="card flat" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>서브도메인</th><th>연결된 서비스</th><th>발급일</th><th></th></tr></thead><tbody>
    ${list.map((x) => `<tr><td>${x.public ? `<a href="${esc(location.hostname === 'localhost' ? `http://${x.slug}.localhost:${location.port || 80}` : 'https://' + x.host)}" target="_blank" rel="noopener"><b>${esc(x.host)}</b></a>` : `<b>${esc(x.host)}</b>`}</td><td><a href="#/services/${x.serviceId}">${esc(x.serviceName)}</a></td><td class="muted">${dt(x.claimedAt)}</td><td class="right"><a class="btn sm" href="#/services/${x.serviceId}" data-a="tabdom" data-id="${x.serviceId}">이름 변경</a></td></tr>`).join('') || '<tr><td colspan="4" class="empty">발급된 서브도메인이 없습니다. 프로젝트를 만들면서 이름을 정하세요.</td></tr>'}</tbody></table></div></div>`;
  },
  after() {
    $('#subq').onsubmit = async (e) => {
      e.preventDefault();
      const q = e.target.q.value.trim().toLowerCase();
      const r = await GET('/api/slug-check?slug=' + encodeURIComponent(q));
      const box = $('#subres');
      if (r.available) box.innerHTML = `<span style="color:var(--ok)">✓ ${esc(q)}.${esc(S.meta.baseDomain)} 사용 가능</span> · <a href="#/services/new">이 이름으로 프로젝트 만들기</a>`;
      else { const sg = await GET('/api/subdomains/suggest?q=' + encodeURIComponent(q)); box.innerHTML = `<span style="color:var(--bad)">✗ ${esc(r.reason)}</span>${sg.length ? ` · 추천: ${sg.map((x) => `<code>${esc(x)}</code>`).join(' ')}` : ''}`; }
    };
  },
};

// Deployments / Instances
P.deployments = {
  load: () => GET('/api/deployments'),
  render(list) {
    return `<div class="page-h"><div><h1>Deployments</h1><div class="muted">모든 프로젝트의 배포 이력</div></div></div>
    <div class="card flat"><div class="table-wrap"><table><thead><tr><th>프로젝트</th><th>버전</th><th>상태</th><th>트리거</th><th>커밋</th><th>시작</th><th>소요</th><th></th></tr></thead><tbody>
    ${list.map((d) => `<tr><td><a href="#/services/${d.serviceId}">${esc(d.serviceName)}</a></td><td><b>v${d.version}</b>${d.current ? ' <span class="tag">현재</span>' : ''}</td><td>${badge(d.status)}</td><td>${esc(d.trigger)}</td><td class="mono">${esc(d.commit || '-')}</td><td class="muted">${ago(d.createdAt)}</td><td>${d.finishedAt ? Math.round((d.finishedAt - d.createdAt) / 1000) + '초' : '-'}</td>
    <td class="right">${d.status === 'superseded' ? `<button class="btn sm" data-a="rollback" data-id="${d.serviceId}" data-d="${d.id}">롤백</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">배포 이력이 없습니다</td></tr>'}</tbody></table></div></div>`;
  },
};
P.instances = {
  load: () => GET('/api/instances'),
  render(list) {
    const by = {}; list.forEach((i) => (by[i.status] = (by[i.status] || 0) + 1));
    return `<div class="page-h"><div><h1>Instances</h1><div class="muted">전체 ${list.length}개 · ${Object.entries(by).map(([k, v]) => `${LABEL[k] || k} ${v}`).join(' · ') || '없음'}</div></div></div>
    <div class="card flat">${instTable(list)}</div>`;
  },
};

// 로그 뷰어
function mountLogs(box, serviceId) {
  if (!box) return;
  box.innerHTML = `<div class="row wrap" style="margin-bottom:10px"><input id="logq" placeholder="로그 검색…" style="max-width:260px"><label class="chk"><input type="checkbox" id="logfollow" checked> 자동 스크롤</label><div class="grow"></div><button class="btn sm" id="logclear">지우기</button></div><div class="terminal" id="term"></div>`;
  const term = $('#term', box);
  let since = 0, stop = false, q = '';
  const tick = async () => {
    if (stop) return;
    try {
      const rows = await GET(`/api/logs?since=${since}&limit=400${serviceId ? '&serviceId=' + serviceId : ''}${q ? '&q=' + encodeURIComponent(q) : ''}`);
      if (rows.length) {
        since = rows[rows.length - 1].seq;
        const near = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
        term.insertAdjacentHTML('beforeend', rows.map((r) => `<div class="l"><span class="ts">${clock(r.ts)}</span> <span class="src">[${esc(r.node)}${r.inst !== 'platform' ? '/' + esc(r.inst.slice(-6)) : ''}${serviceId ? '' : ' · ' + esc(r.service)}]</span> <span class="${r.stream}">${esc(r.line)}</span></div>`).join(''));
        while (term.children.length > 1500) term.firstChild.remove();
        if (near || $('#logfollow', box).checked) term.scrollTop = term.scrollHeight;
      }
    } catch {}
    if (!stop) setTimeout(tick, 1500);
  };
  $('#logq', box).oninput = (e) => { q = e.target.value; since = 0; term.innerHTML = ''; };
  $('#logclear', box).onclick = () => (term.innerHTML = '');
  S.cleanup.push(() => { stop = true; });
  tick();
}
P.logs = {
  load: async () => ({ services: await GET('/api/services') }),
  render({ services }) {
    return `<div class="page-h"><div><h1>Logs</h1><div class="muted">모든 인스턴스의 로그를 실시간으로 확인합니다.</div></div>
      <select id="logsvc" style="max-width:260px"><option value="">모든 프로젝트</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div id="logbox"></div>`;
  },
  after() {
    const go = () => { S.cleanup.forEach((f) => f()); S.cleanup = []; mountLogs($('#logbox'), $('#logsvc').value); };
    $('#logsvc').onchange = go; go();
  },
};

// Credits
P.credits = {
  load: () => GET('/api/credits'),
  render(c) {
    const e = c.estimate;
    return `<div class="page-h"><div><h1>Credits</h1><div class="muted">PC 자원을 제공하면 크레딧을 받고, 호스팅에 사용합니다.</div></div><button class="btn" data-a="daily">🎁 출석 보상 받기 (+20)</button></div>
    <div class="grid g4"><div class="card stat"><div class="l">실시간 잔액</div><div class="v">${cr(c.balance)}</div></div>
      <div class="card stat"><div class="l">시간당 획득 (예상)</div><div class="v" style="color:var(--ok)">+${cr(e.earnPerHour)}</div></div>
      <div class="card stat"><div class="l">시간당 소모 (예상)</div><div class="v" style="color:var(--warn)">−${cr(e.burnPerHour)}</div><div class="s muted">일 ${cr(e.burnPerDay)} · 월 ${cr(e.burnPerMonth)}</div></div>
      <div class="card stat"><div class="l">잔액 지속 시간</div><div class="v" style="font-size:22px">${e.runwayHours == null ? '무제한' : e.runwayHours > 48 ? Math.round(e.runwayHours / 24) + '일' : Math.round(e.runwayHours) + '시간'}</div><div class="s muted">${e.runwayHours == null ? '획득 ≥ 소모' : '획득 반영 후'}</div></div></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2 style="margin:0">시간별 수익 / 사용 (24h)</h2><div class="legend"><span><i style="background:var(--ok)"></i>획득</span><span><i style="background:var(--warn)"></i>사용</span></div></div>
      ${chart([{ vals: c.hourly.map((x) => x.earn), color: 'var(--ok)' }, { vals: c.hourly.map((x) => x.spend), color: 'var(--warn)' }], { h: 120, max: Math.max(1, ...c.hourly.map((x) => Math.max(x.earn, x.spend))) })}</div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card"><h2>월별 통계</h2>${c.monthly.map((m) => `<div class="row between" style="padding:5px 0"><span>${m.month}</span><span><span style="color:var(--ok)">+${cr(m.earn)}</span> / <span style="color:var(--warn)">−${cr(m.spend)}</span></span></div>`).join('') || '<span class="muted">데이터 없음</span>'}</div>
      <div class="card"><h2>프로젝트별 비용 (30일)</h2>${c.projects.map((p) => `<div class="row between" style="padding:5px 0"><span>${esc(p.name)}</span><b>−${cr(p.cost)}</b></div>`).join('') || '<span class="muted">사용 내역 없음</span>'}</div>
      <div class="card"><h2>노드별 획득 (30일)</h2>${c.nodes.map((p) => `<div class="row between" style="padding:5px 0"><span>${esc(p.name)}</span><b style="color:var(--ok)">+${cr(p.earned)}</b></div>`).join('') || '<span class="muted">획득 내역 없음</span>'}</div></div>
    <div class="card flat" style="margin-top:16px"><div style="padding:16px 18px 0"><h2>적립 및 차감 내역</h2></div><div class="table-wrap"><table><thead><tr><th>시각</th><th>구분</th><th>대상</th><th class="right">크레딧</th></tr></thead><tbody>
      ${c.ledger.map((l) => `<tr><td class="muted nowrap">${dt(l.ts)}</td><td>${esc(KIND[l.kind] || l.kind)}${l.note ? `<div class="muted small">${esc(l.note)}</div>` : ''}</td><td>${esc(l.node || l.service || '-')}</td><td class="right" style="color:${l.amount >= 0 ? 'var(--ok)' : 'var(--warn)'}"><b>${l.amount >= 0 ? '+' : ''}${cr(l.amount)}</b></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card" style="margin-top:16px"><h2>크레딧 체계</h2><div class="grid g2 small muted">
      <div><b style="color:var(--text)">획득</b><br>• 제공 자원 보상: CPU 코어·RAM·디스크·대역폭 제공량에 비례, 신뢰도/장기 유지(30일마다 +5%, 최대 +25%) 반영<br>• 호스팅 사용 보상: 내 노드에서 실행된 인스턴스 사용료의 ${Math.round(0.85 * 100)}%<br>• 신규 노드 보너스, 24시간 안정 가동 보너스, 이벤트</div>
      <div><b style="color:var(--text)">사용</b><br>• 인스턴스 시간당 요금 (플랜·인스턴스 수)<br>• 고가용성 +20%, 우선 배치 +15%, 지역 지정 +10%, Spot −50%<br>• 데이터 전송 0.5 크레딧/GB<br>• 크레딧이 소진되면 서비스가 일시 중지됩니다.</div></div></div>`;
  },
};

// Analytics
P.analytics = {
  load: () => GET('/api/analytics'),
  render(a) {
    return `<div class="page-h"><div><h1>Analytics</h1><div class="muted">자원 사용 통계 · 장애 기록</div></div></div>
    <div class="grid g2">${a.services.map((s) => `<div class="card"><div class="card-h"><b>${esc(s.name)}</b><span class="muted small">${num(s.reqs)}건 · 오류 ${num(s.errs)} · ${bytes(s.bytes)} · 가동률 ${pct(s.availability, 2)}</span></div>${bars(s.series.map((x) => x.reqs), { h: 80 })}</div>`).join('') || '<div class="card empty">프로젝트가 없습니다</div>'}</div>
    <h2 style="margin:22px 0 12px">노드 부하</h2><div class="grid g2">${a.nodes.map((n) => `<div class="card"><div class="card-h"><b>${esc(n.name)}</b>${badge(n.status)}</div>${n.hist.length > 2 ? chart([{ vals: n.hist.map((x) => x[1]), color: 'var(--brand)' }, { vals: n.hist.map((x) => x[2]), color: 'var(--ok)' }], { h: 80, max: 100 }) : '<div class="muted">수집 중</div>'}</div>`).join('') || '<div class="card empty">노드가 없습니다</div>'}</div>
    <div class="card flat" style="margin-top:22px"><div style="padding:16px 18px 0"><h2>장애 기록</h2></div><div class="table-wrap"><table><thead><tr><th>유형</th><th>내용</th><th>발생</th><th>복구</th></tr></thead><tbody>
    ${a.incidents.map((i) => `<tr><td><span class="tag">${esc(i.type)}</span></td><td>${esc(i.detail)}</td><td class="muted">${dt(i.startedAt)}</td><td>${i.resolvedAt ? `<span style="color:var(--ok)">${Math.round((i.resolvedAt - i.startedAt) / 1000)}초 만에 복구</span>` : badge('failed')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">장애 기록이 없습니다</td></tr>'}</tbody></table></div></div>`;
  },
};

// Alerts
P.alerts = {
  load: () => GET('/api/alerts'),
  render(list) {
    const col = { info: 'var(--info)', warn: 'var(--warn)', critical: 'var(--bad)' };
    return `<div class="page-h"><div><h1>Alerts</h1><div class="muted">장애 · 복구 · 크레딧 알림</div></div><button class="btn" data-a="readAlerts">모두 읽음</button></div>
    <div class="stack">${list.map((a) => `<div class="card" style="border-left:3px solid ${col[a.level]};opacity:${a.read ? .65 : 1}"><div class="row between"><b>${esc(a.title)}</b><span class="muted small">${ago(a.ts)}</span></div><div class="muted">${esc(a.msg)}</div></div>`).join('') || '<div class="card empty"><div class="big">🔔</div>알림이 없습니다</div>'}</div>`;
  },
};

// Settings
P.settings = {
  load: async () => ({ me: await GET('/api/me') }),
  render({ me }) {
    return `<div class="page-h"><div><h1>Settings</h1></div></div><div class="grid g2">
      <form class="card stack" id="profform"><h2 style="margin:0">프로필</h2><label class="f"><span>이메일</span><input disabled value="${esc(me.email)}"></label><label class="f"><span>이름</span><input name="name" value="${esc(me.name)}"></label><div><button class="btn primary">저장</button></div></form>
      <form class="card stack" id="pwform"><h2 style="margin:0">비밀번호 변경</h2><label class="f"><span>현재 비밀번호</span><input type="password" name="currentPassword" required></label><label class="f"><span>새 비밀번호 (8자 이상)</span><input type="password" name="password" minlength="8" required></label><div><button class="btn primary">변경</button></div></form></div>
      <div class="card" style="margin-top:16px"><h2>플랫폼 정보</h2><div class="kv"><div>기본 도메인</div><div><code>*.${esc(S.meta.baseDomain)}</code></div><div>DNS / SSL</div><div>${S.meta.cloudflare ? 'Cloudflare 연동 활성 (자동 DNS · 자동 HTTPS)' : 'Cloudflare 미연동 (개발 모드)'}</div><div>정산 주기</div><div>${S.meta.tickSeconds}초</div></div></div>`;
  },
  after() {
    $('#profform').onsubmit = async (e) => { e.preventDefault(); if (await run(() => PATCH('/api/me', { name: e.target.name.value }), '저장했습니다')) { S.me = await GET('/api/me'); } };
    $('#pwform').onsubmit = async (e) => { e.preventDefault(); if (await run(() => PATCH('/api/me', Object.fromEntries(new FormData(e.target))), '비밀번호를 변경했습니다')) e.target.reset(); };
  },
};

// ---------- 액션 ----------
const ACT = {
  menu: () => $('#side').classList.toggle('open'),
  theme() { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; try { localStorage.setItem('krl-theme', t); } catch {} },
  async logout() { await run(() => POST('/api/auth/logout')); S.me = null; location.href = '/'; },
  closemodal() { closeModal(); },
  ostab(el) {
    const box = el.closest('.cmdtabs'); $$('button', box).forEach((b) => b.classList.toggle('active', b === el));
    $('.cmdtext', box).textContent = JSON.parse(box.dataset.cmds)[el.dataset.os];
  },
  copycmd(el) { navigator.clipboard.writeText($('.cmdtext', el.closest('.cmdtabs')).textContent).then(() => toast('복사했습니다', 'ok')); },
  copy(el) { navigator.clipboard.writeText(el.dataset.t).then(() => toast('복사했습니다', 'ok'), () => toast('복사 실패', 'err')); },
  tab(el) { S.tab[route().params[0]] = el.dataset.t; S.cleanup.forEach((f) => f()); S.cleanup = []; refresh(true); },
  async pairNode() {
    const m = modal(`<h2>내 PC 연결</h2>
      <p class="muted"><b>1.</b> 연결할 PC에서 설치 명령을 실행하세요. 설치가 끝나면 화면에 <b>연결 코드</b>가 표시됩니다. 이후 부팅/로그인 시 자동으로 시작되어 호스팅에 참여합니다.</p>
      ${cmdTabs(S.meta.install)}
      <p class="muted small">Node.js 가 없으면 <code>krl-agent-windows-x64.exe install</code> 처럼 단일 실행 파일에 <code>install</code> 인자를 주세요.</p>
      <p class="muted" style="margin-top:14px"><b>2.</b> 표시된 코드를 입력하세요.</p>
      <form id="pf" class="stack"><label class="f"><span>연결 코드</span><input name="code" placeholder="ABCD-1234" maxlength="9" style="text-transform:uppercase;letter-spacing:.2em;font-size:18px" required autocomplete="off"></label>
        <div id="pinfo" class="muted small"></div>
        <div class="grid g2"><label class="f"><span>노드 이름 (선택)</span><input name="name" placeholder="PC 이름 그대로 사용"></label>
        <label class="f"><span>이 PC의 지역</span><select name="region">${S.meta.regions.map((r) => `<option value="${r.id}">${reg(r.id)}</option>`).join('')}</select></label></div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="cx">닫기</button><button class="btn primary">연결</button></div></form>`);
    $('#cx', m).onclick = closeModal;
    const f = $('#pf', m);
    f.code.addEventListener('input', async () => {
      const c = f.code.value.replace(/[^A-Za-z0-9]/g, '');
      if (c.length !== 8) { $('#pinfo', m).textContent = ''; return; }
      try { const r = await GET('/api/pair/lookup?code=' + c); $('#pinfo', m).innerHTML = `<span style="color:var(--ok)">✓ ${esc(r.name)} (${esc(r.platform)}) 를 찾았습니다</span>`; if (!f.name.value) f.name.value = r.name; }
      catch (e) { $('#pinfo', m).innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const n = await run(() => POST('/api/pair/approve', { code: f.code.value, name: f.name.value, region: f.region.value }), '연결했습니다. 에이전트가 자동으로 호스팅을 시작합니다.');
      if (n) { closeModal(); location.hash = '#/nodes/' + n.id; refresh(true); }
    };
  },
  async addNode() {
    const m = modal(`<h2>PC 등록</h2><form id="nf" class="stack"><label class="f"><span>노드 이름</span><input name="name" placeholder="내 데스크탑" required></label>
      <label class="f"><span>지역</span><select name="region">${S.meta.regions.map((r) => `<option value="${r.id}">${reg(r.id)}</option>`).join('')}</select></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="cx">취소</button><button class="btn primary">등록</button></div></form>`);
    $('#cx', m).onclick = closeModal;
    $('#nf', m).onsubmit = async (e) => {
      e.preventDefault();
      const n = await run(() => POST('/api/nodes', Object.fromEntries(new FormData(e.target))));
      if (!n) return;
      m.querySelector('.modal').innerHTML = `<h2>${esc(n.name)} 등록 완료</h2><p class="muted">제공할 PC에서 아래 명령을 실행하면 연결됩니다 (Node.js 20+ 필요). 연결되면 자동으로 자원 제공이 시작됩니다.</p>
        ${cmdTabs(n.commands)}
        <p class="muted small">Docker 가 설치되어 있으면 사용자 코드를 컨테이너에서 격리 실행합니다. 없으면 정적 사이트만 호스팅합니다.</p>
        <div class="row" style="justify-content:flex-end"><a class="btn primary" href="#/nodes/${n.id}" data-a="closemodal">노드 설정으로 이동</a></div>`;
    };
  },
  async pauseNode(el) { await run(() => PATCH('/api/nodes/' + el.dataset.id, { paused: el.dataset.p === '1' }), el.dataset.p === '1' ? '일시 중지했습니다' : '재개했습니다'); refresh(true); },
  async discNode(el) { if (await confirmBox('노드 연결 해제', '원격으로 이 노드의 연결을 끊고 모든 인스턴스를 다른 노드로 이동합니다. 에이전트는 종료됩니다.', '연결 해제')) { await run(() => POST(`/api/nodes/${el.dataset.id}/disconnect`), '연결을 해제했습니다'); refresh(true); } },
  async delNode(el) { if (await confirmBox('노드 삭제', '노드를 삭제합니다. 획득한 크레딧은 유지됩니다.', '삭제')) { await run(() => DEL('/api/nodes/' + el.dataset.id)); location.hash = '#/nodes'; } },
  async addGroup() {
    const m = modal(`<h2>노드 그룹 만들기</h2><form id="gf" class="stack"><label class="f"><span>이름</span><input name="name" required></label><label class="chk"><input type="checkbox" name="private" checked> Private (내 서비스만 이 그룹을 지정할 수 있음)</label><div class="row" style="justify-content:flex-end"><button class="btn primary">만들기</button></div></form>`);
    $('#gf', m).onsubmit = async (e) => { e.preventDefault(); const v = new FormData(e.target); closeModal(); await run(() => POST('/api/groups', { name: v.get('name'), private: !!v.get('private') }), '그룹을 만들었습니다'); refresh(true); };
  },
  async delGroup(el) { if (await confirmBox('그룹 삭제', '그룹을 삭제하면 노드는 그룹에서 빠집니다.', '삭제')) { await run(() => DEL('/api/groups/' + el.dataset.id)); refresh(true); } },
  tabdom(el) { S.tab[el.dataset.id] = 'domains'; },
  async deploy(el) { await run(() => POST(`/api/services/${el.dataset.id}/deploy`), '배포를 시작했습니다'); refresh(true); },
  async restartAll(el) { await run(() => POST(`/api/services/${el.dataset.id}/restart`), '전체 인스턴스를 재시작합니다'); },
  async stopAll(el) { if (await confirmBox('전체 종료', '모든 인스턴스를 종료합니다. 서비스는 중단되지만 설정은 유지됩니다.', '종료')) { await run(() => POST(`/api/services/${el.dataset.id}/stop`), '종료했습니다'); refresh(true); } },
  async startSvc(el) { await run(() => POST(`/api/services/${el.dataset.id}/start`), '시작합니다'); refresh(true); },
  async rollback(el) { if (await confirmBox('롤백', '선택한 버전의 설정으로 새 배포를 만들어 무중단 롤백합니다.', '롤백')) { await run(() => POST(`/api/services/${el.dataset.id}/rollback`, { deploymentId: el.dataset.d }), '롤백을 시작했습니다'); refresh(true); } },
  async delSvc(el) { if (await confirmBox('프로젝트 삭제', '되돌릴 수 없습니다.', '삭제')) { await run(() => DEL('/api/services/' + el.dataset.id), '삭제했습니다'); location.hash = '#/services'; } },
  async restartInst(el) { await run(() => POST(`/api/instances/${el.dataset.id}/restart`), '재시작 요청'); },
  async drainInst(el) { if (await confirmBox('인스턴스 교체', '새 인스턴스를 다른 노드에 띄운 뒤 이 인스턴스를 종료합니다.', '교체')) { await run(() => DEL('/api/instances/' + el.dataset.id), '교체를 시작했습니다'); refresh(true); } },
  addEnv() { $('#envrows').insertAdjacentHTML('beforeend', envRow()); },
  rmEnv(el) { el.closest('.envrow').remove(); },
  async verifyDom(el) { const r = await run(() => POST(`/api/services/${el.dataset.id}/domains/verify`, { host: el.dataset.h })); if (r) { toast(r.verified ? '도메인이 확인되었습니다' : 'DNS 레코드를 아직 찾을 수 없습니다', r.verified ? 'ok' : 'err'); refresh(true); } },
  async delDom(el) { await run(() => DEL(`/api/services/${el.dataset.id}/domains/${encodeURIComponent(el.dataset.h)}`)); refresh(true); },
  async daily() { await run(() => POST('/api/credits/claim-daily'), '+20 크레딧을 받았습니다'); refresh(true); },
  async readAlerts() { await POST('/api/alerts/read'); refresh(true); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (el && ACT[el.dataset.a]) { e.preventDefault(); ACT[el.dataset.a](el, e); }
  if (e.target.closest('.side a')) $('#side').classList.remove('open');
});
document.addEventListener('input', (e) => { if (e.target.closest('#page')) S.dirty = true; });

// ---------- 라우터 / 렌더 루프 ----------
let lastKey = '';
async function refresh(force = false) {
  if (!S.me || !$('#page')) return;
  const r = route();
  const patterns = { overview: 'overview', nodes: r.params.length ? 'nodes/:id' : 'nodes', services: r.params.length ? (r.params[0] === 'new' ? 'services/new' : 'services/:id') : 'services' };
  const key = patterns[r.name] || r.name;
  const page = P[key] || P.overview;
  const navigated = r.key !== lastKey;
  if (navigated) { S.cleanup.forEach((f) => f()); S.cleanup = []; S.dirty = false; S.sig = ''; lastKey = r.key; force = true; }
  if (!force && (S.dirty || $('#modal') || (page.live && !page.live(r.params)))) return;
  if (!force && page.live === undefined && document.activeElement && document.activeElement.closest && document.activeElement.closest('#page') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  let data;
  try { data = await page.load(r.params); } catch (e) { if (navigated) $('#page').innerHTML = `<div class="card empty"><div class="big">⚠</div>${esc(e.message)}<p><a href="#/overview">Overview 로 이동</a></p></div>`; return; }
  if (r.key !== lastKey) return; // 로딩 중 이동함
  const sig = JSON.stringify(data) + tabOfSafe(r);
  if (!force && sig === S.sig) return;
  S.sig = sig; S.dirty = false;
  const scroll = window.scrollY;
  $('#page').innerHTML = page.render(data, r.params);
  if (page.after) page.after(r.params, data);
  if (!navigated) window.scrollTo(0, scroll);
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name));
}
const tabOfSafe = (r) => (r.name === 'services' && r.params[0] ? S.tab[r.params[0]] || '' : '');

async function updateTop() {
  if (!S.me) return;
  try {
    const o = await GET('/api/overview');
    $('#topcr').textContent = cr(o.credits);
    const st = $('#topstat');
    st.innerHTML = `<span class="badge b-${o.overall === 'online' ? 'ok' : 'warn'}" style="border:0;background:none;padding:0">${o.overall === 'online' ? 'Online' : 'Degraded'}</span>`;
    const c = $('#alertcnt');
    c.hidden = !o.unreadAlerts; c.textContent = o.unreadAlerts;
  } catch {}
}

async function boot() {
  if (location.hash === '#/signup') location.hash = '#/overview';
  renderShell();
  await refresh(true);
  updateTop();
}
window.addEventListener('hashchange', () => refresh(true));
setInterval(() => { refresh(); }, 3000);
setInterval(updateTop, 6000);

(async function init() {
  try { const t = localStorage.getItem('krl-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  S.meta = await GET('/api/meta');
  try { S.me = await GET('/api/me'); } catch { S.me = null; }
  if (S.me) boot(); else renderAuth(location.hash === '#/signup' ? 'signup' : 'login');
})();
