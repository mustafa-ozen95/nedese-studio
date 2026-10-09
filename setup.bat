@echo off
rem Nedese Studio one-click setup: ComfyUI, Node, ffmpeg, voice environments, (optional) models.
rem Safe to run again; finished steps are skipped. Details: setup\setup.ps1, log: setup\setup.log
rem   setup.bat                 asks about the models
rem   setup.bat -Models all     downloads all of them
rem   setup.bat -Models none    downloads no model
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\setup.ps1" %*
echo.
pause
