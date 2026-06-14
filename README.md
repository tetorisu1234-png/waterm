# 和ターミナル (WaTerm)

日本語UIの **SSH / Telnet / SFTP クライアント**。MobaXterm / Tera Term の中核機能を、最初から全部日本語で使えるように自作したものです。Electron + xterm.js + ssh2 製。

## 主な機能

### 接続
- **SSH**（パスワード / 秘密鍵＋パスフレーズ）
- **Telnet**（Tera Term 互換、IACネゴシエーション対応）
- **古い暗号方式に対応**：セッションごとに「古い暗号方式を許可」をONにすると、
  `diffie-hellman-group1-sha1` / `group14-sha1` / `ssh-rsa` / `ssh-dss` /
  `aes-cbc` / `3des-cbc` / `hmac-sha1` / `hmac-md5` などを有効化。
  → 旧Cisco・古いAP等、現代のSSHクライアントが繋がらない機器に接続できます。
- ホスト鍵検証（TOFU：初回登録・変更時は警告）
- クイック接続バー（`user@host:port`）

### ターミナル
- タブで複数サーバーに同時接続、xterm.js（256色 / UTF-8）
- **文字コード切替：UTF-8 / Shift_JIS / EUC-JP**（古い日本語機器向け、Tera Term相当）
- **改行コード切替：CR / LF / CR+LF**
- ローカルエコー、文字サイズ変更、端末内検索、URLクリック
- **ターミナルログ保存**（Tera Term の Log 相当）
- **自動ログイン後コマンド**（接続後に自動送信）
- **全タブ送信（MultiExec）** / **スニペット（送信マクロ）**
- ダーク / ライト テーマ

### SFTP（SSH接続時）
- リモートファイルブラウザ（名前・サイズ・更新日時・権限）
- フォルダ移動、上の階層、更新
- アップロード / ダウンロード / 新規フォルダ / リネーム / 削除

### セッション管理
- 追加 / 編集 / 複製 / 削除、フォルダ分類、絞り込み
- パスワードは **OSキーチェーン(safeStorage)で暗号化保存**
- セッションのインポート / エクスポート（JSON）

## 起動方法

- デスクトップの **「和ターミナル (WaTerm)」** ショートカットから起動
- またはコマンドで：
  ```
  cd /d E:\WaTerm
  node_modules\electron\dist\electron.exe .
  ```

## データの保存場所
`%APPDATA%\waterm\`
- `waterm-sessions.json`（セッション）
- `waterm-settings.json`（テーマ・フォント等）
- `waterm-snippets.json`（スニペット）
- `waterm-knownhosts.json`（ホスト鍵）

## 構成
| パス | 内容 |
|---|---|
| `src/main.js` | メインプロセス（SSH/Telnet/SFTP/暗号化/ログ/IPC） |
| `src/preload.js` | contextBridge API |
| `src/renderer/` | 画面（index.html / styles.css / renderer.js） |
| `test-backend.js` | バックエンド実地テスト（`node test-backend.js`） |

## 今後拡張できる余地
シリアル(COM)接続、RDP/VNC、known_hostsのGUI管理、2FA(keyboard-interactive)の対話入力、ポート転送GUI など。

## ライセンス
MIT（個人利用向け）。同梱の ssh2 / xterm.js / iconv-lite 等は各OSSライセンスに従います。
