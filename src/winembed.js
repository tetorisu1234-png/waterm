'use strict';
/*
 * Win32 ウィンドウ再ペアレント(SetParent)で外部アプリ(mstsc等)を
 * WaTermのウィンドウ内に埋め込むためのヘルパー。koffi(FFI)でuser32を呼ぶ。
 * Windows以外/koffi不可の環境では isAvailable=false。
 */
let koffi, user32;
let ok = false;
try {
  if (process.platform === 'win32') {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    ok = true;
  }
} catch (_) { ok = false; }

let api = null;
if (ok) {
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const SetParent = user32.func('void* SetParent(void* hWndChild, void* hWndNewParent)');
  const MoveWindow = user32.func('bool MoveWindow(void* hWnd, int X, int Y, int W, int H, bool repaint)');
  const ShowWindow = user32.func('bool ShowWindow(void* hWnd, int nCmdShow)');
  const GetWindowLongPtr = user32.func('int64 GetWindowLongPtrW(void* hWnd, int nIndex)');
  const SetWindowLongPtr = user32.func('int64 SetWindowLongPtrW(void* hWnd, int nIndex, int64 v)');
  const GetTopWindow = user32.func('void* GetTopWindow(void* hWnd)');
  const GetWindow = user32.func('void* GetWindow(void* hWnd, uint uCmd)');
  const GetWindowThreadProcessId = user32.func('uint GetWindowThreadProcessId(void* hWnd, _Out_ uint32_t* pid)');
  const IsWindowVisible = user32.func('bool IsWindowVisible(void* hWnd)');
  const GetClientRect = user32.func('bool GetClientRect(void* hWnd, _Out_ RECT* r)');
  const SetFocus = user32.func('void* SetFocus(void* hWnd)');
  const SetWindowPos = user32.func('bool SetWindowPos(void* hWnd, void* after, int x, int y, int cx, int cy, uint flags)');
  const SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_SHOWWINDOW = 0x40, SWP_NOACTIVATE = 0x10;
  let GetDpiForWindow = null;
  try { GetDpiForWindow = user32.func('uint GetDpiForWindow(void* hWnd)'); } catch (_) {}
  const GetWindowRect = user32.func('bool GetWindowRect(void* hWnd, _Out_ RECT* r)');
  const GetClassNameA = user32.func('int GetClassNameA(void* hWnd, _Out_ char* buf, int max)');
  function getClass(h) { try { const b = Buffer.alloc(256); const n = GetClassNameA(h, b, 256); return b.toString('latin1', 0, n); } catch (_) { return ''; } }

  const GWL_STYLE = -16;
  const WS_CHILD = 0x40000000n, WS_VISIBLE = 0x10000000n;
  const WS_POPUP = 0x80000000n, WS_CAPTION = 0x00C00000n, WS_THICKFRAME = 0x00040000n, WS_BORDER = 0x00800000n, WS_DLGFRAME = 0x00400000n;
  const GW_HWNDNEXT = 2;
  const SW_HIDE = 0, SW_SHOW = 5;

  // RDP本体ウィンドウ(TscShellContainerClass)だけを返す。出るまでは null（呼び出し側がポーリング）
  function findWindowByPid(pid) {
    let h = GetTopWindow(null);
    let guard = 0;
    while (h && guard++ < 5000) {
      if (IsWindowVisible(h)) {
        const out = [0];
        GetWindowThreadProcessId(h, out);
        if (out[0] === pid) {
          const r = {};
          GetClientRect(h, r);
          if ((r.right - r.left) > 60 && (r.bottom - r.top) > 60 && getClass(h) === 'TscShellContainerClass') return h;
        }
      }
      h = GetWindow(h, GW_HWNDNEXT);
    }
    return null;
  }

  // mainWin.getNativeWindowHandle() の Buffer から HWND(数値)を得る
  function hwndFromBuffer(buf) {
    return process.arch === 'x64' || process.arch === 'arm64' ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  }

  api = {
    isAvailable: true,
    findWindowByPid,
    hwndFromBuffer,
    embed(childHwnd, parentHwndNum) {
      try {
        let style = BigInt(GetWindowLongPtr(childHwnd, GWL_STYLE));
        style = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME)) | WS_CHILD | WS_VISIBLE;
        SetWindowLongPtr(childHwnd, GWL_STYLE, style);
        SetParent(childHwnd, parentHwndNum);
        return true;
      } catch (_) { return false; }
    },
    move(childHwnd, x, y, w, h) {
      try {
        MoveWindow(childHwnd, Math.round(x), Math.round(y), Math.round(w), Math.round(h), true);
        // ElectronのWebコンテンツより前面(兄弟内の最前)へ
        SetWindowPos(childHwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
        return true;
      } catch (e) { return 'ERR:' + e.message; }
    },
    show(childHwnd, visible) { try { ShowWindow(childHwnd, visible ? SW_SHOW : SW_HIDE); } catch (_) {} },
    focus(childHwnd) { try { SetFocus(childHwnd); } catch (_) {} },
    clientHeight(parentHwndNum) { try { const r = {}; GetClientRect(parentHwndNum, r); return r.bottom - r.top; } catch (_) { return 0; } },
    clientWidth(parentHwndNum) { try { const r = {}; GetClientRect(parentHwndNum, r); return r.right - r.left; } catch (_) { return 0; } },
    dpi(hwnd) { try { return GetDpiForWindow ? GetDpiForWindow(hwnd) : 96; } catch (_) { return 96; } },
    winRect(hwnd) { try { const r = {}; GetWindowRect(hwnd, r); return r; } catch (_) { return null; } },
  };
} else {
  api = { isAvailable: false };
}

module.exports = api;
