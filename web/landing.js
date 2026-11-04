'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async () => {
  try {
    const st = await (await fetch('/api/public/stats')).json();
    $('#s-nodes').textContent = st.nodesOnline.toLocaleString('ko-KR');
    $('#s-inst').textContent = st.instancesRunning.toLocaleString('ko-KR');
    $('#s-svc').textContent = st.services.toLocaleString('ko-KR');
    $('#s-reg').textContent = st.regions.toLocaleString('ko-KR');
  } catch {}

  let meta;
  try { meta = await (await fetch('/api/meta')).json(); } catch { return; }

  $('#plans').innerHTML = Object.values(meta.plans).map((p) => `<div class="card plan"><b>${esc(p.label)}</b>
    <div class="price">${p.creditsPerHour ? p.creditsPerHour : '무료'}<small>${p.creditsPerHour ? ' 크레딧/h' : ''}</small></div>
    <div class="muted small">${p.cpu} CPU · ${p.ramMB >= 1024 ? p.ramMB / 1024 + 'GB' : p.ramMB + 'MB'} RAM<br>최대 ${p.maxReplicas} 인스턴스</div></div>`).join('');

  const os = [['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux'], ['android', 'Android (Termux)'], ['manual', '수동 / 단일 실행 파일']];
  const guess = /Win/.test(navigator.platform) ? 'windows' : /Mac/.test(navigator.platform) ? 'mac' : /Android/.test(navigator.userAgent) ? 'android' : 'linux';
  const show = (k) => {
    $('#cmdtext').textContent = k === 'manual' ? `${meta.install.manual}   (또는 krl-agent-<os>-<arch> install)` : meta.install[k];
    document.querySelectorAll('#ostabs button').forEach((b) => b.classList.toggle('active', b.dataset.os === k));
  };
  $('#ostabs').innerHTML = os.map(([k, l]) => `<button data-os="${k}">${l}</button>`).join('');
  $('#ostabs').onclick = (e) => { if (e.target.dataset.os) show(e.target.dataset.os); };
  $('#copycmd').onclick = () => navigator.clipboard.writeText($('#cmdtext').textContent.split('   (')[0]).then(() => { $('#copycmd').textContent = '복사됨'; setTimeout(() => ($('#copycmd').textContent = '복사'), 1500); });
  show(guess);
})();
