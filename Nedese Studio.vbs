' Nedese Studio: starts the tray icon without a window (tray\tray.ps1).
' The "Nedese Studio" desktop shortcut runs this file.
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & folder & "\tray\tray.ps1""", 0, False
