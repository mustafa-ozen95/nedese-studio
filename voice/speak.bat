@echo off
rem Local Turkish voice-over (Chatterbox Multilingual) + Whisper check.
rem Example: speak.bat --text "Merhaba." --reference ref.wav --output merhaba.wav
rem          speak.bat --job job.json --folder shots --trial 3
rem ffmpeg: first the portable copy of setup.bat (<ai>\ffmpeg\bin), otherwise the winget install.
set "PATH=%~dp0..\ffmpeg\bin;%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin"
set PYTHONUTF8=1
"%~dp0.venv\Scripts\python.exe" "%~dp0speak.py" %*
