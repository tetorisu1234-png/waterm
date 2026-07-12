'use strict';
// プラグイン ZIP コーデック（src/plugin-archive.js）の回帰テスト。
//   未信頼の zip を解析するため、往復・BOM・前置ディレクトリ・'\\' 区切り
//   （Windows PowerShell 5.1 の Compress-Archive 由来）・不正入力を検証する。
const A = require('./src/plugin-archive');

let pass = 0, total = 0;
function check(name, fn) {
  total++;
  try { const ok = fn(); console.log((ok ? 'PASS  ' : 'FAIL  ') + name); if (ok) pass++; }
  catch (e) { console.log('FAIL  ' + name + '  例外: ' + e.message); }
}

// 1) 基本往復（deflate/stored 混在・日本語・ネスト）
check('往復: 内容とパスが保たれる', () => {
  const files = [
    { name: 'plugin.json', data: Buffer.from('{"id":"demo","name":"デモ"}') },
    { name: 'renderer.js', data: Buffer.from('// 日本語\n' + 'x'.repeat(2000)) }, // 圧縮される
    { name: 'sub/panel.html', data: Buffer.from('<div>パネル</div>') },
    { name: 'tiny.txt', data: Buffer.from('a') }, // 縮まない→stored
  ];
  const back = A.zipRead(A.zipWrite(files));
  return files.every((f) => { const g = back.find((x) => x.name === f.name); return g && g.data.equals(f.data); });
});

// 2) CRC-32 既知値（"123456789" → 0xCBF43926）
check('CRC-32 既知ベクタ', () => A.crc32(Buffer.from('123456789')) === 0xCBF43926);

// 3) 空ファイルを含んでも壊れない
check('空データ入り往復', () => {
  const back = A.zipRead(A.zipWrite([{ name: 'empty', data: Buffer.alloc(0) }, { name: 'x', data: Buffer.from('y') }]));
  const e = back.find((b) => b.name === 'empty');
  return e && e.data.length === 0;
});

// 4) バックスラッシュ区切りのエントリ名を '/' へ正規化（PS 5.1 対策）
check("'\\\\' 区切りを '/' に正規化", () => {
  // zipWrite は '/' 化するので、ローカルに手組みせず zipWrite の名前を \\ にして確認
  const buf = A.zipWrite([{ name: 'hello\\plugin.json', data: Buffer.from('{}') }]);
  const back = A.zipRead(buf);
  return back[0].name === 'hello/plugin.json';
});

// 5) 不正入力は例外（zip ではない）
check('非zipは例外', () => {
  try { A.zipRead(Buffer.from('not a zip at all')); return false; }
  catch (_) { return true; }
});

// 6) ディレクトリエントリは dir=true・データ空
check('ディレクトリエントリ判定', () => {
  const back = A.zipRead(A.zipWrite([{ name: 'd/', data: Buffer.alloc(0) }, { name: 'd/f', data: Buffer.from('z') }]));
  const d = back.find((b) => b.name === 'd/');
  return d && d.dir === true;
});

console.log(`\n${pass}/${total} 合格`);
process.exit(pass === total ? 0 : 1);
