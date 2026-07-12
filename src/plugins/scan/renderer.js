'use strict';
// ネットワークスキャン — レンダラ（scan プラグイン）
//   本体グローバル（$, elx, toast, showMenu, uid, openSession, openEditor,
//   DB, persistSessions, renderSessions, api）を利用する。main との通信は
//   汎用ブリッジ WT.invoke/send/on 経由（チャンネル: netscan:*）。
(function () {
  let scanRunning = false;
  const SCAN_COLS = {
    ping: ['IP', '状態', 'RTT', 'ホスト名'],
    port: ['ホスト', 'ポート', 'サービス', '状態'],
    arp: ['IP', 'MAC', '種別'],
    snmp: ['OID', '型', '値'],
  };
  function wireScan() {
    $('#scanClose').onclick = () => { WT.send('netscan:stop'); $('#scanModal').classList.add('hidden'); };
    $('#scanKind').onchange = () => updateScanFields();
    $('#scanRun').onclick = startScan;
    $('#scanStop').onclick = () => { WT.send('netscan:stop'); };
    $('#scanClear').onclick = () => { $('#scanBody').innerHTML = ''; $('#scanProg').textContent = ''; };
    $('#scanTarget').onkeydown = (e) => { if (e.key === 'Enter') startScan(); };
    WT.on('netscan:result', (p) => addScanRow(p.kind, p.row));
    WT.on('netscan:progress', (p) => { $('#scanProg').textContent = p.label || ''; });
    WT.on('netscan:end', (p) => {
      scanRunning = false; updateScanButtons();
      const s = p.summary || {};
      if (s.error) { $('#scanProg').textContent = '⚠ ' + s.error; toast('スキャン: ' + s.error, true); }
      else $('#scanProg').textContent = '完了（' + (s.alive != null ? '応答 ' + s.alive + '/' + s.total : s.open != null ? '開放 ' + s.open + '/' + s.total : (s.total || 0) + ' 件') + '）';
    });
  }
  function updateScanButtons() { $('#scanStop').disabled = !scanRunning; $('#scanRun').disabled = scanRunning; }
  function updateScanFields() {
    const k = $('#scanKind').value;
    document.querySelectorAll('#scanModal .scan-f').forEach((el) => { el.style.display = el.classList.contains('scan-' + k) ? '' : 'none'; });
    $('#scanTargetLbl').textContent = (k === 'ping') ? 'サブネット/範囲' : 'ホスト/IP';
    renderScanHead(k);
  }
  function renderScanHead(kind) {
    const cols = SCAN_COLS[kind] || [];
    $('#scanHead').innerHTML = '<tr>' + cols.map((c) => '<th>' + c + '</th>').join('') + '</tr>';
  }
  function openScan(prefill) {
    if (prefill) { $('#scanKind').value = prefill.kind || 'ping'; if (prefill.target) $('#scanTarget').value = prefill.target; }
    updateScanFields();
    $('#scanModal').classList.remove('hidden');
    if (!$('#scanTarget').value && $('#scanKind').value !== 'arp') $('#scanTarget').focus();
  }
  function startScan() {
    if (scanRunning) return;
    const kind = $('#scanKind').value;
    const params = {};
    if (kind !== 'arp') { params.target = $('#scanTarget').value.trim(); if (!params.target) { toast('対象を入力してください', true); return; } }
    if (kind === 'port') params.ports = $('#scanPorts').value.trim();
    if (kind === 'snmp') { params.community = $('#scanCommunity').value.trim() || 'public'; params.oid = $('#scanOid').value.trim() || '1.3.6.1.2.1'; }
    $('#scanBody').innerHTML = ''; renderScanHead(kind);
    scanRunning = true; updateScanButtons(); $('#scanProg').textContent = '実行中…';
    WT.invoke('netscan:run', { kind, params }).then((r) => { if (!(r && r.ok)) { scanRunning = false; updateScanButtons(); toast('スキャン開始失敗: ' + ((r && r.error) || ''), true); } });
  }
  function addScanRow(kind, row) {
    const tb = $('#scanBody'); if (!tb) return;
    const tr = elx('tr');
    let cells = [], menuInfo = null;
    if (kind === 'ping') { cells = [row.ip, '応答', row.rtt || '', row.host || '']; menuInfo = { host: row.ip }; }
    else if (kind === 'port') { cells = [row.host, String(row.port), row.service || '', row.state]; menuInfo = { host: row.host, port: row.port }; }
    else if (kind === 'arp') { cells = [row.ip, row.mac, row.type]; menuInfo = { host: row.ip }; }
    else if (kind === 'snmp') { cells = [row.oid, row.type, row.value]; }
    for (const c of cells) tr.appendChild(elx('td', null, c));
    if (menuInfo) {
      tr.style.cursor = 'context-menu';
      tr.oncontextmenu = (ev) => { ev.preventDefault(); scanRowMenu(ev.clientX, ev.clientY, menuInfo); };
    }
    tb.appendChild(tr);
  }
  function scanRowMenu(x, y, info) {
    const items = [];
    const guess = info.port === 23 ? 'telnet' : info.port === 3389 ? 'rdp' : 'ssh';
    const mk = (proto, label) => ({ label, fn: () => connectScanTarget(info.host, proto, info.port) });
    if (info.port) { items.push(mk(guess, 'この ' + info.host + ':' + info.port + ' に接続（' + guess.toUpperCase() + '）')); items.push({ sep: true }); }
    items.push(mk('ssh', 'SSHで接続'), mk('telnet', 'Telnetで接続'), mk('rdp', 'RDPで接続'));
    items.push({ sep: true });
    items.push({ label: 'セッションとして保存…', fn: () => saveScanTarget(info.host, info.port) });
    items.push({ label: 'IPをコピー', fn: () => { api.clipboardWrite(info.host); toast('コピー: ' + info.host); } });
    showMenu(x, y, items);
  }
  function defPort(proto, port) { if (proto === 'rdp') return 3389; if (proto === 'telnet') return 23; if (proto === 'ssh') return 22; return port || 22; }
  function connectScanTarget(host, proto, port) {
    const s = { id: uid(), name: host, protocol: proto, host: host, port: defPort(proto, (proto === 'ssh' || proto === 'telnet') ? port : null) };
    $('#scanModal').classList.add('hidden');
    openSession(s);
  }
  function saveScanTarget(host, port) {
    const s = { id: uid(), name: host, protocol: 'ssh', host: host, port: (port && port !== 23 && port !== 3389) ? port : 22 };
    DB.sessions.push(s); persistSessions(); renderSessions();
    $('#scanModal').classList.add('hidden');
    openEditor(s.id);
  }

  // ---- プラグイン登録 ----
  WT.register('scan', {
    activate(WT) {
      WT.addToolbarButton({ id: 'btnScan', label: '🔎 スキャン', title: 'ネットワークスキャン (ping sweep / port / ARP / SNMP)', onClick: () => openScan() });
      WT.registerCommand({ icon: '🔎', label: 'ネットワークスキャン', run: () => openScan() });
      wireScan();
    },
  });
})();
