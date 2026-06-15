# SmartScreen 警告（WindowsによってPCが保護されました）の回避手順

WaTerm のインストーラ（`WaTerm-Setup-x.y.z.exe`）は**コード署名されていない**ため、
インターネットからダウンロードすると Windows SmartScreen が
「**WindowsによってPCが保護されました**」と表示します。

これは「ネットから来たファイル」という印（**Mark-of-the-Web / MOTW**）が付いているのが原因で、
**印を外せば警告は出なくなります**（ファイルの中身は安全なまま・署名は不要）。

---

## 方法A：付属スクリプトで一発解除（推奨）

ダウンロード後、リポジトリ同梱の以下を使います。

- **`Unblock-WaTerm.bat`** をダブルクリック
  → `Downloads` 内の最新 `WaTerm-Setup-*.exe` を自動で探してブロック解除します。

特定のファイルを指定したい場合（PowerShell）:

```powershell
.\Unblock-WaTerm.ps1 -Path "$env:USERPROFILE\Downloads\WaTerm-Setup-1.3.0.exe"
```

解除後はダブルクリックで普通に実行できます（SmartScreen は出ません）。

---

## 方法B：エクスプローラーで手動解除

1. ダウンロードした `WaTerm-Setup-x.y.z.exe` を**右クリック → プロパティ**
2. 「全般」タブ下部の **「セキュリティ: このファイルは…ブロックされる可能性があります」** で
   **［許可する(ブロックの解除)］にチェック → OK**
3. ダブルクリックで実行（警告は出ません）

---

## 方法C：その場で実行する（解除し忘れた場合）

警告ダイアログが出てしまったら:

1. **「詳細情報」** をクリック
2. 下に現れる **「実行」** ボタンを押す

これで一度だけ実行できます。

---

## 方法D：PowerShell の1行コマンド

```powershell
Unblock-File "$env:USERPROFILE\Downloads\WaTerm-Setup-1.3.0.exe"
```

---

## 補足

- **自分でビルドした** `release\WaTerm-Setup-x.y.z.exe` を直接実行する場合は、
  そもそも MOTW が付かないため**警告は出ません**。
- 他人に配布しても警告を出したくない場合は、**正規のコード署名証明書**
  （EV なら即時／OV・標準は配布実績で徐々に消える）での署名が必要です。
  必要になったら `package.json` の `build.win` に署名設定を追加できます。
