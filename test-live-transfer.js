'use strict';
// Parrot 実機の lrzsz と WaTerm transfer.js を pty shell 上で相互運用テスト
const { Client } = require('ssh2');
const crypto = require('crypto');
const { startTransfer } = require('./src/plugins/transfer/transfer');

const HOST = '192.168.40.117', USER = 'parrot', PASS = 'parrot';
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conn() {
  return new Promise((res, rej) => {
    const c = new Client();
    c.on('ready', () => res(c)).on('error', rej)
      .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 9000 });
  });
}
function execCmd(c, cmd) {
  return new Promise((res, rej) => {
    c.exec(cmd, (e, s) => {
      if (e) return rej(e);
      let o = ''; s.on('data', (d) => o += d).stderr.on('data', (d) => o += d);
      s.on('close', () => res(o));
    });
  });
}
function openShell(c) { return new Promise((res, rej) => c.shell({ term: 'vt100' }, (e, s) => e ? rej(e) : res(s))); }

// 受信テスト：Parrot 側で send 系コマンド → WaTerm transfer.js が受信
async function testRecv(c, proto, sendCmd, srcPath, srcMd5) {
  const s = await openShell(c);
  let xfer = null, saved = null;
  s.on('data', (d) => { if (xfer) xfer.onData(d); });
  await sleep(1500); // プロンプト安定待ち
  s.write(sendCmd + ' ' + srcPath + '\r');
  const result = await new Promise((resolve) => {
    const guard = setTimeout(() => resolve({ ok: false, error: 'タイムアウト' }), 40000);
    xfer = startTransfer({
      proto, dir: 'recv',
      send: (b) => s.write(b),
      log: () => {},
      saveFile: async (name, buf) => { saved = { name, buf }; return name; },
      done: (r) => { clearTimeout(guard); resolve(r); },
    });
  });
  try { s.write('\r'); s.end(); } catch (_) {}
  const okMd5 = saved && md5(saved.buf) === srcMd5;
  return { proto, dir: 'recv', ok: !!(result.ok && okMd5), size: saved ? saved.buf.length : 0, err: result.error, md5ok: okMd5 };
}

// 送信テスト：WaTerm transfer.js が送信 → Parrot 側 receive コマンド
async function testSend(c, proto, recvCmd, data, destName) {
  const s = await openShell(c);
  let xfer = null;
  s.on('data', (d) => { if (xfer) xfer.onData(d); });
  await sleep(1500);
  await execCmd(c, 'rm -f ~/' + destName); // 念のため
  s.write(recvCmd + '\r');
  const result = await new Promise((resolve) => {
    const guard = setTimeout(() => resolve({ ok: false, error: 'タイムアウト' }), 40000);
    xfer = startTransfer({
      proto, dir: 'send',
      send: (b) => s.write(b),
      log: () => {},
      files: [{ name: destName, data }],
      done: (r) => { clearTimeout(guard); resolve(r); },
    });
  });
  await sleep(800);
  try { s.write('\r'); s.end(); } catch (_) {}
  const out = await execCmd(c, 'md5sum ~/' + destName + ' 2>/dev/null');
  const remoteMd5 = (out.trim().split(/\s+/)[0]) || '';
  const okMd5 = remoteMd5 === md5(data);
  return { proto, dir: 'send', ok: !!(result.ok && okMd5), size: data.length, err: result.error, md5ok: okMd5, remoteMd5 };
}

(async () => {
  const c = await conn();
  const results = [];

  // テスト用ソース（受信用）
  const mk = await execCmd(c, 'head -c 49152 /dev/urandom > /tmp/wt_src.bin && md5sum /tmp/wt_src.bin');
  const srcMd5 = mk.trim().split(/\s+/)[0];
  console.log('Parrot 側ソース md5 = ' + srcMd5 + '\n');

  // ZMODEM
  results.push(await testRecv(c, 'zmodem', 'sz -b', '/tmp/wt_src.bin', srcMd5));
  results.push(await testSend(c, 'zmodem', 'rz -b -y', crypto.randomBytes(40000), 'wt_up_z.bin'));
  // YMODEM (sb/rb)
  results.push(await testRecv(c, 'ymodem', 'sb', '/tmp/wt_src.bin', srcMd5));
  results.push(await testSend(c, 'ymodem', 'rb -y', crypto.randomBytes(40000), 'wt_up_y.bin'));
  // XMODEM (sx/rx) — 受信＋送信。XMODEMはサイズ非保持なので 128 の倍数(49152)で照合
  const mk2 = await execCmd(c, 'head -c 49152 /dev/urandom > /tmp/wt_src2.bin && md5sum /tmp/wt_src2.bin');
  const src2 = mk2.trim().split(/\s+/)[0];
  results.push(await testRecv(c, 'xmodem1k', 'sx -k', '/tmp/wt_src2.bin', src2));
  results.push(await testSend(c, 'xmodem', 'rx wt_up_x.bin', crypto.randomBytes(49152), 'wt_up_x.bin'));

  // Kermit (gkermit) — stop&wait で低速のため小さめサイズで検証
  const mk3 = await execCmd(c, 'head -c 4096 /dev/urandom > /tmp/wt_ksrc.bin && md5sum /tmp/wt_ksrc.bin');
  const src3 = mk3.trim().split(/\s+/)[0];
  results.push(await testRecv(c, 'kermit', 'gkermit -s', '/tmp/wt_ksrc.bin', src3));
  results.push(await testSend(c, 'kermit', 'gkermit -r', crypto.randomBytes(6000), 'wt_up_k.bin'));

  c.end();

  console.log('結果:');
  let pass = 0;
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) pass++;
    console.log(`  ${tag}  ${r.proto.padEnd(9)} ${r.dir}  size=${r.size}` + (r.ok ? '' : '  ' + (r.err || ('md5不一致 ' + (r.remoteMd5 || '')))));
  }
  console.log(`\n${pass}/${results.length} 合格`);
  process.exit(0);
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
