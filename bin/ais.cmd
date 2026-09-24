@echo off
REM ==========================================================================
REM  ais bootstrap (Windows)
REM    Makes sure the SHA256-pinned portable Node exists under app\node, then
REM    hands off to launcher\ais.mjs. Lives in bin\ so the installer can put
REM    just this folder on the user PATH.
REM ==========================================================================

setlocal DisableDelayedExpansion

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "NODE_DIR=%ROOT%\app\node"

set "NODE_VERSION=22.16.0"
set "NODE_SUBDIR=node-v%NODE_VERSION%-win-x64"
set "NODE_BIN=%NODE_DIR%\%NODE_SUBDIR%"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_SUBDIR%.zip"
set "NODE_SHA256=21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd"

if not exist "%NODE_BIN%\node.exe" call :bootstrap || exit /b 1

REM One line on purpose: cmd.exe reads a batch file while running it and
REM "ais update" rewrites this file while node runs, so nothing after this
REM line may be read once node returns. "call" expands %%ERRORLEVEL%% only
REM after node exits, without delayed expansion mangling "!" in arguments.
"%NODE_BIN%\node.exe" "%ROOT%\launcher\ais.mjs" %* & call exit /b %%ERRORLEVEL%%

:bootstrap
setlocal EnableDelayedExpansion
echo ais: bootstrapping Node.js %NODE_VERSION% (first run only)... 1>&2
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_DIR%\node.zip' -UseBasicParsing"
if errorlevel 1 (
    echo ais: failed to download Node.js. 1>&2
    exit /b 1
)
for /f %%h in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%NODE_DIR%\node.zip').Hash.ToLower()"') do set "NODE_ACTUAL=%%h"
if /i not "!NODE_ACTUAL!"=="%NODE_SHA256%" (
    echo ais: SHA256 mismatch for the Node.js archive. 1>&2
    echo   expected: %NODE_SHA256% 1>&2
    echo   actual:   !NODE_ACTUAL! 1>&2
    del /q "%NODE_DIR%\node.zip" >nul 2>&1
    exit /b 1
)
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Expand-Archive -Path '%NODE_DIR%\node.zip' -DestinationPath '%NODE_DIR%' -Force"
if errorlevel 1 (
    echo ais: failed to extract Node.js. 1>&2
    exit /b 1
)
del /q "%NODE_DIR%\node.zip" >nul 2>&1
endlocal & exit /b 0
