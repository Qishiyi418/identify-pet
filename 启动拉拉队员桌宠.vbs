Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executable = fileSystem.BuildPath(root, "node_modules\electron\dist\electron.exe")
If Not fileSystem.FileExists(executable) Then
  MsgBox "缺少 Electron 运行文件。请在项目文件夹中打开终端，运行 npm ci 安装依赖后再启动。", 48, "拉拉队员桌宠"
  WScript.Quit 1
End If
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
shell.CurrentDirectory = root
shell.Run Chr(34) & executable & Chr(34) & " " & Chr(34) & root & Chr(34), 0, False
