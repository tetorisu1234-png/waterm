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
// 分離ウィンドウでタブが全て無くなったら自動で閉じる
function maybeCloseEmptyWindow() { if (isDetachedWindow && tabs.size === 0) { try { api.closeSelf(); } catch (_) {} } }

const THEME_DARK = { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' };
const THEME_LIGHT = { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selectionBackground: '#bcc0cc', black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be', brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc' };
const xtermTheme = () => (SETTINGS.theme === 'light' ? THEME_LIGHT : THEME_DARK);

init();
async function init() {
  DB = (await api.loadSessions()) || { folders: [], sessions: [] };
  if (!DB.sessions) DB.sessions = [];
  SETTINGS = Object.assign({ theme: 'dark', fontSize: 14, sidebar: true, sftp: false }, (await api.loadSettings()) || {});
  SNIPPETS = (await api.loadSnippets()) || [];
  applyTheme();
  $('#sidebar').classList.toggle('collapsed', !SETTINGS.sidebar);
  HL_RULES = parseHighlightRules(SETTINGS.highlightText);
  renderSessions(); renderSnippets();
  wireUI(); wireMenu(); wireData();
  renderMenuBar();
  applyLayoutSettings();
  api.windowReady(); // 分離ウィンドウの場合は引き継ぎタブを受け取る
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
        ...(s.host ? [{ label: '診断 (ping/tracert)', fn: () => openDiag(s.host) }] : []),
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
  $('#fDomain').value = s.domain || '';
  $('#fScreen').value = s.fullscreen === false ? 'window' : 'full';
  $('#fWidth').value = s.width || 1280;
  $('#fHeight').value = s.height || 800;
  $('#fClipboard').checked = s.clipboard !== false;
  $('#fDrives').checked = !!s.drives;
  $('#fMultimon').checked = !!s.multimon;
  $('#fAdmin').checked = !!s.adminSession;
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
  s.domain = $('#fDomain').value.trim();
  s.fullscreen = $('#fScreen').value !== 'window';
  s.width = Number($('#fWidth').value) || 1280; s.height = Number($('#fHeight').value) || 800;
  s.clipboard = $('#fClipboard').checked; s.drives = $('#fDrives').checked;
  s.multimon = $('#fMultimon').checked; s.adminSession = $('#fAdmin').checked;
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
function buildTermTab(id, session, status) {
  const wrap = elx('div', 'term-wrap'); $('#termpool').appendChild(wrap);
  const term = new Terminal({ fontSize: SETTINGS.fontSize, fontFamily: 'Consolas, "Cascadia Mono", "MS Gothic", monospace', cursorBlink: true, scrollback: 8000, theme: xtermTheme(), allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  const search = new SearchAddon.SearchAddon(); term.loadAddon(search);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => api.openExternal(uri))); } catch (_) {}
  term.open(wrap);
  // 右クリックで貼り付け、範囲選択で自動コピー(PuTTY/MobaXterm方式)
  wrap.addEventListener('contextmenu', async (e) => { e.preventDefault(); const txt = await api.clipboardRead(); if (txt) term.paste(txt); }, true);
  term.onSelectionChange(() => { const sel = term.getSelection(); if (sel) api.clipboardWrite(sel); });
  const tab = { id, term, fit, search, session, wrap, tabEl: null, status: status || 'connecting', sftpCwd: null, logging: false };
  tabs.set(id, tab);
  addTabEl(tab);
  setActive(id);
  setTimeout(() => { try { fit.fit(); } catch (_) {} }, 30);
  term.onData((d) => {
    // 同時入力グループ：このタブが同期ONなら、グループ内の全タブへ同じ入力を送る
    const self = tabs.get(id);
    if (self && self.syncOn) { for (const o of tabs.values()) { if (o.syncOn && !o.isRdp) api.connInput(o.id, d); } }
    else api.connInput(id, d);
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
  // 通信モニタの記録状態を引き継ぐ（移動先のボタン表示を合わせる）
  api.monitorState(tab.id).then((s) => { if (s && s.ok) { tab.monOn = s.on; if (activeId === tab.id && monVisible() && monMode === 'sess') updateMonToggle(); } }).catch(() => {});
}
async function openSession(s) {
  // RDP は mstsc を起動してウィンドウ内に埋め込む
  if (s.protocol === 'rdp') {
    const id = uid();
    const wrap = elx('div', 'term-wrap rdp-wrap');
    wrap.innerHTML = '<div class="rdp-msg">🖥 リモートデスクトップに接続中…</div>';
    $('#termpool').appendChild(wrap);
    const tab = { id, term: null, fit: null, search: null, session: s, wrap, tabEl: null, status: 'connecting', sftpCwd: null, logging: false, isRdp: true };
    tabs.set(id, tab);
    addTabEl(tab);
    setActive(id);
    await new Promise((r) => setTimeout(r, 90)); // レイアウト確定を待つ
    const cfg = await buildCfg(s, 0, 0);
    const pr = tab.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (pr.width > 4 && pr.height > 4) { cfg.paneWidth = Math.round(pr.width * dpr); cfg.paneHeight = Math.round(pr.height * dpr); }
    const res = await api.rdpEmbed(id, cfg);
    if (res && res.ok && res.embedded) {
      tab.status = 'connected'; updateTabEl(tab);
      [200, 700, 1500, 3000].forEach((d) => setTimeout(updateEmbeds, d));
    } else {
      closeTab(id);
      if (res && res.ok) toast('「' + s.name + '」を外部のリモートデスクトップで開きました');
      else toast('RDP起動に失敗: ' + ((res && res.error) || '不明なエラー'), true);
    }
    return;
  }
  const id = uid();
  const tab = buildTermTab(id, s, 'connecting');
  const term = tab.term, fit = tab.fit;
  const target = s.protocol === 'serial' ? ((s.serialPort || 'COM?') + ' @ ' + (s.baud || 9600) + 'bps') : (s.host + ':' + s.port);
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
  const lbl = elx('span', null, tab.session.name);
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
  const layoutReorder = (dx) => {
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
      if (tearing) { tearing = false; el.classList.remove('tearing'); hideTabGhost(); }
      layoutReorder(ev.clientX - startX);
    } else {
      if (!tearing) { tearing = true; el.classList.add('tearing'); }
      clearShifts(); el.style.transform = '';
      showTabGhost(ev.clientX, ev.clientY, name);
    }
  };
  const finish = () => { clearShifts(); el.classList.remove('dragging', 'tearing'); document.body.classList.remove('tab-dragging'); hideTabGhost(); };
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
  tabGhostEl.style.left = (x + 12) + 'px'; tabGhostEl.style.top = (y + 14) + 'px';
  tabGhostEl.style.display = 'flex';
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
  if (tab.isRdp) { toast('RDPタブはウィンドウ移動に未対応です', true); return; }
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
    $('#btnSendFile').classList.toggle('hidden', !!at.isRdp);
    updateMacroBtn();
    updateXferBtn();
    updateSyncBtn();
  } else setState('');
  setTimeout(() => { refitAll(); updateEmbeds(); }, 30);
  if (sftpVisible()) sftpRefresh();
  if (monVisible() && monMode === 'sess') refreshMonitor();
}
function refitAll() {
  for (const id of panes) { const t = id && tabs.get(id); if (t && t.fit) { try { t.fit.fit(); } catch (_) {} } }
}
function refitActive() { refitAll(); updateEmbeds(); }
// 埋め込みRDP(mstsc子ウィンドウ)を、表示中のペインに合わせて配置/表示する
function updateEmbeds() {
  for (const t of tabs.values()) {
    if (!t.isRdp) continue;
    const inPane = !!(t.wrap && t.wrap.closest('#termarea'));
    const r = t.wrap ? t.wrap.getBoundingClientRect() : null;
    if (inPane && r && r.width > 4 && r.height > 4) {
      api.rdpPosition(t.id, { left: r.left, top: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1, innerH: window.innerHeight });
      api.rdpShow(t.id, true);
    } else {
      api.rdpShow(t.id, false);
    }
  }
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
  api.onData(({ id, data }) => { const t = tabs.get(id); if (t) { if (t.macro) t.macro.feed(data); if (t.ttlIo) t.ttlIo.feed(data); t.term.write(applyHighlights(data, t)); } });
  api.onTransferDone(({ id }) => { const t = tabs.get(id); if (t) { t.xferActive = false; if (id === activeId) updateXferBtn(); } });
  api.onAdoptTab(adoptTab);
  api.onSftpEditEvent((p) => {
    if (p && p.ok) { toast('⤴ 保存を検知：' + p.name + ' をアップロードしました'); if (sftpVisible()) $('#sftpStatus').textContent = '⤴ ' + p.name + ' を反映しました (' + new Date().toLocaleTimeString('ja-JP') + ')'; if (sftpVisible()) sftpRefresh(); }
    else if (p) toast('アップロード失敗（' + p.name + '）: ' + (p.error || ''), true);
  });
  api.onDiagData((p) => diagAppend(p.text));
  api.onDiagEnd((p) => { diagRunning = false; updateDiagButtons(); diagAppend('— 終了' + (p && p.code != null ? '（code ' + p.code + '）' : '') + (p && p.error ? ' ' + p.error : '') + ' —\n'); });
  api.onMonitorData(onMonitorData);
  api.onCapturePacket(onCapturePacket);
  api.onCaptureEnd(onCaptureEnd);
  api.onUpdateAvailable((p) => toast('新しいバージョン ' + (p.version || '') + ' をダウンロード中…'));
  api.onUpdateDownloaded((p) => { if (confirm('新しいバージョン ' + (p.version || '') + ' を準備しました。今すぐ再起動して更新しますか？')) api.updateInstall(); });
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
    if ((status === 'closed' || status === 'error') && t.session && t.session.autoReconnect && t.everConnected && !t.isRdp) {
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
  $('#btnDiag').onclick = () => { const t = tabs.get(activeId); openDiag(t && t.session ? (t.session.host || '') : ''); };
  $('#btnSync').onclick = (e) => { if (e.shiftKey) { syncAll(syncCount() === 0); } else toggleSync(); };
  $('#btnReconnect').onclick = () => { const t = tabs.get(activeId); if (!t) return; const s = t.session; closeTab(activeId); openSession(s); };
  $('#btnLog').onclick = async () => {
    const t = tabs.get(activeId); if (!t) return;
    if (t.logging) { await api.logStop(activeId); t.logging = false; $('#btnLog').textContent = '⏺ ログ'; if (t.term) t.term.writeln('\x1b[90m[ログ保存を停止しました]\x1b[0m'); }
    else { const r = await api.logStart(activeId, (t.session.name || 'terminal') + '.log', !!SETTINGS.logTimestamp); if (r && r.ok) { t.logging = true; $('#btnLog').textContent = '⏹ ログ中'; if (t.term) t.term.writeln('\x1b[90m[ログ保存開始' + (SETTINGS.logTimestamp ? '(時刻付き)' : '') + ': ' + r.path + ']\x1b[0m'); } }
  };
  $('#btnSendFile').onclick = async () => {
    const t = tabs.get(activeId); if (!t || t.isRdp) return;
    const r = await api.sendFile(activeId);
    if (r && r.ok) toast(r.name + ' を送信中（' + r.lines + '行）');
    else if (r && r.error) toast('ファイル送信に失敗: ' + r.error, true);
  };
  $('#btnBreak').onclick = async () => {
    const t = tabs.get(activeId); if (!t || t.session.protocol !== 'serial') return;
    const r = await api.serialBreak(activeId);
    if (r && r.ok) toast('Break を送信しました'); else toast('Break送信に失敗: ' + ((r && r.error) || ''), true);
  };
  $('#btnMacro').onclick = () => { const t = tabs.get(activeId); if (!t || t.isRdp) return; openMacro(); };
  $('#btnTransfer').onclick = () => {
    const t = tabs.get(activeId); if (!t || t.isRdp) return;
    if (t.xferActive) { api.transferAbort(activeId); return; }
    openTransfer();
  };
}

/* ---------------- 簡易マクロ (expect/send) ---------------- */
// 文字列リテラルのエスケープ展開: \n \r \t \\ \" \xHH
function macroUnescape(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (m, c) => {
    if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t';
    if (c === '0') return '\0'; if (c === '\\') return '\\'; if (c === '"') return '"';
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return c;
  });
}
// 1行を {cmd, arg} に解釈。引数は "..." または素のトークン
function macroParseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith(';')) return null;
  const sp = t.indexOf(' ');
  const cmd = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
  let rest = sp < 0 ? '' : t.slice(sp + 1).trim();
  let arg = rest;
  const q = rest.match(/^"((?:[^"\\]|\\.)*)"/);
  if (q) arg = macroUnescape(q[1]);
  return { cmd, arg, raw: rest };
}
class MacroRunner {
  constructor(tab, script) {
    this.tab = tab; this.id = tab.id;
    this.lines = script.split('\n');
    this.ip = 0; this.buf = ''; this.waiting = null; this.timer = null; this.stopped = false;
    this.defaultTimeout = 10000;
  }
  log(msg, color) { if (this.tab.term) this.tab.term.writeln('\x1b[' + (color || '35') + 'm[マクロ] ' + msg + '\x1b[0m'); }
  feed(data) {
    if (this.stopped || !this.waiting) return;
    this.buf += data;
    if (this.buf.length > 65536) this.buf = this.buf.slice(-65536);
    if (this.buf.indexOf(this.waiting.text) >= 0) {
      const w = this.waiting; this.waiting = null;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.buf = '';
      w.resolve(true);
    }
  }
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(false); }
    this.log('終了' + (reason ? '：' + reason : ''), '90');
    if (this.tab.macro === this) this.tab.macro = null;
    updateMacroBtn();
  }
  waitFor(text, timeoutMs) {
    return new Promise((resolve) => {
      this.waiting = { text, resolve };
      if (this.buf.indexOf(text) >= 0) { this.feed(''); return; }
      this.timer = setTimeout(() => {
        if (this.waiting) { this.waiting = null; this.log('待機タイムアウト: "' + text + '"', '31'); resolve(false); }
      }, timeoutMs || this.defaultTimeout);
    });
  }
  async run() {
    this.log('開始（' + this.lines.filter((l) => macroParseLine(l)).length + 'ステップ）');
    let curTimeout = this.defaultTimeout;
    while (this.ip < this.lines.length && !this.stopped) {
      const p = macroParseLine(this.lines[this.ip]); this.ip++;
      if (!p) continue;
      switch (p.cmd) {
        case 'wait': case 'expect': {
          if (!p.arg) break;
          const ok = await this.waitFor(p.arg, curTimeout);
          if (this.stopped) return;
          if (!ok) return this.stop('待機失敗で中断');
          break;
        }
        case 'send': api.connInput(this.id, p.arg); break;
        case 'sendln': api.connInput(this.id, p.arg + '\r'); break;
        case 'pause': case 'sleep': {
          const sec = parseFloat(p.raw) || 1;
          await new Promise((r) => { this.timer = setTimeout(r, sec * 1000); });
          if (this.stopped) return; break;
        }
        case 'timeout': curTimeout = (parseFloat(p.raw) || 10) * 1000; break;
        case 'print': case 'echo': this.log(p.arg || p.raw, '36'); break;
        default: this.log('不明なコマンド: ' + p.cmd, '33'); break;
      }
    }
    if (!this.stopped) this.stop('完了');
  }
}
function macroRunning(t) { return !!((t && t.macro && !t.macro.stopped) || (t && t.ttl && !t.ttl.done)); }
function updateMacroBtn() {
  const t = tabs.get(activeId);
  const b = $('#btnMacro'); if (b) { b.textContent = macroRunning(t) ? '⏹ マクロ実行中' : '🤖 マクロ'; b.classList.toggle('hidden', !!(t && t.isRdp)); }
}
function updateMacroHelp() {
  const ttl = $('#macroLang').value === 'ttl';
  $('#macroHelpSimple').classList.toggle('hidden', ttl);
  $('#macroHelpTtl').classList.toggle('hidden', !ttl);
}
function openMacro() {
  const t = tabs.get(activeId); if (!t) return;
  if (t.macro && !t.macro.stopped) { t.macro.stop('ユーザー停止'); return; }
  if (t.ttl && !t.ttl.done) { stopTtl(t); return; }
  $('#macroLang').value = (t.session && t.session.macroLang) || SETTINGS.lastMacroLang || 'simple';
  $('#macroScript').value = (t.session && t.session.macroScript) || SETTINGS.lastMacro || '';
  updateMacroHelp();
  $('#macroModal').classList.remove('hidden');
  $('#macroScript').focus();
}
function runMacroFromModal() {
  const t = tabs.get(activeId); if (!t) { $('#macroModal').classList.add('hidden'); return; }
  const script = $('#macroScript').value;
  const lang = $('#macroLang').value;
  SETTINGS.lastMacro = script; SETTINGS.lastMacroLang = lang; api.saveSettings(SETTINGS);
  if (t.session) { t.session.macroScript = script; t.session.macroLang = lang; persistSessions(); }
  $('#macroModal').classList.add('hidden');
  if (t.macro && !t.macro.stopped) t.macro.stop('再実行');
  if (t.ttl && !t.ttl.done) stopTtl(t);
  if (lang === 'ttl') { runTtl(t, script); return; }
  t.macro = new MacroRunner(t, script);
  updateMacroBtn();
  t.macro.run();
}

/* ---------------- TTL (Tera Term マクロ) ---------------- */
function makeTtlIo(tab) {
  let buf = ''; let waiter = null;
  const io = {
    feed(data) { buf += data; if (buf.length > 65536) buf = buf.slice(-65536); if (waiter) waiter.check(); },
    cancel() { if (waiter) { clearTimeout(waiter.timer); const w = waiter; waiter = null; w.resolve({ index: 0, matched: '' }); } },
    async send(s) { api.connInput(tab.id, s); },
    async wait(pats, to) {
      return new Promise((resolve) => {
        const check = () => {
          for (let i = 0; i < pats.length; i++) { const j = pats[i] ? buf.indexOf(pats[i]) : -1; if (j >= 0) { buf = buf.slice(j + pats[i].length); if (waiter) clearTimeout(waiter.timer); waiter = null; resolve({ index: i + 1, matched: pats[i] }); return true; } }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => { waiter = null; resolve({ index: 0, matched: '' }); }, Math.max(1, to) * 1000);
        waiter = { resolve, timer, check };
      });
    },
    async pause(ms) { await new Promise((r) => setTimeout(r, Math.max(0, ms || 0))); },
    async flush() { buf = ''; },
    async sendBreak() { if (tab.session && tab.session.protocol === 'serial') await api.serialBreak(tab.id); },
    async message(m, ti) { try { window.alert((ti ? '[' + ti + '] ' : '') + m); } catch (_) {} },
    async status(m) { setState(String(m)); },
    async inputbox(m, ti, d) { return await askText(m || '入力', { value: d || '' }); },
    async passwordbox(m, ti) { return await askText(m || 'パスワード', { password: true }); },
    async yesno(m, ti) { return window.confirm((ti ? '[' + ti + '] ' : '') + m) ? 1 : 0; },
    log(msg) { if (tab.term) tab.term.writeln('\x1b[35m[TTL] ' + msg + '\x1b[0m'); },
  };
  return io;
}
function runTtl(tab, script) {
  if (typeof TtlInterpreter === 'undefined') { toast('TTLエンジンが読み込まれていません', true); return; }
  const io = makeTtlIo(tab);
  tab.ttlIo = io;
  const interp = new TtlInterpreter(io, script, { defaultTimeout: 30, rand: Math.random });
  tab.ttl = { interp, done: false };
  if (tab.term) tab.term.writeln('\x1b[35m[TTL] マクロを開始します\x1b[0m');
  updateMacroBtn();
  interp.run().then((r) => {
    tab.ttl.done = true; tab.ttlIo = null;
    if (tab.term) {
      if (r.ok) tab.term.writeln('\x1b[32m[TTL] 完了しました\x1b[0m');
      else tab.term.writeln('\x1b[31m[TTL] エラー(' + (r.line || '?') + '行目): ' + r.error + '\x1b[0m');
    }
    if (activeId === tab.id) updateMacroBtn();
  });
}
function stopTtl(tab) {
  if (!tab.ttl || tab.ttl.done) return;
  try { tab.ttl.interp.stop(); } catch (_) {}
  try { if (tab.ttlIo) tab.ttlIo.cancel(); } catch (_) {}
  tab.ttl.done = true; tab.ttlIo = null;
  if (tab.term) tab.term.writeln('\x1b[90m[TTL] 停止しました\x1b[0m');
  updateMacroBtn();
}

/* ---------------- 同時入力グループ (Sync Input) ---------------- */
// グループに参加しているタブ数
function syncCount() { let n = 0; for (const t of tabs.values()) if (t.syncOn) n++; return n; }
// アクティブタブのグループ参加/離脱をトグル
function toggleSync() {
  const t = tabs.get(activeId); if (!t || t.isRdp) return;
  t.syncOn = !t.syncOn;
  updateTabEl(t); updateSyncBtn();
  const n = syncCount();
  if (t.syncOn) toast('⌨ このタブを同時入力グループに追加しました（' + n + 'タブ）。入力が全メンバーへ同時送信されます');
  else toast('このタブを同時入力グループから外しました' + (n ? '（残り' + n + 'タブ）' : ''));
}
// 開いている全タブをまとめてグループへ追加/解除
function syncAll(on) {
  let n = 0; for (const t of tabs.values()) { if (t.isRdp) continue; t.syncOn = on; if (on) n++; updateTabEl(t); }
  updateSyncBtn();
  toast(on ? ('⌨ ' + n + 'タブを同時入力グループに追加しました') : '同時入力グループを解除しました');
}
function updateSyncBtn() {
  const t = tabs.get(activeId);
  const b = $('#btnSync'); if (!b) return;
  const on = !!(t && t.syncOn); const n = syncCount();
  b.classList.toggle('hidden', !!(t && t.isRdp));
  b.classList.toggle('on', on);
  b.textContent = (on || n) ? ('⌨ 同時入力 (' + n + ')') : '⌨ 同時入力';
  b.title = on ? 'このタブはグループに参加中（クリックで解除）。Shift+クリックで全タブ一括' : '同時入力グループに追加（複数タブへ一括入力）。Shift+クリックで全タブ一括';
}

/* ---------------- ファイル転送 (XMODEM/YMODEM) ---------------- */
function updateXferBtn() {
  const t = tabs.get(activeId);
  const b = $('#btnTransfer'); if (!b) return;
  b.textContent = (t && t.xferActive) ? '⏹ 転送中止' : '⇅ 転送';
  b.classList.toggle('hidden', !!(t && t.isRdp));
}
function openTransfer() {
  const t = tabs.get(activeId); if (!t) return;
  $('#xferProto').value = SETTINGS.lastXferProto || 'xmodem';
  $('#xferDir').value = SETTINGS.lastXferDir || 'recv';
  $('#xferModal').classList.remove('hidden');
}
async function startTransferFromModal() {
  const t = tabs.get(activeId); if (!t) { $('#xferModal').classList.add('hidden'); return; }
  const proto = $('#xferProto').value, dir = $('#xferDir').value;
  SETTINGS.lastXferProto = proto; SETTINGS.lastXferDir = dir; api.saveSettings(SETTINGS);
  $('#xferModal').classList.add('hidden');
  const r = await api.transferStart(activeId, proto, dir);
  if (r && r.started) { t.xferActive = true; updateXferBtn(); }
  else if (r && r.error) toast('転送を開始できません: ' + r.error, true);
}
/* ---------------- ネットワーク診断 (ローカル ping / tracert / nslookup) ---------------- */
let diagRunning = false;
function openDiag(host) {
  $('#diagHost').value = host || '';
  if (SETTINGS.diagCount != null) $('#diagCount').value = SETTINGS.diagCount;
  $('#diagModal').classList.remove('hidden');
  diagRunning = false; updateDiagButtons();
  if (!host) $('#diagHost').focus();
}
function diagAppend(t) { const el = $('#diagOut'); if (!el) return; el.textContent += t; el.scrollTop = el.scrollHeight; }
function updateDiagButtons() {
  $('#diagStop').disabled = !diagRunning;
  ['#diagPing', '#diagTracert', '#diagNslookup'].forEach((s) => { const b = $(s); if (b) b.disabled = diagRunning; });
}
async function runDiag(kind) {
  if (diagRunning) return;
  const host = $('#diagHost').value.trim();
  if (!host) { toast('対象ホストを入力してください', true); $('#diagHost').focus(); return; }
  const count = $('#diagCount').value;
  SETTINGS.diagCount = count; saveSettings();
  const label = kind === 'ping' ? 'ping' : kind === 'tracert' ? 'tracert' : 'nslookup';
  diagAppend((($('#diagOut').textContent) ? '\n' : '') + '$ ' + label + ' ' + host + '\n');
  // 先に実行中フラグを立てる（短時間で終わる nslookup 等で diag:end が先着しても矛盾しないように）
  diagRunning = true; updateDiagButtons();
  const r = await api.diagRun(kind, host, count);
  if (!(r && r.ok)) { diagRunning = false; updateDiagButtons(); diagAppend('[エラー] ' + ((r && r.error) || '実行できませんでした') + '\n'); }
}

/* 検索 */
function toggleFind() { const fb = $('#findbar'); fb.classList.toggle('hidden'); if (!fb.classList.contains('hidden')) $('#findInput').focus(); }
function doFind(dir) { const t = tabs.get(activeId); if (!t || !t.search) return; const q = $('#findInput').value; if (!q) return; if (dir < 0) t.search.findPrevious(q); else t.search.findNext(q); }

/* ---------------- 通信モニタ / パケットキャプチャ ---------------- */
let monMode = 'sess';
let capturing = false, capCount = 0, ifacesLoaded = false;
const MON_VIEW_MAX = 3000; // 一覧に保持するDOM行の上限（記録自体は別途20000フレームまで保持）
function monVisible() { return !$('#monitorDock').classList.contains('hidden'); }
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function monClock(ts) { const d = new Date(ts); const p = (x, n) => String(x).padStart(n || 2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }
function asciiPreview(bytes, max) { let s = ''; const n = Math.min(bytes.length, max || 80); for (let i = 0; i < n; i++) { const c = bytes[i]; s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.'; } if (bytes.length > n) s += '…'; return s; }
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
  $('#monClear').onclick = async () => { const t = tabs.get(activeId); if (!t) return; await api.monitorClear(activeId); t.monFrames = []; t.monTx = 0; t.monRx = 0; $('#monBody').innerHTML = ''; $('#monHex').textContent = ''; updateMonStat(); };
  $('#monExport').onclick = async () => { if (!activeId) return; const r = await api.monitorExport(activeId); if (r && r.ok) toast('保存しました: ' + r.path + ' (' + r.frames + 'フレーム)'); else if (r && r.error) toast('保存できません: ' + r.error, true); };
  $('#monFilter').oninput = renderMonAll;
  $('#capRefresh').onclick = loadInterfaces;
  $('#capStart').onclick = startCapture;
  $('#capStop').onclick = () => api.captureStop();
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
  const r = await api.monitorToggle(activeId, !t.monOn);
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
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------------- 出力ハイライト / キーワード通知 ---------------- */
const HL_COLORS = { yellow: '\x1b[30;43m', red: '\x1b[37;41m', green: '\x1b[30;42m', cyan: '\x1b[30;46m', magenta: '\x1b[30;45m', blue: '\x1b[37;44m' };
let HL_RULES = [];
function parseHighlightRules(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim(); if (!line || line.startsWith('#')) continue;
    let notify = false;
    if (line[0] === '!') { notify = true; line = line.slice(1).trim(); }
    let color = notify ? 'red' : 'yellow';
    const m = line.match(/^(.*?)\s*=\s*(yellow|red|green|cyan|magenta|blue)$/i);
    if (m) { line = m[1].trim(); color = m[2].toLowerCase(); }
    if (line) out.push({ kw: line, notify, ansi: HL_COLORS[color] || HL_COLORS.yellow });
  }
  return out;
}
function applyHighlights(data, t) {
  if (!HL_RULES.length || !data) return data;
  let out = data;
  for (const r of HL_RULES) {
    let re; try { re = new RegExp(r.kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (_) { continue; }
    const before = out;
    out = out.replace(re, (mm) => r.ansi + mm + '\x1b[0m');
    if (out !== before && r.notify) notifyMatch(t, r.kw);
  }
  return out;
}
let _beepCtx = null;
function beep() { try { _beepCtx = _beepCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = _beepCtx.createOscillator(), g = _beepCtx.createGain(); o.connect(g); g.connect(_beepCtx.destination); o.frequency.value = 880; g.gain.value = 0.06; o.start(); setTimeout(() => { try { o.stop(); } catch (_) {} }, 130); } catch (_) {} }
function notifyMatch(t, kw) {
  const now = Date.now();
  if (t._lastNotify && now - t._lastNotify < 1500) return;
  t._lastNotify = now;
  beep();
  toast('🔔 ' + (t.session ? t.session.name : '') + '：「' + kw + '」を検知');
  if (t.tabEl) { t.tabEl.classList.remove('flash'); void t.tabEl.offsetWidth; t.tabEl.classList.add('flash'); setTimeout(() => { if (t.tabEl) t.tabEl.classList.remove('flash'); }, 1700); }
}
function openHighlight() { $('#hlText').value = SETTINGS.highlightText || ''; $('#hlModal').classList.remove('hidden'); $('#hlText').focus(); }
function saveHighlight() { SETTINGS.highlightText = $('#hlText').value; HL_RULES = parseHighlightRules(SETTINGS.highlightText); saveSettings(); $('#hlModal').classList.add('hidden'); toast('ハイライト設定を保存（' + HL_RULES.length + '件）'); }
// --- パケットキャプチャ (tshark) ---
async function loadInterfaces() {
  const sel = $('#capIface'); sel.innerHTML = '';
  $('#capStat').textContent = '取得中…';
  const r = await api.captureInterfaces();
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
  const r = await api.captureStart(iface, filter);
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

/* ---------------- SFTP ---------------- */
function sftpVisible() { return !$('#sftpDock').classList.contains('hidden'); }
async function sftpRefresh() {
  const t = tabs.get(activeId);
  const body = $('#sftpBody'); body.innerHTML = '';
  if (!t) { $('#sftpStatus').textContent = 'タブがありません'; return; }
  if (t.session.protocol !== 'ssh') { $('#sftpStatus').textContent = 'SFTPはSSH接続でのみ利用できます'; return; }
  if (!t.sftpCwd) { const rp = await api.sftpRealpath(activeId, '.'); t.sftpCwd = (typeof rp === 'string') ? rp : '/'; }
  $('#sftpPath').value = t.sftpCwd;
  const list = await api.sftpList(activeId, t.sftpCwd);
  if (list && list.error) { $('#sftpStatus').textContent = 'エラー: ' + list.error; return; }
  for (const it of list) {
    const tr = document.createElement('tr');
    const nm = elx('td', it.isDir ? 'dir' : null, (it.isDir ? '📁 ' : it.isLink ? '🔗 ' : '📄 ') + it.name);
    tr.appendChild(nm);
    tr.appendChild(elx('td', null, it.isDir ? '' : fmtSize(it.size)));
    tr.appendChild(elx('td', null, fmtTime(it.mtime)));
    tr.appendChild(elx('td', null, it.perms || ''));
    const full = (t.sftpCwd.replace(/\/$/, '') || '') + '/' + it.name;
    if (it.isDir) tr.dataset.dir = full; // フォルダへのドロップ先
    tr.ondblclick = () => { if (it.isDir) { t.sftpCwd = full; sftpRefresh(); } else { api.sftpDownload(activeId, full, it.name).then((r) => { if (r && r.ok) $('#sftpStatus').textContent = '保存: ' + r.path; }); } };
    tr.oncontextmenu = (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, [
      it.isDir ? { label: '開く', fn: () => { t.sftpCwd = full; sftpRefresh(); } } : { label: 'ダウンロード', fn: () => api.sftpDownload(activeId, full, it.name).then((r) => { if (r && r.ok) $('#sftpStatus').textContent = '保存: ' + r.path; }) },
      ...(it.isDir ? [] : [{ label: '編集（ローカルで開く・保存で自動反映）', fn: () => sftpEditFile(full, it.name) }]),
      { label: 'リネーム', fn: async () => { const nn = await askText('新しい名前', { value: it.name }); if (nn) { const r = await api.sftpRename(activeId, full, t.sftpCwd.replace(/\/$/, '') + '/' + nn); if (r.ok) sftpRefresh(); else $('#sftpStatus').textContent = 'エラー: ' + r.error; } } },
      { label: '削除', fn: async () => { if (confirm(it.name + ' を削除しますか？')) { const r = await api.sftpDelete(activeId, full, it.isDir); if (r.ok) sftpRefresh(); else $('#sftpStatus').textContent = 'エラー: ' + r.error; } } },
    ]); };
    body.appendChild(tr);
  }
  $('#sftpStatus').textContent = `${list.length} 項目 — ${t.sftpCwd}`;
}
function sftpUp() { const t = tabs.get(activeId); if (!t || !t.sftpCwd) return; const p = t.sftpCwd.replace(/\/+$/, ''); const parent = p.substring(0, p.lastIndexOf('/')) || '/'; t.sftpCwd = parent; sftpRefresh(); }
// 即時編集：リモートファイルをローカルの既定エディタで開く（以後は保存するたび自動で再アップロード）
async function sftpEditFile(remotePath, name) {
  if (!activeId) return;
  $('#sftpStatus').textContent = '「' + name + '」をローカルで開いています…';
  const r = await api.sftpEdit(activeId, remotePath, name);
  if (r && r.ok) {
    $('#sftpStatus').textContent = '✎ 編集中: ' + name + '（ローカルで保存するたび自動でアップロードします）';
    toast('✎ ' + name + ' をローカルエディタで開きました。保存すると自動で反映されます');
    if (r.openError) toast('既定アプリで開けませんでした: ' + r.openError, true);
  } else {
    $('#sftpStatus').textContent = '編集を開始できません: ' + ((r && r.error) || '不明');
    toast('編集を開始できません: ' + ((r && r.error) || '不明'), true);
  }
}
function wireSftp() {
  $('#sftpUp').onclick = sftpUp;
  $('#sftpRefresh').onclick = sftpRefresh;
  $('#sftpGo').onclick = () => { const t = tabs.get(activeId); if (t) { t.sftpCwd = $('#sftpPath').value; sftpRefresh(); } };
  $('#sftpUpload').onclick = async () => { const t = tabs.get(activeId); if (!t) return; const r = await api.sftpUpload(activeId, t.sftpCwd); if (r && r.ok) { $('#sftpStatus').textContent = r.count + ' 件アップロードしました'; sftpRefresh(); } };
  $('#sftpMkdir').onclick = async () => { const t = tabs.get(activeId); if (!t) return; const nm = await askText('新しいフォルダ名'); if (nm) { const r = await api.sftpMkdir(activeId, t.sftpCwd.replace(/\/$/, '') + '/' + nm); if (r.ok) sftpRefresh(); else $('#sftpStatus').textContent = 'エラー: ' + r.error; } };
  // エクスプローラからファイルをドラッグ&ドロップしてアップロード
  const sftpEl = $('#sftp');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  sftpEl.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; sftpEl.classList.add('drop-active'); } });
  sftpEl.addEventListener('dragleave', (e) => { if (e.target === sftpEl) sftpEl.classList.remove('drop-active'); });
  sftpEl.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); sftpEl.classList.remove('drop-active');
    const t = tabs.get(activeId); if (!t) { $('#sftpStatus').textContent = '接続中のタブがありません'; return; }
    if (t.session && t.session.protocol !== 'ssh') { $('#sftpStatus').textContent = 'SFTPはSSH接続でのみ利用できます'; return; }
    const paths = Array.from(e.dataTransfer.files || []).map((f) => api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const row = e.target.closest && e.target.closest('tr[data-dir]');
    const dir = (row && row.dataset.dir) || t.sftpCwd || '.';
    $('#sftpStatus').textContent = paths.length + ' 件を ' + dir + ' へアップロード中…';
    const r = await api.sftpUploadPaths(activeId, dir, paths);
    if (r && r.ok) { $('#sftpStatus').textContent = r.count + ' 件アップロードしました'; sftpRefresh(); }
    else $('#sftpStatus').textContent = 'アップロード失敗: ' + ((r && r.error) || '不明');
  });
}

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
  $('#btnExport').onclick = exportSessions;
  $('#btnSidebar').onclick = toggleSidebar;
  $('#btnSftp').onclick = toggleSftp;
  $('#btnMonitor').onclick = toggleMonitor;
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

  $('#hlCancel').onclick = () => $('#hlModal').classList.add('hidden');
  $('#hlSave').onclick = saveHighlight;

  $('#macroCancel').onclick = () => $('#macroModal').classList.add('hidden');
  $('#macroRun').onclick = runMacroFromModal;
  $('#macroLang').onchange = updateMacroHelp;
  $('#macroLoad').onclick = async () => {
    const r = await api.loadTextFile(['ttl', 'txt', 'inc', 'mac']);
    if (r && r.ok) { $('#macroScript').value = r.content; if (/\.(ttl|inc|mac)$/i.test(r.name)) $('#macroLang').value = 'ttl'; updateMacroHelp(); toast(r.name + ' を読み込みました'); }
    else if (r && r.error) toast('読込に失敗: ' + r.error, true);
  };

  $('#xferCancel').onclick = () => $('#xferModal').classList.add('hidden');
  $('#xferStart').onclick = startTransferFromModal;

  $('#diagPing').onclick = () => runDiag('ping');
  $('#diagTracert').onclick = () => runDiag('tracert');
  $('#diagNslookup').onclick = () => runDiag('nslookup');
  $('#diagStop').onclick = () => api.diagStop();
  $('#diagClear').onclick = () => { $('#diagOut').textContent = ''; };
  $('#diagCopy').onclick = () => { const txt = $('#diagOut').textContent; if (txt) { api.clipboardWrite(txt); toast('診断結果をコピーしました'); } };
  $('#diagClose').onclick = () => { api.diagStop(); $('#diagModal').classList.add('hidden'); };
  $('#diagHost').onkeydown = (e) => { if (e.key === 'Enter') runDiag('ping'); };

  $('#bcastBtn').onclick = broadcast;
  $('#bcastInput').onkeydown = (e) => { if (e.key === 'Enter') broadcast(); };

  $('#findInput').onkeydown = (e) => { if (e.key === 'Enter') doFind(e.shiftKey ? -1 : 1); if (e.key === 'Escape') toggleFind(); };
  $('#findNext').onclick = () => doFind(1);
  $('#findPrev').onclick = () => doFind(-1);
  $('#findClose').onclick = toggleFind;

  document.querySelectorAll('.layoutsel .lay').forEach((b) => { b.onclick = () => setLayout(b.dataset.layout); });
  wireTabTools(); wireSftp(); wireMonitor(); wireLayout();
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
  // パネルのグリップ（下＝高さ／横＝幅）
  document.querySelectorAll('.dock-grip').forEach((grip) => grip.addEventListener('pointerdown', (e) => startGripDrag(e, grip.dataset.dock)));
  // ドック位置切替（下↔横）
  $('#sftpDockBtn').onclick = () => toggleDockPos('sftp');
  $('#monDockBtn').onclick = () => toggleDockPos('monitor');
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
  const item = $('#' + which + 'Dock');
  const btn = $(which === 'sftp' ? '#sftpDockBtn' : '#monDockBtn');
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
  setDockPos('sftp', SETTINGS.sftpDockPos === 'side' ? 'side' : 'bottom');
  setDockPos('monitor', SETTINGS.monitorDockPos === 'side' ? 'side' : 'bottom');
}
function toggleSftp() { const d = $('#sftpDock'); d.classList.toggle('hidden'); SETTINGS.sftp = !d.classList.contains('hidden'); saveSettings(); if (SETTINGS.sftp) sftpRefresh(); setTimeout(refitActive, 50); }
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
    case 'toggle-sftp': toggleSftp(); break;
    case 'toggle-monitor': toggleMonitor(); break;
    case 'toggle-log-ts': SETTINGS.logTimestamp = !SETTINGS.logTimestamp; saveSettings(); toast('ログのタイムスタンプ: ' + (SETTINGS.logTimestamp ? 'ON（次回ログ開始から）' : 'OFF')); break;
    case 'broadcast': $('#bcastInput').focus(); break;
    case 'sync-toggle': toggleSync(); break;
    case 'sync-all-on': syncAll(true); break;
    case 'sync-all-off': syncAll(false); break;
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
    case 'highlight': openHighlight(); break;
  }
}
async function checkUpdate() {
  const r = await api.updateCheck();
  if (!r) return;
  if (r.dev) { toast('開発モードのため更新確認はできません（インストール版で有効）'); return; }
  if (!r.ok) { toast('更新を確認できませんでした（配布先URLが未設定の可能性）', true); return; }
  if (r.available) toast('新しいバージョン ' + r.latest + ' を取得します…');
  else toast('お使いのバージョン (' + r.current + ') は最新です');
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
    { label: '同時入力：このタブを切替', a: 'sync-toggle' },
    { label: '同時入力：全タブを追加', a: 'sync-all-on' },
    { label: '同時入力：全タブを解除', a: 'sync-all-off' },
  ] },
  { label: '表示', items: [
    { label: 'テーマ切替(ダーク/ライト)', a: 'toggle-theme' },
    { label: 'サイドバー表示切替', a: 'toggle-sidebar' },
    { label: 'SFTPパネル表示切替', a: 'toggle-sftp' },
    { label: '通信モニタ表示切替', a: 'toggle-monitor' },
    { label: '出力ハイライト設定…', a: 'highlight' },
    { label: 'ログにタイムスタンプを付ける(切替)', a: 'toggle-log-ts' },
    { sep: true },
    { label: '開発者ツール', a: 'devtools' },
    { label: '再読み込み', a: 'reload' },
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
