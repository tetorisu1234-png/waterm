'use strict';
/* ===========================================================================
 * 第3弾（v1.5.0）追加機能のレンダラ実装
 *   - 内蔵ファイルサーバ (TFTP / HTTP / FTP)
 *   - ネットワークスキャン (ping sweep / port scan / ARP / SNMP walk)
 *   - コンフィグ管理＆差分
 *   - コマンドパレット (Ctrl+K) ＋ コマンド履歴
 * renderer.js より前に読み込む。relies on renderer.js のグローバル関数は
 * すべて実行時（イベント/ボタン）にのみ参照する。
 * =========================================================================== */

/* ---------------- 内蔵ファイルサーバ (TFTP / HTTP / FTP) ---------------- */
let FS_STATUS = { tftp: false, http: false, ftp: false };
function wireServer() {
  $('#btnServer').onclick = openServer;
  $('#fsClose').onclick = () => $('#fsModal').classList.add('hidden');
  $('#fsClear').onclick = () => { $('#fsLog').textContent = ''; };
  $('#fsPick').onclick = async () => { const r = await api.fsPickDir(); if (r && r.ok) { $('#fsRoot').value = r.dir; SETTINGS.fsRoot = r.dir; saveSettings(); } };
  $('#fsOpen').onclick = () => { const d = $('#fsRoot').value.trim(); if (d) api.fsOpenDir(d); };
  $('#fsRoot').onchange = () => { SETTINGS.fsRoot = $('#fsRoot').value.trim(); saveSettings(); };
  document.querySelectorAll('#fsModal tr[data-proto]').forEach((tr) => {
    const proto = tr.dataset.proto;
    tr.querySelector('.fs-toggle').onclick = () => toggleServer(proto, tr);
    const pi = tr.querySelector('.fs-port'); pi.onchange = () => { SETTINGS['fsPort_' + proto] = pi.value; saveSettings(); };
  });
  api.onFsLog((entry) => fsAppendLog(entry));
  api.onFsStatus((st) => { FS_STATUS = st || FS_STATUS; renderFsStatus(); });
}
function fsAppendLog(entry) {
  const el = $('#fsLog'); if (!el) return;
  const d = new Date(entry.ts); const p = (x) => String(x).padStart(2, '0');
  const tm = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  el.textContent += '[' + tm + '] [' + (entry.proto || '').toUpperCase() + '] ' + entry.msg + '\n';
  el.scrollTop = el.scrollHeight;
}
function renderFsStatus() {
  document.querySelectorAll('#fsModal tr[data-proto]').forEach((tr) => {
    const proto = tr.dataset.proto;
    const running = !!FS_STATUS[proto];
    const st = tr.querySelector('.fs-state'); const btn = tr.querySelector('.fs-toggle');
    st.textContent = running ? '● 稼働中 :' + FS_STATUS[proto] : '● 停止';
    st.className = 'fs-state' + (running ? ' on' : '');
    btn.textContent = running ? '停止' : '起動';
    btn.classList.toggle('primary', !running);
    tr.querySelector('.fs-port').disabled = running;
  });
}
async function openServer() {
  if (SETTINGS.fsRoot) $('#fsRoot').value = SETTINGS.fsRoot;
  ['tftp', 'http', 'ftp'].forEach((p) => { if (SETTINGS['fsPort_' + p]) { const i = document.querySelector('#fsModal tr[data-proto="' + p + '"] .fs-port'); if (i) i.value = SETTINGS['fsPort_' + p]; } });
  $('#fsWritable').checked = SETTINGS.fsWritable !== false;
  $('#fsModal').classList.remove('hidden');
  const r = await api.fsStatus();
  if (r) { FS_STATUS = r.status || FS_STATUS; renderFsIps(r.ips || []); renderFsStatus(); }
}
function renderFsIps(ips) {
  const box = $('#fsIps'); box.innerHTML = '';
  if (!ips.length) { box.appendChild(elx('span', 'muted', 'IPなし')); return; }
  for (const ip of ips) {
    const chip = elx('span', 'ip-chip', ip.address);
    chip.title = ip.name + ' — クリックでコピー';
    chip.onclick = () => { api.clipboardWrite(ip.address); toast('コピー: ' + ip.address); };
    box.appendChild(chip);
  }
}
async function toggleServer(proto, tr) {
  if (FS_STATUS[proto]) {
    await api.fsStop(proto);
    toast(proto.toUpperCase() + ' サーバを停止しました');
  } else {
    const root = $('#fsRoot').value.trim();
    if (!root) { toast('公開フォルダを選択してください', true); return; }
    const port = tr.querySelector('.fs-port').value;
    const writable = $('#fsWritable').checked;
    SETTINGS.fsWritable = writable; saveSettings();
    const r = await api.fsStart(proto, { root, port, writable });
    if (r && r.ok) toast(proto.toUpperCase() + ' サーバを起動しました :' + r.port);
    else toast(proto.toUpperCase() + ' 起動失敗: ' + ((r && r.error) || '不明'), true);
  }
}

/* ---------------- ネットワークスキャン ---------------- */
let scanRunning = false;
const SCAN_COLS = {
  ping: ['IP', '状態', 'RTT', 'ホスト名'],
  port: ['ホスト', 'ポート', 'サービス', '状態'],
  arp: ['IP', 'MAC', '種別'],
  snmp: ['OID', '型', '値'],
};
function wireScan() {
  $('#btnScan').onclick = () => openScan();
  $('#scanClose').onclick = () => { api.scanStop(); $('#scanModal').classList.add('hidden'); };
  $('#scanKind').onchange = () => updateScanFields();
  $('#scanRun').onclick = startScan;
  $('#scanStop').onclick = () => { api.scanStop(); };
  $('#scanClear').onclick = () => { $('#scanBody').innerHTML = ''; $('#scanProg').textContent = ''; };
  $('#scanTarget').onkeydown = (e) => { if (e.key === 'Enter') startScan(); };
  api.onScanResult((p) => addScanRow(p.kind, p.row));
  api.onScanProgress((p) => { $('#scanProg').textContent = p.label || ''; });
  api.onScanEnd((p) => {
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
  api.scanRun(kind, params).then((r) => { if (!(r && r.ok)) { scanRunning = false; updateScanButtons(); toast('スキャン開始失敗: ' + ((r && r.error) || ''), true); } });
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

/* ---------------- コンフィグ管理＆差分 ---------------- */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][AB012]|[\x00\x07]/g;
function cfgKeyOf(session) { if (!session) return 'device'; return (session.name || session.host || 'device'); }
let cfgSelected = []; // 選択中のスナップショット file 名（最大2）

function ConfigCapture(tab, opts) {
  this.tab = tab; this.cmd = opts.cmd; this.termLen = opts.termLen; this.idleMs = opts.idleMs; this.onDone = opts.onDone;
  this.buf = ''; this.capturing = false; this.done = false; this.timer = null; this.hardTimer = null;
}
// xterm バッファからカーソル付近の最終非空行（＝現在のプロンプト）を読む。
// 送信せずに現在のモードを判定するために使う。
function currentPromptLine(tab) {
  try {
    if (!tab || !tab.term) return '';
    const b = tab.term.buffer.active;
    const bottom = b.baseY + b.cursorY;
    for (let y = bottom; y >= Math.max(0, bottom - 4); y--) {
      const l = b.getLine(y); if (!l) continue;
      const s = l.translateToString(true);
      if (s && s.trim()) return s;
    }
  } catch (_) {}
  return '';
}
ConfigCapture.prototype.start = function () {
  const self = this;
  // Cisco向け事前処理（termLen=ON時）。
  // ⚠️特権EXEC(#)で `end` を打つと IOS が未知コマンド＝ホスト名と解釈して telnet を試み
  //   「% Bad IP address or host name」エラーになる。そこで現在のプロンプトを読み、
  //   設定モード「(config…)#」にいる時だけ `end` を送って特権EXECへ戻す。
  let preDelay = 60;
  if (this.termLen) {
    const inConfig = /\(config[^)]*\)\s*#/.test(currentPromptLine(this.tab));
    if (inConfig) {
      api.connInput(this.tab.id, 'end\r');
      setTimeout(() => api.connInput(self.tab.id, 'terminal length 0\r'), 300);
      preDelay = 900;
    } else {
      api.connInput(this.tab.id, 'terminal length 0\r');
      preDelay = 500;
    }
  }
  setTimeout(() => {
    self.capturing = true; self.buf = '';
    api.connInput(self.tab.id, self.cmd + '\r');
    self.arm();
  }, preDelay);
  this.hardTimer = setTimeout(() => self.finish(), 30000); // 取りこぼし防止の上限
};
ConfigCapture.prototype.feed = function (data) { if (!this.capturing) return; this.buf += data; this.arm(); };
ConfigCapture.prototype.arm = function () { clearTimeout(this.timer); const self = this; this.timer = setTimeout(() => self.finish(), this.idleMs); };
ConfigCapture.prototype.finish = function () {
  if (this.done) return; this.done = true; clearTimeout(this.timer); clearTimeout(this.hardTimer);
  if (this.tab) this.tab.cfgCap = null;
  this.onDone(this.clean(this.buf));
};
ConfigCapture.prototype.clean = function (s) {
  let t = s.replace(ANSI_RE, '').replace(/\r/g, '');
  const lines = t.split('\n');
  // 先頭のコマンドエコー行・空行を除去
  while (lines.length && (lines[0].trim() === '' || lines[0].indexOf(this.cmd) >= 0)) { const drop = lines[0].indexOf(this.cmd) >= 0; lines.shift(); if (drop) break; }
  // 末尾のプロンプト行/空行を除去
  while (lines.length && (lines[lines.length - 1].trim() === '' || /[#>$%]\s*$/.test(lines[lines.length - 1]))) lines.pop();
  return lines.join('\n').trim() + '\n';
};

function wireConfig() {
  $('#btnConfig').onclick = openConfig;
  $('#cfgClose').onclick = () => $('#cfgModal').classList.add('hidden');
  $('#cfgKey').onchange = () => { cfgSelected = []; loadCfgList(); };
  $('#cfgOpenDir').onclick = () => api.configOpenDir($('#cfgKey').value);
  $('#cfgCapture').onclick = () => captureConfig(false);
  $('#cfgCaptureSync').onclick = () => captureConfig(true);
  $('#cfgView').onclick = cfgDoView;
  $('#cfgDiff').onclick = cfgDoDiff;
  $('#cfgDel').onclick = cfgDoDelete;
}
async function openConfig() {
  cfgSelected = [];
  const t = tabs.get(activeId);
  const curKey = (t && !t.isRdp) ? cfgKeyOf(t.session) : '';
  const r = await api.configListKeys();
  const keys = (r && r.ok) ? r.keys.map((k) => k.key) : [];
  if (curKey && !keys.includes(curKey)) keys.unshift(curKey);
  const sel = $('#cfgKey'); sel.innerHTML = '';
  for (const k of keys) sel.appendChild(elx('option', null, k));
  if (!keys.length) sel.appendChild(elx('option', null, '(まだありません)'));
  if (curKey) sel.value = curKey;
  $('#cfgView2').textContent = '';
  $('#cfgModal').classList.remove('hidden');
  loadCfgList();
}
async function loadCfgList() {
  const key = $('#cfgKey').value; const ul = $('#cfgList'); ul.innerHTML = '';
  if (!key || key === '(まだありません)') { ul.appendChild(elx('li', 'muted', 'スナップショットがありません。「取得」で作成します。')); return; }
  const r = await api.configList(key);
  const snaps = (r && r.ok) ? r.snapshots : [];
  if (!snaps.length) { ul.appendChild(elx('li', 'muted', 'スナップショットがありません。')); return; }
  for (const s of snaps) {
    const li = elx('li', 'cfg-item');
    li.textContent = s.file.replace('.txt', '').replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/, '$1/$2/$3 $4:$5:$6') + '  (' + (s.size < 1024 ? s.size + 'B' : (s.size / 1024).toFixed(1) + 'KB') + ')';
    li.dataset.file = s.file;
    li.onclick = () => toggleCfgSelect(li, s.file);
    if (cfgSelected.includes(s.file)) li.classList.add('sel');
    ul.appendChild(li);
  }
}
function toggleCfgSelect(li, file) {
  const i = cfgSelected.indexOf(file);
  if (i >= 0) { cfgSelected.splice(i, 1); li.classList.remove('sel'); }
  else { cfgSelected.push(file); li.classList.add('sel'); if (cfgSelected.length > 2) { const drop = cfgSelected.shift(); const el = $('#cfgList').querySelector('[data-file="' + drop + '"]'); if (el) el.classList.remove('sel'); } }
}
function stripCfgHeader(content) { const lines = content.split('\n'); while (lines.length && /^# /.test(lines[0])) lines.shift(); return lines.join('\n'); }
async function cfgDoView() {
  if (!cfgSelected.length) { toast('表示するスナップショットを選んでください', true); return; }
  const key = $('#cfgKey').value;
  const r = await api.configRead(key, cfgSelected[cfgSelected.length - 1]);
  if (r && r.ok) { $('#cfgView2').textContent = r.content; $('#cfgView2').className = 'cfg-view'; }
  else toast('読込失敗', true);
}
async function cfgDoDelete() {
  if (!cfgSelected.length) { toast('削除するスナップショットを選んでください', true); return; }
  const key = $('#cfgKey').value;
  for (const f of cfgSelected.slice()) await api.configDelete(key, f);
  cfgSelected = []; $('#cfgView2').textContent = ''; loadCfgList(); toast('削除しました');
}
async function cfgDoDiff() {
  if (cfgSelected.length !== 2) { toast('差分は2件選択してください（古い→新しい）', true); return; }
  const key = $('#cfgKey').value;
  const sorted = cfgSelected.slice().sort(); // ファイル名=日時昇順 → [0]=古い [1]=新しい
  const ra = await api.configRead(key, sorted[0]); const rb = await api.configRead(key, sorted[1]);
  if (!(ra && ra.ok && rb && rb.ok)) { toast('読込失敗', true); return; }
  const diff = lineDiff(stripCfgHeader(ra.content).split('\n'), stripCfgHeader(rb.content).split('\n'));
  renderDiff(diff, sorted[0], sorted[1]);
}
// 行単位 LCS 差分
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4000000) { // 大きすぎる場合は簡易差分（集合ベース）
    const setB = new Set(b), setA = new Set(a); const out = [];
    a.forEach((l) => { if (!setB.has(l)) out.push({ t: 'del', text: l }); });
    b.forEach((l) => { if (!setA.has(l)) out.push({ t: 'add', text: l }); });
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: a[i] }); i++; }
    else { out.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: 'del', text: a[i++] });
  while (j < m) out.push({ t: 'add', text: b[j++] });
  return out;
}
function renderDiff(diff, aName, bName) {
  const el = $('#cfgView2'); el.className = 'cfg-view diff'; el.innerHTML = '';
  const head = elx('div', 'diff-head', '- ' + aName.replace('.txt', '') + '  →  + ' + bName.replace('.txt', ''));
  el.appendChild(head);
  let adds = 0, dels = 0;
  for (const d of diff) {
    if (d.t === 'add') adds++; if (d.t === 'del') dels++;
    el.appendChild(elx('div', 'dl ' + d.t, (d.t === 'add' ? '+ ' : d.t === 'del' ? '- ' : '  ') + d.text));
  }
  head.textContent += '   （+' + adds + ' / -' + dels + '）';
  if (!adds && !dels) el.appendChild(elx('div', 'muted', '差分はありません（同一）'));
}
async function captureConfig(syncGroup) {
  let targets = [];
  if (syncGroup) { targets = [...tabs.values()].filter((t) => t.syncOn && !t.isRdp); if (!targets.length) { const t = tabs.get(activeId); if (t && !t.isRdp) targets = [t]; } }
  else { const t = tabs.get(activeId); if (t && !t.isRdp) targets = [t]; }
  if (!targets.length) { toast('取得できる接続中のタブがありません', true); return; }
  const cmd = $('#cfgCmd').value.trim() || 'show running-config';
  const termLen = $('#cfgTermLen').checked;
  const idleMs = Math.max(400, parseInt($('#cfgIdle').value, 10) || 1500);
  toast(targets.length + '台から「' + cmd + '」を取得中…');
  for (const tab of targets) {
    if (tab.cfgCap) continue;
    const key = cfgKeyOf(tab.session);
    const cap = new ConfigCapture(tab, {
      cmd: cmd, termLen: termLen, idleMs: idleMs,
      onDone: async (content) => {
        const r = await api.configSave(key, cmd, content);
        if (r && r.ok) { toast('保存: ' + key + ' ← ' + cmd); if ($('#cfgKey').value === key && !$('#cfgModal').classList.contains('hidden')) loadCfgList(); }
        else toast('保存失敗: ' + ((r && r.error) || ''), true);
      },
    });
    tab.cfgCap = cap; cap.start();
  }
}

/* ---------------- コマンドパレット (Ctrl+K) ＋ コマンド履歴 ---------------- */
const CMD_HISTORY = [];   // 文字列（新しい順）
const cmdLineBuf = new Map();
let CMD_HISTORY_LOADED = false;
function recordCmdInput(id, d) {
  let buf = cmdLineBuf.get(id) || '';
  for (let i = 0; i < d.length; i++) {
    const ch = d[i]; const code = d.charCodeAt(i);
    if (ch === '\r' || ch === '\n') { commitCmd(buf); buf = ''; }
    else if (code === 0x7f || code === 0x08) { buf = buf.slice(0, -1); }
    else if (code === 0x15 || code === 0x03) { buf = ''; }       // Ctrl+U / Ctrl+C
    else if (code === 0x1b) { break; }                            // エスケープ列（矢印等）は無視
    else if (code >= 0x20) { buf += ch; }
  }
  cmdLineBuf.set(id, buf);
}
function commitCmd(line) {
  const cmd = (line || '').trim();
  if (cmd.length < 1 || cmd.length > 400) return;
  const i = CMD_HISTORY.indexOf(cmd); if (i >= 0) CMD_HISTORY.splice(i, 1);
  CMD_HISTORY.unshift(cmd);
  if (CMD_HISTORY.length > 300) CMD_HISTORY.length = 300;
  SETTINGS.cmdHistory = CMD_HISTORY.slice(0, 200); saveSettings();
}
function wirePalette() {
  $('#btnPalette').onclick = togglePalette;
  const inp = $('#paletteInput');
  inp.oninput = () => renderPalette(inp.value);
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') { closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteSel(); }
  };
  $('#palette').onclick = (e) => { if (e.target === $('#palette')) closePalette(); };
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); }
  }, true);
}
let paletteItems = [], paletteSel = 0;
function buildPaletteItems() {
  if (!CMD_HISTORY_LOADED) { if (Array.isArray(SETTINGS.cmdHistory)) for (const c of SETTINGS.cmdHistory) if (!CMD_HISTORY.includes(c)) CMD_HISTORY.push(c); CMD_HISTORY_LOADED = true; }
  const items = [];
  for (const s of DB.sessions) items.push({ icon: '🔌', label: '接続: ' + s.name, sub: (s.host || s.serialPort || ''), run: () => openSession(s) });
  for (const sn of SNIPPETS) items.push({ icon: '✂', label: 'スニペット: ' + sn.name, sub: sn.cmd, run: () => { const t = tabs.get(activeId); if (!t) { toast('送信先のタブがありません', true); return; } sendSnippet(sn); } });
  const acts = [
    ['新規セッション', 'new-session'], ['SFTPパネル', 'toggle-sftp'], ['通信モニタ', 'toggle-monitor'],
    ['テーマ切替', 'toggle-theme'], ['検索', 'find'], ['全タブへ送信', 'broadcast'],
    ['同時入力：切替', 'sync-toggle'], ['更新を確認', 'check-update'], ['出力ハイライト設定', 'highlight'],
  ];
  for (const a of acts) items.push({ icon: '⚙', label: 'コマンド: ' + a[0], sub: '', run: () => runMenuAction(a[1]) });
  items.push({ icon: '🗄', label: 'コマンド: 内蔵サーバ', sub: 'TFTP/HTTP/FTP', run: () => openServer() });
  items.push({ icon: '🔎', label: 'コマンド: ネットワークスキャン', sub: '', run: () => openScan() });
  items.push({ icon: '📑', label: 'コマンド: コンフィグ管理', sub: '', run: () => openConfig() });
  for (const c of CMD_HISTORY) items.push({ icon: '⌨', label: c, sub: '履歴 → アクティブタブへ送信', run: () => { const t = tabs.get(activeId); if (!t) { toast('送信先のタブがありません', true); return; } api.connInput(activeId, c + '\r'); t.term.focus(); } });
  return items;
}
function fuzzyScore(q, text) {
  if (!q) return 1;
  text = text.toLowerCase(); q = q.toLowerCase();
  if (text.includes(q)) return 1000 - text.indexOf(q);
  let ti = 0, hit = 0;
  for (let qi = 0; qi < q.length; qi++) { const f = text.indexOf(q[qi], ti); if (f < 0) return 0; hit++; ti = f + 1; }
  return hit;
}
function renderPalette(query) {
  const scored = paletteItems.map((it) => ({ it, s: fuzzyScore(query, it.label + ' ' + (it.sub || '')) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 40).map((x) => x.it);
  const ul = $('#paletteList'); ul.innerHTML = ''; paletteSel = 0;
  top.forEach((it, idx) => {
    const li = elx('li', 'pal-item' + (idx === 0 ? ' sel' : ''));
    li.appendChild(elx('span', 'pal-ic', it.icon));
    const main = elx('span', 'pal-main'); main.appendChild(elx('span', 'pal-label', it.label));
    if (it.sub) main.appendChild(elx('span', 'pal-sub', it.sub));
    li.appendChild(main);
    li.onclick = () => { paletteSel = idx; runPaletteSel(); };
    li.onmouseenter = () => { paletteSel = idx; highlightPalette(); };
    ul.appendChild(li);
  });
  ul._items = top;
  if (!top.length) ul.appendChild(elx('li', 'pal-empty muted', '一致なし'));
}
function highlightPalette() { const ul = $('#paletteList'); [...ul.children].forEach((li, i) => li.classList.toggle('sel', i === paletteSel)); }
function movePaletteSel(d) { const ul = $('#paletteList'); const n = (ul._items || []).length; if (!n) return; paletteSel = (paletteSel + d + n) % n; highlightPalette(); const li = ul.children[paletteSel]; if (li) li.scrollIntoView({ block: 'nearest' }); }
function runPaletteSel() { const ul = $('#paletteList'); const it = (ul._items || [])[paletteSel]; if (!it) return; closePalette(); setTimeout(() => { try { it.run(); } catch (e) { toast('実行エラー: ' + e.message, true); } }, 10); }
function togglePalette() { if ($('#palette').classList.contains('hidden')) openPalette(); else closePalette(); }
function openPalette() {
  paletteItems = buildPaletteItems();
  $('#palette').classList.remove('hidden');
  const inp = $('#paletteInput'); inp.value = ''; renderPalette('');
  setTimeout(() => inp.focus(), 20);
}
function closePalette() { $('#palette').classList.add('hidden'); }
