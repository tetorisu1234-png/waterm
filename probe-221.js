'use strict';
const { Client } = require('ssh2');
const fs = require('fs');
const RES = 'E:\\WaTerm\\probe-221.txt';
try { fs.unlinkSync(RES); } catch (_) {}
const LOG = (...a) => fs.appendFileSync(RES, a.join(' ') + '\n');
const c = new Client();
c.on('ready', () => {
  LOG('=== SSH READY 192.168.40.221 (sabu1) ===');
  c.shell({ term: 'xterm', cols: 100, rows: 30 }, (err, s) => {
    if (err) { LOG('shell err', err.message); c.end(); return; }
    let o = '';
    s.on('data', (d) => { o += d.toString('utf8'); });
    const cmds = [
      'uname -a 2>/dev/null || ver\r',
      'echo "---PORTS---"; ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/* 2>/dev/null; (command -v powershell >/dev/null && powershell -c "[System.IO.Ports.SerialPort]::GetPortNames()") 2>/dev/null\r',
      'echo "---FTDI---"; (dmesg 2>/dev/null | grep -i -E "ftdi|usbserial|cp210|ch34" | tail -n 8); (command -v mode >/dev/null && mode) 2>/dev/null\r',
      'echo "---TOOLS---"; command -v screen minicom cu picocom plink putty 2>/dev/null\r',
      'echo "---WHO---"; whoami; hostname\r',
    ];
    let i = 0;
    const tick = () => { if (i < cmds.length) { s.write(cmds[i++]); setTimeout(tick, 1200); } else { setTimeout(() => { LOG(o); c.end(); process.exit(0); }, 1000); } };
    setTimeout(tick, 800);
  });
});
c.on('error', (e) => { LOG('ERROR:', e.message); process.exit(1); });
c.connect({ host: '192.168.40.221', port: 22, username: 'sabu1', password: 'nanako', readyTimeout: 15000, tryKeyboard: true });
