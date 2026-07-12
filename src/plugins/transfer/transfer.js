'use strict';
// ---------------------------------------------------------------------------
// ファイル転送プロトコル (XMODEM / XMODEM-1K / YMODEM)
//   - シリアル/Telnet/SSH の生バイトストリーム上で動作
//   - async/await + バイトキュー方式。全ての待機にタイムアウトとリトライ上限あり
//   - ZMODEM / Kermit は同ファイルに順次追加予定
// ---------------------------------------------------------------------------

const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15;
const CAN = 0x18, C = 0x43, SUB = 0x1a;

// CRC-16/CCITT (XMODEM, poly=0x1021, init=0)
function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

// 受信バイトを蓄積し、必要バイト数を非同期に取り出すキュー
class ByteQueue {
  constructor() { this.chunks = []; this.len = 0; this.waiter = null; this.aborted = false; }
  push(buf) {
    if (!buf || !buf.length) return;
    this.chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    this.len += buf.length;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }
  abort() { this.aborted = true; if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  _take(n) {
    const out = Buffer.alloc(n); let off = 0;
    while (off < n) {
      const c = this.chunks[0]; const need = n - off;
      if (c.length <= need) { c.copy(out, off); off += c.length; this.chunks.shift(); this.len -= c.length; }
      else { c.copy(out, off, 0, need); this.chunks[0] = c.slice(need); this.len -= need; off += need; }
    }
    return out;
  }
  // 最大 timeoutMs 待って n バイト読む。揃わなければ null（バイトは温存）
  read(n, timeoutMs) {
    return new Promise((resolve) => {
      let to = null;
      const done = (v) => { if (to) clearTimeout(to); this.waiter = null; resolve(v); };
      const check = () => {
        if (this.aborted) { done(null); return true; }
        if (this.len >= n) { done(this._take(n)); return true; }
        return false;
      };
      if (check()) return;
      this.waiter = () => { check(); };
      to = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
    });
  }
  async readByte(timeoutMs) { const b = await this.read(1, timeoutMs); return b ? b[0] : null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 受信 (XMODEM=1ファイル / YMODEM=複数ファイル)
// ---------------------------------------------------------------------------
async function xyRecv(o) {
  const q = o.q, send = o.send, log = o.log, ymodem = !!o.ymodem;
  const sb = (b) => send(Buffer.from([b]));
  const cancel = () => { try { send(Buffer.from([CAN, CAN, CAN, CAN, CAN])); } catch (_) {} };
  const files = [];

  for (;;) { // ファイル単位ループ
    let crcMode = true;
    let header = null;
    // --- 開始ネゴ：'C'(CRC)を送出してヘッダ待ち。無音時のみ再送し、ノイズ(コマンドエコー等)は捨てて待つ ---
    sb(C);
    const negStart = Date.now();
    let noResp = 0;
    while (header === null) {
      if (Date.now() - negStart > 45000) { cancel(); return { ok: false, error: '転送開始がタイムアウトしました' }; }
      const b = await q.readByte(3000);
      if (b === null) { // 無音 → 'C'/NAK 再送（数回で checksum へ）
        noResp++;
        if (noResp >= 4) crcMode = false;
        if (noResp > 12) { cancel(); return { ok: false, error: '転送開始がタイムアウトしました' }; }
        sb(crcMode ? C : NAK);
        continue;
      }
      if (b === SOH || b === STX) { header = b; break; }
      if (b === EOT) { sb(ACK); return { ok: true, files }; }
      if (b === CAN) { return { ok: false, error: '相手がキャンセルしました' }; }
      // それ以外（コマンドエコー等のノイズ）は捨てて継続
    }

    let expect = ymodem ? 0 : 1;
    let sawHeader0 = false;
    const cur = { name: null, size: null, parts: [], received: 0 };

    for (;;) { // ブロック受信ループ
      if (header === EOT) {
        sb(ACK);
        let buf = Buffer.concat(cur.parts);
        if (cur.size != null) buf = buf.slice(0, cur.size);
        else { let end = buf.length; while (end > 0 && buf[end - 1] === SUB) end--; buf = buf.slice(0, end); }
        const savePath = await o.saveFile(cur.name, buf);
        files.push({ name: cur.name || (savePath ? savePath.split(/[\\/]/).pop() : 'file'), size: buf.length, path: savePath });
        log('受信完了: ' + (cur.name || savePath) + ' (' + buf.length + ' バイト)');
        if (!ymodem) return { ok: true, files };
        break; // YMODEM: 次ファイルへ（外側 for を継続）
      }
      if (header === CAN) { return { ok: false, error: '相手がキャンセルしました' }; }
      if (header !== SOH && header !== STX) {
        sb(NAK);
        const nh = await q.readByte(3000);
        if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; }
        header = nh; continue;
      }

      const len = header === SOH ? 128 : 1024;
      const blk = await q.readByte(1000);
      const blkc = await q.readByte(1000);
      const data = await q.read(len, 8000);
      const crc = await q.read(crcMode ? 2 : 1, 3000);
      if (blk === null || blkc === null || data === null || crc === null) {
        sb(NAK);
        const nh = await q.readByte(3000);
        if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; }
        header = nh; continue;
      }
      // 検証（ブロック番号の補数 + CRC/チェックサム）
      let valid = (blk === ((~blkc) & 0xff));
      if (valid) {
        if (crcMode) { const c = crc16(data); valid = (crc[0] === ((c >> 8) & 0xff) && crc[1] === (c & 0xff)); }
        else { let s = 0; for (const x of data) s = (s + x) & 0xff; valid = (crc[0] === s); }
      }
      if (!valid) { sb(NAK); const nh = await q.readByte(3000); if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; } header = nh; continue; }

      if (blk === ((expect - 1) & 0xff)) { // 重複（前のACK紛失）
        sb(ACK); const nh = await q.readByte(3000); if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; } header = nh; continue;
      }
      if (blk !== (expect & 0xff)) { cancel(); return { ok: false, error: 'ブロック同期ずれ（期待 ' + expect + ' / 受信 ' + blk + '）' }; }

      if (ymodem && !sawHeader0 && expect === 0) {
        sawHeader0 = true;
        const z = data.indexOf(0);
        const name = data.slice(0, z < 0 ? data.length : z).toString('latin1');
        if (name === '') { sb(ACK); return { ok: true, files }; } // 終端ブロック0
        const meta = data.slice(z + 1).toString('latin1').trim().split(/\s+/);
        cur.name = name; cur.size = parseInt(meta[0] || '0', 10) || null;
        log('受信開始: ' + name + (cur.size != null ? ' (' + cur.size + ' バイト)' : ''));
        sb(ACK); expect = 1; crcMode = true; sb(C);
        const nh = await q.readByte(3000); if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; } header = nh; continue;
      }

      // データブロック
      cur.parts.push(data); cur.received += len; sb(ACK);
      if (o.progress) o.progress({ name: cur.name, received: cur.size != null ? Math.min(cur.received, cur.size) : cur.received, total: cur.size });
      expect = (expect + 1) & 0xff;
      const nh = await q.readByte(3000); if (nh === null) { cancel(); return { ok: false, error: '受信タイムアウト' }; } header = nh;
    }
  }
}

// ---------------------------------------------------------------------------
// 送信 (XMODEM / XMODEM-1K / YMODEM)
// ---------------------------------------------------------------------------
function makeBlock(num, data, len, crcMode, pad) {
  const head = Buffer.from([len === 128 ? SOH : STX, num & 0xff, (~num) & 0xff]);
  const body = Buffer.alloc(len, pad == null ? SUB : pad);
  data.copy(body);
  let tail;
  if (crcMode) { const c = crc16(body); tail = Buffer.from([(c >> 8) & 0xff, c & 0xff]); }
  else { let s = 0; for (const x of body) s = (s + x) & 0xff; tail = Buffer.from([s]); }
  return Buffer.concat([head, body, tail]);
}

async function xySend(o) {
  const q = o.q, send = o.send, log = o.log, ymodem = !!o.ymodem, use1k = !!o.use1k;
  const sb = (b) => send(Buffer.from([b]));

  // 受信側の最初のトリガ（'C'=CRC / NAK=checksum）を待つ
  const waitTrigger = async (timeoutTotal) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutTotal) {
      const b = await q.readByte(1000);
      if (b === null) continue;
      if (b === C) return true;
      if (b === NAK) return false;
      if (b === CAN) throw new Error('受信側がキャンセルしました');
    }
    throw new Error('受信側の応答がありません');
  };
  const sendBlock = async (num, data, len, crcMode, pad) => {
    for (let retry = 0; retry < 10; retry++) {
      send(makeBlock(num, data, len, crcMode, pad));
      const b = await q.readByte(4000);
      if (b === null) continue;
      if (b === ACK) return;
      if (b === CAN) throw new Error('受信側がキャンセルしました');
      // NAK 等は再送
    }
    throw new Error('ブロック ' + num + ' のACKが得られません');
  };
  const sendEot = async () => {
    for (let retry = 0; retry < 10; retry++) {
      sb(EOT);
      const b = await q.readByte(3000);
      if (b === ACK) return;
    }
  };

  const files = o.files || [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    let crcMode = await waitTrigger(60000);

    if (ymodem) {
      // ブロック0：ファイル名\0サイズ
      const meta = (f.name || 'file') + '\0' + (f.data.length) + ' ';
      const b0 = Buffer.from(meta, 'latin1');
      await sendBlock(0, b0, 128, crcMode, 0x00);
      crcMode = await waitTrigger(30000); // データ転送開始の 'C'
    }

    const blockLen = use1k ? 1024 : 128;
    let pos = 0, num = 1;
    while (pos < f.data.length) {
      const chunk = f.data.slice(pos, pos + blockLen);
      // 残りが 128 以下なら 128 ブロックで送る（互換性・効率）
      const len = (use1k && chunk.length > 128) ? 1024 : 128;
      await sendBlock(num, chunk, len, crcMode);
      pos += chunk.length; num = (num + 1) & 0xff;
      if (o.progress) o.progress({ name: f.name, sent: Math.min(pos, f.data.length), total: f.data.length });
    }
    await sendEot();
    log('送信完了: ' + (f.name || '') + ' (' + f.data.length + ' バイト)');
  }

  if (ymodem) {
    // 終端ブロック0（全ゼロ）
    try {
      const crcMode = await waitTrigger(15000);
      await sendBlock(0, Buffer.alloc(0), 128, crcMode, 0x00);
    } catch (_) { /* 受信側が既に終了している場合あり */ }
  }
  return { ok: true, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ZMODEM (sz/rz 互換)
// ---------------------------------------------------------------------------
const Z = {
  ZRQINIT: 0, ZRINIT: 1, ZSINIT: 2, ZACK: 3, ZFILE: 4, ZSKIP: 5, ZNAK: 6, ZABORT: 7,
  ZFIN: 8, ZRPOS: 9, ZDATA: 10, ZEOF: 11, ZFERR: 12, ZCRC: 13, ZCHALLENGE: 14,
  ZCOMPL: 15, ZCAN: 16, ZFREECNT: 17, ZCOMMAND: 18, ZSTDERR: 19,
};
const ZPAD = 0x2a, ZDLE = 0x18, ZHEX = 0x42, ZBIN = 0x41, ZBIN32 = 0x43;
const ZCRCE = 0x68, ZCRCG = 0x69, ZCRCQ = 0x6a, ZCRCW = 0x6b, ZRUB0 = 0x6c, ZRUB1 = 0x6d;
const CANFDX = 0x01, CANOVIO = 0x04, CANFC32 = 0x20;

// CRC-32 (reflected, poly 0xEDB88320)
const CRC32TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32upd = (crc, b) => (CRC32TAB[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;

// ZDLE エスケープ（制御文字を安全化）
function escByte(arr, c) {
  c &= 0xff;
  if (c === ZDLE || c === 0x10 || c === 0x11 || c === 0x13 || c === 0x90 || c === 0x91 || c === 0x93) {
    arr.push(ZDLE, c ^ 0x40);
  } else arr.push(c);
}
function posBytes(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function bytesToPos(h) { return ((h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0); }

// 16進ヘッダ生成（制御フレーム用）
function buildHexHeader(type, hdr4) {
  const crc = crc16(Buffer.from([type, hdr4[0], hdr4[1], hdr4[2], hdr4[3]]));
  const hx = (v) => v.toString(16).padStart(2, '0');
  let s = hx(type) + hx(hdr4[0]) + hx(hdr4[1]) + hx(hdr4[2]) + hx(hdr4[3]) + hx((crc >> 8) & 0xff) + hx(crc & 0xff);
  const out = [ZPAD, ZPAD, ZDLE, ZHEX];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  out.push(0x0d, 0x0a);
  if (type !== Z.ZACK && type !== Z.ZFIN) out.push(0x11); // XON
  return Buffer.from(out);
}
// バイナリ32ヘッダ生成（ZFILE/ZDATA用）
function buildBin32Header(type, hdr4) {
  const arr = [ZPAD, ZDLE, ZBIN32];
  const bytes = [type, hdr4[0], hdr4[1], hdr4[2], hdr4[3]];
  let crc = 0xffffffff;
  for (const b of bytes) crc = crc32upd(crc, b);
  crc = (~crc) >>> 0;
  for (const b of bytes) escByte(arr, b);
  for (const b of [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]) escByte(arr, b);
  return Buffer.from(arr);
}
// データサブパケット（CRC32）
function buildSubpacket32(dataBuf, frameend) {
  const arr = [];
  let crc = 0xffffffff;
  for (const b of dataBuf) { escByte(arr, b); crc = crc32upd(crc, b); }
  crc = crc32upd(crc, frameend);
  arr.push(ZDLE, frameend);
  crc = (~crc) >>> 0;
  for (const b of [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]) escByte(arr, b);
  return Buffer.from(arr);
}

// ZDLE デコード付き 1単位読み取り → {kind:'d',v} | {kind:'e',c} | null
async function zget(q, timeoutMs) {
  const b = await q.readByte(timeoutMs);
  if (b === null) return null;
  if (b !== ZDLE) return { kind: 'd', v: b };
  const b2 = await q.readByte(3000);
  if (b2 === null) return null;
  if (b2 === ZCRCE || b2 === ZCRCG || b2 === ZCRCQ || b2 === ZCRCW) return { kind: 'e', c: b2 };
  if (b2 === ZRUB0) return { kind: 'd', v: 0x7f };
  if (b2 === ZRUB1) return { kind: 'd', v: 0xff };
  return { kind: 'd', v: (b2 ^ 0x40) & 0xff };
}

// ヘッダ受信（ZPAD→ZDLE→format を探してパース） → {type, hdr[4], format} | null
async function zRecvHeader(q, timeoutMs) {
  const t0 = Date.now();
  let zpad = false;
  for (;;) {
    if (Date.now() - t0 > timeoutMs) return null;
    const b = await q.readByte(timeoutMs);
    if (b === null) return null;
    if (b === ZPAD || b === 0xaa) { zpad = true; continue; }
    if (b === ZDLE && zpad) {
      const fb = await q.readByte(3000); if (fb === null) return null;
      const f = fb & 0x7f;
      if (f === ZHEX) {
        const rh = async () => { const a = await q.readByte(3000), c = await q.readByte(3000); if (a === null || c === null) return null; const v = parseInt(String.fromCharCode(a & 0x7f) + String.fromCharCode(c & 0x7f), 16); return isNaN(v) ? null : v; };
        const type = await rh(); const h = [];
        for (let i = 0; i < 4; i++) { const v = await rh(); if (v === null) return null; h.push(v); }
        await rh(); // crc16（簡略のため検証省略）
        await q.readByte(1500); await q.readByte(1500); // CR LF
        if (type === null) return null;
        return { type, hdr: h, format: 'hex' };
      }
      if (f === ZBIN || f === ZBIN32) {
        const use32 = f === ZBIN32;
        const rd = async () => { const g = await zget(q, 3000); return (g && g.kind === 'd') ? g.v : null; };
        const type = await rd(); const h = [];
        for (let i = 0; i < 4; i++) { const v = await rd(); if (v === null) return null; h.push(v); }
        for (let i = 0; i < (use32 ? 4 : 2); i++) await rd(); // CRC（簡略のため検証省略）
        if (type === null) return null;
        return { type, hdr: h, format: use32 ? 'bin32' : 'bin16' };
      }
      zpad = false; continue;
    }
    zpad = false;
  }
}

// データサブパケット受信 → {data:Buffer, frameend, ok} | null
async function zRecvSubpacket(q, use32) {
  const data = [];
  for (;;) {
    const g = await zget(q, 10000);
    if (g === null) return null;
    if (g.kind === 'd') { data.push(g.v); if (data.length > 8 * 1024 * 1024) return null; continue; }
    const frameend = g.c;
    const n = use32 ? 4 : 2; const cb = [];
    for (let i = 0; i < n; i++) { const cg = await zget(q, 3000); if (cg === null || cg.kind !== 'd') return null; cb.push(cg.v); }
    const buf = Buffer.from(data);
    let ok;
    if (use32) {
      let crc = 0xffffffff;
      for (const b of buf) crc = crc32upd(crc, b);
      crc = crc32upd(crc, frameend); crc = (~crc) >>> 0;
      const exp = ((cb[0] | (cb[1] << 8) | (cb[2] << 16) | (cb[3] << 24)) >>> 0);
      ok = (crc === exp);
    } else {
      const c = crc16(Buffer.from([...data, frameend]));
      ok = (c === ((cb[0] << 8) | cb[1]));
    }
    return { data: buf, frameend, ok };
  }
}

async function zmodemRecv(o) {
  const q = o.q, send = o.send, log = o.log || (() => {});
  const caps = [0, 0, 0, CANFDX | CANOVIO | CANFC32];
  const sendHex = (type, hdr) => send(buildHexHeader(type, hdr || [0, 0, 0, 0]));
  const files = [];
  let cur = null;
  let idle = 0;

  sendHex(Z.ZRINIT, caps);
  for (;;) {
    const h = await zRecvHeader(q, 20000);
    if (h === null) {
      if (++idle > 6) { send(Buffer.from([ZDLE, ZRUB1])); return { ok: false, error: 'ZMODEMヘッダ待ちタイムアウト' }; }
      sendHex(Z.ZRINIT, caps); continue;
    }
    idle = 0;
    switch (h.type) {
      case Z.ZRQINIT: sendHex(Z.ZRINIT, caps); break;
      case Z.ZFILE: {
        const sp = await zRecvSubpacket(q, h.format !== 'bin16');
        if (!sp || !sp.ok) { sendHex(Z.ZNAK); break; }
        const z = sp.data.indexOf(0);
        const name = sp.data.slice(0, z < 0 ? sp.data.length : z).toString('latin1');
        const meta = sp.data.slice(z + 1).toString('latin1').trim().split(/\s+/);
        const size = parseInt(meta[0] || '0', 10);
        cur = { name, size: isNaN(size) ? null : size, parts: [], received: 0 };
        log('受信開始: ' + name + (cur.size != null ? ' (' + cur.size + ' バイト)' : ''));
        sendHex(Z.ZRPOS, [0, 0, 0, 0]);
        break;
      }
      case Z.ZDATA: {
        if (!cur) { sendHex(Z.ZRPOS, [0, 0, 0, 0]); break; }
        const use32 = h.format !== 'bin16';
        for (;;) {
          const sp = await zRecvSubpacket(q, use32);
          if (sp === null || !sp.ok) { sendHex(Z.ZRPOS, posBytes(cur.received)); break; }
          cur.parts.push(sp.data); cur.received += sp.data.length;
          if (o.progress) o.progress({ name: cur.name, received: cur.received, total: cur.size });
          if (sp.frameend === ZCRCQ || sp.frameend === ZCRCW) sendHex(Z.ZACK, posBytes(cur.received));
          if (sp.frameend === ZCRCE || sp.frameend === ZCRCW) break;
        }
        break;
      }
      case Z.ZEOF: {
        if (cur) {
          let buf = Buffer.concat(cur.parts);
          if (cur.size != null) buf = buf.slice(0, cur.size);
          const p = await o.saveFile(cur.name, buf);
          files.push({ name: cur.name, size: buf.length, path: p });
          log('受信完了: ' + cur.name + ' (' + buf.length + ' バイト)');
          cur = null;
        }
        sendHex(Z.ZRINIT, caps);
        break;
      }
      case Z.ZFIN:
        sendHex(Z.ZFIN, [0, 0, 0, 0]);
        await q.readByte(2000); await q.readByte(2000); // "OO"
        return { ok: true, files };
      case Z.ZSKIP: cur = null; sendHex(Z.ZRINIT, caps); break;
      default: sendHex(Z.ZRINIT, caps); break;
    }
  }
}

async function zmodemSend(o) {
  const q = o.q, send = o.send, log = o.log || (() => {});
  const files = o.files || [];
  const sendHex = (type, hdr) => send(buildHexHeader(type, hdr || [0, 0, 0, 0]));
  let fi = 0, fileHeaderSent = false, eofSent = false, idle = 0;

  sendHex(Z.ZRQINIT, [0, 0, 0, 0]);
  for (;;) {
    const h = await zRecvHeader(q, 20000);
    if (h === null) {
      if (++idle > 6) { send(Buffer.from([ZDLE, ZRUB1])); return { ok: false, error: '受信側の応答がありません' }; }
      sendHex(Z.ZRQINIT, [0, 0, 0, 0]); continue;
    }
    idle = 0;
    switch (h.type) {
      case Z.ZRINIT: {
        if (eofSent) { fi++; eofSent = false; fileHeaderSent = false; }
        if (fileHeaderSent) break;
        if (fi < files.length) {
          const f = files[fi];
          send(buildBin32Header(Z.ZFILE, [0, 0, 0, 0]));
          const meta = (f.name || 'file') + '\0' + f.data.length + ' 0 0 0 ' + (files.length - fi) + ' ' + f.data.length + '\0';
          send(buildSubpacket32(Buffer.from(meta, 'latin1'), ZCRCW));
          fileHeaderSent = true;
          log('送信開始: ' + (f.name || '') + ' (' + f.data.length + ' バイト)');
        } else {
          sendHex(Z.ZFIN, [0, 0, 0, 0]);
          await zRecvHeader(q, 10000); // 相手の ZFIN
          send(Buffer.from('OO', 'latin1'));
          return { ok: true, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
        }
        break;
      }
      case Z.ZRPOS: {
        const f = files[fi]; if (!f) break;
        let p = bytesToPos(h.hdr);
        if (p > f.data.length) p = f.data.length;
        send(buildBin32Header(Z.ZDATA, posBytes(p)));
        if (p >= f.data.length) {
          send(buildSubpacket32(Buffer.alloc(0), ZCRCE)); // 空ファイル
        } else {
          while (p < f.data.length) {
            const chunk = f.data.slice(p, p + 1024); p += chunk.length;
            const end = (p >= f.data.length) ? ZCRCE : ZCRCG;
            send(buildSubpacket32(chunk, end));
            if (o.progress) o.progress({ name: f.name, sent: p, total: f.data.length });
            if (end === ZCRCE) break;
          }
        }
        sendHex(Z.ZEOF, posBytes(f.data.length));
        eofSent = true;
        break;
      }
      case Z.ZSKIP: eofSent = true; break; // 次ファイルへ
      case Z.ZNAK: case Z.ZRPOS + 100: fileHeaderSent = false; break;
      case Z.ZFIN:
        send(Buffer.from('OO', 'latin1'));
        return { ok: true, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
      case Z.ZACK: case Z.ZEOF: break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------------
// Kermit (基本パケットプロトコル / check-type 1 / バイナリquoting)
// ---------------------------------------------------------------------------
const KSOH = 0x01, KQCTL = 0x23 /* # */, KQBIN = 0x26 /* & */;
const ktochar = (n) => (n + 32) & 0xff;
const kunchar = (c) => (c - 32) & 0xff;

// 1バイトをKermit quoting して out 配列へ（制御文字: #, 8thビット: &）
function kEncodeByte(out, b, bin) {
  let c = b & 0xff;
  if (bin && (c & 0x80)) { out.push(KQBIN); c &= 0x7f; }
  const c7 = c & 0x7f;
  if (c7 < 0x20 || c7 === 0x7f) { out.push(KQCTL); c = c ^ 0x40; }
  else if (c7 === KQCTL) out.push(KQCTL);
  else if (bin && c7 === KQBIN) out.push(KQCTL);
  out.push(c & 0xff);
}
function kEncode(buf, bin) { const out = []; for (const b of buf) kEncodeByte(out, b, bin); return Buffer.from(out).toString('latin1'); }
// Kermit quoting を解除
function kDecode(str, bin) {
  const out = [];
  for (let i = 0; i < str.length;) {
    let eight = false; let c = str.charCodeAt(i++);
    if (bin && c === KQBIN) { eight = true; c = str.charCodeAt(i++); }
    if (c === KQCTL) { const n = str.charCodeAt(i++); c = (n === KQCTL || (bin && n === KQBIN)) ? n : (n ^ 0x40); }
    if (eight) c |= 0x80;
    out.push(c & 0xff);
  }
  return Buffer.from(out);
}
// パケット生成（MARK LEN SEQ TYPE DATA CHECK CR、check-type 1）
function buildKermit(seq, type, dataStr) {
  const len = dataStr.length + 3;
  const inner = String.fromCharCode(ktochar(len)) + String.fromCharCode(ktochar(seq & 0x3f)) + type + dataStr;
  let s = 0; for (let i = 0; i < inner.length; i++) s += inner.charCodeAt(i);
  const chk = ktochar((s + ((s >> 6) & 0x03)) & 0x3f);
  return Buffer.from('\x01' + inner + String.fromCharCode(chk) + '\x0d', 'latin1');
}
// パケット受信 → {seq, type, data:Buffer, ok} | null
async function kRecvPacket(q, timeout) {
  let b; do { b = await q.readByte(timeout); if (b === null) return null; } while (b !== KSOH);
  const lenc = await q.readByte(timeout); if (lenc === null) return null;
  const len = kunchar(lenc);
  const seqc = await q.readByte(timeout); const typ = await q.readByte(timeout);
  if (seqc === null || typ === null) return null;
  const dataLen = len - 3; if (dataLen < 0 || dataLen > 200) return null;
  const data = [];
  for (let i = 0; i < dataLen; i++) { const c = await q.readByte(timeout); if (c === null) return null; data.push(c); }
  const chk = await q.readByte(timeout); if (chk === null) return null;
  let s = lenc + seqc + typ; for (const c of data) s += c;
  const calc = ktochar((s + ((s >> 6) & 0x03)) & 0x3f);
  return { seq: kunchar(seqc), type: String.fromCharCode(typ), data: Buffer.from(data), ok: calc === chk };
}
// Send-Init パラメータ（MAXL TIME NPAD PADC EOL QCTL QBIN CHKT REPT）
const K_INIT = String.fromCharCode(ktochar(94)) + String.fromCharCode(ktochar(10)) + String.fromCharCode(ktochar(0)) + String.fromCharCode(64) + String.fromCharCode(ktochar(13)) + '#' + '&' + '1' + ' ';

async function kermitSend(o) {
  const q = o.q, send = o.send, log = o.log || (() => {});
  const files = o.files || [];
  const bin = true;
  const sendAndAck = async (seq, type, data) => {
    for (let r = 0; r < 8; r++) {
      send(buildKermit(seq, type, data));
      const p = await kRecvPacket(q, 5000);
      if (p === null) continue;
      if (p.type === 'Y') return true;
      if (p.type === 'E') return false;
      // 'N' 等は再送
    }
    return false;
  };
  // Send-Init
  let inited = false;
  for (let r = 0; r < 8 && !inited; r++) {
    send(buildKermit(0, 'S', K_INIT));
    const p = await kRecvPacket(q, 5000);
    if (p && p.type === 'Y') inited = true;
  }
  if (!inited) return { ok: false, error: 'Send-Init応答なし' };

  let seq = 0;
  for (const f of files) {
    seq = (seq + 1) & 0x3f;
    if (!await sendAndAck(seq, 'F', kEncode(Buffer.from(f.name || 'file', 'latin1'), bin))) return { ok: false, error: 'ファイルヘッダNAK' };
    log('送信開始: ' + (f.name || '') + ' (' + f.data.length + ' バイト)');
    let pos = 0;
    while (pos < f.data.length) {
      const chunk = f.data.slice(pos, pos + 30); pos += chunk.length;
      seq = (seq + 1) & 0x3f;
      if (!await sendAndAck(seq, 'D', kEncode(chunk, bin))) return { ok: false, error: 'データ送信失敗' };
      if (o.progress) o.progress({ name: f.name, sent: pos, total: f.data.length });
    }
    seq = (seq + 1) & 0x3f;
    if (!await sendAndAck(seq, 'Z', '')) return { ok: false, error: 'EOF失敗' };
    log('送信完了: ' + (f.name || ''));
  }
  seq = (seq + 1) & 0x3f;
  await sendAndAck(seq, 'B', '');
  return { ok: true, files: files.map((f) => ({ name: f.name, size: f.data.length })) };
}

async function kermitRecv(o) {
  const q = o.q, send = o.send, log = o.log || (() => {});
  const bin = true;
  const files = [];
  let cur = null, idle = 0;
  const ack = (seq, data) => send(buildKermit(seq, 'Y', data || ''));
  send(buildKermit(0, 'N', '')); // 受信開始：NAK(seq0)で送信側を促す
  for (;;) {
    const p = await kRecvPacket(q, 3000);
    if (p === null) { if (++idle > 12) return { ok: false, error: 'Kermitパケット待ちタイムアウト' }; send(buildKermit(0, 'N', '')); continue; }
    idle = 0;
    if (!p.ok) { send(buildKermit(p.seq, 'N', '')); continue; }
    switch (p.type) {
      case 'S': ack(p.seq, K_INIT); break;
      case 'F': cur = { name: kDecode(p.data.toString('latin1'), bin).toString('latin1'), parts: [] }; log('受信開始: ' + cur.name); ack(p.seq); break;
      case 'D':
        if (cur) { const d = kDecode(p.data.toString('latin1'), bin); cur.parts.push(d); cur.received = (cur.received || 0) + d.length; if (o.progress) o.progress({ name: cur.name, received: cur.received, total: null }); }
        ack(p.seq); break;
      case 'Z':
        if (cur) { const buf = Buffer.concat(cur.parts); const path = await o.saveFile(cur.name, buf); files.push({ name: cur.name, size: buf.length, path }); log('受信完了: ' + cur.name + ' (' + buf.length + ' バイト)'); cur = null; }
        ack(p.seq); break;
      case 'B': ack(p.seq); return { ok: true, files };
      case 'E': return { ok: false, error: '相手がエラー: ' + p.data.toString('latin1') };
      default: ack(p.seq); break;
    }
  }
}

// ---------------------------------------------------------------------------
// ディスパッチャ：main から呼ぶ統合API
//   opts: { proto, dir, send, log, progress, done, files?, saveFile? }
//   返り値: { onData(buf), abort() }
// ---------------------------------------------------------------------------
function startTransfer(opts) {
  const q = new ByteQueue();
  const proto = opts.proto;
  const ymodem = proto === 'ymodem';
  const use1k = proto === 'xmodem1k' || proto === 'ymodem';
  const base = { q, send: opts.send, log: opts.log || (() => {}), progress: opts.progress, ymodem, use1k };

  const start = () => {
    let runner;
    if (proto === 'zmodem') {
      const z = { q, send: opts.send, log: opts.log || (() => {}), progress: opts.progress };
      runner = opts.dir === 'send'
        ? zmodemSend(Object.assign(z, { files: opts.files }))
        : zmodemRecv(Object.assign(z, { saveFile: opts.saveFile }));
    } else if (proto === 'kermit') {
      const k = { q, send: opts.send, log: opts.log || (() => {}), progress: opts.progress };
      runner = opts.dir === 'send'
        ? kermitSend(Object.assign(k, { files: opts.files }))
        : kermitRecv(Object.assign(k, { saveFile: opts.saveFile }));
    } else {
      runner = opts.dir === 'send'
        ? xySend(Object.assign({}, base, { files: opts.files }))
        : xyRecv(Object.assign({}, base, { saveFile: opts.saveFile }));
    }
    runner
      .then((r) => { if (opts.done) opts.done(r || { ok: true }); })
      .catch((e) => { if (opts.done) opts.done({ ok: false, error: e && e.message ? e.message : String(e) }); });
  };
  // 次ティックで開始（双方向クロス接続でも安全に変数を確定させる）
  Promise.resolve().then(start);

  return { onData: (buf) => q.push(buf), abort: () => q.abort() };
}

module.exports = { startTransfer, crc16 };
