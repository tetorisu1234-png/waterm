@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $w=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $l=$w.CreateShortcut($d+'\WaTerm.lnk'); $l.TargetPath=$env:USERPROFILE+'\WaTerm\node_modules\electron\dist\electron.exe'; $l.Arguments=$env:USERPROFILE+'\WaTerm'; $l.WorkingDirectory=$env:USERPROFILE+'\WaTerm'; $l.IconLocation=$env:USERPROFILE+'\WaTerm\node_modules\electron\dist\electron.exe,0'; $l.Save(); Write-Host ('OK created: '+$d+'\WaTerm.lnk') } catch { Write-Host ('ERR: '+$_.Exception.Message) }"
echo.
echo (press a key to close)
pause >nul