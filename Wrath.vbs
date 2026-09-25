' ---------------------------------------------------------------------------
'  Starts Wrath without a console window.
'  Startup errors go to data\logs\wrath.log.
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, here, electron, command, result, style
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

If Not fso.FolderExists(fso.BuildPath(here, "node_modules")) Then
    ' first run needs a console, npm install takes a while
    If Not OnPath("node.exe") Then
        MsgBox "Wrath needs Node.js, which is not installed or not on your PATH." & vbCrLf & vbCrLf & _
               "Install it from https://nodejs.org and try again.", 16, "Wrath"
        WScript.Quit 1
    End If
    result = shell.Run("cmd /c npm install --no-audit --no-fund", 1, True)
    If result <> 0 Then
        MsgBox "Installing Wrath's dependencies failed." & vbCrLf & _
               "Run Wrath.cmd to see why.", 16, "Wrath"
        WScript.Quit result
    End If
End If

electron = fso.BuildPath(here, "node_modules\electron\dist\electron.exe")

If fso.FileExists(electron) Then
    command = Quote(electron) & " " & Quote(fso.BuildPath(here, "src\ui\electron.js"))
    ' electron has no console, don't start it hidden or the window won't show
    style = 1
Else
    ' The application shell is missing, so fall back to the proxy with its page
    ' opened in a browser. Everything works; it just looks like a browser.
    If Not OnPath("node.exe") Then
        MsgBox "Wrath needs Node.js, which is not installed or not on your PATH." & vbCrLf & vbCrLf & _
               "Install it from https://nodejs.org and try again.", 16, "Wrath"
        WScript.Quit 1
    End If
    command = "node " & Quote(fso.BuildPath(here, "src\index.js")) & " window"
    ' This one really is a console program, and that console is what to hide.
    style = 0
End If

' False returns immediately, so this script does not stay in memory for the
' life of the application.
shell.Run command, style, False

Function Quote(text)
    Quote = Chr(34) & text & Chr(34)
End Function

Function OnPath(exeName)
    Dim probe
    On Error Resume Next
    probe = shell.Run("cmd /c where " & exeName & " >nul 2>&1", 0, True)
    OnPath = (Err.Number = 0 And probe = 0)
    On Error GoTo 0
End Function
