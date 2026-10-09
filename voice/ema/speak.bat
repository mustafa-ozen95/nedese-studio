@echo off
rem Voice-over with EMA Lightning (one Turkish female voice, no cloning, very fast) + Whisper check.
rem Example: speak.bat --job job.json --folder shots --trial 3
set "PATH=%~dp0..\..\ffmpeg\bin;%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin"
set PYTHONUTF8=1
"%~dp0.venv\Scripts\python.exe" "%~dp0generate.py" %*
if errorlevel 1 exit /b 1
"%~dp0..\.venv\Scripts\python.exe" "%~dp0..\speak.py" %* --check-only
