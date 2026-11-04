(async () => {
  const $ = (s) => document.querySelector(s);
  try {
    const t0 = Date.now();
    const s = await (await fetch('/api/public/stats')).json();
    $('#cp').innerHTML = `<b style="color:var(--ok)">● 정상</b> <span class="muted small">(${Date.now() - t0}ms)</span>`;
    $('#a').textContent = s.nodesOnline; $('#b').textContent = s.nodesTotal; $('#c').textContent = s.instancesRunning; $('#d').textContent = s.services; $('#e').textContent = s.regions;
  } catch { $('#cp').innerHTML = '<b style="color:var(--bad)">● 응답 없음</b>'; }
})();
