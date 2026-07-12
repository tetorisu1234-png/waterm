'use strict';
// マクロ（簡易 expect/send ＋ TTL）— レンダラ（macro プラグイン）
//   受信データは WT.onData で購読し、実行中の MacroRunner / TTL IO へ流す。
//   本体グローバル（tabs, activeId, api.*, setState, askText, toast,
//   persistSessions, SETTINGS）＋ ttl.js の TtlInterpreter を利用。
(function () {
  // 文字列リテラルのエスケープ展開: \n \r \t \\ \" \xHH
  function macroUnescape(s) {
    return s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (m, c) => {
      if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t';
      if (c === '0') return '\0'; if (c === '\\') return '\\'; if (c === '"') return '"';
      if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
      return c;
    });
  }
  // 1行を {cmd, arg} に解釈。引数は "..." または素のトークン
  function macroParseLine(line) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) return null;
    const sp = t.indexOf(' ');
    const cmd = (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
    let rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    let arg = rest;
    const q = rest.match(/^"((?:[^"\\]|\\.)*)"/);
    if (q) arg = macroUnescape(q[1]);
    return { cmd, arg, raw: rest };
  }
  class MacroRunner {
    constructor(tab, script) {
      this.tab = tab; this.id = tab.id;
      this.lines = script.split('\n');
      this.ip = 0; this.buf = ''; this.waiting = null; this.timer = null; this.stopped = false;
      this.defaultTimeout = 10000;
    }
    log(msg, color) { if (this.tab.term) this.tab.term.writeln('\x1b[' + (color || '35') + 'm[マクロ] ' + msg + '\x1b[0m'); }
    feed(data) {
      if (this.stopped || !this.waiting) return;
      this.buf += data;
      if (this.buf.length > 65536) this.buf = this.buf.slice(-65536);
      if (this.buf.indexOf(this.waiting.text) >= 0) {
        const w = this.waiting; this.waiting = null;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.buf = '';
        w.resolve(true);
      }
    }
    stop(reason) {
      if (this.stopped) return;
      this.stopped = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(false); }
      this.log('終了' + (reason ? '：' + reason : ''), '90');
      if (this.tab.macro === this) this.tab.macro = null;
      updateMacroBtn();
    }
    waitFor(text, timeoutMs) {
      return new Promise((resolve) => {
        this.waiting = { text, resolve };
        if (this.buf.indexOf(text) >= 0) { this.feed(''); return; }
        this.timer = setTimeout(() => {
          if (this.waiting) { this.waiting = null; this.log('待機タイムアウト: "' + text + '"', '31'); resolve(false); }
        }, timeoutMs || this.defaultTimeout);
      });
    }
    async run() {
      this.log('開始（' + this.lines.filter((l) => macroParseLine(l)).length + 'ステップ）');
      let curTimeout = this.defaultTimeout;
      while (this.ip < this.lines.length && !this.stopped) {
        const p = macroParseLine(this.lines[this.ip]); this.ip++;
        if (!p) continue;
        switch (p.cmd) {
          case 'wait': case 'expect': {
            if (!p.arg) break;
            const ok = await this.waitFor(p.arg, curTimeout);
            if (this.stopped) return;
            if (!ok) return this.stop('待機失敗で中断');
            break;
          }
          case 'send': api.connInput(this.id, p.arg); break;
          case 'sendln': api.connInput(this.id, p.arg + '\r'); break;
          case 'pause': case 'sleep': {
            const sec = parseFloat(p.raw) || 1;
            await new Promise((r) => { this.timer = setTimeout(r, sec * 1000); });
            if (this.stopped) return; break;
          }
          case 'timeout': curTimeout = (parseFloat(p.raw) || 10) * 1000; break;
          case 'print': case 'echo': this.log(p.arg || p.raw, '36'); break;
          default: this.log('不明なコマンド: ' + p.cmd, '33'); break;
        }
      }
      if (!this.stopped) this.stop('完了');
    }
  }
  function macroRunning(t) { return !!((t && t.macro && !t.macro.stopped) || (t && t.ttl && !t.ttl.done)); }
  function updateMacroBtn() {
    const t = tabs.get(activeId);
    const b = $('#btnMacro'); if (b) { b.textContent = macroRunning(t) ? '⏹ マクロ実行中' : '🤖 マクロ'; b.classList.toggle('hidden', !!(t && t.isEmbed)); }
  }
  function updateMacroHelp() {
    const ttl = $('#macroLang').value === 'ttl';
    $('#macroHelpSimple').classList.toggle('hidden', ttl);
    $('#macroHelpTtl').classList.toggle('hidden', !ttl);
  }
  function openMacro() {
    const t = tabs.get(activeId); if (!t) return;
    if (t.macro && !t.macro.stopped) { t.macro.stop('ユーザー停止'); return; }
    if (t.ttl && !t.ttl.done) { stopTtl(t); return; }
    $('#macroLang').value = (t.session && t.session.macroLang) || SETTINGS.lastMacroLang || 'simple';
    $('#macroScript').value = (t.session && t.session.macroScript) || SETTINGS.lastMacro || '';
    updateMacroHelp();
    $('#macroModal').classList.remove('hidden');
    $('#macroScript').focus();
  }
  function runMacroFromModal() {
    const t = tabs.get(activeId); if (!t) { $('#macroModal').classList.add('hidden'); return; }
    const script = $('#macroScript').value;
    const lang = $('#macroLang').value;
    SETTINGS.lastMacro = script; SETTINGS.lastMacroLang = lang; api.saveSettings(SETTINGS);
    if (t.session) { t.session.macroScript = script; t.session.macroLang = lang; persistSessions(); }
    $('#macroModal').classList.add('hidden');
    if (t.macro && !t.macro.stopped) t.macro.stop('再実行');
    if (t.ttl && !t.ttl.done) stopTtl(t);
    if (lang === 'ttl') { runTtl(t, script); return; }
    t.macro = new MacroRunner(t, script);
    updateMacroBtn();
    t.macro.run();
  }

  /* ---- TTL (Tera Term マクロ) ---- */
  function makeTtlIo(tab) {
    let buf = ''; let waiter = null;
    const io = {
      feed(data) { buf += data; if (buf.length > 65536) buf = buf.slice(-65536); if (waiter) waiter.check(); },
      cancel() { if (waiter) { clearTimeout(waiter.timer); const w = waiter; waiter = null; w.resolve({ index: 0, matched: '' }); } },
      async send(s) { api.connInput(tab.id, s); },
      async wait(pats, to) {
        return new Promise((resolve) => {
          const check = () => {
            for (let i = 0; i < pats.length; i++) { const j = pats[i] ? buf.indexOf(pats[i]) : -1; if (j >= 0) { buf = buf.slice(j + pats[i].length); if (waiter) clearTimeout(waiter.timer); waiter = null; resolve({ index: i + 1, matched: pats[i] }); return true; } }
            return false;
          };
          if (check()) return;
          const timer = setTimeout(() => { waiter = null; resolve({ index: 0, matched: '' }); }, Math.max(1, to) * 1000);
          waiter = { resolve, timer, check };
        });
      },
      async pause(ms) { await new Promise((r) => setTimeout(r, Math.max(0, ms || 0))); },
      async flush() { buf = ''; },
      async sendBreak() { if (tab.session && tab.session.protocol === 'serial') await api.serialBreak(tab.id); },
      async message(m, ti) { try { window.alert((ti ? '[' + ti + '] ' : '') + m); } catch (_) {} },
      async status(m) { setState(String(m)); },
      async inputbox(m, ti, d) { return await askText(m || '入力', { value: d || '' }); },
      async passwordbox(m, ti) { return await askText(m || 'パスワード', { password: true }); },
      async yesno(m, ti) { return window.confirm((ti ? '[' + ti + '] ' : '') + m) ? 1 : 0; },
      log(msg) { if (tab.term) tab.term.writeln('\x1b[35m[TTL] ' + msg + '\x1b[0m'); },
    };
    return io;
  }
  function runTtl(tab, script) {
    if (typeof TtlInterpreter === 'undefined') { toast('TTLエンジンが読み込まれていません', true); return; }
    const io = makeTtlIo(tab);
    tab.ttlIo = io;
    const interp = new TtlInterpreter(io, script, { defaultTimeout: 30, rand: Math.random });
    tab.ttl = { interp, done: false };
    if (tab.term) tab.term.writeln('\x1b[35m[TTL] マクロを開始します\x1b[0m');
    updateMacroBtn();
    interp.run().then((r) => {
      tab.ttl.done = true; tab.ttlIo = null;
      if (tab.term) {
        if (r.ok) tab.term.writeln('\x1b[32m[TTL] 完了しました\x1b[0m');
        else tab.term.writeln('\x1b[31m[TTL] エラー(' + (r.line || '?') + '行目): ' + r.error + '\x1b[0m');
      }
      if (activeId === tab.id) updateMacroBtn();
    });
  }
  function stopTtl(tab) {
    if (!tab.ttl || tab.ttl.done) return;
    try { tab.ttl.interp.stop(); } catch (_) {}
    try { if (tab.ttlIo) tab.ttlIo.cancel(); } catch (_) {}
    tab.ttl.done = true; tab.ttlIo = null;
    if (tab.term) tab.term.writeln('\x1b[90m[TTL] 停止しました\x1b[0m');
    updateMacroBtn();
  }

  // ---- プラグイン登録 ----
  WT.register('macro', {
    activate(WT) {
      WT.addTabToolButton({ id: 'btnMacro', label: '🤖 マクロ', title: '簡易マクロ (expect/send)', onClick: () => { const t = tabs.get(activeId); if (!t || t.isEmbed) return; openMacro(); } });
      // 受信データを実行中マクロ/TTLへ流す
      WT.onData((data, tab) => { if (tab.macro) tab.macro.feed(data); if (tab.ttlIo) tab.ttlIo.feed(data); });
      WT.onActiveTabChange(updateMacroBtn);
      // モーダル配線
      $('#macroCancel').onclick = () => $('#macroModal').classList.add('hidden');
      $('#macroRun').onclick = runMacroFromModal;
      $('#macroLang').onchange = updateMacroHelp;
      $('#macroLoad').onclick = async () => {
        const r = await api.loadTextFile(['ttl', 'txt', 'inc', 'mac']);
        if (r && r.ok) { $('#macroScript').value = r.content; if (/\.(ttl|inc|mac)$/i.test(r.name)) $('#macroLang').value = 'ttl'; updateMacroHelp(); toast(r.name + ' を読み込みました'); }
        else if (r && r.error) toast('読込に失敗: ' + r.error, true);
      };
    },
  });
})();
