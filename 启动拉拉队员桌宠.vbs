Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executable = fileSystem.BuildPath(root, "node_modules\electron\dist\electron.exe")
If Not fileSystem.FileExists(executable) Then
  MsgBox "Electron runtime is missing. Run npm ci in the project folder.", 48, "Cheerleader desktop pet"
  WScript.Quit 1
End If
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
shell.CurrentDirectory = root
shell.Run Chr(34) & executable & Chr(34) & " " & Chr(34) & root & Chr(34), 0, False
