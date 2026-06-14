'use strict';
/*
 * シリアル(COM)コンソール中継プロセス。システムNode(serialport)で動かし、
 * Electron本体とは stdin/stdout の行ベース base64 で通信する。
 *   起動: node serial-bridge.js <base64(JSON設定)>   または   node serial-bridge.js --list
 *   stdout: 'O'(open) / 'E<msg>'(error) / 'D<base64>'(受信) / 'C'(close) / 'L<base64 JSON>'(ポート一覧)
 *   stdin : 'I<base64>'(送信) / 'B'(ブレーク) / 'X'(切断)
 */
const { SerialPort } = require('serialport');

const out = (s) => { try { process.stdout.write(s + '\n'); } catch (_) {} };

if (process.argv[2] === '--list') {
  SerialPort.list()
    .then((l) => { out('L' + Buffer.from(JSON.stringify(l)).toString('base64')); process.exit(0); })
    .catch(() => { out('L' + Buffer.from('[]').toString('base64')); process.exit(0); });
  return;
}

let cfg;
try { cfg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8')); }
catch (e) { out('E設定の解析に失敗: ' + e.message); process.exit(1); }

const port = new SerialPort({
  path: cfg.path,
  baudRate: cfg.baudRate || 9600,
  dataBits: cfg.dataBits || 8,
  parity: cfg.parity || 'none',
  stopBits: cfg.stopBits || 1,
  rtscts: !!cfg.rtscts,
  xon: !!cfg.xon,
  xoff: !!cfg.xoff,
  autoOpen: false,
});

port.open((err) => {
  if (err) { out('E' + err.message); process.exit(1); }
  else out('O');
});
port.on('data', (d) => out('D' + d.toString('base64')));
port.on('error', (e) => out('E' + e.message));
port.on('close', () => { out('C'); process.exit(0); });

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const t = line[0], rest = line.slice(1);
    if (t === 'I') { try { port.write(Buffer.from(rest, 'base64')); } catch (_) {} }
    else if (t === 'X') { try { port.close(); } catch (_) {} process.exit(0); }
    else if (t === 'B') { try { port.set({ brk: true }, () => setTimeout(() => port.set({ brk: false }, () => {}), 350)); } catch (_) {} }
  }
});
process.stdin.on('end', () => { try { port.close(); } catch (_) {} process.exit(0); });
