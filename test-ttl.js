'use strict';
const { TtlInterpreter } = require('./src/ttl');

function makeIo(initial, responder) {
  let buf = initial || '';
  const sent = []; const logs = [];
  return {
    sent, logs, getBuf: () => buf,
    async send(s) { sent.push(s); if (responder) buf += (responder(s) || ''); },
    async wait(pats, to) { for (let i = 0; i < pats.length; i++) { const j = buf.indexOf(pats[i]); if (j >= 0) { buf = buf.slice(j + pats[i].length); return { index: i + 1, matched: pats[i] }; } } return { index: 0, matched: '' }; },
    async pause() {},
    async flush() { buf = ''; },
    async message(m, t) { logs.push('MSG:' + m); },
    async status(m) { logs.push('ST:' + m); },
    async inputbox(m, t, d) { return 'admin'; },
    async passwordbox(m, t) { return 'secret'; },
    async yesno() { return 1; },
    log: (m) => logs.push('LOG:' + m),
  };
}

let pass = 0, total = 0;
async function check(name, fn) {
  total++;
  try { const ok = await fn(); console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (ok) pass++; }
  catch (e) { console.log('FAIL  ' + name + '  例外: ' + e.message); }
}

(async () => {
  // 1) 式・if・for・while
  await check('式/if/for/while', async () => {
    const io = makeIo();
    const sc = `
a = 5
b = 3
c = a + b
if c = 8 then
  messagebox 'eight' 'T'
endif
sum = 0
for i 1 5
  sum = sum + i
next
if sum = 15 then
  messagebox 'sum15' 'T'
endif
n = 0
while n < 3
  n = n + 1
endwhile
messagebox n 'N'`;
    const r = await new TtlInterpreter(io, sc).run();
    return r.ok && io.logs.includes('MSG:eight') && io.logs.includes('MSG:sum15') && io.logs.includes('MSG:3');
  });

  // 2) elseif/else
  await check('elseif/else', async () => {
    const io = makeIo();
    const sc = `
x = 2
if x = 1 then
  messagebox 'one' 'T'
elseif x = 2 then
  messagebox 'two' 'T'
else
  messagebox 'other' 'T'
endif`;
    const r = await new TtlInterpreter(io, sc).run();
    return r.ok && io.logs.includes('MSG:two') && !io.logs.includes('MSG:one') && !io.logs.includes('MSG:other');
  });

  // 3) goto / call / return
  await check('goto/call/return', async () => {
    const io = makeIo();
    const sc = `
call sub
goto done
:sub
x = 42
return
messagebox 'should not run' 'T'
:done
messagebox x 'X'`;
    const r = await new TtlInterpreter(io, sc).run();
    return r.ok && io.logs.includes('MSG:42') && !io.logs.includes('MSG:should not run');
  });

  // 4) do/loop until + break/continue
  await check('do-loop/break/continue', async () => {
    const io = makeIo();
    const sc = `
k = 0
do
  k = k + 1
loop until k >= 4
total = 0
for i 1 10
  if i = 3 then
    continue
  endif
  if i = 6 then
    break
  endif
  total = total + i
next
messagebox k 'K'
messagebox total 'TT'`;
    const r = await new TtlInterpreter(io, sc).run();
    // total = 1+2+4+5 = 12 (3 skip, 6 break)
    return r.ok && io.logs.includes('MSG:4') && io.logs.includes('MSG:12');
  });

  // 5) 1行if + 文字列連結 + str2int
  await check('1行if/連結/str2int', async () => {
    const io = makeIo();
    const sc = `
name = 'cisco'
greet = 'hello ' + name
if greet = 'hello cisco' messagebox 'concat ok' 'T'
str2int num '123'
if num = 123 then
  messagebox 'int ok' 'T'
endif`;
    const r = await new TtlInterpreter(io, sc).run();
    return r.ok && io.logs.includes('MSG:concat ok') && io.logs.includes('MSG:int ok');
  });

  // 6) ログインシナリオ（wait/sendln, result, ダイアログ）
  await check('ログイン手順(wait/sendln)', async () => {
    const responder = (s) => {
      if (/^admin\r/.test(s)) return 'Password: ';
      if (/^secret\r/.test(s)) return '\r\n#'; // 特権っぽいプロンプト
      if (/show version/.test(s)) return ' Cisco IOS\r\n#';
      return '';
    };
    const io = makeIo('Welcome\r\nUsername: ', responder);
    const sc = `
inputbox 'user?' 'login'
user = inputstr
passwordbox 'pass?' 'login'
pw = inputstr
wait 'Username:'
sendln user
wait 'Password:'
sendln pw
wait '#' '>'
if result = 1 then
  sendln 'show version'
  wait '#'
endif`;
    const r = await new TtlInterpreter(io, sc).run();
    return r.ok && io.sent.includes('admin\r') && io.sent.includes('secret\r') && io.sent.includes('show version\r');
  });

  // 7) エラー検出（未定義ラベル）
  await check('エラー: 未定義ラベル', async () => {
    const io = makeIo();
    const r = await new TtlInterpreter(io, 'goto nowhere').run();
    return !r.ok && /ラベル/.test(r.error);
  });

  console.log(`\n${pass}/${total} 合格`);
  process.exit(pass === total ? 0 : 1);
})();
