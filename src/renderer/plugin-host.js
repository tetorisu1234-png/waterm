'use strict';
// ===========================================================================
// プラグインホスト（レンダラ側）。window.WT を提供する。
//   - 起動時に有効プラグインの CSS / パネルHTML / renderer.js を注入
//   - 本体 init() を実行 → 各プラグインの activate(WT) を呼ぶ
//   - WT は「UI追加(ボタン/メニュー/パレット)」「受信データフック」「本体内部への
//     アクセス($/toast/SETTINGS/DB/tabs 等)」をプラグインへ公開する。
//   renderer.js より前に読み込む（renderer.js 末尾で WT.boot(init) する）。
// ===========================================================================
(function () {
  const plugins = [];        // {id, activate}
  const commands = [];       // パレット用 {icon,label,sub,run}
  const dataObservers = [];  // (data, tab) => void   受信データ観測
  const dataTransforms = []; // (data, tab) => data   term.write 前の変換
  const inputSubs = [];      // (id, data) => void    ユーザー入力の観測
  const activeTabSubs = [];  // () => void            アクティブタブ変更時
  const tabAdoptSubs = [];   // (tab) => void         別ウィンドウからのタブ引き継ぎ時
  const menuActions = {};    // action -> fn          runMenuAction 拡張
  const sessionMenuFns = []; // (session) => items[]  セッション右クリック拡張
  const protocols = {};      // protocol id -> def    接続プロトコル拡張（RDP 等）
  const bootHooks = [];      // activate 後に一度呼ぶ

  const WT = {
    // ---- プラグイン登録（各 renderer.js の先頭で呼ぶ） ----
    register(id, def) { plugins.push(Object.assign({ id }, def || {})); },

    // ---- UI 追加 ----
    // トップツールバー（#toolbar .topbtns）へボタン追加。テーマボタンの前に挿入。
    addToolbarButton(opt) {
      const bar = document.querySelector('#toolbar .topbtns'); if (!bar) return null;
      const b = document.createElement('button');
      if (opt.id) b.id = opt.id;
      b.textContent = opt.label || '';
      if (opt.title) b.title = opt.title;
      if (opt.onClick) b.onclick = opt.onClick;
      const theme = document.getElementById('btnTheme');
      if (theme && theme.parentNode === bar) bar.insertBefore(b, theme); else bar.appendChild(b);
      return b;
    },
    // タブツールバー（#tabtools）へボタン追加。接続状態表示(#connState)の前に挿入。
    addTabToolButton(opt) {
      const bar = document.getElementById('tabtools'); if (!bar) return null;
      const b = document.createElement('button');
      if (opt.id) b.id = opt.id;
      b.textContent = opt.label || '';
      if (opt.title) b.title = opt.title;
      if (opt.className) b.className = opt.className;
      if (opt.onClick) b.onclick = opt.onClick;
      const st = document.getElementById('connState');
      if (st && st.parentNode === bar) bar.insertBefore(b, st); else bar.appendChild(b);
      return b;
    },
    // メニューへ項目追加。menuLabel='ファイル'/'表示' 等。item={label,action,onRun} or {sep:true}
    addMenuItem(menuLabel, item) {
      if (typeof MENUS === 'undefined') return;
      let mn = MENUS.find((m) => m.label === menuLabel);
      if (!mn) { mn = { label: menuLabel, items: [] }; MENUS.push(mn); }
      if (item.sep) { mn.items.push({ sep: true }); return; }
      mn.items.push({ label: item.label, a: item.action });
      if (item.action && item.onRun) menuActions[item.action] = item.onRun;
    },
    // メニュー以外からアクションハンドラを登録したい時
    onMenuAction(action, fn) { menuActions[action] = fn; },

    // ---- main との汎用IPC（プラグイン用。preload の api.plugin へ委譲） ----
    invoke(channel, payload) { return window.api.plugin.invoke(channel, payload); },
    send(channel, payload) { return window.api.plugin.send(channel, payload); },
    on(channel, cb) { return window.api.plugin.on(channel, cb); },

    // ---- コマンドパレット ----
    registerCommand(cmd) { commands.push(cmd); },   // {icon,label,sub,run}
    commands() { return commands.slice(); },

    // ---- セッション右クリックメニューの拡張 ----
    // fn(session) => [{label,fn} or {sep:true}, ...]（空配列可）
    addSessionMenuItem(fn) { sessionMenuFns.push(fn); },
    sessionMenuItems(session) { const out = []; for (const f of sessionMenuFns) { try { const r = f(session); if (Array.isArray(r)) out.push(...r); } catch (_) {} } return out; },

    // ---- 接続プロトコルの拡張（RDP 等、xterm 以外のタブ種別） ----
    // def = { id:'rdp', openTab(session)->Promise }。openTab はタブ生成〜接続まで担う。
    registerProtocol(def) { if (def && def.id) protocols[def.id] = def; },
    hasProtocol(id) { return !!protocols[id]; },
    openProtocolTab(session) { const p = protocols[session && session.protocol]; return (p && p.openTab) ? p.openTab(session) : null; },

    // ---- 受信データフック ----
    onData(fn) { dataObservers.push(fn); },             // 観測（config取得 等）
    onDataTransform(fn) { dataTransforms.push(fn); },   // 変換（出力ハイライト 等）
    // ---- 入力フック（ユーザーがタブに打った文字。コマンド履歴等） ----
    onInput(fn) { inputSubs.push(fn); },
    // ---- アクティブタブ変更フック（ツールバーボタンの状態更新等） ----
    onActiveTabChange(fn) { activeTabSubs.push(fn); },
    // ---- タブ移動（別ウィンドウから引き継ぎ）フック ----
    onTabAdopt(fn) { tabAdoptSubs.push(fn); },

    // ---- 本体内部への橋渡し（SETTINGS/activeId 等は init で再代入されるため getter） ----
    get api() { return window.api; },
    $(sel) { return document.querySelector(sel); },
    get SETTINGS() { return SETTINGS; },
    saveSettings() { return saveSettings(); },
    get DB() { return DB; },
    get SNIPPETS() { return SNIPPETS; },
    persistSessions() { return persistSessions(); },
    renderSessions() { return renderSessions(); },
    get tabs() { return tabs; },
    get activeId() { return activeId; },
    activeTab() { return tabs.get(activeId); },
    openSession(s) { return openSession(s); },
    openEditor(id) { return openEditor(id); },
    runMenuAction(a) { return runMenuAction(a); },
    sendSnippet(sn) { return sendSnippet(sn); },
    toast(msg, err) { return toast(msg, err); },
    showMenu(x, y, items) { return showMenu(x, y, items); },
    elx(tag, cls, txt) { return elx(tag, cls, txt); },
    uid() { return uid(); },

    // ---- 本体から呼ばれる内部フック ----
    _observeData(data, tab) { for (const f of dataObservers) { try { f(data, tab); } catch (_) {} } },
    _transformData(data, tab) { let out = data; for (const f of dataTransforms) { try { out = f(out, tab); } catch (_) {} } return out; },
    _emitInput(id, data) { for (const f of inputSubs) { try { f(id, data); } catch (_) {} } },
    _activeTabChanged() { for (const f of activeTabSubs) { try { f(); } catch (_) {} } },
    _tabAdopted(tab) { for (const f of tabAdoptSubs) { try { f(tab); } catch (_) {} } },
    _runMenuAction(action) { const fn = menuActions[action]; if (fn) { try { fn(); } catch (e) { toast('実行エラー: ' + e.message, true); } return true; } return false; },
    afterActivate(fn) { bootHooks.push(fn); },

    // ---- 起動オーケストレーション ----
    async boot(coreInit) {
      try { await loadAll(); } catch (e) { console.error('[WT] プラグイン読込失敗', e); }
      await coreInit();
      for (const p of plugins) {
        if (typeof p.activate === 'function') {
          try { p.activate(WT); } catch (e) { console.error('[WT] activate 失敗', p.id, e); }
        }
      }
      for (const fn of bootHooks) { try { fn(); } catch (_) {} }
      try { if (typeof renderMenuBar === 'function') renderMenuBar(); } catch (_) {}
    },

    // 実行中に 1 プラグインをライブ投入（フォルダ監視でファイルが増えた時）。
    //   CSS/パネル/renderer.js を注入 → 新規 register 分だけ activate → メニュー再描画。
    async loadOne(m) {
      if (!m) return false;
      try {
        if (m.styleUrl) injectCss(m.styleUrl);
        if (m.panelHtml) injectPanel(m.panelHtml);
        const beforeP = plugins.length, beforeB = bootHooks.length;
        if (m.rendererUrl) { const ok = await injectScript(m.rendererUrl); if (!ok) return false; }
        for (let i = beforeP; i < plugins.length; i++) {
          const p = plugins[i];
          if (typeof p.activate === 'function') { try { p.activate(WT); } catch (e) { console.error('[WT] activate 失敗', p.id, e); } }
        }
        for (let i = beforeB; i < bootHooks.length; i++) { try { bootHooks[i](); } catch (_) {} }
        try { if (typeof renderMenuBar === 'function') renderMenuBar(); } catch (_) {}
        return true;
      } catch (e) { console.error('[WT] loadOne 失敗', e); return false; }
    },
  };

  // 有効プラグインの資産（CSS/パネル/スクリプト）を注入
  function injectCss(url) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l); }
  function injectPanel(html) {
    let c = document.getElementById('pluginPanels');
    if (!c) { c = document.createElement('div'); c.id = 'pluginPanels'; document.body.appendChild(c); }
    c.insertAdjacentHTML('beforeend', html);
  }
  function injectScript(url) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = url; s.onload = () => resolve(true);
      s.onerror = () => { console.error('[WT] スクリプト読込失敗', url); resolve(false); };
      document.body.appendChild(s);
    });
  }
  async function loadAll() {
    let list = [];
    try { list = (await window.api.plugins.manifests()) || []; } catch (_) { list = []; }
    // CSS とパネルHTML を先に（renderer スクリプトが DOM を参照できるように）
    for (const m of list) { if (m.styleUrl) injectCss(m.styleUrl); if (m.panelHtml) injectPanel(m.panelHtml); }
    // renderer スクリプトを順に注入（各 renderer.js が WT.register を呼ぶ）
    for (const m of list) { if (m.rendererUrl) await injectScript(m.rendererUrl); }
  }

  window.WT = WT;
})();
