'use strict';
// 出力ハイライト / キーワード通知 — レンダラ（highlight プラグイン）
//   受信データ変換フック WT.onDataTransform で色付け。全セッション共通ルール。
//   本体グローバル（$, toast, SETTINGS, saveSettings）を利用。
(function () {
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
      if (line) {
        let re = null; try { re = new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (_) {}
        out.push({ kw: line, notify, ansi: HL_COLORS[color] || HL_COLORS.yellow, re });
      }
    }
    return out;
  }
  function applyHighlights(data, t) {
    if (!HL_RULES.length || !data) return data;
    let out = data;
    for (const r of HL_RULES) {
      if (!r.re) continue; // 正規表現は事前コンパイル済み（チャンク毎の再コンパイルを回避）
      const before = out;
      out = out.replace(r.re, (mm) => r.ansi + mm + '\x1b[0m');
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

  // ---- プラグイン登録 ----
  WT.register('highlight', {
    activate(WT) {
      HL_RULES = parseHighlightRules(SETTINGS.highlightText);
      WT.onDataTransform((data, tab) => applyHighlights(data, tab));
      WT.onMenuAction('highlight', openHighlight);
      WT.addMenuItem('表示', { label: '出力ハイライト設定…', action: 'highlight', onRun: openHighlight });
      WT.registerCommand({ icon: '🖍', label: '出力ハイライト設定', run: () => openHighlight() });
      $('#hlCancel').onclick = () => $('#hlModal').classList.add('hidden');
      $('#hlSave').onclick = saveHighlight;
    },
  });
})();
