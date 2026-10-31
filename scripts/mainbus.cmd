@echo off
rem The mainbus CLI and MCP server (mainbus ticket ..., mainbus mcp) of the current stable build.
rem scripts\build-stable.ps1 installs this as %LOCALAPPDATA%\Mainbus\bin\mainbus.cmd. It reads app\current.txt
rem on every run, so it follows rebuilds and rollbacks, and runs the bundle on that build's own Mainbus.exe in
rem Node mode, so no separate Node install is needed. It never starts the app.
rem Arguments pass through cmd, which mangles quotes and percent signs: use --json - or --*-file for text.
rem Paths are only ever expanded inside quotes or with delayed expansion, never inside a ( ) block, so a ")"
rem or "&" in a folder name can't end a block or start a command. Delayed expansion stays off on the line that
rem passes the arguments on, where it would eat any "!" in them.
setlocal DisableDelayedExpansion
set "MAINBUS_APP=%~dp0..\app"
set "MAINBUS_BUILD="
if exist "%MAINBUS_APP%\current.txt" set /p MAINBUS_BUILD=<"%MAINBUS_APP%\current.txt"
if not defined MAINBUS_BUILD goto not_installed
set "MAINBUS_BUILD_DIR=%MAINBUS_APP%\%MAINBUS_BUILD%"
if not exist "%MAINBUS_BUILD_DIR%\resources\cli\mainbus.cjs" goto no_cli
set "ELECTRON_RUN_AS_NODE=1"
"%MAINBUS_BUILD_DIR%\Mainbus.exe" "%MAINBUS_BUILD_DIR%\resources\cli\mainbus.cjs" %*
exit /b %ERRORLEVEL%

:not_installed
setlocal EnableDelayedExpansion
echo Mainbus isn't installed: !MAINBUS_APP!\current.txt is missing or empty. Run scripts\build-stable.ps1 first. 1>&2
exit /b 3

:no_cli
setlocal EnableDelayedExpansion
echo Mainbus build !MAINBUS_BUILD! has no CLI: !MAINBUS_BUILD_DIR!\resources\cli\mainbus.cjs is missing. 1>&2
exit /b 3
