' Start the WorkBuddy opencode Go bridge with no console window.
' Key is optional here: WorkBuddy can carry it in the request instead.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\WorkBuddy\opencode\node-bridge"
node = "C:\Users\yzx\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
sh.Environment("PROCESS")("OPENCODE_GO_BRIDGE_PORT") = "8788"
sh.Environment("PROCESS")("OPENCODE_GO_BRIDGE_STATE_DIR") = "D:\WorkBuddy\opencode\node-bridge\.state"
sh.Run """" & node & """ src\bridge.js", 0, False
