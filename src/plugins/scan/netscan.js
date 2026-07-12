'use strict';
// ---------------------------------------------------------------------------
// 内蔵ネットワークツールキット
//   - ping sweep : サブネット/範囲を ping.exe で死活確認（逆引き付き）
//   - port scan  : TCP connect スキャン（並列・タイムアウト付き）
//   - arp        : `arp -a` をパースして近傍ホスト一覧
//   - snmp walk  : SNMP v2c GetNext を自前 BER で実装（UDP 161）
//   run(kind, params, ctx) は「キャンセル関数」を返す。
//   ctx = { onResult(row), onProgress({done,total,label}), onEnd(summary) }
// ---------------------------------------------------------------------------
const cp = require('child_process');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const iconv = require('iconv-lite');

function ipToInt(ip) { const p = ip.split('.').map(Number); if (p.length !== 4 || p.some((x) => isNaN(x) || x < 0 || x > 255)) return null; return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }
function intToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }

// "192.168.10.0/24" / "192.168.10.10-50" / "192.168.10.5" / カンマ区切り → IP配列
function expandTargets(spec, maxHosts) {
  const out = [];
  const seen = new Set();
  const push = (ip) => { if (!seen.has(ip)) { seen.add(ip); out.push(ip); } };
  for (let part of String(spec || '').split(',')) {
    part = part.trim(); if (!part) continue;
    let m;
    if ((m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(part))) {
      const base = ipToInt(m[1]); const bits = parseInt(m[2], 10);
      if (base == null || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const netAddr = (base & mask) >>> 0;
      const size = bits >= 31 ? (1 << (32 - bits)) : (1 << (32 - bits));
      const first = bits >= 31 ? netAddr : netAddr + 1;       // /31,/32 は全部、それ以外はネット/ブロードキャストを除く
      const lastN = bits >= 31 ? netAddr + size - 1 : netAddr + size - 2;
      for (let n = first; n <= lastN; n++) { push(intToIp(n >>> 0)); if (out.length >= maxHosts) return out; }
    } else if ((m = /^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/.exec(part))) {
      const pre = m[1]; const a = parseInt(m[2], 10), b = parseInt(m[3], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 255; i++) { push(pre + '.' + i); if (out.length >= maxHosts) return out; }
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(part)) { push(part); }
    if (out.length >= maxHosts) break;
  }
  return out;
}

// 並列実行プール（cancel対応）
function pool(items, concurrency, worker, onProgress, onDone) {
  let idx = 0, active = 0, done = 0, cancelled = false;
  const total = items.length;
  function next() {
    if (cancelled) return;
    while (active < concurrency && idx < total) {
      const item = items[idx++]; active++;
      Promise.resolve().then(() => worker(item)).catch(() => {}).then(() => {
        active--; done++;
        if (onProgress) onProgress({ done, total });
        if (done >= total && !cancelled) { if (onDone) onDone(); }
        else next();
      });
    }
  }
  next();
  return () => { cancelled = true; };
}

function reverseDns(ip, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(''); } }, timeoutMs || 800);
    try { dns.reverse(ip, (err, names) => { if (settled) return; settled = true; clearTimeout(t); resolve((!err && names && names[0]) || ''); }); }
    catch (_) { if (!settled) { settled = true; clearTimeout(t); resolve(''); } }
  });
}

// ---- ping sweep ----
function runPingSweep(params, ctx) {
  const targets = expandTargets(params.target, 1024);
  if (!targets.length) { ctx.onEnd({ error: '対象が解析できません（例: 192.168.10.0/24）' }); return () => {}; }
  let alive = 0;
  const dec = (b) => { try { return iconv.decode(b, 'cp932'); } catch (_) { return b.toString('utf8'); } };
  const cancel = pool(targets, 40, (ip) => new Promise((resolve) => {
    let out = '';
    const child = cp.spawn('ping', ['-n', '1', '-w', String(params.timeout || 600), ip], { windowsHide: true });
    child.stdout.on('data', (b) => out += dec(b));
    child.on('error', () => resolve());
    child.on('close', async () => {
      const up = /TTL=\d+/i.test(out);
      if (up) {
        alive++;
        const rm = /[=<]\s*(\d+)\s*ms/i.exec(out) || /[=<]\s*(\d+)ms/i.exec(out);
        const host = await reverseDns(ip, 700);
        ctx.onResult({ ip, alive: true, rtt: rm ? rm[1] + ' ms' : '', host });
      }
      resolve();
    });
  }), (p) => ctx.onProgress({ done: p.done, total: p.total, label: `ping ${p.done}/${p.total}` }), () => ctx.onEnd({ total: targets.length, alive }));
  return cancel;
}

// ---- port scan ----
const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 1723, 3306, 3389, 5060, 5432, 5900, 8080, 8443, 8291, 161];
function parsePorts(spec) {
  if (!spec || !String(spec).trim()) return COMMON_PORTS.slice();
  const out = []; const seen = new Set();
  for (let part of String(spec).split(',')) {
    part = part.trim(); let m;
    if ((m = /^(\d+)-(\d+)$/.exec(part))) { for (let i = parseInt(m[1], 10); i <= parseInt(m[2], 10) && i <= 65535; i++) { if (!seen.has(i)) { seen.add(i); out.push(i); } } }
    else if (/^\d+$/.test(part)) { const n = parseInt(part, 10); if (n >= 1 && n <= 65535 && !seen.has(n)) { seen.add(n); out.push(n); } }
    if (out.length >= 5000) break;
  }
  return out;
}
const PORT_NAMES = { 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http', 110: 'pop3', 135: 'msrpc', 139: 'netbios', 143: 'imap', 443: 'https', 445: 'smb', 993: 'imaps', 995: 'pop3s', 1433: 'mssql', 1723: 'pptp', 3306: 'mysql', 3389: 'rdp', 5432: 'postgres', 5900: 'vnc', 8080: 'http-alt', 8443: 'https-alt', 8291: 'winbox', 161: 'snmp' };
function runPortScan(params, ctx) {
  const host = String(params.target || '').trim();
  if (!host) { ctx.onEnd({ error: 'ホスト/IPを入力してください' }); return () => {}; }
  const ports = parsePorts(params.ports);
  if (!ports.length) { ctx.onEnd({ error: 'ポート指定が不正です' }); return () => {}; }
  let open = 0;
  const cancel = pool(ports, 100, (port) => new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (state) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} if (state === 'open') { open++; ctx.onResult({ host, port, service: PORT_NAMES[port] || '', state: 'open' }); } resolve(); };
    sock.setTimeout(params.timeout || 1200);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('closed'));
    sock.once('error', () => finish('closed'));
    try { sock.connect(port, host); } catch (_) { finish('closed'); }
  }), (p) => ctx.onProgress({ done: p.done, total: p.total, label: `port ${p.done}/${p.total}` }), () => ctx.onEnd({ total: ports.length, open }));
  return cancel;
}

// ---- ARP テーブル ----
function runArp(params, ctx) {
  const dec = (b) => { try { return iconv.decode(b, 'cp932'); } catch (_) { return b.toString('utf8'); } };
  let cancelled = false;
  const child = cp.execFile('arp', ['-a'], { windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (cancelled) return;
    if (err && !stdout) { ctx.onEnd({ error: (err.message || 'arp 実行失敗') }); return; }
    const text = dec(stdout); let count = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F-]{11,17})\s+(\S+)/.exec(line);
      if (m) { count++; ctx.onResult({ ip: m[1], mac: m[2].toLowerCase(), type: m[3] }); }
    }
    ctx.onEnd({ total: count });
  });
  return () => { cancelled = true; try { child.kill(); } catch (_) {} };
}

// ---- SNMP v2c walk（自前 BER） ----
function encLen(n) { if (n < 0x80) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
function tlv(tag, content) { return Buffer.concat([Buffer.from([tag]), encLen(content.length), content]); }
function encInt(n) { const b = []; let v = n; if (v === 0) b.push(0); while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } if (b[0] & 0x80) b.unshift(0); return tlv(0x02, Buffer.from(b)); }
function encOid(oid) {
  const parts = oid.replace(/^\./, '').split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) { let v = parts[i]; const stack = [v & 0x7f]; v = Math.floor(v / 128); while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); } for (const s of stack) bytes.push(s); }
  return tlv(0x06, Buffer.from(bytes));
}
function buildSnmpGetNext(community, oid, reqId) {
  const varbind = tlv(0x30, Buffer.concat([encOid(oid), Buffer.from([0x05, 0x00])]));
  const varbinds = tlv(0x30, varbind);
  const pdu = tlv(0xa1, Buffer.concat([encInt(reqId), encInt(0), encInt(0), varbinds])); // GetNextRequest=0xa1
  return tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from(community, 'ascii')), pdu])); // version=1 (v2c)
}
function parseTlv(buf, off) { const tag = buf[off]; let len = buf[off + 1]; let p = off + 2; if (len & 0x80) { const nb = len & 0x7f; len = 0; for (let i = 0; i < nb; i++) len = (len << 8) + buf[p++]; } return { tag, len, vstart: p, vend: p + len, next: p + len }; }
function decodeOid(buf, s, e) { const out = []; const first = buf[s]; out.push(Math.floor(first / 40), first % 40); let v = 0; for (let i = s + 1; i < e; i++) { v = (v * 128) + (buf[i] & 0x7f); if (!(buf[i] & 0x80)) { out.push(v); v = 0; } } return out.join('.'); }
function decodeValue(buf, t) {
  const { tag, vstart, vend } = t; const slice = buf.subarray(vstart, vend);
  if (tag === 0x02 || tag === 0x41 || tag === 0x42 || tag === 0x43 || tag === 0x44 || tag === 0x46) { let n = 0; for (const b of slice) n = (n * 256) + b; return { type: tag === 0x43 ? 'TimeTicks' : tag === 0x41 ? 'Counter' : tag === 0x42 ? 'Gauge' : 'INTEGER', value: String(n) }; }
  if (tag === 0x04) { const printable = slice.every((c) => c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f)); return { type: 'STRING', value: printable ? slice.toString('utf8') : slice.toString('hex').replace(/(..)/g, '$1 ').trim() }; }
  if (tag === 0x06) return { type: 'OID', value: decodeOid(buf, vstart, vend) };
  if (tag === 0x40) return { type: 'IpAddress', value: Array.from(slice).join('.') };
  if (tag === 0x05) return { type: 'NULL', value: '' };
  if (tag === 0x80 || tag === 0x81 || tag === 0x82) return { type: 'endOfMib', value: '' };
  return { type: 'tag' + tag.toString(16), value: slice.toString('hex') };
}
function runSnmpWalk(params, ctx) {
  const host = String(params.target || '').trim();
  if (!host) { ctx.onEnd({ error: 'ホスト/IPを入力してください' }); return () => {}; }
  const community = params.community || 'public';
  const base = (params.oid || '1.3.6.1.2.1').replace(/^\./, '');
  const sock = dgram.createSocket('udp4');
  let reqId = 1000, current = base, count = 0, cancelled = false, timer = null;
  const MAX = parseInt(params.max, 10) || 200;
  function inSubtree(oid) { return oid === base || oid.startsWith(base + '.'); }
  function step() {
    if (cancelled) return;
    reqId++;
    const pkt = buildSnmpGetNext(community, current, reqId);
    clearTimeout(timer);
    timer = setTimeout(() => { finish(count ? '' : 'タイムアウト（コミュニティ名/到達性を確認）'); }, params.timeout || 2500);
    try { sock.send(pkt, parseInt(params.port, 10) || 161, host); } catch (e) { finish(e.message); }
  }
  function finish(error) { if (cancelled) return; cancelled = true; clearTimeout(timer); try { sock.close(); } catch (_) {} ctx.onEnd({ total: count, error: error || '' }); }
  sock.on('error', (e) => finish(e.message));
  sock.on('message', (msg) => {
    clearTimeout(timer);
    try {
      let t = parseTlv(msg, 0);                 // SEQUENCE
      let p = t.vstart;
      const ver = parseTlv(msg, p); p = ver.next;
      const comm = parseTlv(msg, p); p = comm.next;
      const pdu = parseTlv(msg, p);             // PDU (0xa2 = Response)
      let q = pdu.vstart;
      const rid = parseTlv(msg, q); q = rid.next;
      const errStat = parseTlv(msg, q); q = errStat.next;
      const errIdx = parseTlv(msg, q); q = errIdx.next;
      const vbList = parseTlv(msg, q);          // SEQUENCE of varbind
      let r = vbList.vstart;
      const vb = parseTlv(msg, r);              // first varbind SEQUENCE
      let s = vb.vstart;
      const oidT = parseTlv(msg, s); s = oidT.next;
      const valT = parseTlv(msg, s);
      const oid = decodeOid(msg, oidT.vstart, oidT.vend);
      const val = decodeValue(msg, valT);
      if (val.type === 'endOfMib' || !inSubtree(oid) || oid === current) { finish(''); return; }
      count++; ctx.onResult({ oid, type: val.type, value: val.value });
      ctx.onProgress({ done: count, total: 0, label: `snmp ${count}` });
      current = oid;
      if (count >= MAX) { finish(''); return; }
      step();
    } catch (e) { finish('応答の解析に失敗: ' + e.message); }
  });
  step();
  return () => { cancelled = true; clearTimeout(timer); try { sock.close(); } catch (_) {} };
}

function run(kind, params, ctx) {
  if (kind === 'ping') return runPingSweep(params, ctx);
  if (kind === 'port') return runPortScan(params, ctx);
  if (kind === 'arp') return runArp(params, ctx);
  if (kind === 'snmp') return runSnmpWalk(params, ctx);
  ctx.onEnd({ error: '不明な種別' });
  return () => {};
}

module.exports = { run, expandTargets, parsePorts };
