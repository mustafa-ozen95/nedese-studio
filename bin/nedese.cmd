@echo off
rem Nedese Studio CLI: chat with the panel's agent in the current folder (nedese --help).
"%~dp0..\node\node.exe" "%~dp0..\panel\cli\nedese.mjs" %*
