@echo off
rem Turkish voice-over with VoxCPM2 (panel "Voice engine: VoxCPM2"); same arguments as voice\speak.bat.
rem 1) generate.py writes the takes (voice\voxcpm\.venv), 2) speak.py --check-only picks the best take with Whisper
rem    (voice\.venv): <folder>\<id>.wav + report.json.
rem ffmpeg: first the portable copy of setup.bat (<ai>\ffmpeg\bin), otherwise the winget install.
set "PATH=%~dp0..\..\ffmpeg\bin;%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin"
set PYTHONUTF8=1
"%~dp0.venv\Scripts\python.exe" "%~dp0generate.py" %*
if errorlevel 1 exit /b 1
"%~dp0..\.venv\Scripts\python.exe" "%~dp0..\speak.py" %* --check-only
