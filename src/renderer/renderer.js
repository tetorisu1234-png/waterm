'use strict';
/* 和ターミナル (WaTerm) — レンダラー */

const $ = (s) => document.querySelector(s);
function elx(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function uid() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function fmtSize(n) { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(1)) + u[i]; }
function fmtTime(sec) { if (!sec) return ''; const d = new Date(sec * 1000); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }

let DB = { folders: [], sessions: [] };
let SETTINGS = { theme: 'dark', fontSize: 14, sidebar: true, sftp: false };
let SNIPPETS = [];
const tabs = new Map();
let activeId = null;
let selectedSessionId = null;
// 画面分割(ペイン)
const PANE_COUNT = { '1': 1, '2v': 2, '2h': 2, '4': 4 };
let LAYOUT = '1';
let panes = [null];
let focused = 0;
let editingSessionId = null;
let editingSnip = -1;
let isDetachedWindow = false; // ドラッグで切り離した（サイドバー非表示の）ウィンドウか
let DRAGCHIP = false; // 切り離しドラッグのチップをWin32レイヤード窓で出せるか（ウィンドウ外表示可）
let updateManual = false; // 「更新を確認」ボタンからの手動チェックか（最新/エラー時のみ通知するため）
let updState = 'idle';    // アップデートダイアログの状態: idle / prompt / downloading / applying
let ACTIVE_PERF = true; // 実際に起動している描画モード（main側の起動時設定。menuのSETTINGS.perfModeとは別＝再起動で反映）
// 分離ウィンドウでタブが全て無くなったら自動で閉じる
function maybeCloseEmptyWindow() { if (isDetachedWindow && tabs.size === 0) { try { api.closeSelf(); } catch (_) {} } }

const THEME_DARK = { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' };
const THEME_LIGHT = { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selectionBackground: '#bcc0cc', black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be', brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc' };
const xtermTheme = () => (SETTINGS.theme === 'light' ? THEME_LIGHT : THEME_DARK);

// プラグインを読み込んでから init()、その後に各プラグインの activate を呼ぶ
if (window.WT && typeof WT.boot === 'function') WT.boot(init); else init();

// フォルダ監視によるプラグインのライブ反映（再起動不要）
try {
  api.plugin.on('plugins:liveAdd', async (m) => {
    if (window.WT && typeof WT.loadOne === 'function') {
      const ok = await WT.loadOne(m);
      if (ok) toast('プラグインを追加: ' + (m.name || m.id));
    }
    if (!$('#pluginsModal').classList.contains('hidden')) openPluginManager();
  });
  api.plugin.on('plugins:changed', (info) => {
    if (!$('#pluginsModal').classList.contains('hidden')) openPluginManager();
    if (info && info.needRestart) toast('削除/更新の完全反映には再起動が必要です');
  });
} catch (_) {}
async function init() {
  DB = (await api.loadSessions()) || { folders: [], sessions: [] };
  if (!DB.sessions) DB.sessions = [];
  SETTINGS = Object.assign({ theme: 'dark', fontSize: 14, sidebar: true, sftp: false }, (await api.loadSettings()) || {});
  SNIPPETS = (await api.loadSnippets()) || [];
  try { const vs = await api.vaultStatus(); if (vs && vs.enabled && !vs.unlocked) await promptUnlock(); } catch (_) {}
  applyTheme();
  $('#sidebar').classList.toggle('collapsed', !SETTINGS.sidebar);
  renderSessions(); renderSnippets();
  wireUI(); wireMenu(); wireData();
  renderMenuBar();
  applyLayoutSettings();
  try { DRAGCHIP = !!(await api.dragChipAvailable()); } catch (_) { DRAGCHIP = false; }
  try { ACTIVE_PERF = !!(await api.getPerfMode()); } catch (_) { ACTIVE_PERF = false; }
  if (SETTINGS.perfMode === undefined) SETTINGS.perfMode = true; // 既定ON
  api.windowReady(); // 分離ウィンドウの場合は引き継ぎタブを受け取る
}
// 切り離しチップを canvas に描き、前乗算BGRA(物理px)で返す（Win32 UpdateLayeredWindow 用）
function renderDragChip(name) {
  const dpr = window.devicePixelRatio || 1;
  const Wc = 280, Hc = 36;
  const w = Math.round(Wc * dpr), h = Math.round(Hc * dpr);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.beginPath(); ctx.roundRect(0.5, 0.5, Wc - 1, Hc - 1, 7);
  ctx.fillStyle = '#1e1e2e'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = '#89b4fa'; ctx.stroke();
  ctx.fillStyle = '#a6e3a1'; ctx.beginPath(); ctx.arc(16, Hc / 2, 4, 0, Math.PI * 2); ctx.fill();
  const hint = '↗ 新しいウィンドウ';
  ctx.font = '11px "Segoe UI","Meiryo",sans-serif';
  const hintW = ctx.measureText(hint).width;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#cdd6f4'; ctx.font = '600 12px "Segoe UI","Meiryo",sans-serif';
  const nameMax = Wc - 12 - hintW - 10 - 28;
  let nm = name || 'セッション';
  if (ctx.measureText(nm).width > nameMax) { while (nm.length > 1 && ctx.measureText(nm + '…').width > nameMax) nm = nm.slice(0, -1); nm += '…'; }
  ctx.textAlign = 'left'; ctx.fillText(nm, 28, Hc / 2 + 1);
  ctx.fillStyle = '#89b4fa'; ctx.font = '11px "Segoe UI","Meiryo",sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(hint, Wc - 12, Hc / 2 + 1);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const R = rgba[i * 4], G = rgba[i * 4 + 1], B = rgba[i * 4 + 2], A = rgba[i * 4 + 3];
    out[i * 4] = (B * A / 255) | 0; out[i * 4 + 1] = (G * A / 255) | 0; out[i * 4 + 2] = (R * A / 255) | 0; out[i * 4 + 3] = A;
  }
  return { bgra: out, w, h };
}

/* ---------------- テーマ ---------------- */
function applyTheme() { document.body.className = 'theme-' + (SETTINGS.theme === 'light' ? 'light' : 'dark'); }
function toggleTheme() { SETTINGS.theme = SETTINGS.theme === 'light' ? 'dark' : 'light'; applyTheme(); for (const t of tabs.values()) t.term.options.theme = xtermTheme(); saveSettings(); }
function saveSettings() { api.saveSettings(SETTINGS); }
function persistSessions() { api.saveSessions(DB); }
function persistSnippets() { api.saveSnippets(SNIPPETS); }

/* ---------------- サイドバー：セッション ---------------- */
// セッション一覧の最大高さ：下のスニペット/全タブ送信が隠れない範囲に制限
function maxSessListHeight() { return Math.max(120, Math.round(window.innerHeight * 0.5)); }
let dragSessId = null;
function clearDropMarks() { document.querySelectorAll('.sess-list .drop-before, .sess-list .drop-after, .sess-list .drop-into').forEach((e) => e.classList.remove('drop-before', 'drop-after', 'drop-into')); }
// ドラッグ移動：dragId を targetId の前/後ろ（または folder の末尾）へ移し、フォルダも設定
function moveSession(dragId, targetId, folder, after) {
  const di = DB.sessions.findIndex((x) => x.id === dragId); if (di < 0) return;
  const [moved] = DB.sessions.splice(di, 1);
  moved.folder = folder || '';
  if (targetId && targetId !== dragId) {
    const ti = DB.sessions.findIndex((x) => x.id === targetId);
    if (ti < 0) DB.sessions.push(moved); else DB.sessions.splice(after ? ti + 1 : ti, 0, moved);
  } else {
    DB.sessions.push(moved); // フォルダ見出し/空きスペースへのドロップは末尾へ
  }
  persistSessions(); renderSessions();
}
function renderSessions() {
  const filter = ($('#sessFilter').value || '').toLowerCase();
  const ul = $('#sessList'); ul.innerHTML = '';
  const groups = {};
  for (const s of DB.sessions) {
    if (filter && !(`${s.name} ${s.host} ${s.username}`.toLowerCase().includes(filter))) continue;
    const f = s.folder || '';
    (groups[f] = groups[f] || []).push(s);
  }
  const folders = Object.keys(groups).sort();
  for (const f of folders) {
    if (f) {
      const fh = elx('div', 'sess-folder', '📂 ' + f);
      fh.addEventListener('dragover', (e) => { if (!dragSessId) return; e.preventDefault(); e.stopPropagation(); clearDropMarks(); fh.classList.add('drop-into'); });
      fh.addEventListener('dragleave', () => fh.classList.remove('drop-into'));
      fh.addEventListener('drop', (e) => { if (!dragSessId) return; e.preventDefault(); e.stopPropagation(); const id = dragSessId; clearDropMarks(); moveSession(id, null, f, true); });
      ul.appendChild(fh);
    }
    for (const s of groups[f]) {
      const li = elx('li'); li.dataset.id = s.id;
      if (s.id === selectedSessionId) li.classList.add('selected');
      const ic = s.protocol === 'serial' ? '🔌 ' : s.protocol === 'telnet' ? '☎ ' : s.protocol === 'rdp' ? '🖥 ' : '🔐 ';
      const nm = elx('div', 'nm', ic + s.name);
      const metaTxt = s.protocol === 'serial'
        ? `${s.serialPort || 'COM?'} ${s.baud || 9600}bps`
        : `${s.username ? s.username + '@' : ''}${s.host}:${s.port}${s.protocol === 'rdp' ? ' ·RDP' : ''}${s.legacy ? ' ·旧暗号' : ''}`;
      const meta = elx('div', 'meta', metaTxt);
      li.appendChild(nm); li.appendChild(meta);
      li.onclick = () => { selectedSessionId = s.id; renderSessions(); };
      li.ondblclick = () => openSession(s);
      li.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, [
        { label: '接続', fn: () => openSession(s) },
        ...(window.WT ? WT.sessionMenuItems(s) : []),
        { sep: true },
        { label: '編集', fn: () => openEditor(s.id) },
        { label: '複製', fn: () => dupSession(s.id) },
        { label: '削除', fn: () => delSession(s.id) },
      ]); };
      // ドラッグで並べ替え／フォルダ移動
      li.draggable = true;
      li.addEventListener('dragstart', (e) => { dragSessId = s.id; if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', s.id); } catch (_) {} } setTimeout(() => li.classList.add('dragging'), 0); });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragSessId = null; clearDropMarks(); });
      li.addEventListener('dragover', (e) => {
        if (!dragSessId || dragSessId === s.id) return;
        e.preventDefault(); e.stopPropagation();
        const r = li.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
        clearDropMarks(); li.classList.add(after ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        if (!dragSessId) return; e.preventDefault(); e.stopPropagation();
        const id = dragSessId; const r = li.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
        clearDropMarks(); moveSession(id, s.id, s.folder || '', after);
      });
      ul.appendChild(li);
    }
  }
  if (!DB.sessions.length) ul.appendChild(elx('li', 'meta', 'セッションがありません。＋ で追加してください。'));
}

/* ---------------- セッション編集 ---------------- */
function openEditor(id) {
  editingSessionId = id || null;
  const s = id ? DB.sessions.find((x) => x.id === id) : {};
  $('#modalTitle').textContent = id ? 'セッションの編集' : '新規セッション';
  $('#fName').value = s.name || '';
  $('#fProto').value = s.protocol || 'ssh';
  $('#fHost').value = s.host || '';
  $('#fPort').value = s.port || (s.protocol === 'telnet' ? 23 : s.protocol === 'rdp' ? 3389 : 22);
  $('#fUser').value = s.username || '';
  $('#fAuth').value = s.authType || 'password';
  $('#fPass').value = '';
  $('#fPass').placeholder = s.passwordStored ? '(保存済み・変更する場合のみ入力)' : '(任意・暗号化保存)';
  $('#fKey').value = s.keyPath || '';
  $('#fPhrase').value = '';
  $('#fLegacy').checked = !!s.legacy;
  // 踏み台候補：自分以外のSSHセッション
  const jumpSel = $('#fJump'); jumpSel.innerHTML = '<option value="">なし（直接接続）</option>';
  for (const o of DB.sessions) { if (o.id !== id && (o.protocol || 'ssh') === 'ssh') { const op = document.createElement('option'); op.value = o.id; op.textContent = o.name + (o.host ? ' (' + o.host + ')' : ''); jumpSel.appendChild(op); } }
  jumpSel.value = s.jumpId || '';
  $('#fAutoReconnect').checked = !!s.autoReconnect;
  $('#fEnc').value = s.encoding || 'utf8';
  $('#fNl').value = s.newline || (s.protocol === 'telnet' ? 'crlf' : 'cr');
  $('#fTermType').value = s.termType || 'xterm-256color';
  $('#fEcho').checked = !!s.localEcho;
  $('#fFolder').value = s.folder || '';
  $('#fLogin').value = s.loginCommands || '';
  $('#fForwards').value = s.forwards || '';
  $('#fKeep').value = s.keepalive || 15;
  // シリアル
  editingSerialPort = s.serialPort || '';
  $('#fBaud').value = s.baud || '9600';
  $('#fDataBits').value = s.dataBits || '8';
  $('#fParity').value = s.parity || 'none';
  $('#fStopBits').value = s.stopBits || '1';
  $('#fFlow').value = s.flow || 'none';
  // RDP
  // RDP編集フィールドは rdp プラグインが注入（無効時は存在しないのでガード）
  if ($('#fDomain')) {
    $('#fDomain').value = s.domain || '';
    $('#fScreen').value = s.fullscreen === false ? 'window' : 'full';
    $('#fWidth').value = s.width || 1280;
    $('#fHeight').value = s.height || 800;
    $('#fClipboard').checked = s.clipboard !== false;
    $('#fDrives').checked = !!s.drives;
    $('#fMultimon').checked = !!s.multimon;
    $('#fAdmin').checked = !!s.adminSession;
  }
  setAdvOpen(hasAdvancedValues(s)); // 新規は折りたたみ、詳細設定済みなら展開
  updateModalProto();
  $('#modal').classList.remove('hidden');
  $('#fName').focus();
}
let editingSerialPort = '';
function defaultPort(proto) { return proto === 'telnet' ? '23' : proto === 'rdp' ? '3389' : proto === 'ssh' ? '22' : ''; }
// プロトコル変更時：ポートが既定値(または空)なら新プロトコルの既定ポートへ自動切替（手動ポートは保持）
function onProtoChange() {
  const proto = $('#fProto').value;
  const cur = ($('#fPort').value || '').trim();
  if (['', '22', '23', '3389'].includes(cur)) $('#fPort').value = defaultPort(proto);
  updateModalProto();
}
function updateModalProto() {
  const proto = $('#fProto').value;
  const ssh = proto === 'ssh', serial = proto === 'serial', rdp = proto === 'rdp';
  const key = ssh && $('#fAuth').value === 'key';
  // プロトコルに合わない行を proto-hide。adv(詳細)の出し分けは CSS の show-adv が担当
  const setShow = (sel, show) => document.querySelectorAll(sel).forEach((e) => e.classList.toggle('proto-hide', !show));
  setShow('.netOnly', !serial);
  setShow('.sshOnly', ssh);
  setShow('.serialOnly', serial);
  setShow('.rdpOnly', rdp);
  setShow('.termOnly', !rdp);
  setShow('.keyOnly', key);
  if (serial) populateSerialPorts();
}
// 詳細設定の展開/折りたたみ
function setAdvOpen(open) {
  $('#modal').classList.toggle('show-adv', open);
  const b = $('#advToggle'); if (b) b.textContent = open ? '▾ 詳細設定を隠す' : '▸ 詳細設定を表示';
}
function hasAdvancedValues(s) {
  if (!s) return false;
  return !!(s.legacy || s.jumpId || s.autoReconnect || (s.authType === 'key') || (s.folder && s.folder.trim())
    || (s.loginCommands && s.loginCommands.trim()) || (s.forwards && s.forwards.trim())
    || (s.encoding && s.encoding !== 'utf8') || (s.termType && s.termType !== 'xterm-256color') || s.localEcho
    || s.domain || s.drives || s.multimon || s.adminSession
    || (s.parity && s.parity !== 'none') || (s.flow && s.flow !== 'none') || (s.dataBits && String(s.dataBits) !== '8') || (s.stopBits && String(s.stopBits) !== '1'));
}
async function populateSerialPorts(selected) {
  const sel = $('#fSerialPort');
  const want = selected || editingSerialPort || sel.value;
  const ports = await api.serialList();
  sel.innerHTML = '';
  const added = new Set();
  const addOpt = (val, label) => { if (added.has(val)) return; added.add(val); const o = document.createElement('option'); o.value = val; o.textContent = label || val; sel.appendChild(o); };
  // 1) 実際に検出されたポート（説明付き、先頭に）
  for (const p of ports) {
    const desc = p.friendlyName || p.manufacturer || '';
    addOpt(p.path, p.path + (desc ? ' — ' + desc : ' — 検出'));
  }
  if (ports.length) { const o = document.createElement('option'); o.disabled = true; o.textContent = '──────────'; sel.appendChild(o); }
  // 2) COM1〜COM20 を一覧に（未検出でも選べるように）
  for (let i = 1; i <= 20; i++) addOpt('COM' + i, 'COM' + i);
  // 保存済み/選択中のポートが一覧に無ければ追加
  if (want) {
    if (!added.has(want)) addOpt(want, want);
    sel.value = want;
  }
}
async function saveEditor() {
  const id = editingSessionId || uid();
  let s = DB.sessions.find((x) => x.id === id);
  if (!s) { s = { id }; DB.sessions.push(s); }
  s.protocol = $('#fProto').value;
  s.name = $('#fName').value.trim() || (s.protocol === 'serial' ? $('#fSerialPort').value : $('#fHost').value.trim()) || '名称未設定';
  s.host = $('#fHost').value.trim();
  s.port = Number($('#fPort').value) || (s.protocol === 'telnet' ? 23 : 22);
  s.username = $('#fUser').value.trim();
  s.authType = $('#fAuth').value;
  s.keyPath = $('#fKey').value.trim();
  s.legacy = $('#fLegacy').checked;
  s.jumpId = $('#fJump').value || '';
  s.autoReconnect = $('#fAutoReconnect').checked;
  s.encoding = $('#fEnc').value;
  s.newline = $('#fNl').value;
  s.termType = $('#fTermType').value;
  s.localEcho = $('#fEcho').checked;
  s.folder = $('#fFolder').value.trim();
  s.loginCommands = $('#fLogin').value;
  s.forwards = $('#fForwards').value;
  s.keepalive = Number($('#fKeep').value) || 15;
  s.serialPort = $('#fSerialPort').value;
  s.baud = $('#fBaud').value; s.dataBits = $('#fDataBits').value;
  s.parity = $('#fParity').value; s.stopBits = $('#fStopBits').value; s.flow = $('#fFlow').value;
  if ($('#fDomain')) {
    s.domain = $('#fDomain').value.trim();
    s.fullscreen = $('#fScreen').value !== 'window';
    s.width = Number($('#fWidth').value) || 1280; s.height = Number($('#fHeight').value) || 800;
    s.clipboard = $('#fClipboard').checked; s.drives = $('#fDrives').checked;
    s.multimon = $('#fMultimon').checked; s.adminSession = $('#fAdmin').checked;
  }
  if ($('#fPass').value) s.passwordStored = await api.encrypt($('#fPass').value);
  if ($('#fPhrase').value) s.phraseStored = await api.encrypt($('#fPhrase').value);
  persistSessions(); renderSessions();
  $('#modal').classList.add('hidden');
}
function dupSession(id) { const s = DB.sessions.find((x) => x.id === id); if (!s) return; const c = JSON.parse(JSON.stringify(s)); c.id = uid(); c.name = s.name + ' (複製)'; DB.sessions.push(c); persistSessions(); renderSessions(); }
function delSession(id) { const s = DB.sessions.find((x) => x.id === id); if (!s) return; if (!confirm(`セッション「${s.name}」を削除しますか？`)) return; DB.sessions = DB.sessions.filter((x) => x.id !== id); if (selectedSessionId === id) selectedSessionId = null; persistSessions(); renderSessions(); }

/* ---------------- 接続 / タブ ---------------- */
async function buildCfg(s, cols, rows) {
  const cfg = {
    protocol: s.protocol || 'ssh', host: s.host, port: Number(s.port) || (s.protocol === 'telnet' ? 23 : 22),
    username: s.username, authType: s.authType || 'password', legacy: !!s.legacy,
    encoding: s.encoding || 'utf8', newline: s.newline || (s.protocol === 'telnet' ? 'crlf' : 'cr'),
    localEcho: !!s.localEcho, loginCommands: s.loginCommands || '', keepalive: Number(s.keepalive) || 15,
    keyPath: s.keyPath || '', cols, rows, termType: s.termType || 'xterm-256color',
    forwards: s.forwards || '',
  };
  if (s.protocol === 'serial') { cfg.serialPort = s.serialPort; cfg.baud = s.baud; cfg.dataBits = s.dataBits; cfg.parity = s.parity; cfg.stopBits = s.stopBits; cfg.flow = s.flow; }
  if (s.protocol === 'shell') cfg.shellKind = s.shellKind || 'powershell';
  if (s.protocol === 'rdp') { cfg.domain = s.domain; cfg.fullscreen = s.fullscreen; cfg.width = s.width; cfg.height = s.height; cfg.clipboard = s.clipboard; cfg.drives = s.drives; cfg.multimon = s.multimon; cfg.adminSession = s.adminSession; }
  if (s.password) cfg.password = s.password; // クイック接続用（平文一時）
  if (s.passwordStored) cfg.password = await api.decrypt(s.passwordStored);
  if (s.phraseStored) cfg.passphrase = await api.decrypt(s.phraseStored);
  if (s.passphrase) cfg.passphrase = s.passphrase;
  // 踏み台(ProxyJump)：別セッションの資格情報を復号して渡す
  if (s.protocol === 'ssh' && s.jumpId) {
    const j = DB.sessions.find((x) => x.id === s.jumpId);
    if (j) {
      const jump = { host: j.host, port: Number(j.port) || 22, username: j.username, authType: j.authType || 'password', legacy: !!j.legacy, keyPath: j.keyPath || '' };
      if (j.passwordStored) jump.password = await api.decrypt(j.passwordStored);
      if (j.password) jump.password = j.password;
      if (j.phraseStored) jump.passphrase = await api.decrypt(j.phraseStored);
      cfg.jump = jump;
    }
  }
  return cfg;
}
// ターミナルタブ(xterm + ラッパ + 配線)を生成する共通処理
// 端末の描画レンダラを読み込む。WebGL(高速モード)→失敗ならCanvas→それも無ければ標準(DOM)。
function loadFastRenderer(term) {
  if (ACTIVE_PERF && typeof WebglAddon !== 'undefined') {
    try {
      const w = new WebglAddon.WebglAddon();
      w.onContextLoss(() => { try { w.dispose(); } catch (_) {} try { if (typeof CanvasAddon !== 'undefined') term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (_) {} });
      term.loadAddon(w);
      return;
    } catch (_) { /* WebGL不可 → Canvasへ */ }
  }
  try { if (typeof CanvasAddon !== 'undefined') term.loadAddon(new CanvasAddon.CanvasAddon()); } catch (_) {}
}
function buildTermTab(id, session, status) {
  const wrap = elx('div', 'term-wrap'); $('#termpool').appendChild(wrap);
  const term = new Terminal({ fontSize: SETTINGS.fontSize, fontFamily: 'Consolas, "Cascadia Mono", "MS Gothic", monospace', cursorBlink: true, scrollback: 8000, theme: xtermTheme(), allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  const search = new SearchAddon.SearchAddon(); term.loadAddon(search);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => api.openExternal(uri))); } catch (_) {}
  term.open(wrap);
  // レンダラ高速化: 高速モードはWebGL(GPU)、通常モードはCanvas(ソフトだがDOMより速い)。失敗時はCanvas→DOMへフォールバック。
  loadFastRenderer(term);
  // 右クリックで貼り付け、範囲選択で自動コピー(PuTTY/MobaXterm方式)
  wrap.addEventListener('contextmenu', async (e) => { e.preventDefault(); const txt = await api.clipboardRead(); if (txt) term.paste(txt); }, true);
  term.onSelectionChange(() => { const sel = term.getSelection(); if (sel) api.clipboardWrite(sel); });
  const tab = { id, term, fit, search, session, wrap, tabEl: null, status: status || 'connecting', sftpCwd: null, logging: false };
  tabs.set(id, tab);
  addTabEl(tab);
  setActive(id);
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 30);
  term.onData((d) => {
    if (window.WT) WT._emitInput(id, d); // プラグイン（コマンド履歴・同時入力ミラー等）へ入力を通知
    api.connInput(id, d);
  });
  term.onResize(({ cols, rows }) => api.connResize(id, cols, rows));
  return tab;
}
// 別ウィンドウから移動してきたタブを受け取る（接続は維持済み）
function adoptTab(payload) {
  if (!payload || !payload.id || tabs.has(payload.id)) return;
  if (payload.detached) {
    isDetachedWindow = true;
    $('#sidebar').classList.add('collapsed'); // 分離ウィンドウはサイドバー(セッション等)を非表示
  }
  const tab = buildTermTab(payload.id, payload.session, payload.status || 'connected');
  updateTabEl(tab);
  tab.term.writeln('\x1b[90m── 別ウィンドウから移動しました（接続は継続中・スクロールバックは引き継がれません）──\x1b[0m');
  setTimeout(() => { try { tab.fit.fit(); api.connResize(tab.id, tab.term.cols, tab.term.rows); } catch (_) {} }, 60);
  if (window.WT) WT._tabAdopted(tab); // プラグイン（通信モニタの記録状態引き継ぎ等）へ通知
}
async function openSession(s) {
  // プロトコルプラグイン（RDP 等、xterm 以外のタブ種別）が担当する場合は委譲
  if (window.WT && WT.hasProtocol(s.protocol)) { await WT.openProtocolTab(s); return; }
  // 端末以外のプロトコルなのにハンドラが無い＝担当プラグインが無効
  if (['ssh', 'telnet', 'serial', 'shell'].indexOf(s.protocol) < 0) {
    toast('「' + (s.protocol || '').toUpperCase() + '」を扱うプラグインが無効です（プラグイン管理で有効化）', true);
    return;
  }
  const id = uid();
  const tab = buildTermTab(id, s, 'connecting');
  const term = tab.term, fit = tab.fit;
  const target = s.protocol === 'serial' ? ((s.serialPort || 'COM?') + ' @ ' + (s.baud || 9600) + 'bps')
    : s.protocol === 'shell' ? (s.shellKind || 'powershell')
    : (s.host + ':' + s.port);
  term.writeln('\x1b[90m' + s.name + ' へ接続中... (' + s.protocol.toUpperCase() + ' ' + target + ')\x1b[0m');
  const cfg = await buildCfg(s, term.cols, term.rows);
  const res = await api.connOpen(id, cfg);
  if (!res || !res.ok) { tab.status = 'error'; updateTabEl(tab); term.writeln('\x1b[31m接続失敗: ' + ((res && res.error) || '不明なエラー') + '\x1b[0m'); }
}
// タブをドラッグして離れる縦の許容範囲（この範囲を超えたら別ウィンドウへ）
const TAB_TEAR_TOLERANCE = 44;
function addTabEl(tab) {
  const t = elx('div', 'tab'); t.dataset.id = tab.id;
  const dot = elx('span', 'dot');
  const lbl = elx('span', 'tablabel', tab.session.name);
  const x = elx('span', 'x', '✕');
  x.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
  t.appendChild(dot); t.appendChild(lbl); t.appendChild(x);
  t.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === x) return;
    beginTabDrag(e, tab.id, t, tab.session.name);
  });
  tab.tabEl = t; $('#tabbar').appendChild(t); updateTabEl(tab);
}
// Chrome風タブドラッグ：縦の許容範囲内ならバー内で並べ替え（縦には飛び出さない）、
// 範囲を外れたら離脱モード（離した位置で別ウィンドウ／他ウィンドウへ取り込み）
function beginTabDrag(e, id, el, name) {
  const tb = $('#tabbar');
  const startX = e.clientX, startY = e.clientY;
  let dragging = false, tearing = false;
  let snap = null, slotW = 0, di = 0, startCenter = 0, curTarget = 0;
  try { el.setPointerCapture(e.pointerId); } catch (_) {} // ウィンドウ外でも pointerup を受け取る
  const inBand = (y) => { const b = tb.getBoundingClientRect(); return y >= b.top - TAB_TEAR_TOLERANCE && y <= b.bottom + TAB_TEAR_TOLERANCE; };
  const buildSnap = () => {
    snap = [...tb.querySelectorAll('.tab')].map((n) => { const r = n.getBoundingClientRect(); return { el: n, center: r.left + r.width / 2 }; });
    di = snap.findIndex((s) => s.el === el);
    slotW = el.offsetWidth + 2; // タブ幅 + #tabbar の gap
    startCenter = snap[di] ? snap[di].center : 0; curTarget = di;
  };
  const clearShifts = () => { if (snap) snap.forEach((s) => { s.el.style.transform = ''; }); };
  // ドラッグ中のタブは半透明でカーソル追従、他タブは隙間を空けるようスライド
  const layoutReorder = (dxRaw) => {
    // ドラッグ中のタブを #tabbar の内側にクランプ（左右の壁を貫通させない）
    const tbr = tb.getBoundingClientRect();
    const w = el.offsetWidth;
    const origLeft = startCenter - w / 2;
    const minDx = (tbr.left + 6) - origLeft;        // 左パディング(6px)分内側まで
    const maxDx = (tbr.right - 6 - w) - origLeft;   // 右端 - パディング - タブ幅
    const dx = (maxDx < minDx) ? dxRaw : Math.max(minDx, Math.min(dxRaw, maxDx));
    const dc = startCenter + dx;
    let target = di;
    for (let j = 0; j < snap.length; j++) {
      if (j === di) continue;
      if (j < di && dc < snap[j].center) target = Math.min(target, j);
      else if (j > di && dc > snap[j].center) target = Math.max(target, j);
    }
    curTarget = target;
    snap.forEach((s, j) => {
      if (s.el === el) return;
      let shift = 0;
      if (target > di && j > di && j <= target) shift = -slotW;
      else if (target < di && j >= target && j < di) shift = slotW;
      s.el.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
    });
    el.style.transform = 'translateX(' + dx + 'px)';
  };
  const onMove = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
      dragging = true; document.body.classList.add('tab-dragging'); buildSnap();
      el.classList.add('dragging');
    }
    if (inBand(ev.clientY)) {
      if (tearing) { tearing = false; el.classList.remove('tearing'); api.dragChipHide(); hideTabGhost(); }
      layoutReorder(ev.clientX - startX);
    } else {
      if (!tearing) {
        tearing = true; el.classList.add('tearing');
        // DRAGCHIP可ならWin32レイヤード窓でウィンドウ外も表示。不可ならDOMゴースト(端クランプ)。
        if (DRAGCHIP) { try { const c = renderDragChip(name); api.dragChipShow(c.bgra, c.w, c.h, ev.screenX, ev.screenY); } catch (_) { showTabGhost(ev.clientX, ev.clientY, name); } }
      }
      clearShifts(); el.style.transform = '';
      if (DRAGCHIP) api.dragChipMove(ev.screenX, ev.screenY);
      else showTabGhost(ev.clientX, ev.clientY, name);
    }
  };
  const finish = () => { clearShifts(); el.classList.remove('dragging', 'tearing'); document.body.classList.remove('tab-dragging'); api.dragChipHide(); hideTabGhost(); };
  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!dragging) { finish(); setActive(id); return; } // 動かさなければクリック扱い
    const reorder = inBand(ev.clientY), target = curTarget;
    finish();
    if (reorder) {
      if (snap && target !== di) {
        const ref = snap[target].el;
        if (target > di) tb.insertBefore(el, ref.nextElementSibling); else tb.insertBefore(el, ref);
        commitTabOrder();
      }
    } else relocateTab(id, ev.screenX, ev.screenY);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
let tabGhostEl = null;
function showTabGhost(x, y, name) {
  if (!tabGhostEl) {
    tabGhostEl = elx('div', 'tab-ghost');
    tabGhostEl.innerHTML = '<span class="dot"></span><span class="gname"></span><span class="ghint">↗ 新しいウィンドウ</span>';
    document.body.appendChild(tabGhostEl);
  }
  tabGhostEl.querySelector('.gname').textContent = name || 'セッション';
  tabGhostEl.style.display = 'flex';
  // カーソルがウィンドウ端／画面外へ出ても消えないよう、ゴーストをビューポート内にクランプして端で止める
  const w = tabGhostEl.offsetWidth || 180, h = tabGhostEl.offsetHeight || 32;
  const lx = Math.max(4, Math.min(x + 12, window.innerWidth - w - 4));
  const ly = Math.max(4, Math.min(y + 14, window.innerHeight - h - 4));
  tabGhostEl.style.left = lx + 'px'; tabGhostEl.style.top = ly + 'px';
}
function hideTabGhost() { if (tabGhostEl) tabGhostEl.style.display = 'none'; }
// DOM順に合わせて tabs Map の順序を作り直す
function commitTabOrder() {
  const order = [...$('#tabbar').querySelectorAll('.tab')].map((el) => el.dataset.id);
  const snapshot = new Map(tabs);
  tabs.clear();
  for (const id of order) if (snapshot.has(id)) { tabs.set(id, snapshot.get(id)); snapshot.delete(id); }
  for (const [id, t] of snapshot) tabs.set(id, t); // 念のため漏れを後ろへ
}
// タブをドラッグ移動（接続は維持）。座標から別ウィンドウへ取り込み/新ウィンドウ/その場を判定
async function relocateTab(id, screenX, screenY) {
  const tab = tabs.get(id); if (!tab) return;
  if (tab.isEmbed) { toast('RDPタブはウィンドウ移動に未対応です', true); return; }
  const res = await api.relocateTab(id, tab.session, tab.status, screenX, screenY);
  if (!res || !res.ok) { if (res && res.error) toast('移動に失敗: ' + res.error, true); return; }
  if (res.moved) removeTabLocal(id); // 別ウィンドウ/新ウィンドウへ移った → このウィンドウからは撤去
  // res.moved === false は同一ウィンドウ内ドロップ → そのまま
}
// 接続を閉じずにローカルのタブだけ撤去（分離時に使用）
function removeTabLocal(id) {
  const tab = tabs.get(id); if (!tab) return;
  if (tab.macro) { try { tab.macro.stop('別ウィンドウへ移動'); } catch (_) {} }
  if (tab.ttl && !tab.ttl.done) { try { tab.ttl.interp.stop(); if (tab.ttlIo) tab.ttlIo.cancel(); } catch (_) {} }
  try { tab.term.dispose(); } catch (_) {}
  try { tab.wrap.remove(); } catch (_) {}
  if (tab.tabEl) tab.tabEl.remove();
  tabs.delete(id);
  for (let i = 0; i < panes.length; i++) if (panes[i] === id) panes[i] = null;
  if (!panes[focused]) { const cand = [...tabs.keys()].find((x) => !panes.includes(x)); if (cand) panes[focused] = cand; }
  activeId = panes[focused] || null;
  renderLayout();
  maybeCloseEmptyWindow();
}
function updateTabEl(tab) {
  if (!tab.tabEl) return;
  tab.tabEl.classList.remove('st-connected', 'st-error', 'st-closed', 'active');
  if (tab.status === 'connected') tab.tabEl.classList.add('st-connected');
  else if (tab.status === 'error') tab.tabEl.classList.add('st-error');
  else if (tab.status === 'closed') tab.tabEl.classList.add('st-closed');
  if (tab.id === activeId) tab.tabEl.classList.add('active');
  tab.tabEl.classList.toggle('sync', !!tab.syncOn);
}
function paneCount() { return PANE_COUNT[LAYOUT] || 1; }
function setLayout(l) {
  if (!PANE_COUNT[l]) return;
  LAYOUT = l;
  const n = paneCount();
  if (panes.length > n) panes = panes.slice(0, n);
  while (panes.length < n) panes.push(null);
  if (focused >= n) focused = n - 1;
  // 空きペインを、未表示の開いているタブで自動補充
  const shown = new Set(panes.filter(Boolean));
  for (let i = 0; i < n; i++) {
    if (!panes[i] || !tabs.has(panes[i])) {
      const cand = [...tabs.keys()].find((id) => !shown.has(id));
      panes[i] = cand || null; if (cand) shown.add(cand);
    }
  }
  if (!panes[focused]) { const f = panes.findIndex(Boolean); if (f >= 0) focused = f; }
  activeId = panes[focused] || null;
  document.querySelectorAll('.layoutsel .lay').forEach((b) => b.classList.toggle('active', b.dataset.layout === l));
  renderLayout();
}
// タブを「フォーカス中のペイン」に割り当てる
function setActive(id) {
  for (let i = 0; i < panes.length; i++) if (panes[i] === id) panes[i] = null;
  panes[focused] = id;
  activeId = id;
  renderLayout();
}
function focusPane(i) {
  focused = i;
  activeId = panes[i] || null;
  renderLayout();
  const t = tabs.get(activeId);
  if (t) setTimeout(() => { try { t.term.focus(); } catch (_) {} }, 10);
}
function renderLayout() {
  const area = $('#termarea'), pool = $('#termpool');
  for (const t of tabs.values()) pool.appendChild(t.wrap); // 一旦退避
  area.className = 'layout-' + LAYOUT;
  area.innerHTML = '';
  const n = paneCount();
  for (let i = 0; i < n; i++) {
    const pane = elx('div', 'pane'); if (i === focused) pane.classList.add('focused');
    const head = elx('div', 'pane-head');
    const tab = panes[i] ? tabs.get(panes[i]) : null;
    const title = elx('span', null, tab ? tab.session.name : '');
    if (!tab) { title.className = 'pane-empty'; title.textContent = '(空き — タブをクリックで表示)'; }
    head.appendChild(title);
    const body = elx('div', 'pane-body');
    const idx = i;
    head.onclick = () => focusPane(idx);
    body.addEventListener('mousedown', () => { if (focused !== idx) focusPane(idx); });
    pane.appendChild(head); pane.appendChild(body); area.appendChild(pane);
    if (tab) body.appendChild(tab.wrap);
  }
  for (const t of tabs.values()) updateTabEl(t);
  const at = tabs.get(activeId);
  $('#tabtools').classList.toggle('hidden', tabs.size === 0);
  if (at) {
    $('#encSel').value = at.session.encoding || 'utf8';
    $('#nlSel').value = at.session.newline || (at.session.protocol === 'telnet' ? 'crlf' : 'cr');
    $('#echoChk').checked = !!at.session.localEcho;
    setState(at.status);
    $('#btnLog').textContent = at.logging ? '⏹ ログ中' : '⏺ ログ';
    $('#btnBreak').classList.toggle('hidden', at.session.protocol !== 'serial');
    $('#btnSendFile').classList.toggle('hidden', !!at.isEmbed);
  } else setState('');
  if (window.WT) WT._activeTabChanged();
  setTimeout(() => { refitAll(); updateEmbeds(); }, 30);
}
function refitAll() {
  for (const id of panes) { const t = id && tabs.get(id); if (t && t.fit) { try { t.fit.fit(); } catch (_) {} } }
}
function refitActive() { refitAll(); updateEmbeds(); }
// 埋め込みRDP(mstsc子ウィンドウ)を、表示中のペインに合わせて配置/表示する
// 埋め込みタブ（RDP等）の位置追従。各プロトコルプラグインがタブに reposition() を持たせる。
function updateEmbeds() {
  for (const t of tabs.values()) { if (typeof t.reposition === 'function') { try { t.reposition(); } catch (_) {} } }
}
function setState(st) {
  const e = $('#connState'); e.className = 'state ' + (st || '');
  e.textContent = st === 'connected' ? '● 接続中' : st === 'connecting' ? '○ 接続処理中' : st === 'error' ? '× エラー' : st === 'closed' ? '× 切断' : '';
}
function closeTab(id) {
  const tab = tabs.get(id); if (!tab) return;
  if (tab.reconnectTimer) { try { clearTimeout(tab.reconnectTimer); } catch (_) {} tab.reconnecting = false; }
  if (tab.macro) { try { tab.macro.stop('タブを閉じました'); } catch (_) {} }
  if (tab.ttl && !tab.ttl.done) { try { tab.ttl.interp.stop(); if (tab.ttlIo) tab.ttlIo.cancel(); tab.ttl.done = true; } catch (_) {} }
  api.connClose(id);
  try { tab.term.dispose(); } catch (_) {}
  try { tab.wrap.remove(); } catch (_) {}
  if (tab.tabEl) tab.tabEl.remove();
  tabs.delete(id);
  for (let i = 0; i < panes.length; i++) if (panes[i] === id) panes[i] = null;
  if (!panes[focused]) { const cand = [...tabs.keys()].find((x) => !panes.includes(x)); if (cand) panes[focused] = cand; }
  activeId = panes[focused] || null;
  renderLayout();
  maybeCloseEmptyWindow();
}

/* ---------------- データ / ステータス受信 ---------------- */
function wireData() {
  api.onData(({ id, data }) => { const t = tabs.get(id); if (t) { if (window.WT) WT._observeData(data, t); t.term.write(window.WT ? WT._transformData(data, t) : data); } });
  api.onAdoptTab(adoptTab);
  // 新版あり → アプリ内ダイアログで確認。更新する→DLプログレスバー→完了で適用中表示→自動再起動。
  api.onUpdateAvailable((p) => { updateManual = false; showUpdatePrompt(p.version); });
  api.onUpdateNone((p) => { if (updateManual) toast('お使いのバージョン (v' + (p.version || '') + ') が最新です'); updateManual = false; });
  api.onUpdateProgress((p) => setUpdateProgress(p && p.percent));
  api.onUpdateDownloaded((p) => showUpdateApplying(p.version));
  api.onUpdateError(() => { if (updateManual) toast('更新の確認・取得に失敗しました（ネットワーク/配布先）', true); updateManual = false; if (updState !== 'applying') hideUpdateModal(); });
  api.onStatus(({ id, status, message }) => {
    const t = tabs.get(id); if (!t) return;
    t.status = status; updateTabEl(t);
    if (id === activeId) setState(status);
    if (t.term) {
      if (status === 'connected') t.term.writeln('\x1b[32m✔ 接続しました\x1b[0m');
      if (status === 'error' && message) t.term.writeln('\x1b[31m✖ ' + message + '\x1b[0m');
      if (status === 'closed') t.term.writeln('\x1b[90m── 接続が閉じられました ──\x1b[0m');
    }
    if (status === 'connected') { t.everConnected = true; t.reconnectAttempts = 0; }
    // 自動再接続：一度つながった接続が切れた/エラーになったら再接続（RDPは対象外）
    if ((status === 'closed' || status === 'error') && t.session && t.session.autoReconnect && t.everConnected && !t.isEmbed) {
      scheduleReconnect(t);
    }
  });
}
function scheduleReconnect(t) {
  if (t.reconnecting || !tabs.has(t.id)) return;
  t.reconnectAttempts = (t.reconnectAttempts || 0) + 1;
  if (t.reconnectAttempts > 20) { if (t.term) t.term.writeln('\x1b[31m[自動再接続] 上限(20回)に達しました。⟳ 再接続 で手動接続できます\x1b[0m'); return; }
  t.reconnecting = true;
  const delay = Math.min(15000, 2000 * t.reconnectAttempts);
  if (t.term) t.term.writeln('\x1b[33m[自動再接続] ' + (delay / 1000) + '秒後に再接続します… (試行 ' + t.reconnectAttempts + ')\x1b[0m');
  t.reconnectTimer = setTimeout(async () => {
    t.reconnecting = false;
    if (!tabs.has(t.id)) return; // 閉じられた
    try { const cfg = await buildCfg(t.session, t.term.cols, t.term.rows); await api.connOpen(t.id, cfg); } catch (_) {}
  }, delay);
}

/* ---------------- クイック接続 ---------------- */
async function quickConnect() {
  const raw = $('#quickInput').value.trim(); if (!raw) return;
  const proto = $('#quickProto').value;
  let user = '', host = raw, port = proto === 'telnet' ? 23 : proto === 'rdp' ? 3389 : 22;
  const at = raw.split('@'); if (at.length === 2) { user = at[0]; host = at[1]; }
  const cp = host.split(':'); if (cp.length === 2) { host = cp[0]; port = Number(cp[1]) || port; }
  const s = { id: uid(), name: (user ? user + '@' : '') + host, protocol: proto, host, port, username: user, authType: 'password', encoding: 'utf8', newline: proto === 'telnet' ? 'crlf' : 'cr' };
  if (proto === 'ssh') { const pw = await askText('パスワード（' + s.name + '）', { password: true }); if (pw === null) return; s.password = pw; }
  openSession(s);
}

/* ---------------- ツールバー（文字コード/改行/エコー/ログ/検索/再接続）---------------- */
function wireTabTools() {
  $('#encSel').onchange = (e) => { const t = tabs.get(activeId); if (t) { t.session.encoding = e.target.value; api.setEncoding(activeId, e.target.value); } };
  $('#nlSel').onchange = (e) => { const t = tabs.get(activeId); if (t) { t.session.newline = e.target.value; api.setNewline(activeId, e.target.value); } };
  $('#echoChk').onchange = (e) => { const t = tabs.get(activeId); if (t) { t.session.localEcho = e.target.checked; api.setLocalEcho(activeId, e.target.checked); } };
  $('#btnFind').onclick = toggleFind;
  $('#btnReconnect').onclick = () => { const t = tabs.get(activeId); if (!t) return; const s = t.session; closeTab(activeId); openSession(s); };
  $('#btnLog').onclick = async () => {
    const t = tabs.get(activeId); if (!t) return;
    if (t.logging) { await api.logStop(activeId); t.logging = false; $('#btnLog').textContent = '⏺ ログ'; if (t.term) t.term.writeln('\x1b[90m[ログ保存を停止しました]\x1b[0m'); }
    else { const r = await api.logStart(activeId, (t.session.name || 'terminal') + '.log', !!SETTINGS.logTimestamp); if (r && r.ok) { t.logging = true; $('#btnLog').textContent = '⏹ ログ中'; if (t.term) t.term.writeln('\x1b[90m[ログ保存開始' + (SETTINGS.logTimestamp ? '(時刻付き)' : '') + ': ' + r.path + ']\x1b[0m'); } }
  };
  $('#btnSendFile').onclick = async () => {
    const t = tabs.get(activeId); if (!t || t.isEmbed) return;
    const r = await api.sendFile(activeId);
    if (r && r.ok) toast(r.name + ' を送信中（' + r.lines + '行）');
    else if (r && r.error) toast('ファイル送信に失敗: ' + r.error, true);
  };
  $('#btnBreak').onclick = async () => {
    const t = tabs.get(activeId); if (!t || t.session.protocol !== 'serial') return;
    const r = await api.serialBreak(activeId);
    if (r && r.ok) toast('Break を送信しました'); else toast('Break送信に失敗: ' + ((r && r.error) || ''), true);
  };
}

/* 検索 */
function toggleFind() { const fb = $('#findbar'); fb.classList.toggle('hidden'); if (!fb.classList.contains('hidden')) $('#findInput').focus(); }
function doFind(dir) { const t = tabs.get(activeId); if (!t || !t.search) return; const q = $('#findInput').value; if (!q) return; if (dir < 0) t.search.findPrevious(q); else t.search.findNext(q); }

/* ---------------- スニペット ---------------- */
function renderSnippets() {
  const ul = $('#snipList'); ul.innerHTML = '';
  SNIPPETS.forEach((sn, i) => {
    const li = elx('li');
    const name = elx('span', null, '▶ ' + sn.name); name.style.cursor = 'pointer'; name.style.flex = '1';
    name.onclick = () => sendSnippet(sn);
    const ed = elx('button', null, '✎'); ed.style.padding = '0 6px'; ed.onclick = () => openSnip(i);
    const del = elx('button', null, '✕'); del.style.padding = '0 6px'; del.onclick = () => { SNIPPETS.splice(i, 1); persistSnippets(); renderSnippets(); };
    li.appendChild(name); const box = elx('span'); box.appendChild(ed); box.appendChild(del); li.appendChild(box);
    ul.appendChild(li);
  });
  if (!SNIPPETS.length) ul.appendChild(elx('li', 'meta', 'よく使うコマンドを登録できます'));
}
function sendSnippet(sn) { const t = tabs.get(activeId); if (!t) return; api.connInput(activeId, sn.cmd + (sn.enter ? '\r' : '')); t.term.focus(); }
function openSnip(i) { editingSnip = i; const sn = i >= 0 ? SNIPPETS[i] : { name: '', cmd: '', enter: true }; $('#snName').value = sn.name; $('#snCmd').value = sn.cmd; $('#snEnter').checked = sn.enter !== false; $('#snipModal').classList.remove('hidden'); $('#snName').focus(); }
function saveSnip() { const sn = { name: $('#snName').value.trim() || 'コマンド', cmd: $('#snCmd').value, enter: $('#snEnter').checked }; if (editingSnip >= 0) SNIPPETS[editingSnip] = sn; else SNIPPETS.push(sn); persistSnippets(); renderSnippets(); $('#snipModal').classList.add('hidden'); }

/* ---------------- 汎用：プロンプト / コンテキストメニュー ---------------- */
function askText(title, opts = {}) {
  return new Promise((resolve) => {
    const ov = elx('div', 'modal'); ov.style.zIndex = 200;
    const box = elx('div', 'modal-box small');
    box.innerHTML = `<div class="modal-head">${title}</div><div class="modal-body"><input id="_ask" type="${opts.password ? 'password' : 'text'}" style="width:100%" /></div><div class="modal-foot"><button id="_c">キャンセル</button><button id="_o" class="primary">OK</button></div>`;
    ov.appendChild(box); document.body.appendChild(ov);
    const inp = box.querySelector('#_ask'); inp.value = opts.value || ''; inp.focus(); inp.select();
    const close = (v) => { ov.remove(); resolve(v); };
    box.querySelector('#_o').onclick = () => close(inp.value);
    box.querySelector('#_c').onclick = () => close(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') close(inp.value); if (e.key === 'Escape') close(null); };
  });
}
function toast(msg, isErr) {
  const t = elx('div', 'toast' + (isErr ? ' err' : ''), msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}
function showMenu(x, y, items) {
  document.querySelectorAll('.ctxmenu').forEach((m) => m.remove());
  const m = elx('div', 'ctxmenu');
  Object.assign(m.style, { position: 'fixed', left: x + 'px', top: y + 'px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px', zIndex: 300, boxShadow: '0 6px 20px rgba(0,0,0,0.4)' });
  for (const it of items) {
    if (it.sep) { const d = elx('div'); Object.assign(d.style, { height: '1px', background: 'var(--border)', margin: '4px 8px' }); m.appendChild(d); continue; }
    const b = elx('div', null, it.label);
    Object.assign(b.style, { padding: '5px 14px', cursor: 'pointer', borderRadius: '4px', fontSize: '12px', whiteSpace: 'nowrap' });
    b.onmouseenter = () => b.style.background = 'var(--border)';
    b.onmouseleave = () => b.style.background = '';
    b.onclick = () => { m.remove(); it.fn(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

/* ---------------- UI 配線 ---------------- */
function wireUI() {
  $('#quickBtn').onclick = quickConnect;
  $('#quickInput').onkeydown = (e) => { if (e.key === 'Enter') quickConnect(); };
  $('#btnNew').onclick = () => openEditor(null);
  $('#btnEdit').onclick = () => { if (selectedSessionId) openEditor(selectedSessionId); };
  $('#btnDup').onclick = () => { if (selectedSessionId) dupSession(selectedSessionId); };
  $('#btnDel').onclick = () => { if (selectedSessionId) delSession(selectedSessionId); };
  $('#sessFilter').oninput = renderSessions;
  // セッション一覧の空きスペースへドロップ → フォルダ無し(ルート)へ移動
  const sessUl = $('#sessList');
  sessUl.addEventListener('dragover', (e) => { if (dragSessId) e.preventDefault(); });
  sessUl.addEventListener('drop', (e) => { if (!dragSessId) return; e.preventDefault(); const id = dragSessId; clearDropMarks(); moveSession(id, null, '', true); });
  $('#btnImport').onclick = importSessions;
  $('#btnImportSsh').onclick = importSshConfig;
  $('#btnVault').onclick = manageMaster;
  $('#btnShell').onclick = () => openLocalShell('powershell');
  $('#btnExport').onclick = exportSessions;
  $('#btnSidebar').onclick = toggleSidebar;
  $('#btnTheme').onclick = toggleTheme;
  // カスタムタイトルバーのウィンドウ操作
  $('#winMin').onclick = () => api.winMinimize();
  $('#winMax').onclick = () => api.winMaximize();
  $('#winClose').onclick = () => api.winClose();
  api.onWinState((s) => setMaxGlyph(s.maximized));
  api.winIsMaximized().then(setMaxGlyph).catch(() => {});

  $('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
  $('#modalSave').onclick = saveEditor;
  $('#fProto').onchange = onProtoChange;
  $('#fAuth').onchange = updateModalProto;
  $('#advToggle').onclick = () => setAdvOpen(!$('#modal').classList.contains('show-adv'));
  $('#fKeyBtn').onclick = async () => { const p = await api.pickKey(); if (p) $('#fKey').value = p; };
  $('#fSerialRefresh').onclick = () => populateSerialPorts();

  $('#btnSnipAdd').onclick = () => openSnip(-1);
  $('#snCancel').onclick = () => $('#snipModal').classList.add('hidden');
  $('#snSave').onclick = saveSnip;



  $('#updNow').onclick = startUpdateDownload;
  $('#updLater').onclick = hideUpdateModal;

  $('#bcastBtn').onclick = broadcast;
  $('#bcastInput').onkeydown = (e) => { if (e.key === 'Enter') broadcast(); };

  $('#findInput').onkeydown = (e) => { if (e.key === 'Enter') doFind(e.shiftKey ? -1 : 1); if (e.key === 'Escape') toggleFind(); };
  $('#findNext').onclick = () => doFind(1);
  $('#findPrev').onclick = () => doFind(-1);
  $('#findClose').onclick = toggleFind;

  document.querySelectorAll('.layoutsel .lay').forEach((b) => { b.onclick = () => setLayout(b.dataset.layout); });
  wireTabTools(); wireLayout();
  $('#pluginsClose').onclick = () => $('#pluginsModal').classList.add('hidden');
  $('#pluginRestartBtn').onclick = () => api.appRelaunch();
  window.addEventListener('resize', () => { refitAll(); updateEmbeds(); });
  window.addEventListener('move', updateEmbeds);
}
function broadcast() { const v = $('#bcastInput').value; if (!v) return; for (const id of tabs.keys()) api.connInput(id, v + '\r'); $('#bcastInput').value = ''; }
function toggleSidebar() { const sb = $('#sidebar'); const show = sb.classList.contains('collapsed'); sb.classList.toggle('collapsed', !show); SETTINGS.sidebar = show; saveSettings(); setTimeout(refitActive, 50); }
// 最大化ボタンのアイコンを状態に合わせて切替（最大化⇄元に戻す）
function setMaxGlyph(max) {
  const b = $('#winMax'); if (!b) return;
  b.title = max ? '元に戻す' : '最大化';
  b.innerHTML = max
    ? '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.6" y="2.4" width="6.4" height="6.4" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.9"/><path d="M3 2.4 V1.1 H9 V7.1 H7.2" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>'
    : '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.6" y="0.6" width="8.8" height="8.8" rx="1" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';
}

/* ---------------- レイアウト（サイドバー/パネルのリサイズ・ドック） ---------------- */
function wireLayout() {
  // サイドバー幅のドラッグ
  $('#sideResizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const sb = $('#sidebar'); const startX = e.clientX, startW = sb.offsetWidth;
    const move = (ev) => { sb.style.width = Math.max(150, Math.min(640, startW + (ev.clientX - startX))) + 'px'; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); SETTINGS.sidebarWidth = sb.offsetWidth; saveSettings(); refitActive(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  // セッション一覧の高さ
  const sr = $('#sessResizer');
  if (sr) sr.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const ul = $('#sessList'); const startY = e.clientY, startH = ul.offsetHeight;
    const move = (ev) => { ul.style.height = Math.max(80, Math.min(maxSessListHeight(), startH + (ev.clientY - startY))) + 'px'; };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); SETTINGS.sessListHeight = ul.offsetHeight; saveSettings(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  // パネルのグリップ（下＝高さ／横＝幅）※プラグインのドックパネルも含め汎用に配線
  document.querySelectorAll('.dock-grip').forEach((grip) => grip.addEventListener('pointerdown', (e) => startGripDrag(e, grip.dataset.dock)));
  // ドック位置切替（下↔横）※ .dockbtn[data-dock] を汎用配線
  document.querySelectorAll('.dockbtn[data-dock]').forEach((b) => { b.onclick = () => toggleDockPos(b.dataset.dock); });
}
function startGripDrag(e, which) {
  e.preventDefault();
  const item = $('#' + which + 'Dock');
  const side = item.classList.contains('dock-side');
  const startX = e.clientX, startY = e.clientY, startW = item.offsetWidth, startH = item.offsetHeight;
  const move = (ev) => {
    if (side) item.style.width = Math.max(160, Math.min(window.innerWidth - 280, startW - (ev.clientX - startX))) + 'px';
    else item.style.height = Math.max(90, Math.min(window.innerHeight - 180, startH - (ev.clientY - startY))) + 'px';
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    SETTINGS[which + (side ? 'W' : 'H')] = side ? item.offsetWidth : item.offsetHeight; saveSettings(); refitActive();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}
function setDockPos(which, pos) {
  const item = $('#' + which + 'Dock'); if (!item) return;
  const btn = $('#' + which + 'DockBtn');
  if (pos === 'side') {
    item.classList.remove('dock-bottom'); item.classList.add('dock-side');
    item.style.height = ''; item.style.width = (SETTINGS[which + 'W'] || 440) + 'px';
    $('#sideDock').appendChild(item);
    if (btn) btn.textContent = '⤓ 下に表示';
  } else {
    item.classList.remove('dock-side'); item.classList.add('dock-bottom');
    item.style.width = ''; item.style.height = (SETTINGS[which + 'H'] || 300) + 'px';
    $('#bottomDock').appendChild(item);
    if (btn) btn.textContent = '⇥ 横に表示';
  }
  setTimeout(refitActive, 30);
}
function toggleDockPos(which) {
  const item = $('#' + which + 'Dock');
  const pos = item.classList.contains('dock-side') ? 'bottom' : 'side';
  setDockPos(which, pos); SETTINGS[which + 'DockPos'] = pos; saveSettings();
}
function applyLayoutSettings() {
  if (SETTINGS.sidebarWidth) $('#sidebar').style.width = SETTINGS.sidebarWidth + 'px';
  if (SETTINGS.sessListHeight) $('#sessList').style.height = Math.min(SETTINGS.sessListHeight, maxSessListHeight()) + 'px';
  // プラグインが注入したドックパネル（#<which>Dock）を設定に従って配置
  document.querySelectorAll('.dock-item[id$="Dock"]').forEach((item) => {
    const which = item.id.replace(/Dock$/, '');
    setDockPos(which, SETTINGS[which + 'DockPos'] === 'side' ? 'side' : 'bottom');
  });
}
function fontInc() { SETTINGS.fontSize = Math.min(28, SETTINGS.fontSize + 1); for (const t of tabs.values()) t.term.options.fontSize = SETTINGS.fontSize; saveSettings(); refitActive(); }
function fontDec() { SETTINGS.fontSize = Math.max(8, SETTINGS.fontSize - 1); for (const t of tabs.values()) t.term.options.fontSize = SETTINGS.fontSize; saveSettings(); refitActive(); }

async function exportSessions() { const r = await api.exportSessions(DB); if (r && r.ok) alert('エクスポートしました:\n' + r.path); }
async function importSessions() {
  const r = await api.importSessions();
  if (r && r.ok && r.data) {
    const incoming = r.data.sessions || [];
    for (const s of incoming) { if (!s.id) s.id = uid(); DB.sessions.push(s); }
    if (r.data.folders) DB.folders = Array.from(new Set([...(DB.folders || []), ...r.data.folders]));
    persistSessions(); renderSessions(); alert(incoming.length + ' 件のセッションをインポートしました');
  }
}

async function importSshConfig() {
  const r = await api.importSshConfig();
  if (!r || !r.ok) { if (r && r.error) alert('ssh_config を読めません: ' + r.error); return; }
  const list = r.sessions || [];
  if (!list.length) { alert('取り込める Host エントリがありませんでした。'); return; }
  // 既存(名前+ホスト)と重複するものは除外
  const seen = new Set(DB.sessions.map((s) => (s.name || '') + ' ' + (s.host || '')));
  let added = 0;
  for (const s of list) {
    const key = (s.name || '') + ' ' + (s.host || '');
    if (seen.has(key)) continue;
    seen.add(key);
    s.id = uid();
    DB.sessions.push(s);
    added++;
  }
  persistSessions(); renderSessions();
  alert(added + ' 件を取り込みました（重複 ' + (list.length - added) + ' 件はスキップ）。\n※鍵認証は IdentityFile を引き継ぎましたが、パスフレーズ/踏み台は編集で設定してください。');
}

// ローカルシェル（PowerShell/cmd/WSL）をタブで開く。パイプ方式（簡易シェル・完全なPTYではない）。
function openLocalShell(kind) {
  const names = { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'コマンドプロンプト', wsl: 'WSL' };
  const k = kind || 'powershell';
  openSession({ name: '＞ ' + (names[k] || k), protocol: 'shell', shellKind: k, encoding: 'utf8', newline: 'crlf', localEcho: true });
}

/* ---------------- マスターパスワード保管庫 ---------------- */
// 保存済み秘密(passwordStored/phraseStored)を一括で再暗号化する。
async function reencryptSecrets(toDefault) {
  const refs = [], strs = [];
  for (const s of DB.sessions) {
    for (const f of ['passwordStored', 'phraseStored']) {
      if (s[f]) { refs.push([s, f]); strs.push(s[f]); }
    }
  }
  if (!strs.length) return;
  const out = await api.vaultReencrypt(strs, toDefault);
  refs.forEach(([s, f], i) => { s[f] = out[i]; });
  persistSessions();
}
// 起動時などに解錠を促す。最大5回。キャンセルすると保存パスワードは使えない旨を通知。
async function promptUnlock() {
  for (let i = 0; i < 5; i++) {
    const p = await askText('マスターパスワードを入力', { password: true });
    if (p === null) { toast('ロック中：保存済みパスワードは使用できません（解錠するまで）', true); return false; }
    const r = await api.vaultUnlock(p);
    if (r && r.ok) { toast('🔓 解錠しました'); return true; }
    alert((r && r.error) || '解錠に失敗しました');
  }
  return false;
}
// 🔒 ボタン: 設定/解除/解錠のハブ。
async function manageMaster() {
  const vs = await api.vaultStatus();
  if (!vs || !vs.enabled) {
    const p1 = await askText('マスターパスワードを新規設定', { password: true });
    if (!p1) return;
    const p2 = await askText('確認のためもう一度入力', { password: true });
    if (p2 !== p1) { alert('パスワードが一致しません。'); return; }
    const r = await api.vaultEnable(p1);
    if (!r || !r.ok) { alert((r && r.error) || '設定に失敗しました'); return; }
    await reencryptSecrets(false); // マスター鍵で mpw へ再暗号化
    alert('🔒 マスターパスワードを設定しました。\n次回起動時に入力が必要になります。忘れると保存済みパスワードは復元できません。');
    return;
  }
  if (!vs.unlocked) { if (!(await promptUnlock())) return; }
  const disable = confirm('マスターパスワードを解除しますか？\nOK＝解除（OSキーチェーン方式に戻す） / キャンセル＝そのまま');
  if (disable) {
    await reencryptSecrets(true); // 解錠中に mpw → 既定方式へ戻す
    const r = await api.vaultDisable();
    alert(r && r.ok ? 'マスターパスワードを解除しました。' : ((r && r.error) || '解除に失敗しました'));
  }
}

/* ---------------- メニュー連携 ---------------- */
function runMenuAction(action) {
  switch (action) {
    case 'new-session': openEditor(null); break;
    case 'quick-connect': $('#quickInput').focus(); break;
    case 'new-tab': if (selectedSessionId) { const s = DB.sessions.find((x) => x.id === selectedSessionId); if (s) openSession(s); } break;
    case 'close-tab': if (activeId) closeTab(activeId); break;
    case 'font-inc': fontInc(); break;
    case 'font-dec': fontDec(); break;
    case 'find': toggleFind(); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'toggle-log-ts': SETTINGS.logTimestamp = !SETTINGS.logTimestamp; saveSettings(); toast('ログのタイムスタンプ: ' + (SETTINGS.logTimestamp ? 'ON（次回ログ開始から）' : 'OFF')); break;
    case 'broadcast': $('#bcastInput').focus(); break;
    case 'export': exportSessions(); break;
    case 'import': importSessions(); break;
    case 'log-start': $('#btnLog').click(); break;
    case 'log-stop': { const t = tabs.get(activeId); if (t && t.logging) $('#btnLog').click(); break; }
    case 'copy': { const t = tabs.get(activeId); if (t && t.term) { const sel = t.term.getSelection(); if (sel) api.clipboardWrite(sel); } break; }
    case 'paste': { const t = tabs.get(activeId); if (t) api.clipboardRead().then((txt) => { if (txt) { if (t.term) t.term.paste(txt); else api.connInput(activeId, txt); } }); break; }
    case 'select-all': { const t = tabs.get(activeId); if (t && t.term) t.term.selectAll(); break; }
    case 'reload': location.reload(); break;
    case 'devtools': api.winDevtools(); break;
    case 'quit': api.appQuit(); break;
    case 'about': api.appAbout(); break;
    case 'check-update': checkUpdate(); break;
    case 'toggle-perf': togglePerfMode(); break;
    case 'plugins': openPluginManager(); break;
    default: if (window.WT) WT._runMenuAction(action); break;
  }
}
// プラグイン管理（有効/無効トグル）
async function openPluginManager() {
  const box = $('#pluginList'); if (!box) return;
  const wasOpen = !$('#pluginsModal').classList.contains('hidden');
  const openBtn = $('#pluginOpenDirBtn');
  if (openBtn && api.plugins.openDir) openBtn.onclick = () => api.plugins.openDir();
  let list = [];
  try { list = (await api.plugins.list()) || []; } catch (_) { list = []; }
  // フラグメントに組んでから一括差し替え（監視リフレッシュとの並行呼び出しで倍化しない）
  const frag = document.createDocumentFragment();
  if (!list.length) { frag.appendChild(elx('li', 'muted', 'プラグインがありません。')); }
  for (const p of list) {
    const li = elx('li', 'plugin-row');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!p.enabled; cb.disabled = !!p.core;
    cb.onchange = async () => {
      await api.plugins.setEnabled(p.id, cb.checked);
      // レンダラ側 SETTINGS も同期（別処理の saveSettings で巻き戻らないように）
      if (!Array.isArray(SETTINGS.disabledPlugins)) SETTINGS.disabledPlugins = [];
      const i = SETTINGS.disabledPlugins.indexOf(p.id);
      if (cb.checked) { if (i >= 0) SETTINGS.disabledPlugins.splice(i, 1); }
      else if (i < 0) SETTINGS.disabledPlugins.push(p.id);
      $('#pluginReload').classList.remove('hidden');
    };
    const info = elx('div', 'plugin-info');
    const nameRow = elx('div', 'plugin-name', p.name + (p.core ? '（コア）' : ''));
    // 組込かユーザー追加かのバッジ（コアは組込のため省略）
    if (!p.core) {
      const badge = elx('span', 'plugin-badge ' + (p.builtin ? 'builtin' : 'user'), p.builtin ? '組込' : 'ユーザー');
      nameRow.appendChild(document.createTextNode(' ')); nameRow.appendChild(badge);
    }
    // 単一ファイル(.wtp/.zip)由来なら圧縮バッジ
    if (p.archived) {
      const zb = elx('span', 'plugin-badge zip', '📦 ファイル');
      nameRow.appendChild(document.createTextNode(' ')); nameRow.appendChild(zb);
    }
    info.appendChild(nameRow);
    if (p.description) info.appendChild(elx('div', 'plugin-desc muted', p.description));
    // チェックボックスをトグルスイッチの見た目で包む（機能はそのまま）
    const sw = elx('label', 'switch');
    if (p.core) sw.classList.add('disabled');
    sw.title = p.core ? 'コアプラグインは無効化できません' : (p.enabled ? '有効（クリックで無効化）' : '無効（クリックで有効化）');
    sw.appendChild(cb); sw.appendChild(elx('span', 'slider'));
    li.appendChild(sw); li.appendChild(info);
    frag.appendChild(li);
  }
  box.replaceChildren(frag);
  if (!wasOpen) $('#pluginReload').classList.add('hidden'); // 新規に開いた時のみ再起動プロンプトを初期化
  $('#pluginsModal').classList.remove('hidden');
}
// 高速描画モードの切替（settings.jsonに保存。HWアクセラ設定は起動時固定のため再起動で反映）
function togglePerfMode() {
  const next = !(SETTINGS.perfMode !== false);
  SETTINGS.perfMode = next; saveSettings();
  const msg = next
    ? '高速描画モードを ON にしました（GPU/WebGL）。RDPは外部mstscで開きます。\n再起動後に有効になります。'
    : '高速描画モードを OFF にしました（RDPウィンドウ内埋め込み・描画はソフトウェア）。\n再起動後に有効になります。';
  toast(next ? '高速描画モード: ON（要再起動）' : '高速描画モード: OFF（要再起動）');
  setTimeout(() => alert(msg), 50);
}
// ヘルプ→更新を確認。新版あり→確認(イベントup-available)→OKで自動更新。なし/dev/エラーはトーストで通知。
async function checkUpdate() {
  updateManual = true;
  toast('更新を確認しています…');
  const r = await api.updateCheck();
  // available / none / error の結果は update:* イベント側で処理（確認ダイアログ等）。
  // dev・即時エラーだけここで通知。
  if (!r) { updateManual = false; return; }
  if (r.dev) { updateManual = false; toast('開発版のため自動更新は使えません。インストール版（WaTerm-Setup）でご利用ください', true); return; }
  if (!r.ok) { updateManual = false; toast('更新を確認できませんでした（ネットワーク/配布先）', true); return; }
  // r.ok のときは update:available または update:none が発火して処理される
}
/* ---------------- アップデートUI（プログレスバー付き） ---------------- */
function hideUpdateModal() { const m = $('#updateModal'); if (m) m.classList.add('hidden'); updState = 'idle'; }
function showUpdatePrompt(version) {
  updState = 'prompt';
  $('#updMsg').innerHTML = '新しいバージョン <b>v' + (version || '') + '</b> が公開されています。<br>最新版に更新しますか？';
  $('#updBarWrap').classList.add('hidden'); $('#updPct').textContent = '';
  $('#updBar').style.width = '0%';
  $('#updNow').classList.remove('hidden'); $('#updNow').disabled = false;
  $('#updLater').classList.remove('hidden');
  $('#updateModal').classList.remove('hidden');
}
function startUpdateDownload() {
  updState = 'downloading';
  $('#updMsg').innerHTML = 'ダウンロードしています…';
  $('#updBarWrap').classList.remove('hidden'); $('#updBar').style.width = '0%';
  $('#updPct').textContent = '0%';
  $('#updNow').disabled = true; $('#updLater').classList.add('hidden');
  api.updateDownload();
}
function setUpdateProgress(pct) {
  if (updState !== 'downloading') return;
  const n = Math.max(0, Math.min(100, Math.round(pct || 0)));
  $('#updBar').style.width = n + '%';
  $('#updPct').textContent = 'ダウンロード中… ' + n + '%';
}
function showUpdateApplying(version) {
  updState = 'applying';
  $('#updateModal').classList.remove('hidden');
  $('#updMsg').innerHTML = '<b>v' + (version || '') + '</b> を適用しています。<br>まもなく自動で再起動します…';
  $('#updBarWrap').classList.remove('hidden'); $('#updBar').style.width = '100%';
  $('#updBar').classList.add('indet'); $('#updPct').textContent = '';
  $('#updNow').classList.add('hidden'); $('#updLater').classList.add('hidden');
}
function wireMenu() { api.onMenu(runMenuAction); }
// タイトルバー内のカスタムメニューバー
const MENUS = [
  { label: 'ファイル', items: [
    { label: '新規セッション', a: 'new-session' },
    { label: 'クイック接続', a: 'quick-connect' },
    { sep: true },
    { label: 'セッションをエクスポート…', a: 'export' },
    { label: 'セッションをインポート…', a: 'import' },
    { sep: true },
    { label: '終了', a: 'quit' },
  ] },
  { label: '編集', items: [
    { label: 'コピー', a: 'copy' },
    { label: '貼り付け', a: 'paste' },
    { label: 'すべて選択', a: 'select-all' },
  ] },
  { label: 'ターミナル', items: [
    { label: '新しいタブ', a: 'new-tab' },
    { label: 'タブを閉じる', a: 'close-tab' },
    { sep: true },
    { label: '文字を大きく', a: 'font-inc' },
    { label: '文字を小さく', a: 'font-dec' },
    { label: '検索', a: 'find' },
    { sep: true },
    { label: 'ターミナルログを保存…', a: 'log-start' },
    { label: 'ログ保存を停止', a: 'log-stop' },
    { sep: true },
    { label: '全タブへ送信(MultiExec)', a: 'broadcast' },
  ] },
  { label: '表示', items: [
    { label: 'テーマ切替(ダーク/ライト)', a: 'toggle-theme' },
    { label: 'サイドバー表示切替', a: 'toggle-sidebar' },
    { label: '高速描画モード 切替（GPU/WebGL・要再起動）', a: 'toggle-perf' },
    { label: 'ログにタイムスタンプを付ける(切替)', a: 'toggle-log-ts' },
    { sep: true },
    { label: '開発者ツール', a: 'devtools' },
    { label: '再読み込み', a: 'reload' },
  ] },
  { label: 'プラグイン', items: [
    { label: 'プラグイン管理…', a: 'plugins' },
  ] },
  { label: 'ヘルプ', items: [
    { label: '更新を確認', a: 'check-update' },
    { sep: true },
    { label: 'バージョン情報', a: 'about' },
  ] },
];
let menuBarOpen = false;
function renderMenuBar() {
  const bar = $('#menubar'); if (!bar) return;
  bar.innerHTML = '';
  MENUS.forEach((mn) => {
    const b = elx('button', 'menubtn', mn.label);
    const open = () => { const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom, mn.items.map((it) => it.sep ? { sep: true } : { label: it.label, fn: () => runMenuAction(it.a) })); menuBarOpen = true; };
    b.onclick = (e) => { e.stopPropagation(); open(); };
    b.onmouseenter = () => { if (menuBarOpen) open(); }; // 開いている間はホバーで切替
    bar.appendChild(b);
  });
  document.addEventListener('click', () => { menuBarOpen = false; });
}
