'use strict';
// コマンドパレット (Ctrl+K) ＋ コマンド履歴 — レンダラ（palette プラグイン）
//   本体グローバル（$, elx, toast, DB, SNIPPETS, tabs, activeId, openSession,
//   sendSnippet, runMenuAction, SETTINGS, saveSettings, api）を利用。
//   ユーザー入力は WT.onInput で購読して履歴を蓄積、コマンドは WT.commands()。
(function () {
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
  let _cmdHistSaveTimer = null;
  function commitCmd(line) {
    const cmd = (line || '').trim();
    if (cmd.length < 1 || cmd.length > 400) return;
    const i = CMD_HISTORY.indexOf(cmd); if (i >= 0) CMD_HISTORY.splice(i, 1);
    CMD_HISTORY.unshift(cmd);
    if (CMD_HISTORY.length > 300) CMD_HISTORY.length = 300;
    // 保存はデバウンス（Enter毎のsettings.json書き込みを避ける）
    clearTimeout(_cmdHistSaveTimer);
    _cmdHistSaveTimer = setTimeout(() => { SETTINGS.cmdHistory = CMD_HISTORY.slice(0, 200); saveSettings(); }, 4000);
  }
  function wirePalette() {
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
      ['プラグイン管理', 'plugins'],
    ];
    for (const a of acts) items.push({ icon: '⚙', label: 'コマンド: ' + a[0], sub: '', run: () => runMenuAction(a[1]) });
    // プラグインが登録したコマンド
    for (const c of WT.commands()) items.push({ icon: c.icon || '⚙', label: 'コマンド: ' + c.label, sub: c.sub || '', run: c.run });
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

  // ---- プラグイン登録 ----
  WT.register('palette', {
    activate(WT) {
      WT.addToolbarButton({ id: 'btnPalette', label: '⌘ パレット', title: 'コマンドパレット (Ctrl+K)', onClick: () => togglePalette() });
      WT.onInput((id, d) => recordCmdInput(id, d));
      wirePalette();
    },
  });
})();
