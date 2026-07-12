'use strict';
// 第3弾機能（内蔵サーバ / ネットワークスキャン）のバックエンド回帰テスト。
//   実行: cd E:\WaTerm; node test-features3.js
//   - netscan の CIDR/範囲/ポート解析
//   - fileserver の HTTP(GET/一覧/PUT/404) / TFTP(RRQ/WRQ/ERROR) / FTP(STOR/RETR/LIST)
// すべてループバック(127.0.0.1)で完結。外部ネットワーク不要。
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const http = require('http'), net = require('net'), dgram = require('dgram');
const netscan = require('./src/plugins/scan/netscan');
const fsv = require('./src/plugins/fileserver/fileserver');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { console.log('PASS ', name); pass++; } else { console.log('FAIL ', name); fail++; } }
function t(name, p) { return p.then(() => { console.log('PASS ', name); pass++; }).catch((e) => { console.log('FAIL ', name, '->', e.message); fail++; }); }

// ---- netscan 解析 ----
ok('CIDR /24 → 254', netscan.expandTargets('192.168.10.0/24', 1024).length === 254);
ok('CIDR /30 → 2', netscan.expandTargets('10.0.0.0/30', 1024).length === 2);
ok('CIDR /32 → 1', netscan.expandTargets('10.0.0.5/32', 1024)[0] === '10.0.0.5');
ok('範囲 .10-12 → 3', netscan.expandTargets('192.168.1.10-12', 1024).length === 3);
ok('カンマ重複除去', JSON.stringify(netscan.expandTargets('10.0.0.1,10.0.0.1,10.0.0.2', 1024)) === '["10.0.0.1","10.0.0.2"]');
ok('ポート範囲+単発', JSON.stringify(netscan.parsePorts('22,80,1000-1002')) === '[22,80,1000,1001,1002]');
ok('既定ポート(空)', netscan.parsePorts('').includes(22));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waterm-f3-'));
fs.writeFileSync(path.join(root, 'hello.txt'), 'Hello WaTerm!\n'.repeat(50));
const sample = fs.readFileSync(path.join(root, 'hello.txt'));

function httpGet(port, p) { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej); }); }
function httpPut(port, p, buf) { return new Promise((res, rej) => { const req = http.request({ host: '127.0.0.1', port, path: p, method: 'PUT' }, (r) => { r.on('data', () => {}); r.on('end', () => res(r.statusCode)); }); req.on('error', rej); req.end(buf); }); }

function tftpReq(op, fn) { return Buffer.concat([Buffer.from([0, op]), Buffer.from(fn), Buffer.from([0]), Buffer.from('octet'), Buffer.from([0])]); }
function tftpDownload(port, fn) { return new Promise((res, rej) => { const s = dgram.createSocket('udp4'); let data = Buffer.alloc(0); const to = setTimeout(() => { s.close(); rej(new Error('timeout')); }, 5000);
  s.on('message', (m, ri) => { const op = m.readUInt16BE(0); if (op === 3) { const blk = m.readUInt16BE(2); data = Buffer.concat([data, m.subarray(4)]); const a = Buffer.alloc(4); a.writeUInt16BE(4, 0); a.writeUInt16BE(blk, 2); s.send(a, ri.port, ri.address); if (m.length - 4 < 512) { clearTimeout(to); s.close(); res(data); } } else if (op === 5) { clearTimeout(to); s.close(); rej(new Error('tftp err ' + m.subarray(4))); } });
  s.send(tftpReq(1, fn), port, '127.0.0.1'); }); }
function tftpUpload(port, fn, buf) { return new Promise((res, rej) => { const s = dgram.createSocket('udp4'); let block = 0, lastSent = false; const bs = 512; let to;
  const arm = () => { clearTimeout(to); to = setTimeout(() => { s.close(); rej(new Error('timeout')); }, 5000); };
  const sendData = (n, addr, p) => { const st = (n - 1) * bs; const ch = buf.subarray(st, st + bs); const pkt = Buffer.alloc(4 + ch.length); pkt.writeUInt16BE(3, 0); pkt.writeUInt16BE(n, 2); ch.copy(pkt, 4); s.send(pkt, p, addr); arm(); return ch.length < bs; };
  s.on('message', (m, ri) => { const op = m.readUInt16BE(0); if (op === 4) { const ack = m.readUInt16BE(2); if (ack === block) { if (lastSent) { clearTimeout(to); s.close(); res(); return; } block++; lastSent = sendData(block, ri.address, ri.port); } } else if (op === 5) { clearTimeout(to); s.close(); rej(new Error('tftp err')); } });
  s.send(tftpReq(2, fn), port, '127.0.0.1'); arm(); }); }

function ftpClient(port) { return new Promise((resolve) => { const c = net.connect(port, '127.0.0.1'); let buf = ''; const q = []; let waiter = null; c.on('error', () => {});
  c.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1); if (/^\d\d\d /.test(line)) { if (waiter) { const w = waiter; waiter = null; w(line); } else q.push(line); } } });
  const expect = () => new Promise((r) => { if (q.length) r(q.shift()); else waiter = r; });
  const cmd = (s) => { c.write(s + '\r\n'); return expect(); };
  const openData = async () => { const r = await cmd('PASV'); const m = /\(([\d,]+)\)/.exec(r); const n = m[1].split(',').map(Number); const host = n.slice(0, 4).join('.'); const dport = (n[4] << 8) + n[5];
    return await new Promise((res) => { const ds = net.connect(dport, host); const chunks = []; ds.on('error', () => {}); ds.on('data', (x) => chunks.push(x)); const closed = new Promise((rr) => ds.on('close', () => rr())); ds.on('connect', () => res({ ds, chunks, closed })); }); };
  resolve({ expect, cmd, end: () => c.end(), openData }); }); }

(async () => {
  let r = await fsv.start('http', { root, port: 18090, writable: true, advertiseIp: '127.0.0.1' }); assert.ok(r.ok, 'http start');
  await t('HTTP GET 内容一致', httpGet(18090, '/hello.txt').then((g) => { assert.equal(g.status, 200); assert.ok(g.body.equals(sample)); }));
  await t('HTTP ディレクトリ一覧', httpGet(18090, '/').then((g) => assert.ok(g.body.toString().includes('hello.txt'))));
  await t('HTTP PUT', httpPut(18090, '/up.bin', Buffer.from('x')).then((s) => { assert.ok(s === 201 || s === 200); }));
  await t('HTTP 404', httpGet(18090, '/nope').then((g) => assert.equal(g.status, 404)));

  r = await fsv.start('tftp', { root, port: 16979, writable: true }); assert.ok(r.ok, 'tftp start');
  await t('TFTP RRQ 内容一致', tftpDownload(16979, 'hello.txt').then((d) => assert.ok(d.equals(sample))));
  await t('TFTP WRQ 内容一致', tftpUpload(16979, 'up.txt', Buffer.from('z'.repeat(1200))).then(() => assert.equal(fs.readFileSync(path.join(root, 'up.txt')).length, 1200)));
  await t('TFTP 不在→ERROR', tftpDownload(16979, 'missing').then(() => { throw new Error('should fail'); }, (e) => assert.ok(/err/i.test(e.message))));

  r = await fsv.start('ftp', { root, port: 12141, writable: true, advertiseIp: '127.0.0.1' }); assert.ok(r.ok, 'ftp start');
  await t('FTP STOR/RETR/LIST 一連', (async () => {
    const f = await ftpClient(12141); await f.expect();
    assert.ok((await f.cmd('USER a')).startsWith('331')); assert.ok((await f.cmd('PASS b')).startsWith('230')); await f.cmd('TYPE I');
    let d = await f.openData(); const sr = f.cmd('STOR f.txt'); d.ds.end('ftp-content'); await sr; await d.closed; await f.expect();
    assert.equal(fs.readFileSync(path.join(root, 'f.txt')).toString(), 'ftp-content');
    d = await f.openData(); const rr = f.cmd('RETR hello.txt'); await rr; await d.closed; await f.expect(); assert.ok(Buffer.concat(d.chunks).equals(sample));
    d = await f.openData(); const lr = f.cmd('LIST'); await lr; await d.closed; await f.expect(); assert.ok(Buffer.concat(d.chunks).toString().includes('hello.txt'));
    await f.cmd('QUIT'); f.end();
  })());

  fsv.stopAll();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + '/' + (pass + fail) + ' 合格');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); try { fsv.stopAll(); } catch (_) {} process.exit(1); });
