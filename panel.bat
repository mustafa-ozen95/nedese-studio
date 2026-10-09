@echo off
rem Nedese Studio: image, video, voice, music and film generation, opened in the browser.
rem The desktop shortcut runs the tray instead; closing this window closes the panel. Another port: panel.bat --port 1166
rem Address and port come from panel\defaults.json (0.0.0.0:1071: every network of this computer; the firewall rule
rem "Nedese Studio 1071" opens it on private networks). Only this computer: set AI_PANEL_ADDRESS=127.0.0.1 first.
rem Optional sign-in: AI_PANEL_LOGIN=1.
setlocal
cd /d "%~dp0"
title Nedese Studio
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if exist "%~dp0ffmpeg\bin\ffmpeg.exe" set "PATH=%~dp0ffmpeg\bin;%PATH%"
"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js not found: %~dp0node\node.exe or node on the PATH is required.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0panel\server.mjs" %*
if errorlevel 1 pause
