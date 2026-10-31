' Stops the hidden TAYL server using its PID file.
Option Explicit
Dim sh, fso, root, pidFile, ts, pid
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
pidFile = root & "\data\tayl.pid"
If fso.FileExists(pidFile) Then
  Set ts = fso.OpenTextFile(pidFile, 1)
  pid = Trim(ts.ReadAll()) : ts.Close
  sh.Run "taskkill /PID " & pid & " /T /F", 0, True
  If fso.FileExists(pidFile) Then fso.DeleteFile pidFile, True
End If
