'use strict';
// ネットワーク診断（ローカル ping / tracert / nslookup）— レンダラ（diag プラグイン）
//   本体グローバル（$, toast, SETTINGS, saveSettings, api, tabs 相当は WT 経由）を利用。
//   main との通信は WT.invoke/send/on 経由（チャンネル: diag:*）。
(function () {
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
    const r = await WT.invoke('diag:run', { kind, host, count });
    if (!(r && r.ok)) { diagRunning = false; updateDiagButtons(); diagAppend('[エラー] ' + ((r && r.error) || '実行できませんでした') + '\n'); }
  }
  function wireDiag() {
    WT.on('diag:data', (p) => diagAppend(p.text));
    WT.on('diag:end', (p) => { diagRunning = false; updateDiagButtons(); diagAppend('— 終了' + (p && p.code != null ? '（code ' + p.code + '）' : '') + (p && p.error ? ' ' + p.error : '') + ' —\n'); });
    $('#diagPing').onclick = () => runDiag('ping');
    $('#diagTracert').onclick = () => runDiag('tracert');
    $('#diagNslookup').onclick = () => runDiag('nslookup');
    $('#diagStop').onclick = () => WT.send('diag:stop');
    $('#diagClear').onclick = () => { $('#diagOut').textContent = ''; };
    $('#diagCopy').onclick = () => { const txt = $('#diagOut').textContent; if (txt) { api.clipboardWrite(txt); toast('診断結果をコピーしました'); } };
    $('#diagClose').onclick = () => { WT.send('diag:stop'); $('#diagModal').classList.add('hidden'); };
    $('#diagHost').onkeydown = (e) => { if (e.key === 'Enter') runDiag('ping'); };
  }

  // ---- プラグイン登録 ----
  WT.register('diag', {
    activate(WT) {
      WT.addTabToolButton({ id: 'btnDiag', label: '🔧 診断', title: 'ネットワーク診断（自分のPCから ping / tracert を実行）', onClick: () => { const t = WT.activeTab(); openDiag(t && t.session ? (t.session.host || '') : ''); } });
      WT.addSessionMenuItem((s) => (s && s.host ? [{ label: '診断 (ping/tracert)', fn: () => openDiag(s.host) }] : []));
      WT.registerCommand({ icon: '🔧', label: 'ネットワーク診断', run: () => openDiag('') });
      wireDiag();
    },
  });
})();
