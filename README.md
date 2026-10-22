# opencode GO 控制台 · 桥接 + 托盘面板

[![tests](https://github.com/g4yzx/opencode-go-console/actions/workflows/test.yml/badge.svg)](https://github.com/g4yzx/opencode-go-console/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 **opencode Go** 订阅接进 **WorkBuddy**：本地四协议桥接（chat / Responses / Anthropic / Google 互转）+ 可视化控制台 + 单文件 Windows 托盘版。

- GitHub：<https://github.com/g4yzx/opencode-go-console>（[Releases](https://github.com/g4yzx/opencode-go-console/releases)）
- Gitee：<https://gitee.com/g4yzx/opencode-go-console>（[发行版](https://gitee.com/g4yzx/opencode-go-console/releases)）
- 协议：MIT（见 [LICENSE](LICENSE)）· 安全审计：[AUDIT.md](AUDIT.md) · 版本：v1.0.1

> 为什么需要桥接：opencode Go 的网关强制要求 `x-opencode-session` 头，而 WorkBuddy 的自定义模型表单没有自定义 header 入口。本机起一个 127.0.0.1 的小服务做协议转换与鉴权补全，WorkBuddy 指向 `http://127.0.0.1:8788/v1` 即可。

**桥接内核来源**：[wuwu0605/workbuddy-opencode-go-bridge](https://github.com/wuwu0605/workbuddy-opencode-go-bridge)（MIT，v1.0.0，源码方式运行，不装它的 exe）
**模型/用量能力来源**：[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT，读了它的 catalog / usage / plan 实现）

## 图形面板（推荐日常用这个）

双击 **`启动控制台.bat`**（或 `start-panel.bat`，同一份内容），浏览器会自动打开 `http://127.0.0.1:8790`。
不想看到黑窗口就用 **`start-panel-silent.vbs`**。

> 打不开怎么办：先在浏览器手动访问 `http://127.0.0.1:8790`。窗口里若显示 `[FAIL] Node.js 20+ not found`，
> 说明 node 路径变了，编辑 bat 里的 `NODE=` 那一行。脚本会用 `%~dp0` 定位自身目录，
> 不再写死绝对路径，也不再 `chcp 65001`（那会让 GBK 控制台把后续行解析错，报一堆
> `'xxx' 不是内部或外部命令`）。

| 区域 | 能做什么 |
|---|---|
| 顶部状态条 | 桥接是否在跑、账号数、目录是否最新；右上「自动刷新」开关（每 10 秒刷状态与看板，不重载页面）；四色圆点切主题 |
| **桥接进程（最上面）** | 整块边框就是状态灯：**运行中绿框 + 绿色徽标**，未运行红框 + 红色徽标。启停、打开 `/health`、**改端口** |
| **代理** | 启用开关、代理地址、连接测试、地区限制自动回退；**按模型勾选是否走代理**（模型表「代理」列） |
| 账号与用量 | 多账号增删改、上下排序、设为当前、逐个别查额度；当前账号三个窗口的百分比与重置时间 |
| 用量看板 | 今天 / 7 / 30 / 90 天，按模型汇总请求数、输入输出 token、估算花费 |
| 模型目录 | 搜索 / 按协议筛选 / 勾选；表格显示协议、上下文、输出上限、思考档位、图片、单价 |
| 写入 | 一键合并进 `~/.workbuddy/models.json`，自动备份；四种协议都可以勾选 |

面板只监听 `127.0.0.1:8790`，零 npm 依赖，和 CLI 脚本共用同一份 `models-catalog.json`、`accounts.json`。

## 打包成单文件 EXE（托盘版）

给不想装 Node、不想看黑窗口的人用。**一个 exe，双击就行**：首次解包 → 后台起服务 → 弹浏览器 → 缩进通知栏。

```bat
python pack\build.py                     :: 产物 dist\OpenCodeGoConsole.exe（约 32 MB）
python pack\build.py --version 1.0.1     :: 换版本号，用户端会自动重解包
```

结构：Win32 启动器（`pack/launcher.c`，MinGW 编译）+ 内嵌 payload（node.exe + 应用代码，zlib 压缩后 32 MB）。

| 行为 | 说明 |
|---|---|
| 首次运行 | 解包到 `%LOCALAPPDATA%\OpenCodeGo`（`app\` 代码 + `runtime\node.exe`），约 5–10 秒，托盘提示"首次初始化"；之后启动 < 2 秒，不再重解包 |
| 弹页面 | 端口 8790 起来后才开浏览器，不会出现"无法连接" |
| 托盘菜单 | 打开控制台 / 复制地址 / 重启服务 / 打开数据目录 / 开机自启 / 退出 |
| 双击图标 | 直接打开页面 |
| 退出 | 先调面板 `/api/shutdown`（桥接优雅停止），6 秒不退才强杀；Job 对象兜底，绝不留孤儿进程 |
| 重复双击 | 不会开第二个托盘，只会把页面调出来 |
| 绿色版 | exe 旁边放一个空的 `portable.txt`，数据就写在 exe 目录的 `app\` 里，不碰 `%LOCALAPPDATA%` |

数据/日志都在 `%LOCALAPPDATA%\OpenCodeGo\app\`：`accounts.json`、`usage-history.jsonl`、`.state\diagnostic.log`、`models-catalog.json`。升级版本只覆盖代码文件（payload 里列出的那些），配置与历史原地保留。

> 未签名的自解压 exe 首次运行会被 SmartScreen 拦一下（"更多信息 → 仍要运行"）。杀软误报时把 `%LOCALAPPDATA%\OpenCodeGo` 加白名单即可。
>
> 托盘图标默认可能收进 `^` 溢出区：任务栏设置里把它拖出来，或打开"显示所有系统托盘图标"。

### 改端口

桥接框里的「端口」填 1024–65535，点「保存端口」：

1. 写进 `bridge-config.json`（`{"bridgePort": 8788}`），桥接启动时读它；`start-bridge.bat` 不再写死端口
2. 旧端口上正在跑的桥接会被**优雅关闭**（走 `/shutdown` token，失败才 kill pid）
3. `models.json` 里本项目的行（名字以 ` (opencode Go)` 结尾）自动改成新地址，改前备份
4. 不能和控制台端口相同；非法值直接拒绝

改完点「启动桥接」即可。WorkBuddy 侧不用重新写入模型。

## 代理（按模型）

面板「代理」区块 + 模型表最右边的「代理」勾选框。设置存在 `proxy-config.json`：

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:7897",
  "fallback": true,
  "models": ["gpt-6-luna", "gemini-4-argon-contributor"]
}
```

路由规则：

| 情况 | 走向 |
|---|---|
| 模型在 `models` 里 | **强制走代理**，直连一次都不试；代理挂了直接返回 `proxy_unavailable`，不会偷偷改回直连 |
| 模型不在 `models` 里 | 直连 |
| 直连被上游拒（`unsupported_country_region_territory`）且 `fallback: true` | 该**模型**自动改用代理并记住（只记这个模型，不影响别的模型） |
| `enabled: false` | 完全不碰代理，`fallback` 也不生效 |

- 桥接每 3 秒重读一次 `proxy-config.json`，面板改完**不用重启桥接**
- 代理地址支持 `host:port`、`http://host:port`、`user:pass@host:port`
- 面板「测试连接」= TCP 探测 + **出口查询**：透过代理问 `ip-api.com`，显示真实出口 IP / 国家。端口通 ≠ 出口在美国，这一步能直接看出代理规则有没有把 opencode.ai 放走代理
- 兼容旧配置：没有 `proxy-config.json` 时读 `proxy.txt` 或 `OPENCODE_GO_PROXY`
- `/health` 的 `proxy` 字段显示 `enabled / url / fallback / forced / autoPromoted`

## 单模型探针

模型表每行末尾有「测」按钮，走**和 WorkBuddy 完全相同的路径**发一个 16 token 的流式请求：

```
POST /api/test-model  {"id":"gpt-6-luna"}
→ {"ok":true,"status":200,"ms":1544,"chunks":3}
→ {"ok":false,"status":403,"ms":812,"error":"unsupported_country_region_territory"}
```

- 成功显示 `✓ 1.5s`，失败显示 `✗ 403` 并把上游错误原文写进日志面板
- 403 = 地区限制（代理没生效/出口不是美国）；400 = 参数或模型 id 问题；超时 = 代理链路慢
- 会消耗极少量额度（约 20 token）

## 多账号

桥接侧维护账号池（最多 20 个），WorkBuddy 里那条模型填**任意占位值**（例如 `opencode-go`），真实密钥在桥接里轮转。

- 账号存在 `accounts.json`（明文，权限 0600，仅当前用户可读）
- 顺序即优先级；「设为当前」把账号移到首位
- **自动切换**：当前账号 401/403（凭据失效）或 402/429（额度耗尽）时，按顺序试下一个
- 切换只在**还没输出任何内容**时发生 —— 已经吐了 token 就不重发，避免重复计费（语义同 dsh-opencode-go 的 `accountFallback`）
- 上游返回 400 参数错误之类**不会**切号，直接透传，免得掩盖真实问题
- 40x 的判定：`401/403 → credential`，`402/429 → quota`，`400/404` 且正文含 quota/credit/rate limit → quota

已验证（假上游模拟）：主号 401 → 自动切备用号 → 200 返回 `served by keyB`，`activeRef` 自动改为备用号，主号标记 `lastError: credential`，`stats.accountSwitches: 1`。

**添加账号和查额度是两件独立的事**：账号一按保存就落盘，额度查不到只记日志、只把卡片标成「额度未查询」，
不会回滚账号、不会弹红条吓人。查不到的原文会带上上游响应，例如
`密钥被拒绝（401）：{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`。

## 用量看板

桥接每次请求往 `usage-history.jsonl` 追加一行：`{at, model, protocol, account, switched, stream, usage}`。

`usage` 统一成 `{prompt, completion, cached, cacheWrite}`，来源是上游真实 usage，不再只统计非流式：

| 协议 | 字段来源 | 处理 |
|---|---|---|
| chat（OpenAI 兼容） | `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | 流式请求自动补 `stream_options.include_usage=true`，从末尾 usage 块读取 |
| responses | `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` | 流式从 `response.completed` 事件读取 |
| anthropic | `input_tokens`（不含缓存）/ `cache_read_input_tokens` / `cache_creation_input_tokens` | 合计成总输入；流式合并 `message_start` 与 `message_delta` |
| google | `promptTokenCount` / `candidatesTokenCount` + `thoughtsTokenCount` / `cachedContentTokenCount` | 思考 token 计入输出 |

- 花费按 models.dev 的 `cost.input` / `cost.output` / `cost.cache_read` / `cost.cache_write` 估算（缓存命中按缓存价，缓存写入按写入价），**不是账单**
- 面板显示 usage 覆盖率；旧版本留下的记录没有 token 数，只计次数
- 官方额度百分比始终以 `/usage` 接口为准

### 同步官网用量（官方口径）

看板上方那组数字来自控制台真正在用的 JSON 接口，不是爬页面：

```bash
GET https://opencode.ai/console/api/usage/summary?since=<ISO>&range=7d
GET https://opencode.ai/console/api/usage/models?since=<ISO>
GET https://opencode.ai/console/api/usage/cost-by-day?since=<ISO>&bucket=day
Authorization: Bearer oc_sk_...        # 个人密钥或服务账号密钥都行
```

- 密钥需要在控制台有 **Usage: Read** 权限；默认的 Restricted 密钥如果没勾 Usage 会返回 403
- `range=24h` 是「UTC 今天的 0 点起」，跟面板的「今天（滚动 24 小时）」不是一回事，所以请求里一律带显式 `since`，两边窗口才对得齐
- 金额是 `totalCostMicroCents`，1e-8 美元为 1 单位，除以 1e8 就是美元
- 面板每 5 分钟缓存一次；点「同步官网」强制刷新，失败会回落到 `.state/official-usage.json` 里的上次快照
- 本地记录占官方的比例 = 走桥接的请求占比，剩下的是其它客户端（opencode CLI 等）；「token 覆盖」低是旧记录或中途取消的请求没拿到 usage 块，不是解析失败

## 三个脚本，对应三件事

| 脚本 | 作用 |
|---|---|
| `ui.js` + `ui/index.html` | 图形控制台（8790 端口），账号 / 看板 / 目录 / 写入 / 桥接启停 |
| `accounts.js` | 账号池读写，被桥接和面板共用 |
| `catalog.py` | **自动获取可用模型 + 每个模型的配置**：拉网关目录 + models.dev 元数据，合并成 `models-catalog.json` |
| `install-models.py` | 按 catalog 生成 WorkBuddy 的 `models.json` 条目（context / 输出上限 / 图片 / 协议全自动） |
| `usage.py` | **查订阅用量**：5 小时 / 每周 / 每月已用百分比 + 重置时间 |

```bash
python catalog.py                 # 看现在有什么模型、什么配置
python catalog.py --refresh       # 强制刷新（缓存 6 小时）
python install-models.py          # 干跑
python install-models.py --apply  # 写入 ~/.workbuddy/models.json（自动备份）
python usage.py                   # 查额度
python usage.py --watch 60        # 每分钟刷新
```

## 端点（2026-10-21 实测）

| 用途 | 端点 | 鉴权 | 需要 session 头 |
|---|---|---|---|
| 模型目录 | `GET https://opencode.ai/inference/go/v1/models` | 无 | ❌ |
| OpenAI chat 推理 | `POST .../inference/go/openai/v1/chat/completions` | Bearer | ✅ |
| Anthropic Messages 推理 | `POST .../inference/go/anthropic/v1/messages` | x-api-key | ✅ |
| **用量** | `GET .../inference/go/v1/usage` | Bearer | ❌ |
| 官网用量（汇总） | `GET https://opencode.ai/console/api/usage/summary?since=…` | Bearer | ❌ |
| 官网用量（按模型 / 按天） | `GET .../console/api/usage/models`、`/usage/cost-by-day` | Bearer | ❌ |
| 模型元数据 | `GET https://models.dev/api.json` → `["opencode-go"]` | 无 | ❌ |

- 旧的 `/zen/go/v1/*` 仍可用（兼容保留），新端点已切到 `/inference/go/*`
- 用量响应：`{usage:{rolling,weekly,monthly}}`，每项 `{status:"ok"|"rate-limited", percent:0-100, resetsAt:ISO}`
- 模型元数据字段：`limit.context` / `limit.output` / `modalities.input` / `reasoning` / `cost` / `provider.npm`（决定协议）

## catalog.py 输出的现状（2026-10-21）

网关 37 个模型，WorkBuddy 可用 **30** 个：

| 协议 | 数量 | 说明 |
|---|---|---|
| `chat`（OpenAI 兼容） | 18 | glm-5.2/5.3/5.3-flash、kimi-k2.7-code、kimi-k3、deepseek-v4-pro/v4.1-flash、mimo 四款、longcat、hy3/hy4、step-5、beam-free、minimax-m3.1-flash-free |
| `anthropic`（桥接转换） | 6 | qwen3.8-max/flash、qwen3.7-plus、minimax-m3/m2.7、claude-haiku-5-5 |
| `responses`（桥接转换） | 5 | **gpt-6-luna、gpt-5.6-luna**、grok-4.7、muse-spark 1.2/1.3 |
| `google`（桥接转换） | 1 | gemini-4-argon-contributor |
| 无元数据 | 7 | glm-5.1、grok-4.6、kimi-k2.6、minimax-m2.5、omen-alpha、qwen3.6-plus、qwen3.7-max |

`responses` 由 `src/responses-converter.js` 做双向转换：请求侧把 `messages` 拆成 `instructions` + `input` 条目
（含 `function_call` / `function_call_output`），响应侧把 `output` 条目和 13 种 SSE 事件合回 `chat.completion.chunk`。
只有 `google` 的 `generateContent` 协议由 `src/google-converter.js` 翻译：`contents` / `parts` / `functionCall` 与
`candidates[].content.parts` 双向映射，JSON Schema 会裁到 Google 支持的字段，schema 之外的字段直接丢弃。

## 思考等级（低 / 中 / 高 / 极）自动识别

来源是 models.dev 每个模型的 `reasoning_options`，不是猜的：

| models.dev 声明 | 写入 WorkBuddy |
|---|---|
| `{"type":"effort","values":["low","medium","high"]}` | `supportedEfforts: ["low","medium","high"]` |
| 值里含 `none` / `off`，或 `{"type":"toggle"}` | `canDisableThinking: true` |
| `{"type":"budget_tokens","max":262144}` | 记录 `thinkingBudgetMax`（面板可见，暂不下发） |
| `reasoning: true` 但没有任何选项 | 只置 `supportsReasoning: true`，不虚构等级 |

写进 `models.json` 的样子：

```json
"reasoning": {
  "defaultEffort": "medium",
  "supportedEfforts": ["low", "medium", "high", "xhigh", "max"],
  "canDisableThinking": true
}
```

默认等级优先取 `medium`，没有就 `high`，再没有取第一项。表里的 `xhigh` 在面板显示为「极高」，`max` 显示为「极」。

请求侧按协议翻译 `reasoning_effort`：

| 协议 | 落点 |
|---|---|
| `chat` | 原样透传 `reasoning_effort`（上游不认时会自动剥离重试） |
| `responses` | `reasoning: { effort }` |
| `anthropic` | `thinking: { type: 'enabled', budget_tokens }`（low 2048 / medium 4096 / high 8192 / xhigh 12288 / max 15360），并抬高 `max_tokens`、去掉采样参数 |
| `google` | `generationConfig.thinkingConfig.thinkingLevel`（low/medium/high）；`none` → `thinkingBudget: 0` |

`install-models.py --existing` 只刷新已经装过的行，不会往 `models.json` 里塞新模型。

## 与 WorkBuddy 同步

「模型目录」会顺带读 `~/.workbuddy/models.json`，把 WorkBuddy 里**已经装好的条目**标出来：

| 列 / 位置 | 含义 |
|---|---|
| WB 列 `已装` | 已写入 WorkBuddy，且端口 / 上下文 / 输出上限 / 图片与目录一致 |
| WB 列 `旧` | 已装，但参数和目录对不上（悬停看差在哪几项），重新勾选写入即可更新 |
| WB 列 `-` | WorkBuddy 里没有这个模型 |
| 顶部统计 | `· WorkBuddy 已装 11（2 个参数过期）` |
| 「读取 WorkBuddy」按钮 | 重新读一次 models.json，只读不写 |
| 过滤「已装」 | 只看 WorkBuddy 里已有的模型 |

判定范围：`name` 以 ` (opencode Go)` 结尾，或 `url` 指向 `http://127.0.0.1:<port>/v1` —— 你自己加的其他自定义模型不会被误判。
已装但网关上已经没有的模型会记在 `workbuddy.orphans`，用「清理旧条目」写入时清掉。

## 手动修改与新增模型

面板表格每行右侧有「编辑」，弹窗里可以改：显示名、协议、**上下文**、**输出上限**、图片、思考档位。
保存后写进 `custom-models.json` 的 `overrides`，刷新目录不会丢，行上会标「已改」；点「恢复默认」撤销。

工具栏的「手动新增模型」用于网关目录里没有的模型：填 id、协议、上下文、输出、思考档位即可。
保存后立刻出现在目录里并标「手动」，可以勾选后写入 WorkBuddy；只有手动模型才有「删除」按钮。

```json
{
  "overrides": { "gpt-6-luna": { "context": 1050000, "output": 128000 } },
  "custom": [{ "id": "my-model", "protocol": "chat", "context": 128000, "output": 8192 }]
}
```

写入 `models.json` 时用的就是覆盖后的值；手动/覆盖行的输出上限最高 1,000,000，
目录自动值仍按 65,536 保守截断。`install-models.py` 也读同一份 `custom-models.json`，命令行和面板不会打架。

## 地区限制与本地代理



GPT 系列（`gpt-6-luna` / `gpt-5.6-luna`）会在上游返回：

```
403 unsupported_country_region_territory  Country, region, or territory not supported
```

这不是协议或密钥问题——同样的请求经本地代理出口就是 200。桥接因此做了自动回退：

1. 先直连，命中 `unsupported_country_region_territory` 才走代理重试；
2. 代理生效后本进程后续请求直接走代理，不再浪费一次直连；
3. 代理地址写在 `proxy.txt`，一行即可（默认 `http://127.0.0.1:7897`），改端口不用动代码；
4. 代理挂了不会掩盖真实错误，仍返回上游原文。

`/health` 里的 `geoProxy` 显示当前生效的代理。**刻意不读 `HTTPS_PROXY`**：宿主环境常有自己的一套代理变量，静默继承会把流量带去用户没选的出口。

## 推理模型的参数降级

`gpt-6-luna` 这类模型会拒绝采样参数：

```
400 Unsupported parameter: 'temperature' is not supported with this model.
```

桥接遇到 `Unsupported parameter: 'xxx'` 会剥掉该字段重试一次，并把结果按模型记住（`temperature` / `top_p` 等），
后续请求直接不带，不会每次都多花一轮。`top_p` 在 Google 协议里会同时匹配 `topP`。

### Responses 的两个硬门槛（GPT 系）

| 坑 | 上游原文 | 处理 |
|---|---|---|
| `max_tokens` 太小 | `Invalid 'max_output_tokens': integer below minimum value. Expected >= 16, but got 1` | 转换时抬到 **16**（WorkBuddy 的「测试连接」只申请 1 token，之前 GPT 红、Gemini 绿就是这条） |
| `reasoning_effort: minimal` | `Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model` | 折成 `low`（Responses 只认 none/low/medium/high/xhigh/max） |

这两条只影响走 Responses 协议的模型；chat / anthropic / google 没有 16 的下限。

## 对上游代码的改动


### 来自 DSH 插件的三个认知（不是抄代码，是按它的规范实现）

1. 网关已从 `/zen/go/v1` 迁到 `/inference/go`，推理按协议分家（openai / anthropic / google 各自 `v1`）
2. **模型配置的权威来源是 models.dev 的 `opencode-go` 段**，其中 `provider.npm` 决定协议：
   `@ai-sdk/anthropic`→anthropic、`@ai-sdk/openai`→responses、`@ai-sdk/openai-compatible`→chat、`@ai-sdk/google`→google
3. 用量在 `{gateway}/v1/usage`，返回三个窗口的百分比，不是金额

### bridge.js（6 处）

1. 端口 `9221 → 8788`
2. 上游路径切新网关：chat → `/inference/go/openai/v1/chat/completions`，messages → `/inference/go/anthropic/v1/messages`
3. **白名单改为 catalog 驱动**：读 `models-catalog.json` 决定每个模型的协议；内置集合只做无 catalog 时的兜底
4. `responses` / `google` 都走转换；只有未知模型才返回 `protocol_not_bridgeable`
5. key 兜底：客户端没带鉴权头时回退 `GO_KEY`
6. `/health` 增加 `catalogLoaded`，`/v1/models` 改为 catalog ∪ 内置
7. 新增 `responses-converter.js`：chat ↔ Responses 双向转换（含 SSE 增量、tool call、usage）

### protocol-converter.js（1 处）

`MESSAGES_MODELS` 换成真实协议归属：移除 `minimax-m3.1-flash-free`（实际是 chat），补 `claude-haiku-5-5`。

### 测试

原版 6 个测试全部保留并通过；只同步了 3 处上游路径断言（`/zen/go/v1/*` → `/inference/go/*`）。
新增 `test/responses-converter.test.js` 7 项（请求转换、非流式、流式、tool call、错误包装），
集成测试补了 GPT 非流式 + 流式两条链路。

## 本机实测（2026-10-21）

| 用例 | 结果 |
|---|---|
| `node --test` 6 项 | ✅ 全绿 |
| `catalog.py` | ✅ 网关 37 / 可用 30，含 context、output、图片、成本 |
| `install-models.py` 干跑 | ✅ 生成 24 条，`maxOut` 统一 cap 到 65536 |
| `/health` | ✅ `catalogLoaded: true` |
| `glm-5.3`（chat） | ✅ 走 openai 新路径 → 401 `Invalid credential` |
| `minimax-m3.1-flash-free` | ✅ 按 catalog 判为 chat（内置表曾错判为 anthropic，已修） |
| `qwen3.8-max` / `claude-haiku-5-5`（anthropic） | ✅ 走 messages 转换 → 401，错误已转 OpenAI 格式 |
| `grok-4.7` / `gpt-6-luna` | ✅ 走 responses 转换（真 key 下 200） |
| `gemini-4-argon-contributor` | ✅ 走 google 转换（上游要求先开 Privacy 开关） |
| 不存在的模型 | ✅ 400 `unsupported_model` |
| `usage.py` 无 key / 假 key | ✅ 本地报错 / 401 明确提示 |
| 真 key 下的 200 / 流式 / tool call / 用量数值 | ⏳ 待你的 key |

## 安全审计

完整报告见 **[AUDIT.md](AUDIT.md)**（含验证命令与实测结果）。

- 上游硬编码 `https://opencode.ai`，零 npm 依赖，不读 key 文件，不记 prompt / 响应 / 鉴权头
- `usage.py` / `catalog.py` 只访问 `opencode.ai` 和 `models.dev`，key 只在内存里拼 header
- 面板只绑 `127.0.0.1`；非 GET 请求强制 `application/json` 且校验 `Origin`，挡住任意网页对本地端口的跨站写（改代理、停服务）
- 配置与 `models.json` 一律"临时文件 + rename"原子写；`usage-history.jsonl` 8 MB、`diagnostic.log` 1 MB 自动轮转
- `POST /api/shutdown`（退出）、`SIGINT/SIGTERM` 都会先停桥接再退；打包版的 node 进程放在 Job 对象里，启动器退出即连带清理
- 明文密钥是已知取舍：文件仅当前用户可读，面板只回传尾 4 位

> 用 curl 手工调接口要带上 `-H "Content-Type: application/json"`，否则 415。

## 注意

- 端口被占用时桥接以退出码 73 退出，`/health` 打不开就是没起来
- `models-catalog.json` 缓存 6 小时，`--refresh` 强刷；catalog 变了桥接会在 5 秒内自动重读（按 mtime）
- `--reasoning` 默认关：WorkBuddy 开推理会给上游发额外参数，chat 直通路径不保证每家都认
- 不要把 `go_key.txt` 提交到任何 git 仓库（`.gitignore` 已挡）

## 致谢与来源

| 项目 | 用了什么 |
|---|---|
| [wuwu0605/workbuddy-opencode-go-bridge](https://github.com/wuwu0605/workbuddy-opencode-go-bridge)（MIT） | 桥接内核：协议路由、账号池、流式转发。本仓库在其基础上加了四协议转换、图形面板、代理分流、官方用量同步、托盘打包 |
| [Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT） | 只读了实现思路：models.dev 作为模型元数据权威源、`/v1/usage` 额度接口、控制台用量口径 |
| [models.dev](https://models.dev/api.json) | 模型上下文/价格/思考档位的数据源 |

上游版权声明保留在 [LICENSE](LICENSE)。如果你只想要一个最小桥接，直接用上游项目即可；这个仓库多出来的是面板、协议覆盖面和分发形态。

## 参与

- 跑测试：`npm test`（44 项，零依赖，`node --test`）
- 改完先 `node --check ui.js && node --check src/bridge.js`
- 出包：`python pack\build.py --version x.y.z`，产物 `dist\OpenCodeGoConsole.exe`
- 提交前确认 `git status` 里没有 `accounts.json` / `go_key.txt` / `models-catalog.json`（已被 `.gitignore` 挡住，别用 `-f` 强加）
