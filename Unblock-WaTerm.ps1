# 和ターミナル (WaTerm) インストーラの SmartScreen 警告を解除するスクリプト
# ダウンロードしたインストーラに付く「Mark-of-the-Web(ネット由来の印)」を外します。
# これを外すと「WindowsによってPCが保護されました」(SmartScreen) は表示されません。
#
# 使い方:
#   1) このファイルを右クリック →「PowerShell で実行」
#   2) または PowerShell で:  .\Unblock-WaTerm.ps1
#   3) 特定のファイルを指定:    .\Unblock-WaTerm.ps1 -Path "C:\path\WaTerm-Setup-1.3.0.exe"
param([string]$Path)

if (-not $Path) {
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  $Path = Get-ChildItem -Path $dl -Filter 'WaTerm-Setup-*.exe' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $Path -or -not (Test-Path $Path)) {
  Write-Host 'WaTerm-Setup-*.exe が見つかりませんでした。' -ForegroundColor Yellow
  Write-Host '  -Path 引数でインストーラのフルパスを指定してください。' -ForegroundColor Yellow
  Write-Host '  例: .\Unblock-WaTerm.ps1 -Path "$env:USERPROFILE\Downloads\WaTerm-Setup-1.3.0.exe"'
  exit 1
}

try {
  Unblock-File -Path $Path -ErrorAction Stop
  Write-Host "ブロックを解除しました:" -ForegroundColor Green
  Write-Host "  $Path"
  Write-Host 'このままダブルクリックで実行しても SmartScreen 警告は出ません。'
} catch {
  Write-Host "解除に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}