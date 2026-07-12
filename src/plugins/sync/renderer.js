'use strict';
// 同時入力グループ（Sync Input）— レンダラ（sync プラグイン）
//   グループに参加したタブへの入力を全メンバーへ同時送信する。
//   入力は WT.onInput で購読（自タブへの送信は本体が担う。ここでは他メンバーへミラー）。
//   本体グローバル（tabs, activeId, api.connInput, updateTabEl, toast, $）を利用。
(function () {
  function syncCount() { let n = 0; for (const t of tabs.values()) if (t.syncOn) n++; return n; }
  // アクティブタブのグループ参加/離脱をトグル
  function toggleSync() {
    const t = tabs.get(activeId); if (!t || t.isEmbed) return;
    t.syncOn = !t.syncOn;
    updateTabEl(t); updateSyncBtn();
    const n = syncCount();
    if (t.syncOn) toast('⌨ このタブを同時入力グループに追加しました（' + n + 'タブ）。入力が全メンバーへ同時送信されます');
    else toast('このタブを同時入力グループから外しました' + (n ? '（残り' + n + 'タブ）' : ''));
  }
  // 開いている全タブをまとめてグループへ追加/解除
  function syncAll(on) {
    let n = 0; for (const t of tabs.values()) { if (t.isEmbed) continue; t.syncOn = on; if (on) n++; updateTabEl(t); }
    updateSyncBtn();
    toast(on ? ('⌨ ' + n + 'タブを同時入力グループに追加しました') : '同時入力グループを解除しました');
  }
  function updateSyncBtn() {
    const t = tabs.get(activeId);
    const b = $('#btnSync'); if (!b) return;
    const on = !!(t && t.syncOn); const n = syncCount();
    b.classList.toggle('hidden', !!(t && t.isEmbed));
    b.classList.toggle('on', on);
    b.textContent = (on || n) ? ('⌨ 同時入力 (' + n + ')') : '⌨ 同時入力';
    b.title = on ? 'このタブはグループに参加中（クリックで解除）。Shift+クリックで全タブ一括' : '同時入力グループに追加（複数タブへ一括入力）。Shift+クリックで全タブ一括';
  }

  // ---- プラグイン登録 ----
  WT.register('sync', {
    activate(WT) {
      WT.addTabToolButton({ id: 'btnSync', label: '⌨ 同時入力', title: '同時入力グループ（複数タブへ一括入力）。Shift+クリックで全タブ一括', onClick: (e) => { if (e.shiftKey) { syncAll(syncCount() === 0); } else toggleSync(); } });
      // 入力を同期ONの他メンバーへミラー（自タブへの送信は本体が担当）
      WT.onInput((id, d) => { const self = tabs.get(id); if (self && self.syncOn) { for (const o of tabs.values()) { if (o.syncOn && !o.isEmbed && o.id !== id) api.connInput(o.id, d); } } });
      WT.onActiveTabChange(updateSyncBtn);
      WT.onMenuAction('sync-toggle', toggleSync);
      WT.onMenuAction('sync-all-on', () => syncAll(true));
      WT.onMenuAction('sync-all-off', () => syncAll(false));
      WT.addMenuItem('ターミナル', { label: '同時入力：このタブを切替', action: 'sync-toggle', onRun: toggleSync });
      WT.addMenuItem('ターミナル', { label: '同時入力：全タブを追加', action: 'sync-all-on', onRun: () => syncAll(true) });
      WT.addMenuItem('ターミナル', { label: '同時入力：全タブを解除', action: 'sync-all-off', onRun: () => syncAll(false) });
    },
  });
})();
