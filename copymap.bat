@echo off
REM ============================================
REM Dota 2 Map Extractor - Copy Map Files
REM ============================================
REM Update DOTA_PATH to match your Steam installation
REM ============================================

set DOTA_PATH=E:\SteamLibrary\steamapps\common\dota 2 beta

echo Copying latest Dota 2 map files to addon...

REM Copy content maps (vmap source files)
if not exist "content\dota_addons\dota-map-coordinates\maps" mkdir "content\dota_addons\dota-map-coordinates\maps"
xcopy /s /y "%DOTA_PATH%\content\dota\maps" "content\dota_addons\dota-map-coordinates\maps\"

REM Copy game maps (compiled vpk)
if not exist "addon\maps" mkdir "addon\maps"
xcopy /s /y "%DOTA_PATH%\game\dota\maps\dota.vpk" "addon\maps\"

echo.
echo Done! Now copy folders to Dota 2:
echo   addon\  -^>  %DOTA_PATH%\game\dota_addons\dota-map-coordinates\
echo   content\  -^>  %DOTA_PATH%\content\dota_addons\dota-map-coordinates\
echo.
pause
