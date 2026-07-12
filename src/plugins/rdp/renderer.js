'use strict';
// RDP（リモートデスクトップ）— レンダラ（rdp プラグイン）
//   xterm の代わりに mstsc 埋め込み窓を持つ「埋め込みタブ」を作る接続プロトコル。
//   本体グローバル（uid, elx, $, tabs, addTabEl, setActive, buildCfg,
//   updateTabEl, closeTab, updateEmbeds, toast）を利用。main通信は WT.invoke/send。
(function () {
  async function openRdpTab(s) {
    const id = uid();
    const wrap = elx('div', 'term-wrap rdp-wrap');
    wrap.innerHTML = '<div class="rdp-msg">🖥 リモートデスクトップに接続中…</div>';
    $('#termpool').appendChild(wrap);
    const tab = { id, term: null, fit: null, search: null, session: s, wrap, tabEl: null, status: 'connecting', sftpCwd: null, logging: false, isEmbed: true };
    // 埋め込み窓の位置追従（本体 updateEmbeds から呼ばれる）
    tab.reposition = () => {
      const inPane = !!(tab.wrap && tab.wrap.closest('#termarea'));
      const r = tab.wrap ? tab.wrap.getBoundingClientRect() : null;
      if (inPane && r && r.width > 4 && r.height > 4) {
        WT.send('rdp:position', { id: tab.id, rect: { left: r.left, top: r.top, width: r.width, height: r.height, dpr: window.devicePixelRatio || 1, innerH: window.innerHeight } });
        WT.send('rdp:show', { id: tab.id, visible: true });
      } else {
        WT.send('rdp:show', { id: tab.id, visible: false });
      }
    };
    tabs.set(id, tab);
    addTabEl(tab);
    setActive(id);
    await new Promise((r) => setTimeout(r, 90)); // レイアウト確定を待つ
    const cfg = await buildCfg(s, 0, 0);
    const pr = tab.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (pr.width > 4 && pr.height > 4) { cfg.paneWidth = Math.round(pr.width * dpr); cfg.paneHeight = Math.round(pr.height * dpr); }
    const res = await WT.invoke('rdp:embed', { id, cfg });
    if (res && res.ok && res.embedded) {
      tab.status = 'connected'; updateTabEl(tab);
      [200, 700, 1500, 3000].forEach((d) => setTimeout(updateEmbeds, d));
    } else {
      closeTab(id);
      if (res && res.ok) toast('「' + s.name + '」を外部のリモートデスクトップで開きました');
      else toast('RDP起動に失敗: ' + ((res && res.error) || '不明なエラー'), true);
    }
  }

  // プロトコル選択肢と編集フィールドを本体UIへ注入（rdp無効時はそもそも出ない）
  function injectEditorUI() {
    // クイック接続＆セッション編集のプロトコル選択に「RDP」を追加
    const addOpt = (sel, label) => {
      if (!sel || [].some.call(sel.options, (o) => o.value === 'rdp')) return;
      const o = document.createElement('option'); o.value = 'rdp'; o.textContent = label; sel.appendChild(o);
    };
    addOpt(document.getElementById('quickProto'), 'RDP');
    addOpt(document.getElementById('fProto'), 'RDP (リモートデスクトップ)');
    // セッション編集モーダルに rdpOnly 行を注入（最初の termOnly 行の前）
    if (!document.getElementById('fDomain')) {
      const rows = ''
        + '<div class="row rdpOnly adv"><label>ドメイン</label><input id="fDomain" type="text" placeholder="(任意) AD ドメイン名" /></div>'
        + '<div class="row rdpOnly adv"><label>画面</label><select id="fScreen"><option value="full">全画面</option><option value="window">ウィンドウ</option></select></div>'
        + '<div class="row rdpOnly adv"><label>解像度</label><div class="keyrow"><input id="fWidth" type="number" value="1280" style="width:90px" /> <span style="padding-top:5px">×</span> <input id="fHeight" type="number" value="800" style="width:90px" /></div></div>'
        + '<div class="row rdpOnly adv"><label class="chk"><input type="checkbox" id="fClipboard" checked /> クリップボード共有</label></div>'
        + '<div class="row rdpOnly adv"><label class="chk"><input type="checkbox" id="fDrives" /> ローカルドライブ共有</label></div>'
        + '<div class="row rdpOnly adv"><label class="chk"><input type="checkbox" id="fMultimon" /> マルチモニター</label></div>'
        + '<div class="row rdpOnly adv"><label class="chk"><input type="checkbox" id="fAdmin" /> 管理セッション(/admin)</label></div>';
      const anchor = document.querySelector('#modal .row.termOnly');
      if (anchor) anchor.insertAdjacentHTML('beforebegin', rows);
      else { const body = document.querySelector('#modal .modal-body'); if (body) body.insertAdjacentHTML('beforeend', rows); }
    }
  }

  // ---- プラグイン登録 ----
  WT.register('rdp', {
    activate(WT) {
      WT.registerProtocol({ id: 'rdp', openTab: openRdpTab });
      injectEditorUI();
    },
  });
})();
