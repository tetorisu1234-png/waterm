'use strict';
// ===========================================================================
// 最小 ZIP コーデック（Node 組み込み zlib のみ・依存追加なし）
//   プラグインを 1 つの圧縮ファイル(.wtp / .zip)として扱うための読み書き。
//   - zipRead(buf)  : [{name, data:Buffer, dir:bool}] を返す（stored/deflate 対応）
//   - zipWrite(list): [{name, data:Buffer}] を 1 つの zip Buffer にまとめる
//   小さなテキスト資産（plugin.json/*.js/*.html）向け。ZIP64 非対応
//   （4GB 超・65535 エントリ超は想定しない）。エントリのサイズ/CRC は信頼できる
//   セントラルディレクトリ側から読むため、データ記述子(flag bit3)付き zip も可。
// ===========================================================================
const zlib = require('zlib');

// CRC-32（IEEE 802.3）テーブル
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// [{name, data:Buffer}] → zip Buffer
function zipWrite(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data);
    let method = 8;
    let comp = zlib.deflateRawSync(data);
    if (comp.length >= data.length) { method = 0; comp = data; } // 圧縮で縮まなければ無圧縮格納
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LOCAL, 0);
    lfh.writeUInt16LE(20, 4);        // version needed
    lfh.writeUInt16LE(0x0800, 6);    // flags: bit11 = UTF-8 ファイル名
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);        // mod time（固定＝決定的出力）
    lfh.writeUInt16LE(0x21, 12);     // mod date（1980-01-01）
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);        // extra len
    parts.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(SIG_CENTRAL, 0);
    cdh.writeUInt16LE(20, 4);        // version made by
    cdh.writeUInt16LE(20, 6);        // version needed
    cdh.writeUInt16LE(0x0800, 8);    // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);        // extra
    cdh.writeUInt16LE(0, 32);        // comment
    cdh.writeUInt16LE(0, 34);        // disk #
    cdh.writeUInt16LE(0, 36);        // internal attrs
    cdh.writeUInt32LE(0, 38);        // external attrs
    cdh.writeUInt32LE(offset, 42);   // local header offset
    central.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);         // comment len
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// zip Buffer → [{name, data:Buffer, dir:bool}]
function zipRead(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip として短すぎます');
  // EOCD を末尾から探索（コメント最大 64KB を考慮）
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD が見つかりません（zip ではない）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // セントラルディレクトリ開始
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('セントラルヘッダ不正');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    // Windows PowerShell 5.1 の Compress-Archive は区切りに '\\' を使う（仕様違反）
    // ため、'/' に正規化して取り込む。
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error('ローカルヘッダ不正');
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const isDir = name.endsWith('/');
    let data;
    if (isDir) data = Buffer.alloc(0);
    else if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('未対応の圧縮方式: ' + method);
    out.push({ name, data, dir: isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { crc32, zipRead, zipWrite };
