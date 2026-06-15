'use strict';
/*
 * タブ切り離しドラッグ中にカーソルへ追従する「チップ」を、Win32 レイヤードウィンドウで描く。
 * UpdateLayeredWindow は DWM(デスクトップ合成) が直接描画するため、Chromium の GPU 合成とは無関係。
 * → RDP 埋め込みのため app.disableHardwareAcceleration() している状態でも、ウィンドウ外・別モニタに表示できる。
 * 描画ビットは呼び出し側(レンダラ)が canvas で作る「上下反転なし・前乗算アルファ BGRA」を渡す。
 */
let koffi, user32, gdi32, kernel32;
let ok = false;
try {
  if (process.platform === 'win32') {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    gdi32 = koffi.load('gdi32.dll');
    kernel32 = koffi.load('kernel32.dll');
    ok = true;
  }
} catch (_) { ok = false; }

let api = { isAvailable: false };

if (ok) {
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
  const SIZE = koffi.struct('SIZE', { cx: 'int32', cy: 'int32' });
  const BLENDFUNCTION = koffi.struct('BLENDFUNCTION', { BlendOp: 'uint8', BlendFlags: 'uint8', SourceConstantAlpha: 'uint8', AlphaFormat: 'uint8' });
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });

  const CreateWindowExW = user32.func('void* CreateWindowExW(uint32 exStyle, str16 className, str16 windowName, uint32 style, int x, int y, int w, int h, void* parent, void* menu, void* inst, void* param)');
  const DestroyWindow = user32.func('bool DestroyWindow(void* hWnd)');
  const ShowWindow = user32.func('bool ShowWindow(void* hWnd, int nCmdShow)');
  const SetWindowPos = user32.func('bool SetWindowPos(void* hWnd, void* after, int x, int y, int cx, int cy, uint flags)');
  const GetDC = user32.func('void* GetDC(void* hWnd)');
  const ReleaseDC = user32.func('int ReleaseDC(void* hWnd, void* hdc)');
  const UpdateLayeredWindow = user32.func('bool UpdateLayeredWindow(void* hWnd, void* hdcDst, POINT* pptDst, SIZE* psize, void* hdcSrc, POINT* pptSrc, uint32 crKey, BLENDFUNCTION* pblend, uint32 dwFlags)');
  const CreateCompatibleDC = gdi32.func('void* CreateCompatibleDC(void* hdc)');
  const DeleteDC = gdi32.func('bool DeleteDC(void* hdc)');
  const CreateDIBSection = gdi32.func('void* CreateDIBSection(void* hdc, BITMAPINFOHEADER* pbmi, uint usage, _Out_ void** ppvBits, void* hSection, uint32 offset)');
  const SelectObject = gdi32.func('void* SelectObject(void* hdc, void* obj)');
  const DeleteObject = gdi32.func('bool DeleteObject(void* obj)');
  const GetModuleHandleW = kernel32.func('void* GetModuleHandleW(void* name)');
  const RtlMoveMemory = kernel32.func('void RtlMoveMemory(void* dst, void* src, size_t len)');

  const WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
  const WS_POPUP = 0x80000000;
  const SW_SHOWNA = 8;
  const ULW_ALPHA = 0x02, AC_SRC_OVER = 0x00, AC_SRC_ALPHA = 0x01;
  const HWND_TOPMOST = koffi.as(-1, 'void*');
  const SWP_NOSIZE = 0x1, SWP_NOACTIVATE = 0x10;

  let hwnd = null, memDC = null, hbm = null, oldObj = null, screenDC = null, curW = 0, curH = 0;
  let lastErr = '';

  function destroy() {
    try { if (hwnd) DestroyWindow(hwnd); } catch (_) {}
    try { if (memDC && oldObj) SelectObject(memDC, oldObj); } catch (_) {}
    try { if (hbm) DeleteObject(hbm); } catch (_) {}
    try { if (memDC) DeleteDC(memDC); } catch (_) {}
    try { if (screenDC) ReleaseDC(null, screenDC); } catch (_) {}
    hwnd = memDC = hbm = oldObj = screenDC = null; curW = curH = 0;
  }

  // bgra: 前乗算済み BGRA(上→下) の Buffer。w,h は物理ピクセル。px,py は物理スクリーン座標(左上)。
  // show は分離ドラッグ開始時に1回呼ばれる前提。毎回作り直してビットマップを確実に更新する。
  function show(bgra, w, h, px, py) {
    try {
      destroy();
      const inst = GetModuleHandleW(null);
      hwnd = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        'Static', '', WS_POPUP, px, py, w, h, null, null, inst, null);
      if (!hwnd) { hwnd = null; return false; }
      screenDC = GetDC(null);
      memDC = CreateCompatibleDC(screenDC);
      const bmi = { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
      const pp = [null];
      hbm = CreateDIBSection(memDC, bmi, 0, pp, null, 0);
      if (!hbm || !pp[0]) { destroy(); return false; }
      RtlMoveMemory(pp[0], bgra, w * h * 4);
      oldObj = SelectObject(memDC, hbm);
      curW = w; curH = h;
      const pt = { x: px, y: py };
      const sz = { cx: w, cy: h };
      const src = { x: 0, y: 0 };
      const blend = { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA };
      UpdateLayeredWindow(hwnd, screenDC, pt, sz, memDC, src, 0, blend, ULW_ALPHA);
      ShowWindow(hwnd, SW_SHOWNA);
      return true;
    } catch (e) { lastErr = String(e && e.message || e); destroy(); return false; }
  }

  function move(px, py) {
    try { if (hwnd) SetWindowPos(hwnd, HWND_TOPMOST, Math.round(px), Math.round(py), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE); } catch (_) {}
  }

  function hide() { destroy(); }

  api = { isAvailable: true, show, move, hide, lastError: () => lastErr };
}

module.exports = api;
