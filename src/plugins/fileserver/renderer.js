'use strict';
// 内蔵ファイルサーバ（TFTP / HTTP / FTP）— レンダラ（fileserver プラグイン）
//   本体グローバル（$, elx, toast, SETTINGS, saveSettings, api）を利用。
//   main との通信は WT.invoke/on 経由（チャンネル: fileserver:*）。
(function () {
  let FS_STATUS = { tftp: false, http: false, ftp: false };

  function wireServer() {
    $('#fsClose').onclick = () => $('#fsModal').classList.add('hidden');
    $('#fsClear').onclick = () => { $('#fsLog').textContent = ''; };
    $('#fsPick').onclick = async () => { const r = await WT.invoke('fileserver:pickDir'); if (r && r.ok) { $('#fsRoot').value = r.dir; SETTINGS.fsRoot = r.dir; saveSettings(); } };
    $('#fsOpen').onclick = () => { const d = $('#fsRoot').value.trim(); if (d) WT.invoke('fileserver:openDir', { dir: d }); };
    $('#fsRoot').onchange = () => { SETTINGS.fsRoot = $('#fsRoot').value.trim(); saveSettings(); };
    document.querySelectorAll('#fsModal tr[data-proto]').forEach((tr) => {
      const proto = tr.dataset.proto;
      tr.querySelector('.fs-toggle').onclick = () => toggleServer(proto, tr);
      const pi = tr.querySelector('.fs-port'); pi.onchange = () => { SETTINGS['fsPort_' + proto] = pi.value; saveSettings(); };
    });
    WT.on('fileserver:log', (entry) => fsAppendLog(entry));
    WT.on('fileserver:status', (st) => { FS_STATUS = st || FS_STATUS; renderFsStatus(); });
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
    const r = await WT.invoke('fileserver:status');
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
      await WT.invoke('fileserver:stop', { proto });
      toast(proto.toUpperCase() + ' サーバを停止しました');
    } else {
      const root = $('#fsRoot').value.trim();
      if (!root) { toast('公開フォルダを選択してください', true); return; }
      const port = tr.querySelector('.fs-port').value;
      const writable = $('#fsWritable').checked;
      SETTINGS.fsWritable = writable; saveSettings();
      const r = await WT.invoke('fileserver:start', { proto, conf: { root, port, writable } });
      if (r && r.ok) toast(proto.toUpperCase() + ' サーバを起動しました :' + r.port);
      else toast(proto.toUpperCase() + ' 起動失敗: ' + ((r && r.error) || '不明'), true);
    }
  }

  // ---- プラグイン登録 ----
  WT.register('fileserver', {
    activate(WT) {
      WT.addToolbarButton({ id: 'btnServer', label: '🗄 サーバ', title: '内蔵ファイルサーバ (TFTP / HTTP / FTP)', onClick: () => openServer() });
      WT.registerCommand({ icon: '🗄', label: '内蔵サーバ', sub: 'TFTP/HTTP/FTP', run: () => openServer() });
      wireServer();
    },
  });
})();
