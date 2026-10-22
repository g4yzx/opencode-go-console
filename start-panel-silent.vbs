' Launch the control panel with no console window, then open the browser.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\WorkBuddy\opencode\node-bridge"
sh.Environment("PROCESS")("OPENCODE_GO_UI_PORT") = "8790"
sh.Environment("PROCESS")("OPENCODE_GO_BRIDGE_PORT") = "8788"
node = "C:\Users\yzx\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
sh.Run """" & node & """ ui.js", 0, False
