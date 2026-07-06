# WaTerm: Gitフックを有効化する。clone直後に一度だけ実行。
# core.hooksPath を scripts/hooks に向けるので、フックはリポジトリ管理下で共有される。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
git -C $root config core.hooksPath scripts/hooks
Write-Host "core.hooksPath = scripts/hooks に設定しました。pre-commit が有効です。" -ForegroundColor Green
