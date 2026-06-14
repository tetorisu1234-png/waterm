'use strict';
// ---------------------------------------------------------------------------
// TTL (Tera Term Language) マクロ インタプリタ（実用サブセット）
//   - I/O は io オブジェクトで抽象化（renderer は端末/ダイアログ、test はモック）
//   - 対応: 変数/式, if/elseif/else/endif, while/endwhile, for/next,
//           do/loop[while|until], break/continue/goto/:label/call/return/end,
//           sendln/send/wait/waitln/wait4all/flushrecv/pause/mpause/sendbreak,
//           inputbox/passwordbox/getpassword/yesnobox/messagebox/statusbox,
//           strlen/str2int/int2str/strcompare/strconcat/copy/strscan/
//           tolower/toupper/sprintf/random
//   io (すべて async 可): send(str), wait(patterns[],timeoutSec)->{index,matched},
//       pause(ms), flush(), sendBreak(), inputbox(msg,title,def)->str|null,
//       passwordbox(msg,title)->str|null, yesno(msg,title)->1|0,
//       message(msg,title), status(msg,title), log(msg)
// ---------------------------------------------------------------------------
(function (root) {
  function isIdStart(c) { return /[A-Za-z_]/.test(c); }
  function isIdChar(c) { return /[A-Za-z0-9_]/.test(c); }

  // ブロックコメント /* */ を文字列を尊重して除去
  function stripBlockComments(src) {
    let out = ''; let i = 0; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === "'" || c === '"') { // 文字列はそのまま
        const q = c; out += c; i++;
        while (i < n && src[i] !== q) { out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2; out += ' ';
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  // 1行をトークン列へ（; 以降はコメント）
  function tokenizeLine(line) {
    const toks = []; let i = 0; const n = line.length;
    while (i < n) {
      const c = line[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === ';') break; // コメント
      if (c === "'" || c === '"') {
        const q = c; i++; let s = '';
        while (i < n && line[i] !== q) { s += line[i]; i++; }
        i++; toks.push({ k: 'str', v: s });
        continue;
      }
      if (c === '#') { // 文字コード #65 / #$41 / #$x
        i++; let hex = false;
        if (line[i] === '$') { hex = true; i++; }
        let num = '';
        while (i < n && /[0-9a-fA-Fx]/.test(line[i])) { num += line[i]; i++; }
        const code = hex ? parseInt(num, 16) : parseInt(num, 10);
        toks.push({ k: 'str', v: String.fromCharCode(code & 0xffff) });
        continue;
      }
      if (c === '$') { // $1F 16進数
        i++; let num = '';
        while (i < n && /[0-9a-fA-F]/.test(line[i])) { num += line[i]; i++; }
        toks.push({ k: 'num', v: parseInt(num, 16) || 0 });
        continue;
      }
      if (/[0-9]/.test(c)) {
        let num = c; i++;
        if (c === '0' && (line[i] === 'x' || line[i] === 'X')) { num += line[i]; i++; while (i < n && /[0-9a-fA-F]/.test(line[i])) { num += line[i]; i++; } toks.push({ k: 'num', v: parseInt(num, 16) || 0 }); continue; }
        while (i < n && /[0-9]/.test(line[i])) { num += line[i]; i++; }
        toks.push({ k: 'num', v: parseInt(num, 10) });
        continue;
      }
      if (isIdStart(c)) {
        let id = c; i++;
        while (i < n && isIdChar(line[i])) { id += line[i]; i++; }
        toks.push({ k: 'id', v: id });
        continue;
      }
      // 演算子・記号
      const two = line.substr(i, 2);
      if (two === '<>' || two === '<=' || two === '>=' || two === '==' || two === '!=') { toks.push({ k: 'op', v: two === '==' ? '=' : (two === '!=' ? '<>' : two) }); i += 2; continue; }
      if (c === ':') { toks.push({ k: 'op', v: ':' }); i++; continue; }
      if ('=<>+-*/%(),&|!'.indexOf(c) >= 0) { toks.push({ k: 'op', v: c }); i++; continue; }
      i++; // 未知文字は無視
    }
    return toks;
  }

  const KW = new Set(['if', 'then', 'elseif', 'else', 'endif', 'while', 'endwhile', 'for', 'to', 'next', 'do', 'loop', 'until', 'break', 'continue', 'goto', 'call', 'return', 'end', 'exit', 'and', 'or', 'xor', 'not']);

  class TtlInterpreter {
    constructor(io, script, opts) {
      this.io = io;
      this.opts = opts || {};
      this.vars = new Map();
      this.vars.set('result', 0);
      this.vars.set('inputstr', '');
      this.vars.set('timeout', 0);
      this.vars.set('matchstr', '');
      this.lines = stripBlockComments(String(script)).split(/\r?\n/).map(tokenizeLine);
      this.labels = {}; this.openMap = {}; this.endMap = {};
      this.ifInfo = {}; this.endifOf = {};
      this.enclosingLoop = {}; this.loopType = {};
      this.forVar = {}; this.forEnd = {};
      this.callStack = [];
      this.stopped = false; this.steps = 0;
      this._prescan();
    }
    kw(idx) { const t = this.lines[idx]; if (!t || !t.length) return ''; if (t[0].k === 'op' && t[0].v === ':') return ':'; return (t[0].k === 'id') ? t[0].v.toLowerCase() : ''; }
    isMultilineIf(idx) { const t = this.lines[idx]; return t.length && t[t.length - 1].k === 'id' && t[t.length - 1].v.toLowerCase() === 'then'; }
    _prescan() {
      const st = []; const loopSt = [];
      for (let i = 0; i < this.lines.length; i++) {
        this.enclosingLoop[i] = loopSt.length ? loopSt[loopSt.length - 1] : null;
        const k = this.kw(i);
        if (k === ':') { const name = (this.lines[i][1] && this.lines[i][1].v || '').toLowerCase(); if (name) this.labels[name] = i; continue; }
        if (k === 'if' && this.isMultilineIf(i)) { st.push({ t: 'if', line: i, clauses: [{ line: i, kind: 'if' }] }); }
        else if (k === 'elseif') { const f = st[st.length - 1]; if (f && f.t === 'if') f.clauses.push({ line: i, kind: 'elseif' }); }
        else if (k === 'else') { const f = st[st.length - 1]; if (f && f.t === 'if') f.clauses.push({ line: i, kind: 'else' }); }
        else if (k === 'endif') { const f = st.pop(); if (f) { this.ifInfo[f.line] = { clauses: f.clauses, endif: i }; for (const c of f.clauses) this.endifOf[c.line] = i; this.endMap[i] = f.line; } }
        else if (k === 'while') { st.push({ t: 'while', line: i }); loopSt.push(i); this.loopType[i] = 'while'; }
        else if (k === 'endwhile') { const f = st.pop(); if (f) { this.openMap[f.line] = i; this.endMap[i] = f.line; } loopSt.pop(); }
        else if (k === 'for') { st.push({ t: 'for', line: i }); loopSt.push(i); this.loopType[i] = 'for'; }
        else if (k === 'next') { const f = st.pop(); if (f) { this.openMap[f.line] = i; this.endMap[i] = f.line; } loopSt.pop(); }
        else if (k === 'do') { st.push({ t: 'do', line: i }); loopSt.push(i); this.loopType[i] = 'do'; }
        else if (k === 'loop') { const f = st.pop(); if (f) { this.openMap[f.line] = i; this.endMap[i] = f.line; } loopSt.pop(); }
      }
    }
    // ---- 変数 ----
    getVar(name) { const k = name.toLowerCase(); return this.vars.has(k) ? this.vars.get(k) : ''; }
    setVar(name, val) { this.vars.set(name.toLowerCase(), val); }
    // ---- 式評価 ----
    toStr(v) { return (typeof v === 'number') ? String(v) : String(v); }
    toNum(v) { if (typeof v === 'number') return v; const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
    parseExpr(toks, pos) { return this._or(toks, pos); }
    _or(t, p) { let r = this._and(t, p); while (r.pos < t.length && this._is(t[r.pos], 'id', 'or')) { const rhs = this._and(t, r.pos + 1); r = { val: (this.toNum(r.val) || this.toNum(rhs.val)) ? 1 : 0, pos: rhs.pos }; } return r; }
    _and(t, p) { let r = this._cmp(t, p); while (r.pos < t.length && this._is(t[r.pos], 'id', 'and')) { const rhs = this._cmp(t, r.pos + 1); r = { val: (this.toNum(r.val) && this.toNum(rhs.val)) ? 1 : 0, pos: rhs.pos }; } return r; }
    _cmp(t, p) {
      let r = this._add(t, p);
      while (r.pos < t.length && t[r.pos].k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t[r.pos].v)) {
        const op = t[r.pos].v; const rhs = this._add(t, r.pos + 1);
        const a = r.val, b = rhs.val;
        let res;
        const bothNum = (typeof a === 'number' && typeof b === 'number');
        const ca = bothNum ? a : this.toStr(a), cb = bothNum ? b : this.toStr(b);
        if (op === '=') res = (ca === cb); else if (op === '<>') res = (ca !== cb);
        else if (op === '<') res = (ca < cb); else if (op === '>') res = (ca > cb);
        else if (op === '<=') res = (ca <= cb); else res = (ca >= cb);
        r = { val: res ? 1 : 0, pos: rhs.pos };
      }
      return r;
    }
    _add(t, p) {
      let r = this._mul(t, p);
      while (r.pos < t.length && t[r.pos].k === 'op' && (t[r.pos].v === '+' || t[r.pos].v === '-')) {
        const op = t[r.pos].v; const rhs = this._mul(t, r.pos + 1);
        if (op === '+') { r = { val: (typeof r.val === 'number' && typeof rhs.val === 'number') ? r.val + rhs.val : this.toStr(r.val) + this.toStr(rhs.val), pos: rhs.pos }; }
        else { r = { val: this.toNum(r.val) - this.toNum(rhs.val), pos: rhs.pos }; }
      }
      return r;
    }
    _mul(t, p) {
      let r = this._unary(t, p);
      while (r.pos < t.length && t[r.pos].k === 'op' && ['*', '/', '%'].includes(t[r.pos].v)) {
        const op = t[r.pos].v; const rhs = this._unary(t, r.pos + 1);
        const a = this.toNum(r.val), b = this.toNum(rhs.val);
        r = { val: op === '*' ? a * b : op === '/' ? (b ? Math.trunc(a / b) : 0) : (b ? a % b : 0), pos: rhs.pos };
      }
      return r;
    }
    _unary(t, p) {
      if (p < t.length && t[p].k === 'op' && t[p].v === '-') { const r = this._unary(t, p + 1); return { val: -this.toNum(r.val), pos: r.pos }; }
      if (p < t.length && t[p].k === 'op' && t[p].v === '!') { const r = this._unary(t, p + 1); return { val: this.toNum(r.val) ? 0 : 1, pos: r.pos }; }
      if (p < t.length && this._is(t[p], 'id', 'not')) { const r = this._unary(t, p + 1); return { val: this.toNum(r.val) ? 0 : 1, pos: r.pos }; }
      return this._primary(t, p);
    }
    _primary(t, p) {
      const tk = t[p];
      if (!tk) return { val: '', pos: p };
      if (tk.k === 'num') return { val: tk.v, pos: p + 1 };
      if (tk.k === 'str') return { val: tk.v, pos: p + 1 };
      if (tk.k === 'op' && tk.v === '(') { const r = this.parseExpr(t, p + 1); let np = r.pos; if (t[np] && t[np].k === 'op' && t[np].v === ')') np++; return { val: r.val, pos: np }; }
      if (tk.k === 'id') return { val: this.getVar(tk.v), pos: p + 1 };
      return { val: '', pos: p + 1 };
    }
    _is(tk, k, v) { return tk && tk.k === k && tk.v.toLowerCase() === v; }
    evalSlice(toks) { if (!toks.length) return ''; return this.parseExpr(toks, 0).val; }
    // 残りトークンを順に評価し文字列連結（sendln 等の引数）
    argsConcat(toks, start) { let s = ''; let p = start; while (p < toks.length) { const r = this.parseExpr(toks, p); s += this.toStr(r.val); if (r.pos <= p) p++; else p = r.pos; } return s; }
    // 残りを式リストへ（wait 等：各パターン）
    exprList(toks, start) { const out = []; let p = start; while (p < toks.length) { const r = this.parseExpr(toks, p); out.push(r.val); if (r.pos <= p) p++; else p = r.pos; } return out; }
    // 変数名として最初のトークンを取り、残りを評価
    timeoutSec() { const t = this.toNum(this.getVar('timeout')); return t > 0 ? t : (this.opts.defaultTimeout || 30); }

    async run() {
      let pc = 0;
      try {
        while (pc < this.lines.length && !this.stopped) {
          if (++this.steps > 2000000) throw new Error('実行ステップ数の上限に達しました（無限ループの可能性）');
          const next = await this.execLine(pc);
          pc = (next == null) ? pc + 1 : next;
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message, line: pc + 1 };
      }
    }
    stop() { this.stopped = true; }

    async execLine(pc) {
      const toks = this.lines[pc];
      if (!toks || !toks.length) return null;
      const k = this.kw(pc);
      if (k === ':') return null; // ラベル
      // 代入: id = expr
      if (toks[0].k === 'id' && toks[1] && toks[1].k === 'op' && toks[1].v === '=') {
        this.setVar(toks[0].v, this.evalSlice(toks.slice(2)));
        return null;
      }
      return await this.execStmt(toks, pc);
    }

    async execStmt(toks, pc) {
      const io = this.io;
      const cmd = (toks[0].k === 'id') ? toks[0].v.toLowerCase() : '';
      switch (cmd) {
        // ---- 通信 ----
        case 'sendln': await io.send(this.argsConcat(toks, 1) + '\r'); return null;
        case 'send': await io.send(this.argsConcat(toks, 1)); return null;
        case 'sendbreak': if (io.sendBreak) await io.sendBreak(); return null;
        case 'flushrecv': if (io.flush) await io.flush(); return null;
        case 'pause': await io.pause(this.toNum(this.evalSlice(toks.slice(1))) * 1000); return null;
        case 'mpause': await io.pause(this.toNum(this.evalSlice(toks.slice(1)))); return null;
        case 'wait': case 'waitln': {
          const pats = this.exprList(toks, 1).map((v) => this.toStr(v));
          const r = await io.wait(pats, this.timeoutSec());
          this.setVar('result', r.index); this.setVar('matchstr', r.matched || '');
          return null;
        }
        case 'wait4all': {
          const pats = this.exprList(toks, 1).map((v) => this.toStr(v));
          let all = true;
          for (const pat of pats) { const r = await io.wait([pat], this.timeoutSec()); if (!r.index) { all = false; break; } }
          this.setVar('result', all ? 1 : 0);
          return null;
        }
        // ---- ダイアログ ----
        case 'messagebox': { const m = this.argEvalN(toks, 1, 2); await io.message(m[0], m[1] || ''); return null; }
        case 'statusbox': { const m = this.argEvalN(toks, 1, 2); if (io.status) await io.status(m[0], m[1] || ''); return null; }
        case 'inputbox': { const m = this.argEvalN(toks, 1, 3); const r = await io.inputbox(m[0], m[1] || '', m[2] || ''); this.setVar('inputstr', r == null ? '' : r); this.setVar('result', r == null ? 0 : 1); return null; }
        case 'passwordbox': { const m = this.argEvalN(toks, 1, 2); const r = await io.passwordbox(m[0], m[1] || ''); this.setVar('inputstr', r == null ? '' : r); this.setVar('result', r == null ? 0 : 1); return null; }
        case 'getpassword': { // getpassword 'file' 'key' passvar → 簡易: パスワード入力
          const file = this.evalArg(toks, 1); const r = await io.passwordbox('パスワードを入力 (' + this.toStr(this.evalArg(toks, 2)) + ')', this.toStr(file));
          const nm = this.argName(toks, 3); if (nm) this.setVar(nm, r == null ? '' : r); this.setVar('result', r == null ? 0 : 1); return null;
        }
        case 'yesnobox': { const m = this.argEvalN(toks, 1, 2); const r = await io.yesno(m[0], m[1] || ''); this.setVar('result', r ? 1 : 0); return null; }
        // ---- 文字列/数値関数 ----
        case 'strlen': { const s = this.toStr(this.evalArg(toks, 1)); this.setVar('result', s.length); return null; }
        case 'str2int': { const nm = this.argName(toks, 1); const s = this.toStr(this.evalArg(toks, 2)); const v = parseInt(s, 10); if (nm) this.setVar(nm, isNaN(v) ? 0 : v); this.setVar('result', isNaN(v) ? 0 : 1); return null; }
        case 'int2str': { const nm = this.argName(toks, 1); const v = this.toNum(this.evalArg(toks, 2)); if (nm) this.setVar(nm, String(v)); return null; }
        case 'strcompare': { const a = this.toStr(this.evalArg(toks, 1)); const b = this.toStr(this.evalArg(toks, 2)); this.setVar('result', a < b ? -1 : a > b ? 1 : 0); return null; }
        case 'strconcat': { const nm = this.argName(toks, 1); const add = this.toStr(this.evalArg(toks, 2)); if (nm) this.setVar(nm, this.toStr(this.getVar(nm)) + add); return null; }
        case 'strscan': { const s = this.toStr(this.evalArg(toks, 1)); const key = this.toStr(this.evalArg(toks, 2)); this.setVar('result', s.indexOf(key) + 1); return null; }
        case 'copy': { const nm = this.argName(toks, 1); const s = this.toStr(this.evalArg(toks, 2)); const from = this.toNum(this.evalArg(toks, 3)); const len = this.toNum(this.evalArg(toks, 4)); if (nm) this.setVar(nm, s.substr(from - 1, len)); return null; }
        case 'tolower': { const nm = this.argName(toks, 1); const s = this.toStr(this.evalArg(toks, 2)); if (nm) this.setVar(nm, s.toLowerCase()); return null; }
        case 'toupper': { const nm = this.argName(toks, 1); const s = this.toStr(this.evalArg(toks, 2)); if (nm) this.setVar(nm, s.toUpperCase()); return null; }
        case 'random': { const nm = this.argName(toks, 1); const max = this.toNum(this.evalArg(toks, 2)); if (nm) this.setVar(nm, Math.floor((this.opts.rand ? this.opts.rand() : 0.5) * (max + 1))); return null; }
        // ---- 制御 ----
        case 'goto': { const nm = (toks[1] && toks[1].v || '').toLowerCase(); if (this.labels[nm] == null) throw new Error('未定義のラベル: ' + nm); return this.labels[nm]; }
        case 'call': { const nm = (toks[1] && toks[1].v || '').toLowerCase(); if (this.labels[nm] == null) throw new Error('未定義のラベル: ' + nm); this.callStack.push(pc + 1); return this.labels[nm]; }
        case 'return': return this.callStack.length ? this.callStack.pop() : this.lines.length;
        case 'end': case 'exit': case 'closett': case 'disconnect': this.stopped = true; return null;
        case 'connect': if (io.log) io.log('connect は無視されました（すでに接続済み）'); return null;
        case 'if': return await this.execIf(toks, pc);
        case 'elseif': case 'else': return (this.endifOf[pc] != null) ? this.endifOf[pc] + 1 : null;
        case 'endif': return null;
        case 'while': { const cond = this.toNum(this.evalSlice(toks.slice(1))); return cond ? null : (this.openMap[pc] + 1); }
        case 'endwhile': return this.endMap[pc];
        case 'for': return this.execFor(toks, pc);
        case 'next': { const fl = this.endMap[pc]; const vn = this.forVar[fl]; const v = this.toNum(this.getVar(vn)) + 1; this.setVar(vn, v); return (v > this.forEnd[fl]) ? null : fl + 1; }
        case 'do': return null;
        case 'loop': return this.execLoop(toks, pc);
        case 'break': { const ol = this.enclosingLoop[pc]; if (ol == null) throw new Error('break はループ外です'); return this.openMap[ol] + 1; }
        case 'continue': { const ol = this.enclosingLoop[pc]; if (ol == null) throw new Error('continue はループ外です'); const ty = this.loopType[ol]; return (ty === 'while') ? ol : this.openMap[ol]; }
        default:
          if (io.log) io.log('未対応または不明なコマンド: ' + cmd);
          return null;
      }
    }
    // 引数を「式」で1つ評価（最初のトークン位置 idx は引数番号 1..）
    argSlices(toks) { // トークンを引数ごとに分割（空白＝引数境界は使わず、式単位で分割）
      const args = []; let p = 1;
      while (p < toks.length) { const r = this.parseExpr(toks, p); args.push({ val: r.val, start: p }); p = (r.pos <= p) ? p + 1 : r.pos; }
      return args;
    }
    evalArg(toks, n) { const a = this.argSlices(toks); return a[n - 1] ? a[n - 1].val : ''; }
    argEvalN(toks, start, count) { const a = this.argSlices(toks); const out = []; for (let i = 0; i < count; i++) out.push(a[i] ? a[i].val : ''); return out; }
    argName(toks, n) { const a = this.argSlices(toks); const slot = a[n - 1]; if (!slot) return null; const tk = toks[slot.start]; return (tk && tk.k === 'id') ? tk.v : null; }
    async execIf(toks, pc) {
      const thenIdx = toks.findIndex((t) => t.k === 'id' && t.v.toLowerCase() === 'then');
      if (thenIdx >= 0 && thenIdx === toks.length - 1) {
        // 複数行 if
        const cond = this.toNum(this.parseExpr(toks.slice(1, thenIdx), 0).val);
        if (cond) return null;
        const info = this.ifInfo[pc]; if (!info) return null;
        for (let i = 1; i < info.clauses.length; i++) {
          const c = info.clauses[i];
          if (c.kind === 'else') return c.line + 1;
          const ct = this.lines[c.line];
          const ti = ct.findIndex((t) => t.k === 'id' && t.v.toLowerCase() === 'then');
          const cc = this.toNum(this.parseExpr(ct.slice(1, ti < 0 ? ct.length : ti), 0).val);
          if (cc) return c.line + 1;
        }
        return info.endif + 1;
      }
      // 1行 if: if <expr> <statement>
      const r = this.parseExpr(toks, 1);
      if (this.toNum(r.val)) { const sub = toks.slice(r.pos); if (sub.length) return await this.execStmt(sub, pc); }
      return null;
    }
    execFor(toks, pc) {
      // for var [=] start to end   /  for var start end
      let p = 1; const vn = (toks[p] && toks[p].k === 'id') ? toks[p].v : 'i'; p++;
      if (toks[p] && toks[p].k === 'op' && toks[p].v === '=') p++;
      const sr = this.parseExpr(toks, p); let start = this.toNum(sr.val); p = sr.pos;
      if (toks[p] && toks[p].k === 'id' && toks[p].v.toLowerCase() === 'to') p++;
      const er = this.parseExpr(toks, p); const end = this.toNum(er.val);
      this.setVar(vn, start); this.forVar[pc] = vn; this.forEnd[pc] = end;
      return (start > end) ? this.openMap[pc] + 1 : null;
    }
    execLoop(toks, pc) {
      const doLine = this.endMap[pc];
      if (toks.length > 1 && toks[1].k === 'id') {
        const w = toks[1].v.toLowerCase();
        if (w === 'while') { const c = this.toNum(this.evalSlice(toks.slice(2))); return c ? doLine + 1 : null; }
        if (w === 'until') { const c = this.toNum(this.evalSlice(toks.slice(2))); return c ? null : doLine + 1; }
      }
      return doLine + 1; // bare loop（break 前提）
    }
  }

  const api = { TtlInterpreter, tokenizeLine, stripBlockComments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TtlInterpreter = TtlInterpreter;
})(typeof window !== 'undefined' ? window : globalThis);
