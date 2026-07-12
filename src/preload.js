'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 設定・セッション・スニペット
  loadSessions: () => ipcRenderer.invoke('sessions:load'),
  saveSessions: (d) => ipcRenderer.invoke('sessions:save', d),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (d) => ipcRenderer.invoke('settings:save', d),
  loadSnippets: () => ipcRenderer.invoke('snippets:load'),
  saveSnippets: (d) => ipcRenderer.invoke('snippets:save', d),

  // クリップボード（メインプロセス経由：サンドボックスでも動作）
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (t) => ipcRenderer.send('clipboard:write', t),

  // パスワード暗号化
  encrypt: (p) => ipcRenderer.invoke('secure:encrypt', p),
  decrypt: (s) => ipcRenderer.invoke('secure:decrypt', s),

  // マスターパスワード保管庫
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  vaultEnable: (password) => ipcRenderer.invoke('vault:enable', { password }),
  vaultUnlock: (password) => ipcRenderer.invoke('vault:unlock', { password }),
  vaultLock: () => ipcRenderer.invoke('vault:lock'),
  vaultDisable: () => ipcRenderer.invoke('vault:disable'),
  vaultReencrypt: (list, toDefault) => ipcRenderer.invoke('vault:reencrypt', { list, toDefault }),

  // 接続
  connOpen: (id, cfg) => ipcRenderer.invoke('conn:open', { id, cfg }),
  connInput: (id, data) => ipcRenderer.send('conn:input', { id, data }),
  connResize: (id, cols, rows) => ipcRenderer.send('conn:resize', { id, cols, rows }),
  connClose: (id) => ipcRenderer.send('conn:close', { id }),
  setEncoding: (id, encoding) => ipcRenderer.invoke('conn:setEncoding', { id, encoding }),
  setNewline: (id, newline) => ipcRenderer.invoke('conn:setNewline', { id, newline }),
  setLocalEcho: (id, on) => ipcRenderer.invoke('conn:setLocalEcho', { id, on }),
  onData: (cb) => ipcRenderer.on('conn:data', (e, p) => cb(p)),
  onStatus: (cb) => ipcRenderer.on('conn:status', (e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (e, action) => cb(action)),

  // ログ
  logStart: (id, defaultName, timestamp) => ipcRenderer.invoke('log:start', { id, defaultName, timestamp }),
  logStop: (id) => ipcRenderer.invoke('log:stop', { id }),

  // Break / ファイル送信
  serialBreak: (id) => ipcRenderer.invoke('serial:break', { id }),
  sendFile: (id, delayMs) => ipcRenderer.invoke('conn:sendFile', { id, delayMs }),

  // マクロ（.ttl 等のテキスト読込）
  loadTextFile: (exts) => ipcRenderer.invoke('dialog:openText', { exts }),


  // ウィンドウ分離／移動（タブを別ウィンドウへ。座標で移動先を判定）
  relocateTab: (id, session, status, x, y) => ipcRenderer.invoke('window:relocate', { id, session, status, x, y }),
  windowReady: () => ipcRenderer.send('window:ready'),
  onAdoptTab: (cb) => ipcRenderer.on('tab:adopt', (e, p) => cb(p)),
  closeSelf: () => ipcRenderer.send('window:close'),
  // タブ切り離しドラッグの追従チップ（Win32レイヤードウィンドウ＝ウィンドウ外でも表示）
  dragChipAvailable: () => ipcRenderer.invoke('dragchip:available'),
  dragChipShow: (bgra, w, h, x, y) => ipcRenderer.send('dragchip:show', { bgra, w, h, x, y }),
  dragChipMove: (x, y) => ipcRenderer.send('dragchip:move', { x, y }),
  dragChipHide: () => ipcRenderer.send('dragchip:hide'),

  // カスタムタイトルバー（フレームレス）
  winMinimize: () => ipcRenderer.send('win:minimize'),
  winMaximize: () => ipcRenderer.send('win:maximize'),
  winClose: () => ipcRenderer.send('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onWinState: (cb) => ipcRenderer.on('win:state', (e, p) => cb(p)),
  winDevtools: () => ipcRenderer.send('win:devtools'),
  appAbout: () => ipcRenderer.send('app:about'),
  appQuit: () => ipcRenderer.send('app:quit'),
  appRelaunch: () => ipcRenderer.send('app:relaunch'),
  getPerfMode: () => ipcRenderer.invoke('app:perfMode'),

  // 自動更新
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.send('update:download'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (e, p) => cb(p)),
  onUpdateNone: (cb) => ipcRenderer.on('update:none', (e, p) => cb(p)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (e, p) => cb(p)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (e, p) => cb(p)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (e, p) => cb(p)),

  importSshConfig: () => ipcRenderer.invoke('sessions:importSshConfig'),

  // SFTP
  sftpRealpath: (id, p) => ipcRenderer.invoke('sftp:realpath', { id, p }),
  sftpList: (id, p) => ipcRenderer.invoke('sftp:list', { id, p }),
  sftpDownload: (id, remotePath, name) => ipcRenderer.invoke('sftp:download', { id, remotePath, name }),
  sftpUpload: (id, remoteDir) => ipcRenderer.invoke('sftp:upload', { id, remoteDir }),
  sftpUploadPaths: (id, remoteDir, paths) => ipcRenderer.invoke('sftp:uploadPaths', { id, remoteDir, paths }),
  // ドロップされた File からローカル絶対パスを取得（Electron33: File.path 廃止のため webUtils を使用）
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return (file && file.path) || ''; } },
  sftpMkdir: (id, p) => ipcRenderer.invoke('sftp:mkdir', { id, p }),
  sftpDelete: (id, p, isDir) => ipcRenderer.invoke('sftp:delete', { id, p, isDir }),
  sftpRename: (id, oldP, newP) => ipcRenderer.invoke('sftp:rename', { id, oldP, newP }),
  // 即時編集（ローカルエディタで開く→保存で自動再アップロード）
  sftpEdit: (id, remotePath, name) => ipcRenderer.invoke('sftp:edit', { id, remotePath, name }),
  sftpEditStop: (id) => ipcRenderer.send('sftp:editStop', { id }),
  onSftpEditEvent: (cb) => ipcRenderer.on('sftp:editEvent', (e, p) => cb(p)),

  // シリアル(COM)
  serialList: () => ipcRenderer.invoke('serial:list'),

  // ダイアログ等
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
  exportSessions: (d) => ipcRenderer.invoke('dialog:exportSessions', d),
  importSessions: () => ipcRenderer.invoke('dialog:importSessions'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // ===== プラグイン基盤 =====
  // 汎用ブリッジ：プラグインが任意チャンネルで main と通信するための窓口。
  // （チャンネル名の名前空間はプラグイン側の責任。第一級アプリなので素通し。）
  plugin: {
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    send: (channel, payload) => ipcRenderer.send(channel, payload),
    on: (channel, cb) => ipcRenderer.on(channel, (e, p) => cb(p)),
  },
  // プラグイン管理：一覧取得・有効/無効切替・起動時マニフェスト（資産のURL/HTML）
  plugins: {
    manifests: () => ipcRenderer.invoke('plugins:manifests'),
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, on) => ipcRenderer.invoke('plugins:setEnabled', { id, on }),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
  },
});
