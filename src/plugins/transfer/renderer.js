'use strict';
// ファイル転送（XMODEM/YMODEM/ZMODEM/Kermit）— レンダラ（transfer プラグイン）
//   本体グローバル（tabs, activeId, $, SETTINGS, api.saveSettings, toast）を利用。
//   main との通信は WT.invoke/send/on 経由（チャンネル: transfer:*）。
(function () {
  function updateXferBtn() {
    const t = tabs.get(activeId);
    const b = $('#btnTransfer'); if (!b) return;
    b.textContent = (t && t.xferActive) ? '⏹ 転送中止' : '⇅ 転送';
    b.classList.toggle('hidden', !!(t && t.isEmbed));
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
    const r = await WT.invoke('transfer:start', { id: activeId, proto, dir });
    if (r && r.started) { t.xferActive = true; updateXferBtn(); }
    else if (r && r.error) toast('転送を開始できません: ' + r.error, true);
  }

  // ---- プラグイン登録 ----
  WT.register('transfer', {
    activate(WT) {
      WT.addTabToolButton({ id: 'btnTransfer', label: '⇅ 転送', title: 'ファイル転送 (XMODEM/YMODEM)', onClick: () => { const t = tabs.get(activeId); if (!t || t.isEmbed) return; if (t.xferActive) { WT.send('transfer:abort', { id: activeId }); return; } openTransfer(); } });
      WT.onActiveTabChange(updateXferBtn);
      WT.on('transfer:done', ({ id }) => { const t = tabs.get(id); if (t) { t.xferActive = false; if (id === activeId) updateXferBtn(); } });
      // ZMODEMオートスタート: 相手の sz/sb 検出をmainから受けたら自動で受信を開始（設定でOFF可）。
      WT.on('transfer:autostart', async ({ id, proto }) => {
        if (SETTINGS.autoZmodem === false) return;
        const t = tabs.get(id); if (!t || t.xferActive) return;
        toast('⇩ ' + (proto || 'ZMODEM').toUpperCase() + ' を検出：受信を自動開始します');
        const r = await WT.invoke('transfer:start', { id, proto: proto || 'zmodem', dir: 'recv' });
        if (r && r.started) { t.xferActive = true; if (id === activeId) updateXferBtn(); }
        else if (r && r.error) toast('自動受信を開始できません: ' + r.error, true);
      });
      $('#xferCancel').onclick = () => $('#xferModal').classList.add('hidden');
      $('#xferStart').onclick = startTransferFromModal;
    },
  });
})();
