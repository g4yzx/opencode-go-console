# 代码审计报告 · opencode GO 控制台

审计日期：2026-10-22
审计对象：`node-bridge/`（6,400 行 JS + 1,414 行单页 UI）
审计范围：`ui.js`、`src/bridge.js`、`src/*-converter.js`、`src/usage.js`、`src/official-usage.js`、`accounts.js`、`ui/index.html`，以及新增的打包链路（`pack/`）
方法：静态通读 + 威胁建模（本地 HTTP 服务的攻击面）+ 针对每条结论写可复现的验证（curl / 单测 / 实机运行），不是"看着像有问题"就列。

## 一、结论摘要

| # | 级别 | 问题 | 状态 |
|---|---|---|---|
| 1 | 🔴 高 | 任意网页可跨站 POST 到 `127.0.0.1:8790`，改代理指向 → 流量被劫持 | 已修 |
| 2 | 🔴 高 | 控制台没有关闭入口，退出后桥接（detached 子进程）变孤儿继续跑 | 已修 |
| 3 | 🟠 中 | 端口被占用时 `server` 抛未捕获 `error`，进程带堆栈崩溃且不弹页面 | 已修 |
| 4 | 🟠 中 | 配置/账号/`models.json` 全部原地 `writeFileSync`，断电或崩溃会写出半个文件 | 已修 |
| 5 | 🟠 中 | `usage-history.jsonl`、`diagnostic.log` 无上限增长；看板每次把整份读进内存 | 已修 |
| 6 | 🟡 低 | 密钥明文落盘（`accounts.json` / `go_key.txt` / `proxy-config.json`） | 接受（见第五节） |
| 7 | 🟡 低 | 停止桥接的兜底路径用 PID 文件 + `process.kill`，PID 复用会误杀 | 接受（有 token 优先路径） |
| 8 | 🟡 低 | 模型 id 以 `innerHTML` 拼进表格 | 接受（id 有正则白名单） |
| 9 | 🟡 低 | 桥接本身对本地进程完全开放 | 设计如此（它就是给 WorkBuddy 用的接口） |

修复后：**44 项单测全绿**，新增 6 项针对文件工具的用例；HTTP 防护、关闭链路、打包实例均在实机验证（第六节）。

## 二、高危：本地控制台的 CSRF

**现象**

`ui.js` 的路由不校验 `Origin`，也不看 `Content-Type`。浏览器对"简单请求"不预检，于是任意网页只要执行：

```js
fetch('http://127.0.0.1:8790/api/proxy', {
  method: 'POST',
  mode: 'no-cors',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ action: 'save', url: 'http://attacker:8080' })
})
```

就能把代理改成攻击者的地址。之后所有走桥接的模型请求（带真实 API Key 的鉴权头）都会先送到那台机器。同理可调 `action: 'stop'` 让服务下线。

**影响**：密钥泄露 / 服务被停。攻击者不需要在你机器上执行任何东西，只要你在浏览器里打开他的页面。

**修复**（`ui.js:1114-1127`、`ui.js:1147-1156`）

1. 所有非 GET 请求校验 `Origin`：只接受 `127.0.0.1:<面板端口>` / `localhost:<面板端口>`，其它一律 403。
2. 所有非 GET 请求必须 `Content-Type: application/json`，否则 415。跨站表单和 `text/plain` 的 `fetch` 发不出这个头；要发就得预检，而服务端不响应 `OPTIONS`，请求被浏览器拦下。

**验证**

```
POST text/plain            → 415 {"error":"请求体必须使用 application/json"}
POST json + Origin evil    → 403 {"error":"拒绝跨站请求"}
POST json + 本地 Origin    → 200 {"ok":true,...}
```

副作用：手工 curl 调接口要带上 `-H "Content-Type: application/json"`，README 已注明。

## 三、高危：退出后桥接变孤儿

**现象**

桥接由面板 `spawn(..., { detached: true })` 拉起，面板进程一退，桥接继续占着 8788；下次开面板会以为"已经在运行"而沿用旧进程（旧代码/旧配置）。面板原本**没有任何退出路径**：没有 `/shutdown`，也没监听 `SIGINT`/`SIGTERM`。做成托盘程序后这是硬伤——用户点"退出"，8080 端口还在。

**修复**

- `ui.js:1222` 新增 `POST /api/shutdown`：先走桥接自己的 `x-bridge-shutdown-token` 优雅停止，再关监听、退出。
- `ui.js:1261` `shutdown(reason)` 带 8 秒硬超时（上游卡住也不会挂死退出）。
- `ui.js:1285` 监听 `SIGINT`/`SIGTERM`/`SIGHUP`，Ctrl+C 同样干净退出。
- 托盘侧双保险：node 进程放进 Job 对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），启动器无论怎么死，桥接一定跟着走。

**验证**：托盘"退出"→ 9 秒后 8790 / 8788 均无响应，`tasklist` 无残留进程。

## 四、中危：崩溃与写坏

**4.1 端口占用直接崩**

`server.listen()` 没有 `error` 监听，第二次启动会抛 `EADDRINUSE` 未捕获异常，控制台一闪而过、浏览器不弹。现在 `ui.js:1277`：`EADDRINUSE` → 打印"已经在运行" → 打开页面 → `exit(0)`；其它错误打印原因后 `exit(1)`。实机二次启动退出码 0，`tasklist` 只有一个实例。

**4.2 非原子写**

`writeBridgePort` / `writeProxyConfig` / `writeCustom` / `writeKey` / `writePid` / `apiInstall` / `retargetModelsPort` 都是原地写。`models.json` 是 WorkBuddy 的命根子，写到一半崩溃 = 模型全丢（虽然留了 `.bak-时间戳`，但用户得自己找）。

新增 `src/file-util.js`：

- `writeFileAtomic`：写 `.tmp-<pid>` 再 `rename`；`rename` 在 Windows 上目标被占用会 `EPERM`，此时回退原地写，不会让用户"保存失败"。
- 已替换全部 7 处写点（`ui.js:81/109/285/308/587/928/1058`）。

**4.3 日志无限增长**

`usage-history.jsonl` 每个请求一行，`diagnostic.log` 每次重试一行，都是 `appendFileSync` 且永不清理；看板 `apiAnalytics` 每次把整份读进内存再 `JSON.parse`。

- `src/bridge.js:679`：`usage-history.jsonl` 超过 8 MB 轮转为 `.1`（只留一代，磁盘上限 16 MB）。
- `src/bridge.js:324`：`diagnostic.log` 超过 1 MB 轮转。
- `ui.js:823`：看板只读尾部 16 MB，并丢掉被截断的首行（`readTailText`），保证不会把半行 JSON 当数据。

## 五、接受的风险（说明理由，不是遗漏）

| 项 | 为什么不改 |
|---|---|
| 密钥明文存 `accounts.json`（权限 0600）、`go_key.txt`、`proxy-config.json` 里的代理密码 | 加 DPAPI 要引入 native 依赖或 PowerShell 子进程，破坏"零依赖、可绿色运行"。文件仅当前用户可读；面板不通过 HTTP 返回密钥本体（只返回 `keyTail` 后 4 位） |
| `/api/key`、`/api/accounts` 无鉴权 | 威胁模型是"本机可信，浏览器不可信"。本机进程本来就能直接读 `accounts.json`，加鉴权只是自欺欺人；跨站读取已被 SOP + 无 CORS 头挡住 |
| `stopBridgeProcess` 的 PID 兜底 | 优先走 token 的 `/shutdown`；PID 路径只在 token 文件缺失时触发，且立刻校验端口是否还在 |
| 表格 `innerHTML` 拼模型 id | 目录 id 来自 opencode 网关，自建 id 已被 `^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$` 限制，注不进标签 |
| 桥接不校验来源 | 它就是给 WorkBuddy 调用的 `/v1` 接口，同机同用户；加 token 会让用户每次改配置 |

## 六、打包链路的安全审查（`pack/`）

| 检查点 | 结论 |
|---|---|
| 权限 | manifest `asInvoker`，不解压到 `Program Files`，不请求管理员 |
| 解包目标 | 只写 `%LOCALAPPDATA%\OpenCodeGo`（或 exe 同目录的绿色模式），不碰系统目录 |
| 路径穿越 | 归档名限定相对路径，解包时把 `/` 转 `\` 后拼在根目录下；名字长度上限 500 字节 |
| 完整性 | 解包全部成功才写 `.version`；半途失败下次重解，不会留半套代码 |
| 子进程 | `CreateProcessW` 用绝对路径（`runtime\node.exe`、`app\ui.js`），不走 `PATH`，无 shell 拼接 |
| 清理 | Job 对象 `KILL_ON_JOB_CLOSE`；托盘"退出"先 `/api/shutdown`，6 秒不退才 `TerminateProcess` |
| 网络 | 不改 hosts、不装服务、不写注册表 Run 除非用户勾"开机自启"（`HKCU`，删除即恢复） |

## 七、验证记录

```
node --test test/*.test.js            44 pass / 0 fail
POST text/plain                       → 415
POST Origin: https://evil.example      → 403
POST 本地 Origin                       → 200
二次启动（端口占用）                    → exit 0，单实例
POST /api/shutdown                    → 面板+桥接 9 秒内全退
dist/OpenCodeGoConsole.exe 首次运行     → 解包 83.3 MB，面板 200
再次运行                               → node.exe mtime 不变（未重解包）
托盘「重启服务」                        → 面板重新 200
打包实例端到端                         → deepseek-v4.1-flash 200，11 个 SSE 块，usage 完整
资源检查                               → RT_ICON / RT_GROUP_ICON / RT_MANIFEST / PAYLOAD 全部存在
```
