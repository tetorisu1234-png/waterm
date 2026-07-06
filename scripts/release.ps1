# WaTerm リリース補助スクリプト（★実行は毎回ユーザー承認のうえで）。
# 勝手にリリースしない方針のため、既定は -DryRun。実行時は明示的に -Publish を付ける。
#
#   例) 検証だけ:   powershell -File scripts/release.ps1
#       公開まで:   powershell -File scripts/release.ps1 -Publish
#
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# package.json の version を UTF-8 で厳密に読む（Get-Content 既定だと日本語 productName が壊れる）
$pkg = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$ver = $pkg.version
Write-Host "WaTerm v$ver" -ForegroundColor Cyan

Write-Host "1) 構文チェック + 回帰テスト" -ForegroundColor Yellow
npm run check; if (-not $?) { throw 'check 失敗' }
npm test;      if (-not $?) { throw 'test 失敗' }

Write-Host "2) ビルド（未署名。署名は build/dist-signed.ps1 を使う）" -ForegroundColor Yellow
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist;  if (-not $?) { throw 'dist 失敗' }

$exe = Join-Path $root "release/WaTerm-Setup-$ver.exe"
if (-not (Test-Path $exe)) { throw "成果物が見つかりません: $exe" }
Write-Host "  → $exe" -ForegroundColor Green

if (-not $Publish) {
  Write-Host "`nDryRun 完了。公開するには -Publish を付けて再実行してください（ユーザー承認後）。" -ForegroundColor Cyan
  return
}

Write-Host "3) GitHub Release 公開" -ForegroundColor Yellow
gh release create "v$ver" `
  "release/WaTerm-Setup-$ver.exe" `
  "release/latest.yml" `
  "release/WaTerm-Setup-$ver.exe.blockmap" `
  --repo tetorisu1234-png/waterm --title "v$ver" --notes "WaTerm v$ver"
if (-not $?) { throw 'gh release 失敗' }
Write-Host "公開完了: v$ver" -ForegroundColor Green
