' TAYL launcher - starts the server hidden, waits until it answers, then opens the app window.
' ASCII only on purpose (Windows Script Host garbles UTF-8).
Option Explicit
Dim sh, fso, root, url, node, logDir, errFile, cmd, i, q, msg, ts

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
url  = "http://127.0.0.1:3737"
logDir = root & "\data\logs"
errFile = logDir & "\launcher-error.log"

If Not fso.FolderExists(root & "\data") Then fso.CreateFolder root & "\data"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

If Not fso.FolderExists(root & "\node_modules") Then
  MsgBox "Dependencies are not installed. Run INSTALL.bat first.", 16, "TAYL"
  WScript.Quit 1
End If

node = root & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node"

' returns True when the server answers /api/system/health (curl.exe ships with Windows 10+)
Function IsUp()
  Dim rc
  rc = sh.Run("cmd /c curl.exe -s -f --noproxy * -o nul " & q & url & "/api/system/health" & q, 0, True)
  IsUp = (rc = 0)
End Function

If Not IsUp() Then
  sh.CurrentDirectory = root
  If fso.FileExists(errFile) Then fso.DeleteFile errFile, True
  cmd = "cmd /c " & q & q & node & q & " server\index.js 2>" & q & errFile & q & q
  sh.Run cmd, 0, False
  For i = 1 To 30
    WScript.Sleep 700
    If IsUp() Then Exit For
  Next
End If

If Not IsUp() Then
  msg = "TAYL could not start." & vbCrLf & vbCrLf
  If fso.FileExists(errFile) Then
    Set ts = fso.OpenTextFile(errFile, 1)
    If Not ts.AtEndOfStream Then msg = msg & Left(ts.ReadAll(), 700)
    ts.Close
  End If
  msg = msg & vbCrLf & vbCrLf & "Logs: " & logDir & vbCrLf & "Tip: run scripts\windows\TAYL-Debug.bat to see the error."
  MsgBox msg, 16, "TAYL"
  WScript.Quit 1
End If

On Error Resume Next
sh.Run "msedge.exe --app=" & url, 1, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run url, 1, False
End If
