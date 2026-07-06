'use strict';
// WaTerm アプリアイコン生成（Electron/Chromium でSVGをラスタライズ → PNG + ICO）。
// 依存追加なし。実行: npm run icon  （= electron scripts/gen-icon.js）
// 出力: build/icon.png(256) と build/icon.ico(16..256 マルチサイズ)
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'build');
const RENDER = 512; // 高解像度で描いてから各サイズへ縮小

// ---- アイコンのSVG（角丸スクワークル + グラデ + グロス + 和 + ターミナルプロンプト） ----
const SVG = `
<svg width="${RENDER}" height="${RENDER}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3a3a7a"/>
      <stop offset="0.45" stop-color="#232350"/>
      <stop offset="1" stop-color="#0e0e24"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.32" cy="0.26" r="0.9">
      <stop offset="0" stop-color="#5b7cff" stop-opacity="0.55"/>
      <stop offset="0.5" stop-color="#5b7cff" stop-opacity="0.0"/>
    </radialGradient>
    <linearGradient id="wa" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#cfe0ff"/>
      <stop offset="1" stop-color="#8fb2ff"/>
    </linearGradient>
    <radialGradient id="gloss" cx="0.5" cy="0.02" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="prompt" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#7bffbf"/>
      <stop offset="1" stop-color="#39e29a"/>
    </linearGradient>
    <filter id="softglow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="greenglow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- 背景（角丸スクワークル） -->
  <rect x="26" y="26" width="460" height="460" rx="112" ry="112" fill="url(#bg)"/>
  <rect x="26" y="26" width="460" height="460" rx="112" ry="112" fill="url(#glow)"/>
  <!-- 上部グロス（角丸内にクリップして滑らかにフェード） -->
  <clipPath id="clip"><rect x="26" y="26" width="460" height="460" rx="112" ry="112"/></clipPath>
  <rect x="26" y="26" width="460" height="300" fill="url(#gloss)" clip-path="url(#clip)"/>
  <!-- 内側の細いハイライト枠 -->
  <rect x="27.5" y="27.5" width="457" height="457" rx="110" ry="110" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>

  <!-- 和（ヒーロー） -->
  <g filter="url(#softglow)">
    <text x="252" y="292" text-anchor="middle"
          font-family="'Yu Gothic UI','Yu Gothic','Meiryo','Noto Sans JP',sans-serif"
          font-weight="900" font-size="290" fill="url(#wa)">和</text>
  </g>

  <!-- ターミナルプロンプト >_ （下部・緑グロー） -->
  <g filter="url(#greenglow)" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M150 372 L188 400 L150 428" stroke="url(#prompt)" stroke-width="22"/>
  </g>
  <rect x="212" y="404" width="150" height="20" rx="10" fill="url(#prompt)" filter="url(#greenglow)"/>
</svg>`;

function buildIco(images) {
  // images: [{size, buf(PNG)}] を PNG圧縮エントリの ICO にまとめる（Vista+対応）
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((im, i) => {
    const b = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, b + 0);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, b + 1);
    dir.writeUInt8(0, b + 2); dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4); dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(im.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += im.buf.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.buf)]);
}

app.disableHardwareAcceleration(); // オフスクリーン描画を安定化
app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: RENDER, height: RENDER, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: false },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;width:${RENDER}px;height:${RENDER}px;overflow:hidden}
  </style></head><body>${SVG}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500)); // フォント/描画確定待ち

  const full = await win.capturePage();
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const images = sizes.map((s) => ({ size: s, buf: full.resize({ width: s, height: s, quality: 'best' }).toPNG() }));

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), full.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(images));
  // プレビュー用に大きめPNGも出す
  fs.writeFileSync(path.join(OUT_DIR, 'icon-preview.png'), full.toPNG());

  console.log('icon.png / icon.ico / icon-preview.png を書き出しました (' + sizes.join(',') + ')');
  app.quit();
});
