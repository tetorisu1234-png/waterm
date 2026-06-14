@echo off
echo === WaTerm deploy on this PC ===
copy /Y "\\tsclient\E\WaTerm-deploy.zip" "%TEMP%\WT.zip"
if exist "%USERPROFILE%\WaTerm" rmdir /S /Q "%USERPROFILE%\WaTerm"
powershell -NoProfile -Command "Expand-Archive '%TEMP%\WT.zip' '%USERPROFILE%\WaTerm' -Force"
echo === launching WaTerm ===
start "" "%USERPROFILE%\WaTerm\node_modules\electron\dist\electron.exe" "%USERPROFILE%\WaTerm"
echo done.
timeout /t 3 >nul