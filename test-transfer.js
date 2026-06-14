'use strict';
// XMODEM/YMODEM 送受信のループバック検証（実機不要）
const crypto = require('crypto');
const { startTransfer } = require('./src/transfer');

function runCase(proto, size) {
  return new Promise((resolve) => {
    const original = crypto.randomBytes(size);
    // XMODEM はサイズ情報を持たず末尾を 0x1a でパディングするため、末尾が 0x1a/0x00 だと曖昧（仕様上の制約）。テストを決定的にするため調整。
    if (proto.startsWith('xmodem') && size > 0 && (original[size - 1] === 0x1a || original[size - 1] === 0x00)) original[size - 1] = 0x55;
    let recvAPI = null, sendAPI = null;
    let recvDone = null, sendDone = null;
    let saved = null;

    recvAPI = startTransfer({
      proto, dir: 'recv',
      send: (b) => sendAPI && sendAPI.onData(b),
      log: () => {},
      saveFile: async (name, buf) => { saved = { name, buf }; return (name || 'recv') + '.bin'; },
      done: (r) => { recvDone = r; finish(); },
    });
    sendAPI = startTransfer({
      proto, dir: 'send',
      send: (b) => recvAPI && recvAPI.onData(b),
      log: () => {},
      files: [{ name: proto + '_' + size + '.bin', data: original }],
      done: (r) => { sendDone = r; finish(); },
    });

    const guard = setTimeout(() => { resolve({ proto, size, ok: false, error: 'タイムアウト' }); }, 15000);
    function finish() {
      if (!recvDone || !sendDone) return;
      clearTimeout(guard);
      const ok = recvDone.ok && sendDone.ok && saved && saved.buf.equals(original);
      resolve({ proto, size, ok, recv: recvDone, send: sendDone, savedLen: saved ? saved.buf.length : 0, origLen: size });
    }
  });
}

(async () => {
  const cases = [
    ['xmodem', 100], ['xmodem', 128], ['xmodem', 300],
    ['xmodem1k', 1024], ['xmodem1k', 2500], ['xmodem1k', 5000],
    ['ymodem', 50], ['ymodem', 1000], ['ymodem', 4097], ['ymodem', 20000],
    ['zmodem', 0], ['zmodem', 100], ['zmodem', 1024], ['zmodem', 5000], ['zmodem', 100000],
    ['kermit', 0], ['kermit', 60], ['kermit', 1000], ['kermit', 8000],
  ];
  let pass = 0;
  for (const [proto, size] of cases) {
    const r = await runCase(proto, size);
    const tag = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) pass++;
    console.log(`${tag}  ${proto.padEnd(9)} size=${String(size).padStart(6)}  saved=${r.savedLen}` + (r.ok ? '' : '  err=' + (r.error || (r.recv && r.recv.error) || (r.send && r.send.error) || '内容不一致')));
  }
  console.log(`\n${pass}/${cases.length} 合格`);
  process.exit(pass === cases.length ? 0 : 1);
})();
