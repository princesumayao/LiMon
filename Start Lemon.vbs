Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

thisMode = "real"
modeFile = scriptDir & "\.limon-mode"

' If a previous run left a mode marker AND that mode's ports still look
' live, warn before silently reopening the wrong instance - this .vbs has
' no console window, so a plain echo (like the .bat does) would never be
' seen, hence the popup here instead.
portInUse = False
Set execObj = shell.Exec("cmd /c netstat -ano | findstr "":3000 "" | findstr LISTENING")
Do While Not execObj.StdOut.AtEndOfStream
  line = execObj.StdOut.ReadLine()
  If Len(Trim(line)) > 0 Then portInUse = True
Loop

If portInUse And fso.FileExists(modeFile) Then
  Set f = fso.OpenTextFile(modeFile, 1)
  runningMode = Trim(f.ReadLine())
  f.Close
  If runningMode <> "" And LCase(runningMode) <> thisMode Then
    answer = MsgBox("Lemon already looks like it's running in " & UCase(runningMode) & _
      " mode, not " & UCase(thisMode) & " mode." & vbCrLf & vbCrLf & _
      "Opening this now will NOT switch it - it'll just show you the " & runningMode & _
      " instance that's already running." & vbCrLf & vbCrLf & _
      "To actually switch, close the other instance first (Task Manager > end all node.exe), " & _
      "then run this again." & vbCrLf & vbCrLf & "Open the existing instance anyway?", _
      vbYesNo + vbExclamation, "Lemon - mode mismatch")
    If answer = vbNo Then
      WScript.Quit
    End If
  End If
End If

shell.Run "cmd /c ""Start Lemon.bat""", 0, False
