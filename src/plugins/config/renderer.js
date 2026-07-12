'use strict';
// コンフィグ管理＆差分 — レンダラ（config プラグイン）
//   本体グローバル（$, elx, toast, tabs, activeId, api.connInput）を利用。
//   config の保存/一覧/差分は WT.invoke 経由（チャンネル: config:*）。
//   受信データは WT.onData で購読し、取得中タブの ConfigCapture へ流す。
(function () {
  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][AB012]|[\x00\x07]/g;
  function cfgKeyOf(session) { if (!session) return 'device'; return (session.name || session.host || 'device'); }
  let cfgSelected = []; // 選択中のスナップショット file 名（最大2）

  function ConfigCapture(tab, opts) {
    this.tab = tab; this.cmd = opts.cmd; this.termLen = opts.termLen; this.idleMs = opts.idleMs; this.onDone = opts.onDone;
    this.buf = ''; this.capturing = false; this.done = false; this.timer = null; this.hardTimer = null;
  }
  // xterm バッファからカーソル付近の最終非空行（＝現在のプロンプト）を読む。
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
    while (lines.length && (lines[0].trim() === '' || lines[0].indexOf(this.cmd) >= 0)) { const drop = lines[0].indexOf(this.cmd) >= 0; lines.shift(); if (drop) break; }
    while (lines.length && (lines[lines.length - 1].trim() === '' || /[#>$%]\s*$/.test(lines[lines.length - 1]))) lines.pop();
    return lines.join('\n').trim() + '\n';
  };

  function wireConfig() {
    $('#cfgClose').onclick = () => $('#cfgModal').classList.add('hidden');
    $('#cfgKey').onchange = () => { cfgSelected = []; loadCfgList(); };
    $('#cfgOpenDir').onclick = () => WT.invoke('config:openDir', { key: $('#cfgKey').value });
    $('#cfgCapture').onclick = () => captureConfig(false);
    $('#cfgCaptureSync').onclick = () => captureConfig(true);
    $('#cfgView').onclick = cfgDoView;
    $('#cfgDiff').onclick = cfgDoDiff;
    $('#cfgDel').onclick = cfgDoDelete;
  }
  async function openConfig() {
    cfgSelected = [];
    const t = tabs.get(activeId);
    const curKey = (t && !t.isEmbed) ? cfgKeyOf(t.session) : '';
    const r = await WT.invoke('config:listKeys');
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
    const r = await WT.invoke('config:list', { key });
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
    const r = await WT.invoke('config:read', { key, file: cfgSelected[cfgSelected.length - 1] });
    if (r && r.ok) { $('#cfgView2').textContent = r.content; $('#cfgView2').className = 'cfg-view'; }
    else toast('読込失敗', true);
  }
  async function cfgDoDelete() {
    if (!cfgSelected.length) { toast('削除するスナップショットを選んでください', true); return; }
    const key = $('#cfgKey').value;
    for (const f of cfgSelected.slice()) await WT.invoke('config:delete', { key, file: f });
    cfgSelected = []; $('#cfgView2').textContent = ''; loadCfgList(); toast('削除しました');
  }
  async function cfgDoDiff() {
    if (cfgSelected.length !== 2) { toast('差分は2件選択してください（古い→新しい）', true); return; }
    const key = $('#cfgKey').value;
    const sorted = cfgSelected.slice().sort(); // ファイル名=日時昇順 → [0]=古い [1]=新しい
    const ra = await WT.invoke('config:read', { key, file: sorted[0] }); const rb = await WT.invoke('config:read', { key, file: sorted[1] });
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
    if (syncGroup) { targets = [...tabs.values()].filter((t) => t.syncOn && !t.isEmbed); if (!targets.length) { const t = tabs.get(activeId); if (t && !t.isEmbed) targets = [t]; } }
    else { const t = tabs.get(activeId); if (t && !t.isEmbed) targets = [t]; }
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
          const r = await WT.invoke('config:save', { key, label: cmd, content });
          if (r && r.ok) { toast('保存: ' + key + ' ← ' + cmd); if ($('#cfgKey').value === key && !$('#cfgModal').classList.contains('hidden')) loadCfgList(); }
          else toast('保存失敗: ' + ((r && r.error) || ''), true);
        },
      });
      tab.cfgCap = cap; cap.start();
    }
  }

  // ---- プラグイン登録 ----
  WT.register('config', {
    activate(WT) {
      WT.addTabToolButton({ id: 'btnConfig', label: '📑 Config', title: 'コンフィグ取得・世代保存・差分', onClick: () => openConfig() });
      WT.registerCommand({ icon: '📑', label: 'コンフィグ管理', run: () => openConfig() });
      // 取得中タブへ受信データを流す
      WT.onData((data, tab) => { if (tab && tab.cfgCap) tab.cfgCap.feed(data); });
      wireConfig();
    },
  });
})();
