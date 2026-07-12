'use strict';
// 通信モニタ / パケットキャプチャ — レンダラ（monitor プラグイン）
//   本体グローバル（tabs, activeId, $, elx, toast, fmtSize, refitActive）を利用。
//   main との通信は WT.invoke/send/on 経由（monitor:* / capture:*）。
//   ドックの配置/リサイズは本体のドック機構が担当（#monitorDock）。
(function () {
  let monMode = 'sess';
  let capturing = false, capCount = 0, ifacesLoaded = false;
  const MON_VIEW_MAX = 3000; // 一覧に保持するDOM行の上限（記録は別途20000フレームまで保持）
  function monVisible() { return !$('#monitorDock').classList.contains('hidden'); }
  function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function monClock(ts) { const d = new Date(ts); const p = (x, n) => String(x).padStart(n || 2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }
  function asciiPreview(bytes, max) { let s = ''; const n = Math.min(bytes.length, max || 80); for (let i = 0; i < n; i++) { const c = bytes[i]; s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.'; } if (bytes.length > n) s += '…'; return s; }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function hexDump(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 16) {
      const slice = bytes.subarray(i, i + 16);
      let hex = '', asc = '';
      for (let j = 0; j < 16; j++) {
        if (j < slice.length) { hex += slice[j].toString(16).padStart(2, '0') + ' '; const c = slice[j]; asc += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.'; }
        else hex += '   ';
        if (j === 7) hex += ' ';
      }
      out += i.toString(16).padStart(6, '0') + '  ' + hex + ' |' + asc + '|\n';
    }
    return out || '(空)';
  }
  function wireMonitor() {
    $('#monModeSess').onclick = () => switchMonMode('sess');
    $('#monModeCap').onclick = () => switchMonMode('cap');
    $('#monToggle').onclick = monToggleRec;
    $('#monClear').onclick = async () => { const t = tabs.get(activeId); if (!t) return; await WT.invoke('monitor:clear', { id: activeId }); t.monFrames = []; t.monTx = 0; t.monRx = 0; $('#monBody').innerHTML = ''; $('#monHex').textContent = ''; updateMonStat(); };
    $('#monExport').onclick = async () => { if (!activeId) return; const r = await WT.invoke('monitor:export', { id: activeId }); if (r && r.ok) toast('保存しました: ' + r.path + ' (' + r.frames + 'フレーム)'); else if (r && r.error) toast('保存できません: ' + r.error, true); };
    $('#monFilter').oninput = renderMonAll;
    $('#capRefresh').onclick = loadInterfaces;
    $('#capStart').onclick = startCapture;
    $('#capStop').onclick = () => WT.send('capture:stop');
  }
  function toggleMonitor() {
    $('#monitorDock').classList.toggle('hidden');
    if (monVisible()) { if (monMode === 'sess') refreshMonitor(); else if (!ifacesLoaded) loadInterfaces(); }
    setTimeout(refitActive, 50);
  }
  function switchMonMode(mode) {
    monMode = mode;
    $('#monModeSess').classList.toggle('active', mode === 'sess');
    $('#monModeCap').classList.toggle('active', mode === 'cap');
    document.querySelectorAll('.mon-sess-ctl').forEach((e) => e.classList.toggle('hidden', mode !== 'sess'));
    document.querySelectorAll('.mon-cap-ctl').forEach((e) => e.classList.toggle('hidden', mode !== 'cap'));
    $('#monHex').classList.toggle('hidden', mode !== 'sess');
    if (mode === 'sess') refreshMonitor();
    else if (!ifacesLoaded) loadInterfaces();
  }
  // --- セッション通信モニタ ---
  async function monToggleRec() {
    const t = tabs.get(activeId); if (!t) { toast('アクティブな接続がありません', true); return; }
    const r = await WT.invoke('monitor:toggle', { id: activeId, on: !t.monOn });
    if (r && r.ok) { t.monOn = r.on; updateMonToggle(); } else if (r && r.error) toast(r.error, true);
  }
  function updateMonToggle() {
    const t = tabs.get(activeId);
    const b = $('#monToggle');
    const on = !!(t && t.monOn);
    b.textContent = on ? '⏹ 記録停止' : '⏺ 記録開始';
    b.style.background = on ? 'var(--danger)' : '';
    b.style.color = on ? '#fff' : '';
    updateMonStat();
  }
  function updateMonStat() {
    const t = tabs.get(activeId);
    const frames = t && t.monFrames ? t.monFrames.length : 0;
    const tx = (t && t.monTx) || 0, rx = (t && t.monRx) || 0;
    $('#monStat').textContent = (t ? '' : '接続なし ') + frames + 'フレーム  ▲' + fmtSize(tx) + ' ▼' + fmtSize(rx);
  }
  function refreshMonitor() { const t = tabs.get(activeId); if (t && !t.monFrames) t.monFrames = []; updateMonToggle(); renderMonAll(); $('#monHex').textContent = ''; }
  function monRowMatches(fr, q) { if (!q) return true; return asciiPreview(fr.bytes, 4096).toLowerCase().includes(q); }
  function appendMonRow(fr, idx) {
    const q = $('#monFilter').value.trim().toLowerCase();
    if (!monRowMatches(fr, q)) return;
    const tr = elx('tr'); tr.dataset.idx = idx;
    tr.innerHTML = '<td>' + monClock(fr.ts) + '</td><td class="' + fr.dir + '">' + (fr.dir === 'tx' ? '▲送信' : '▼受信') + '</td><td>' + fr.len + '</td><td>' + escapeHtml(asciiPreview(fr.bytes, 120)) + '</td>';
    tr.onclick = () => { document.querySelectorAll('#monBody tr.sel').forEach((e) => e.classList.remove('sel')); tr.classList.add('sel'); $('#monHex').textContent = hexDump(fr.bytes); };
    const tb = $('#monBody');
    tb.appendChild(tr);
    while (tb.children.length > MON_VIEW_MAX) tb.removeChild(tb.firstChild);
    if ($('#monAuto').checked) tb.parentElement.scrollTop = tb.parentElement.scrollHeight;
  }
  function renderMonAll() {
    const body = $('#monBody'); body.innerHTML = '';
    const t = tabs.get(activeId); if (!t || !t.monFrames) { updateMonStat(); return; }
    const q = $('#monFilter').value.trim().toLowerCase();
    const matched = [];
    for (let i = 0; i < t.monFrames.length; i++) if (monRowMatches(t.monFrames[i], q)) matched.push(i);
    for (let k = Math.max(0, matched.length - MON_VIEW_MAX); k < matched.length; k++) appendMonRow(t.monFrames[matched[k]], matched[k]);
    updateMonStat();
  }
  function onMonitorData(p) {
    const t = tabs.get(p.id); if (!t) return;
    if (!t.monFrames) t.monFrames = [];
    const fr = { dir: p.dir, ts: p.ts, len: p.len, bytes: b64ToBytes(p.b64) };
    t.monFrames.push(fr);
    if (fr.dir === 'tx') t.monTx = (t.monTx || 0) + fr.len; else t.monRx = (t.monRx || 0) + fr.len;
    if (t.monFrames.length > 20000) t.monFrames.shift();
    if (p.id === activeId && monVisible() && monMode === 'sess') { appendMonRow(fr, t.monFrames.length - 1); updateMonStat(); }
  }
  // --- パケットキャプチャ (tshark) ---
  async function loadInterfaces() {
    const sel = $('#capIface'); sel.innerHTML = '';
    $('#capStat').textContent = '取得中…';
    const r = await WT.invoke('capture:interfaces');
    if (!r || !r.ok) { $('#capStat').textContent = (r && r.error) || 'tshark を実行できません'; ifacesLoaded = false; return; }
    ifacesLoaded = true;
    for (const it of r.interfaces) { const o = document.createElement('option'); o.value = it.id; o.textContent = it.id + ': ' + it.name; sel.appendChild(o); }
    $('#capStat').textContent = r.interfaces.length + ' 個のインターフェース';
  }
  async function startCapture() {
    if (capturing) return;
    const iface = $('#capIface').value; if (!iface) { toast('インターフェースを選択してください', true); return; }
    const filter = $('#capFilter').value;
    $('#capBody').innerHTML = ''; capCount = 0;
    const r = await WT.invoke('capture:start', { iface, filter });
    if (!r || !r.ok) { $('#capStat').textContent = (r && r.error) || '開始できません'; return; }
    capturing = true; $('#capStart').disabled = true; $('#capStop').disabled = false; $('#capStat').textContent = 'キャプチャ中…';
  }
  function onCapturePacket(p) {
    capCount++;
    const tr = elx('tr');
    tr.innerHTML = '<td>' + (p.no || '') + '</td><td>' + (p.time || '') + '</td><td>' + escapeHtml(p.src || '') + '</td><td>' + escapeHtml(p.dst || '') + '</td><td>' + escapeHtml(p.proto || '') + '</td><td>' + (p.len || '') + '</td><td>' + escapeHtml(p.info || '') + '</td>';
    const body = $('#capBody'); body.appendChild(tr);
    while (body.children.length > 5000) body.removeChild(body.firstChild);
    if ($('#monAuto').checked) body.parentElement.scrollTop = body.parentElement.scrollHeight;
    if (capCount % 10 === 0 || capCount < 10) $('#capStat').textContent = 'キャプチャ中… ' + capCount + ' パケット';
  }
  function onCaptureEnd(p) {
    capturing = false; $('#capStart').disabled = false; $('#capStop').disabled = true;
    $('#capStat').textContent = (p && p.error) ? ('停止: ' + p.error.split(/\r?\n/)[0]) : ('停止 (' + capCount + ' パケット)');
  }

  // ---- プラグイン登録 ----
  WT.register('monitor', {
    activate(WT) {
      WT.addToolbarButton({ id: 'btnMonitor', label: '📡 監視', title: '通信モニタ / パケットキャプチャ', onClick: toggleMonitor });
      WT.onMenuAction('toggle-monitor', toggleMonitor);
      WT.addMenuItem('表示', { label: '通信モニタ表示切替', action: 'toggle-monitor', onRun: toggleMonitor });
      WT.on('monitor:data', onMonitorData);
      WT.on('capture:packet', onCapturePacket);
      WT.on('capture:end', onCaptureEnd);
      WT.onActiveTabChange(() => { if (monVisible() && monMode === 'sess') refreshMonitor(); });
      // 別ウィンドウから移動してきたタブの記録状態を引き継ぐ
      WT.onTabAdopt((tab) => { WT.invoke('monitor:state', { id: tab.id }).then((s) => { if (s && s.ok) { tab.monOn = s.on; if (activeId === tab.id && monVisible() && monMode === 'sess') updateMonToggle(); } }).catch(() => {}); });
      wireMonitor();
    },
  });
})();
