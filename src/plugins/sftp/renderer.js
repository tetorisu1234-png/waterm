'use strict';
// SFTP パネル — レンダラ（sftp プラグイン）
//   SSH接続上のリモートファイル操作。バックエンドの sftp:* は SSH接続の一部として
//   本体(main)に残っており、ここでは本体の api.sftp* をそのまま利用する。
//   ドックの配置/リサイズは本体のドック機構が担当（#sftpDock）。
(function () {
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
  function toggleSftp() { const d = $('#sftpDock'); d.classList.toggle('hidden'); SETTINGS.sftp = !d.classList.contains('hidden'); saveSettings(); if (SETTINGS.sftp) sftpRefresh(); setTimeout(refitActive, 50); }

  // ---- プラグイン登録 ----
  WT.register('sftp', {
    activate(WT) {
      WT.addToolbarButton({ id: 'btnSftp', label: '📁 SFTP', title: 'SFTPパネル (Ctrl+Shift+S)', onClick: toggleSftp });
      WT.onMenuAction('toggle-sftp', toggleSftp);
      WT.addMenuItem('表示', { label: 'SFTPパネル表示切替', action: 'toggle-sftp', onRun: toggleSftp });
      WT.onActiveTabChange(() => { if (sftpVisible()) sftpRefresh(); });
      // ローカル編集→保存の自動再アップロード通知
      api.onSftpEditEvent((p) => {
        if (p && p.ok) { toast('⤴ 保存を検知：' + p.name + ' をアップロードしました'); if (sftpVisible()) { $('#sftpStatus').textContent = '⤴ ' + p.name + ' を反映しました (' + new Date().toLocaleTimeString('ja-JP') + ')'; sftpRefresh(); } }
        else if (p) toast('アップロード失敗（' + p.name + '）: ' + (p.error || ''), true);
      });
      wireSftp();
    },
  });
})();
